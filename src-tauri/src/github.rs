//! GitHub pull-request access through the user's `gh` CLI.
//!
//! Authentication and GitHub Enterprise routing deliberately stay in `gh`:
//! this layer never receives or stores a token. Commands use argument slices
//! throughout, so neither a pasted PR URL nor a comment body crosses a shell.

use std::path::Path;
use std::process::{Command, Stdio};
use std::{io::Write, process::Output};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};

use crate::error::GitError;
use crate::{git, review::cli_candidates};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrRef {
    pub host: String,
    pub owner: String,
    pub repo: String,
    pub number: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrComment {
    pub id: u64,
    pub author: String,
    pub body: String,
    pub created_at: String,
    pub path: Option<String>,
    pub line: Option<u32>,
    pub outdated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrContext {
    pub url: String,
    pub number: u64,
    pub title: String,
    pub body: String,
    pub author: String,
    pub state: String,
    pub is_draft: bool,
    pub base_ref: String,
    pub base_remote: String,
    pub head_sha: String,
    pub compare_ref: String,
    pub comments: Vec<PrComment>,
}

/// One row of the pull-request picker: enough to recognise and to search, not
/// enough to review. Opening one fetches the rest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrSummary {
    pub number: u64,
    pub title: String,
    pub author: String,
    pub is_draft: bool,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshPrResult {
    pub pr: PrContext,
    pub head_moved: bool,
}

/// The GitHub endpoint selected by the UI after validating a finding against
/// the currently rendered patch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PrCommentDestination {
    Inline,
    File,
    TopLevel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostedPrComment {
    pub url: String,
}

/// A GitHub attachment encoded for an `<img>` data URL in the desktop WebView.
/// The raw attachment never reaches disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubImage {
    pub content_type: String,
    pub data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPr {
    url: String,
    number: u64,
    title: String,
    body: String,
    author: GhAuthor,
    state: String,
    is_draft: bool,
    base_ref_name: String,
    head_ref_oid: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPrSummary {
    number: u64,
    title: String,
    author: GhAuthor,
    is_draft: bool,
    url: String,
}

#[derive(Debug, Deserialize)]
struct GhAuthor {
    login: String,
}

#[derive(Debug, Deserialize)]
struct GhComment {
    id: u64,
    body: String,
    created_at: String,
    user: GhAuthor,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    line: Option<u32>,
    #[serde(default)]
    outdated: bool,
}

#[derive(Debug, Deserialize)]
struct GhPostedComment {
    html_url: String,
}

/// Parses the two forms accepted by the PR input: a web URL (including a
/// GitHub Enterprise hostname) or GitHub's compact `owner/repo#123` spelling.
pub fn parse_pr_ref(input: &str) -> Result<PrRef, GitError> {
    // GitHub's Copy URL includes ordinary paths, but people also paste a URL
    // from the Files/Commits tabs, a Markdown-wrapped URL, or a bare hostname.
    // Keep accepting all of those while still extracting one unambiguous PR.
    let value = input
        .trim()
        .trim_matches(|character| matches!(character, '<' | '>'));
    if let Some((repo, number)) = value.rsplit_once('#') {
        if !repo.contains("://") {
            let mut parts = repo.split('/');
            let owner = parts.next().unwrap_or("");
            let name = parts.next().unwrap_or("");
            if !owner.is_empty() && !name.is_empty() && parts.next().is_none() {
                return Ok(PrRef {
                    host: "github.com".into(),
                    owner: owner.into(),
                    repo: name.into(),
                    number: parse_number(number, value)?,
                });
            }
        }
    }

    let without_scheme = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
        .unwrap_or(value);
    let without_suffix = without_scheme
        .split_once('?')
        .map_or(without_scheme, |(before, _)| before)
        .split_once('#')
        .map_or(without_scheme, |(before, _)| before)
        .trim_end_matches('/');
    let pieces: Vec<_> = without_suffix
        .split('/')
        .filter(|piece| !piece.is_empty())
        .collect();
    let (host, owner, repo, pull, number) = match pieces.as_slice() {
        // `github.com/owner/repo/pull/123`, as often pasted from a terminal.
        [host, owner, repo, pull, number, ..] if host.contains('.') => {
            (*host, *owner, *repo, *pull, *number)
        }
        // A regular URL has the same pieces once its scheme is stripped.
        [host, owner, repo, pull, number, ..] => (*host, *owner, *repo, *pull, *number),
        // Let people omit github.com entirely: owner/repo/pull/123.
        [owner, repo, pull, number, ..] => ("github.com", *owner, *repo, *pull, *number),
        _ => return Err(invalid_pr_ref(value)),
    };
    if owner.is_empty() || repo.is_empty() || !matches!(pull, "pull" | "pulls") {
        return Err(invalid_pr_ref(value));
    }
    Ok(PrRef {
        host: if host.eq_ignore_ascii_case("www.github.com") {
            "github.com".into()
        } else {
            host.into()
        },
        owner: owner.into(),
        repo: repo.trim_end_matches(".git").into(),
        number: parse_number(number, value)?,
    })
}

fn parse_number(number: &str, original: &str) -> Result<u64, GitError> {
    number
        .parse()
        .ok()
        .filter(|number: &u64| *number > 0)
        .ok_or_else(|| invalid_pr_ref(original))
}

fn invalid_pr_ref(value: &str) -> GitError {
    GitError::Command(format!(
        "Invalid pull request reference `{value}`. Use https://github.com/owner/repo/pull/123 or owner/repo#123."
    ))
}

/// Opens a PR, fetches the head ref into a stable local namespace, and returns
/// enough metadata for both the review panel and later comment posting.
pub fn open_pr(root: &Path, url: &str) -> Result<PrContext, GitError> {
    let reference = parse_pr_ref(url)?;
    let pr = read_pr(&reference)?;
    let base_remote = find_remote(root, &reference)?;
    let (compare_ref, head_sha) =
        git::fetch_pr_head(root, &base_remote, reference.number, &pr.base_ref_name)?;
    let comments = read_comments(&reference)?;
    Ok(PrContext {
        url: pr.url,
        number: pr.number,
        title: pr.title,
        body: pr.body,
        author: pr.author.login,
        state: pr.state.to_ascii_lowercase(),
        is_draft: pr.is_draft,
        base_ref: pr.base_ref_name,
        base_remote,
        head_sha,
        compare_ref,
        comments,
    })
}

/// How many pull requests the picker offers. Enough to cover what is actually
/// in flight on a busy repository, while still being one quick `gh` call —
/// anything older is reached by pasting its URL, the way it always was.
const PR_LIST_LIMIT: &str = "50";

/// Open pull requests on the repository this checkout's remotes point at.
///
/// Listing is a convenience, not the way in: a repository with no GitHub remote,
/// a missing `gh`, or an expired login all report as an error the picker shows
/// in place of its list, and pasting a URL keeps working regardless.
pub fn list_prs(root: &Path) -> Result<Vec<PrSummary>, GitError> {
    let target = list_target(root)?;
    let raw = run_gh(&[
        "pr",
        "list",
        "--repo",
        &target,
        "--state",
        "open",
        "--limit",
        PR_LIST_LIMIT,
        "--json",
        "number,title,author,isDraft,url",
    ])?;
    if raw.iter().all(u8::is_ascii_whitespace) {
        return Ok(Vec::new());
    }
    let listed: Vec<GhPrSummary> = serde_json::from_slice(&raw).map_err(|error| {
        GitError::Command(format!("Could not read pull requests from gh: {error}"))
    })?;
    Ok(listed
        .into_iter()
        .map(|pr| PrSummary {
            number: pr.number,
            title: pr.title,
            author: pr.author.login,
            is_draft: pr.is_draft,
            url: pr.url,
        })
        .collect())
}

/// The `host/owner/repo` to list from. Remotes are searched in `gh`'s own order
/// of preference — `upstream` before `origin` — so a fork lists the pull
/// requests of the repository it was forked from, which is where they live.
fn list_target(root: &Path) -> Result<String, GitError> {
    let remotes = git::remote_urls(root)?;
    let named = |wanted: &str| {
        remotes
            .iter()
            .find(|(name, _)| name == wanted)
            .and_then(|(_, url)| remote_repo(url))
    };
    let found = named("upstream")
        .or_else(|| named("origin"))
        .or_else(|| remotes.iter().find_map(|(_, url)| remote_repo(url)));
    found
        .map(|(host, owner, repo)| format!("{host}/{owner}/{repo}"))
        .ok_or_else(|| {
            GitError::Command(
                "This repository has no GitHub remote to list pull requests from.".into(),
            )
        })
}

pub fn refresh_pr(root: &Path, previous: &PrContext) -> Result<RefreshPrResult, GitError> {
    let pr = open_pr(root, &previous.url)?;
    Ok(RefreshPrResult {
        head_moved: pr.head_sha != previous.head_sha,
        pr,
    })
}

fn read_pr(reference: &PrRef) -> Result<GhPr, GitError> {
    let target = pr_target(reference);
    let raw = run_gh(&[
        "pr",
        "view",
        &target,
        "--json",
        "url,number,title,body,author,state,isDraft,baseRefName,headRefOid",
    ])?;
    if raw.iter().all(u8::is_ascii_whitespace) {
        return Err(GitError::Command(
            "GitHub CLI returned no pull-request metadata. Check that the URL names a pull request and `gh auth status` is logged in."
                .into(),
        ));
    }
    serde_json::from_slice(&raw).map_err(|error| {
        GitError::Command(format!(
            "Could not read pull request metadata from gh: {error}"
        ))
    })
}

/// Posts one review finding without ever handling a GitHub token directly.
///
/// A review is anchored to the fetched PR commit. Re-read the current head
/// first so an otherwise-valid inline line cannot land on a newer commit.
pub fn post_pr_comment(
    root: &Path,
    pr: &PrContext,
    body: &str,
    path: Option<&str>,
    line: Option<u32>,
    destination: PrCommentDestination,
) -> Result<PostedPrComment, GitError> {
    let _ = root;
    let reference = parse_pr_ref(&pr.url)?;
    let current = read_pr(&reference)?;
    if current.head_ref_oid != pr.head_sha {
        return Err(GitError::Command(
            "This pull request has new commits. Refresh it before posting so line anchors do not drift."
                .into(),
        ));
    }

    let endpoint = match destination {
        PrCommentDestination::TopLevel => format!(
            "repos/{}/{}/issues/{}/comments",
            reference.owner, reference.repo, reference.number
        ),
        PrCommentDestination::Inline | PrCommentDestination::File => format!(
            "repos/{}/{}/pulls/{}/comments",
            reference.owner, reference.repo, reference.number
        ),
    };
    // `gh api -f` turns all values into strings in the installed CLI version,
    // but GitHub requires `line` to be a JSON number. A JSON stdin body keeps
    // all fields correctly typed (and safely carries multi-line Markdown).
    let mut fields = serde_json::Map::new();
    fields.insert("body".into(), serde_json::Value::String(body.into()));
    match destination {
        PrCommentDestination::Inline => {
            let path = path
                .ok_or_else(|| GitError::Command("An inline comment needs a file path.".into()))?;
            let line = line.ok_or_else(|| {
                GitError::Command("An inline comment needs a new-file line.".into())
            })?;
            fields.insert(
                "commit_id".into(),
                serde_json::Value::String(pr.head_sha.clone()),
            );
            fields.insert("path".into(), serde_json::Value::String(path.into()));
            fields.insert("line".into(), serde_json::Value::from(line));
            fields.insert("side".into(), serde_json::Value::String("RIGHT".into()));
        }
        PrCommentDestination::File => {
            let path =
                path.ok_or_else(|| GitError::Command("A file comment needs a file path.".into()))?;
            fields.insert(
                "commit_id".into(),
                serde_json::Value::String(pr.head_sha.clone()),
            );
            fields.insert("path".into(), serde_json::Value::String(path.into()));
            fields.insert(
                "subject_type".into(),
                serde_json::Value::String("file".into()),
            );
        }
        PrCommentDestination::TopLevel => {}
    }
    let payload = serde_json::to_vec(&serde_json::Value::Object(fields)).map_err(|error| {
        GitError::Command(format!("Could not encode the comment for GitHub: {error}"))
    })?;
    let args = [
        "api".to_owned(),
        "--hostname".to_owned(),
        reference.host,
        "-X".to_owned(),
        "POST".to_owned(),
        "--input".to_owned(),
        "-".to_owned(),
        endpoint,
    ];
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    let raw = run_gh_with_input(&borrowed, &payload)?;
    let posted: GhPostedComment = serde_json::from_slice(&raw).map_err(|error| {
        GitError::Command(format!(
            "GitHub accepted the comment but returned unreadable JSON: {error}"
        ))
    })?;
    Ok(PostedPrComment {
        url: posted.html_url,
    })
}

fn read_comments(reference: &PrRef) -> Result<Vec<PrComment>, GitError> {
    let endpoint = format!(
        "repos/{}/{}/pulls/{}/comments",
        reference.owner, reference.repo, reference.number
    );
    let inline = parse_comments(&run_gh(&[
        "api",
        "--hostname",
        &reference.host,
        &endpoint,
        "--paginate",
        "--slurp",
    ])?)?;
    let endpoint = format!(
        "repos/{}/{}/issues/{}/comments",
        reference.owner, reference.repo, reference.number
    );
    let top_level = parse_comments(&run_gh(&[
        "api",
        "--hostname",
        &reference.host,
        &endpoint,
        "--paginate",
        "--slurp",
    ])?)?;
    let mut comments = inline;
    comments.extend(top_level);
    comments.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
    Ok(comments)
}

fn parse_comments(raw: &[u8]) -> Result<Vec<PrComment>, GitError> {
    let pages: serde_json::Value = serde_json::from_slice(raw).map_err(|error| {
        GitError::Command(format!(
            "Could not read pull request comments from gh: {error}"
        ))
    })?;
    let arrays = match pages {
        serde_json::Value::Array(values)
            if values.first().is_some_and(serde_json::Value::is_array) =>
        {
            values
        }
        serde_json::Value::Array(values) => vec![serde_json::Value::Array(values)],
        _ => {
            return Err(GitError::Command(
                "GitHub returned comments in an unexpected format.".into(),
            ))
        }
    };
    arrays.into_iter().try_fold(Vec::new(), |mut all, page| {
        let page: Vec<GhComment> = serde_json::from_value(page).map_err(|error| {
            GitError::Command(format!("Could not parse a pull request comment: {error}"))
        })?;
        all.extend(page.into_iter().map(|comment| PrComment {
            id: comment.id,
            author: comment.user.login,
            body: comment.body,
            created_at: comment.created_at,
            path: comment.path,
            line: comment.line,
            outdated: comment.outdated,
        }));
        Ok(all)
    })
}

fn pr_target(reference: &PrRef) -> String {
    format!(
        "https://{}/{}/{}/pull/{}",
        reference.host, reference.owner, reference.repo, reference.number
    )
}

/// GitHub's `/user-attachments/assets/...` URLs require an authenticated
/// request, even when the pull request is otherwise visible. Keep this allow
/// list deliberately narrow: Markdown is third-party input, and `gh api`
/// attaches the user's GitHub credentials to its request.
fn is_github_attachment_url(url: &str) -> bool {
    let Some(asset) = url.strip_prefix("https://github.com/user-attachments/assets/") else {
        return false;
    };
    let asset = asset.split(['?', '#']).next().unwrap_or_default();
    !asset.is_empty()
        && asset
            .bytes()
            .all(|character| character.is_ascii_hexdigit() || character == b'-')
}

/// Fetches an attachment using the same authenticated GitHub CLI session that
/// the PR reader uses. `gh api --include` keeps the final redirect response's
/// MIME type alongside the binary response body.
pub fn get_github_image(url: &str) -> Result<GitHubImage, GitError> {
    if !is_github_attachment_url(url) {
        return Err(GitError::Command(
            "Only GitHub user-attachment image URLs can be loaded through GitHub authentication."
                .into(),
        ));
    }

    let response = run_gh(&["api", "--method", "GET", "--include", url])?;
    let (content_type, body) = parse_github_image_response(&response)?;
    const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
    if body.is_empty() {
        return Err(GitError::Command(
            "GitHub returned an empty image attachment.".into(),
        ));
    }
    if body.len() > MAX_IMAGE_BYTES {
        return Err(GitError::Command(
            "GitHub image attachment exceeds the 10 MB display limit.".into(),
        ));
    }
    Ok(GitHubImage {
        content_type,
        data: BASE64.encode(body),
    })
}

fn parse_github_image_response(response: &[u8]) -> Result<(String, &[u8]), GitError> {
    let separator = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| {
            GitError::Command("GitHub returned an attachment without HTTP headers.".into())
        })?;
    let headers = std::str::from_utf8(&response[..separator]).map_err(|error| {
        GitError::Command(format!(
            "GitHub returned invalid attachment headers: {error}"
        ))
    })?;
    let content_type = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-type").then(|| {
                value
                    .trim()
                    .split(';')
                    .next()
                    .unwrap_or_default()
                    .to_ascii_lowercase()
            })
        })
        .filter(|value| value.starts_with("image/"))
        .ok_or_else(|| GitError::Command("GitHub attachment is not an image.".into()))?;
    let body = &response[separator + 4..];
    Ok((content_type, body))
}

fn run_gh(args: &[&str]) -> Result<Vec<u8>, GitError> {
    run_gh_inner(args, None)
}

/// Runs `gh` with a JSON request body. No shell or temporary file is involved,
/// so user-supplied Markdown remains a single opaque argument/body.
fn run_gh_with_input(args: &[&str], input: &[u8]) -> Result<Vec<u8>, GitError> {
    run_gh_inner(args, Some(input))
}

fn run_gh_inner(args: &[&str], input: Option<&[u8]>) -> Result<Vec<u8>, GitError> {
    let mut spawned = None;
    for candidate in cli_candidates("gh") {
        let mut command = Command::new(&candidate.program);
        if let Some(prepend) = candidate.path_prepend {
            let mut path = prepend.into_os_string();
            path.push(":");
            path.push(std::env::var_os("PATH").unwrap_or_default());
            command.env("PATH", path);
        }
        command.args(args);
        // `Command::output` did this implicitly before posting gained stdin.
        // With `spawn`, explicitly pipe both streams so reads from `gh` remain
        // available to the app rather than disappearing into the GUI process.
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        if input.is_some() {
            command.stdin(Stdio::piped());
        }
        match command.spawn() {
            Ok(mut child) => {
                if let Some(input) = input {
                    let mut stdin = child.stdin.take().ok_or_else(|| {
                        GitError::Command("Could not open GitHub CLI input stream.".into())
                    })?;
                    stdin
                        .write_all(input)
                        .map_err(|error| GitError::Command(error.to_string()))?;
                }
                let output: Output = child
                    .wait_with_output()
                    .map_err(|error| GitError::Command(error.to_string()))?;
                spawned = Some(output);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(GitError::Command(error.to_string())),
        }
    }
    let output = spawned.ok_or(GitError::GhNotFound)?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        Err(GitError::Command(if stderr.is_empty() {
            stdout
        } else {
            stderr
        }))
    }
}

fn find_remote(root: &Path, reference: &PrRef) -> Result<String, GitError> {
    git::remote_urls(root)?
        .into_iter()
        .find(|(_, remote_url)| remote_matches(remote_url, reference))
        .map(|(name, _)| name)
        .ok_or_else(|| GitError::Command(format!(
            "This repository has no remote for {}/{}/{}. Add a remote for {}/{} before opening this pull request.",
            reference.host, reference.owner, reference.repo, reference.owner, reference.repo
        )))
}

/// The `host/owner/repo` a Git remote points at, for normal HTTPS and SSH
/// spellings. `None` for anything that does not name three parts — a local path
/// remote, most obviously.
pub fn remote_repo(remote: &str) -> Option<(String, String, String)> {
    let without_scheme = remote
        .strip_prefix("https://")
        .or_else(|| remote.strip_prefix("http://"))
        .or_else(|| remote.strip_prefix("ssh://"))
        .unwrap_or(remote);
    let without_user = without_scheme
        .strip_prefix("git@")
        .or_else(|| without_scheme.split_once('@').map(|(_, rest)| rest))
        .unwrap_or(without_scheme);
    let normalized = without_user.replace(':', "/");
    let parts: Vec<_> = normalized.trim_end_matches('/').split('/').collect();
    // A filesystem remote splits into the same shape — `/srv/git/widgets.git`
    // would read as the repository `widgets` on a nameless host — so the leading
    // piece has to actually be a host.
    if parts.len() < 3 || parts[0].is_empty() {
        return None;
    }
    Some((
        parts[0].to_owned(),
        parts[parts.len() - 2].to_owned(),
        parts[parts.len() - 1].trim_end_matches(".git").to_owned(),
    ))
}

/// Matches normal HTTPS and SSH Git remote spellings against a PR's base repo.
pub fn remote_matches(remote: &str, reference: &PrRef) -> bool {
    remote_repo(remote).is_some_and(|(host, owner, repo)| {
        host.eq_ignore_ascii_case(&reference.host)
            && owner == reference.owner
            && repo == reference.repo
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_web_and_shorthand_references() {
        assert_eq!(
            parse_pr_ref("https://github.example.com/acme/widgets/pull/42").expect("URL"),
            PrRef {
                host: "github.example.com".into(),
                owner: "acme".into(),
                repo: "widgets".into(),
                number: 42
            }
        );
        assert_eq!(
            parse_pr_ref("acme/widgets#7").expect("shorthand"),
            PrRef {
                host: "github.com".into(),
                owner: "acme".into(),
                repo: "widgets".into(),
                number: 7
            }
        );
    }

    #[test]
    fn accepts_urls_copied_from_pr_subpages_and_bare_github_spellings() {
        let expected = PrRef {
            host: "github.com".into(),
            owner: "acme".into(),
            repo: "widgets".into(),
            number: 42,
        };
        for value in [
            "https://github.com/acme/widgets/pull/42/files?short_path=abc#diff-123",
            "<https://www.github.com/acme/widgets/pulls/42/commits>",
            "github.com/acme/widgets/pull/42/",
            "acme/widgets/pull/42",
        ] {
            assert_eq!(parse_pr_ref(value).expect(value), expected, "{value}");
        }
    }

    #[test]
    fn rejects_malformed_references() {
        for value in [
            "acme/widgets",
            "https://github.com/acme/widgets/issues/4",
            "acme/widgets#0",
        ] {
            assert!(parse_pr_ref(value).is_err(), "{value} should fail");
        }
    }

    #[test]
    fn matches_https_and_ssh_remotes() {
        let reference = parse_pr_ref("acme/widgets#7").expect("reference");
        for remote in [
            "https://github.com/acme/widgets.git",
            "git@github.com:acme/widgets.git",
            "ssh://git@github.com/acme/widgets",
        ] {
            assert!(remote_matches(remote, &reference), "{remote} should match");
        }
        assert!(!remote_matches("git@github.com:acme/other.git", &reference));
    }

    /// Listing pull requests has no PR reference to match against — it has to
    /// name the repository itself, from whatever spelling the remote uses.
    #[test]
    fn reads_the_repository_out_of_every_remote_spelling() {
        for remote in [
            "https://github.com/acme/widgets.git",
            "git@github.com:acme/widgets.git",
            "ssh://git@github.com/acme/widgets",
            "https://ghe.internal.example/acme/widgets/",
        ] {
            let (host, owner, repo) = remote_repo(remote).expect(remote);
            assert_eq!(
                (owner.as_str(), repo.as_str()),
                ("acme", "widgets"),
                "{remote}"
            );
            assert!(host.contains('.'), "{remote} should keep its host: {host}");
        }

        // A local path remote names no GitHub repository, and must not be
        // guessed at — the picker reports that rather than listing nonsense.
        assert_eq!(remote_repo("/srv/git/widgets.git"), None);
    }

    #[test]
    fn accepts_only_github_user_attachment_urls() {
        assert!(is_github_attachment_url(
            "https://github.com/user-attachments/assets/7af75a80-9eb1-40c8-ad81-e64f45a984dd"
        ));
        assert!(is_github_attachment_url(
            "https://github.com/user-attachments/assets/7af75a80-9eb1-40c8-ad81-e64f45a984dd?download=1"
        ));
        for url in [
            "http://github.com/user-attachments/assets/7af75a80-9eb1-40c8-ad81-e64f45a984dd",
            "https://evil.example/user-attachments/assets/7af75a80-9eb1-40c8-ad81-e64f45a984dd",
            "https://github.com/user-attachments/assets/not-an-asset!",
        ] {
            assert!(!is_github_attachment_url(url), "{url}");
        }
    }

    #[test]
    fn parses_image_response_headers_without_touching_binary_data() {
        let response = b"HTTP/1.1 200 OK\r\nContent-Type: image/png; charset=binary\r\n\r\n\x89PNG";
        let (content_type, body) = parse_github_image_response(response).expect("image response");
        assert_eq!(content_type, "image/png");
        assert_eq!(body, b"\x89PNG");
    }
}
