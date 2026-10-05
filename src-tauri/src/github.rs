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
    /// The new-file line an inline comment anchors to, the last for a span, or
    /// `None` for a comment on a file as a whole. An outdated comment's lines
    /// are where it was made, on a commit since replaced.
    pub line: Option<u32>,
    /// Where a span starts; `None` for a single line.
    #[serde(default)]
    pub start_line: Option<u32>,
    /// The lines it was made on have changed since, so GitHub no longer shows
    /// it in the diff.
    pub outdated: bool,
}

/// A conversation GitHub keeps on a line or file of the diff: an inline
/// comment and the replies to it. Its comments themselves are in
/// `PrContext::comments`, by id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrThread {
    /// GraphQL's node id, which resolving the thread takes.
    pub id: String,
    pub resolved: bool,
    /// Who resolved it, while it is.
    pub resolved_by: Option<String>,
    pub outdated: bool,
    /// Its comments' ids, as `PrComment::id` has them, oldest first: the first
    /// one started it.
    pub comment_ids: Vec<u64>,
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
    /// The PR's branch as GitHub names it; the diff reads `compare_ref` instead.
    pub head_ref: String,
    pub head_sha: String,
    pub compare_ref: String,
    pub comments: Vec<PrComment>,
    /// The review threads the inline comments form, with GitHub's state of each.
    #[serde(default)]
    pub threads: Vec<PrThread>,
}

impl PrContext {
    /// The review thread a comment posted at `url` started or joined. `None`
    /// for a top-level comment, which GitHub keeps no thread for, or one that
    /// was posted since the PR was last read.
    pub fn thread_for(&self, url: &str) -> Option<&PrThread> {
        let id = review_comment_id(url)?;
        self.threads
            .iter()
            .find(|thread| thread.comment_ids.contains(&id))
    }
}

/// The id a review comment's permalink ends in: `…/pull/7#discussion_r<id>`.
/// A top-level comment's ends `#issuecomment-<id>` instead.
pub fn review_comment_id(url: &str) -> Option<u64> {
    url.rsplit_once("#discussion_r")?.1.parse().ok()
}

/// One row of the pull-request list: enough to recognise, search and choose
/// between, not enough to review. Opening one fetches the rest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrSummary {
    pub number: u64,
    pub title: String,
    pub author: String,
    pub is_draft: bool,
    pub url: String,
    pub labels: Vec<PrLabel>,
    pub head_ref: String,
    pub base_ref: String,
    /// Whether the head branch lives in a fork. A fork's branch names say
    /// nothing about this repository's, so only same-repository PRs can be
    /// the one another PR is stacked on.
    pub is_cross_repository: bool,
    /// The head commit, so a stored review can tell it is out of date.
    pub head_sha: String,
    /// ISO 8601, as GitHub reports it.
    pub created_at: String,
    /// ISO 8601, as GitHub reports it.
    pub updated_at: String,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    /// `APPROVED`, `CHANGES_REQUESTED` or `REVIEW_REQUIRED`; `None` when the
    /// repository asks for no review.
    pub review_decision: Option<String>,
}

/// A label as GitHub shows it: `color` is six hex digits, without the `#`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrLabel {
    pub name: String,
    #[serde(default)]
    pub color: String,
}

/// Which open pull requests to list, in `gh`'s own terms of the signed-in user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PrListFilter {
    All,
    ReviewRequested,
    Mine,
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

/// The three outcomes GitHub offers when finishing a review, in the spelling
/// the review agent recommends them in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrReviewVerdict {
    Approve,
    Comment,
    RequestChanges,
}

impl PrReviewVerdict {
    /// The `event` GitHub's create-review endpoint expects.
    fn event(self) -> &'static str {
        match self {
            Self::Approve => "APPROVE",
            Self::Comment => "COMMENT",
            Self::RequestChanges => "REQUEST_CHANGES",
        }
    }
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
    head_ref_name: String,
    head_ref_oid: String,
}

/// A pull request as the list's GraphQL query reads it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPrSummary {
    number: u64,
    title: String,
    /// `null` for an account that has since been deleted.
    author: Option<GhAuthor>,
    is_draft: bool,
    url: String,
    #[serde(default)]
    labels: GhLabels,
    head_ref_name: String,
    base_ref_name: String,
    #[serde(default)]
    is_cross_repository: bool,
    head_ref_oid: String,
    #[serde(default)]
    created_at: String,
    updated_at: String,
    #[serde(default)]
    additions: u64,
    #[serde(default)]
    deletions: u64,
    #[serde(default)]
    changed_files: u64,
    #[serde(default)]
    review_decision: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct GhLabels {
    #[serde(default)]
    nodes: Vec<PrLabel>,
}

/// One page of a GraphQL connection: `pullRequests` counts in `totalCount`,
/// `search` in `issueCount`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhConnection {
    total_count: Option<u64>,
    issue_count: Option<u64>,
    page_info: GhPageInfo,
    /// Search can hold things other than pull requests, which come back empty.
    nodes: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhRepositoryPrs {
    pull_requests: GhConnection,
}

#[derive(Debug, Deserialize)]
struct GhListData {
    repository: Option<GhRepositoryPrs>,
    search: Option<GhConnection>,
}

#[derive(Debug, Deserialize)]
struct GhListResponse {
    data: Option<GhListData>,
    #[serde(default)]
    errors: Vec<GhGraphError>,
}

#[derive(Debug, Deserialize)]
struct GhGraphError {
    message: String,
}

#[derive(Debug, Deserialize)]
struct GhAuthor {
    login: String,
}

/// A comment as REST lists it. Inline ones carry two sets of lines: where they
/// sit on the PR's head now, `null` once those lines have changed, and where
/// they were made.
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
    start_line: Option<u32>,
    #[serde(default)]
    original_line: Option<u32>,
    #[serde(default)]
    original_start_line: Option<u32>,
}

/// A page of a PR's review threads, as GraphQL reads them.
#[derive(Debug, Deserialize)]
struct GhThreadsResponse {
    data: Option<GhThreadsData>,
    #[serde(default)]
    errors: Vec<GhGraphError>,
}

#[derive(Debug, Deserialize)]
struct GhThreadsData {
    repository: Option<GhThreadsRepository>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhThreadsRepository {
    pull_request: Option<GhThreadsPr>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhThreadsPr {
    review_threads: GhNodes<GhThread>,
}

#[derive(Debug, Deserialize)]
struct GhNodes<T> {
    nodes: Vec<T>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhThread {
    id: String,
    is_resolved: bool,
    is_outdated: bool,
    /// `null` while it is open, and for an account since deleted.
    resolved_by: Option<GhAuthor>,
    comments: GhNodes<GhThreadComment>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhThreadComment {
    /// The id REST knows the comment by; GraphQL can leave it `null`.
    database_id: Option<u64>,
}

impl From<GhThread> for PrThread {
    fn from(thread: GhThread) -> Self {
        Self {
            id: thread.id,
            resolved: thread.is_resolved,
            resolved_by: thread.resolved_by.map(|author| author.login),
            outdated: thread.is_outdated,
            comment_ids: thread
                .comments
                .nodes
                .into_iter()
                .filter_map(|comment| comment.database_id)
                .collect(),
        }
    }
}

/// What resolving or reopening a thread answers with.
#[derive(Debug, Deserialize)]
struct GhThreadChangeResponse {
    data: Option<GhThreadChangeData>,
    #[serde(default)]
    errors: Vec<GhGraphError>,
}

#[derive(Debug, Deserialize)]
struct GhThreadChangeData {
    change: Option<GhThreadChange>,
}

#[derive(Debug, Deserialize)]
struct GhThreadChange {
    thread: GhThread,
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
/// enough metadata for both the review panel and later comment posting. `keep`
/// is every other PR open in a tab, whose refs must survive the fetch.
pub fn open_pr(root: &Path, url: &str, keep: &[u64]) -> Result<PrContext, GitError> {
    let reference = parse_pr_ref(url)?;
    let pr = read_pr(&reference)?;
    let base_remote = find_remote(root, &reference)?;
    let (compare_ref, head_sha) = git::fetch_pr_head(
        root,
        &base_remote,
        reference.number,
        &pr.base_ref_name,
        keep,
    )?;
    let (comments, threads) = read_discussion(&reference)?;
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
        head_ref: pr.head_ref_name,
        head_sha,
        compare_ref,
        comments,
        threads,
    })
}

/// How many pull requests a page of a list holds: GitHub's most per request.
/// The list asks for the next page as it is scrolled to the end.
const PR_PAGE_SIZE: u32 = 100;

const PR_FIELDS: &str = "number title url isDraft createdAt updatedAt additions deletions \
    changedFiles reviewDecision headRefName baseRefName headRefOid isCrossRepository \
    author { login } labels(first: 20) { nodes { name color } }";

/// One page of a pull-request list, most recently updated first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrPage {
    pub prs: Vec<PrSummary>,
    /// How many the whole list holds, across every page.
    pub total: u64,
    /// Where the next page starts, to pass back as `after`; `None` on the last.
    pub next: Option<String>,
}

/// One page of the open pull requests on the repository this checkout's
/// remotes point at, most recently updated first, from `after` (a page's
/// `next`) or the start.
///
/// "All open" reads the repository's own list, which is exact and current.
/// The signed-in user's lists go through search, as `gh pr list --search` and
/// `--author` do; `@me` there is whoever `gh` is signed in as.
///
/// Listing is a convenience, not the way in: a repository with no GitHub remote,
/// a missing `gh`, or an expired login all report as an error the list shows
/// in its place, and pasting a URL keeps working regardless.
pub fn list_prs(
    root: &Path,
    filter: PrListFilter,
    after: Option<&str>,
) -> Result<PrPage, GitError> {
    let (host, owner, name) = github_remote(root)?.ok_or_else(|| {
        GitError::Command("This repository has no GitHub remote to list pull requests from.".into())
    })?;
    let page = format!("first: {PR_PAGE_SIZE}, after: $after");
    let mut args: Vec<String> = ["api", "graphql", "--hostname", &host]
        .map(String::from)
        .into();
    let query = match filter {
        PrListFilter::All => {
            args.extend([
                "-f".into(),
                format!("owner={owner}"),
                "-f".into(),
                format!("name={name}"),
            ]);
            format!(
                "query($owner: String!, $name: String!, $after: String) {{ \
                 repository(owner: $owner, name: $name) {{ \
                 pullRequests(states: OPEN, {page}, orderBy: {{ field: UPDATED_AT, direction: DESC }}) {{ \
                 totalCount pageInfo {{ hasNextPage endCursor }} nodes {{ {PR_FIELDS} }} }} }} }}"
            )
        }
        PrListFilter::ReviewRequested | PrListFilter::Mine => {
            let whose = if filter == PrListFilter::Mine {
                "author:@me"
            } else {
                "review-requested:@me"
            };
            let search = format!("repo:{owner}/{name} is:pr is:open sort:updated-desc {whose}");
            args.extend(["-f".into(), format!("q={search}")]);
            format!(
                "query($q: String!, $after: String) {{ \
                 search(query: $q, type: ISSUE, {page}) {{ \
                 issueCount pageInfo {{ hasNextPage endCursor }} \
                 nodes {{ ... on PullRequest {{ {PR_FIELDS} }} }} }} }}"
            )
        }
    };
    args.extend(["-f".into(), format!("query={query}")]);
    if let Some(after) = after {
        args.extend(["-f".into(), format!("after={after}")]);
    }
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    parse_pr_page(&run_gh(&borrowed)?)
}

fn parse_pr_page(raw: &[u8]) -> Result<PrPage, GitError> {
    let unreadable = |error: serde_json::Error| {
        GitError::Command(format!("Could not read pull requests from gh: {error}"))
    };
    let response: GhListResponse = serde_json::from_slice(raw).map_err(unreadable)?;
    if let Some(error) = response.errors.first() {
        return Err(GitError::Command(format!("GitHub said: {}", error.message)));
    }
    let data = response
        .data
        .ok_or_else(|| GitError::Command("gh returned no pull requests.".into()))?;
    let connection = data
        .repository
        .map(|repository| repository.pull_requests)
        .or(data.search)
        .ok_or_else(|| GitError::Command("gh returned no pull requests.".into()))?;
    let prs = connection
        .nodes
        .into_iter()
        // Anything that isn't a pull request has none of its fields.
        .filter_map(|node| serde_json::from_value::<GhPrSummary>(node).ok())
        .map(|pr| PrSummary {
            number: pr.number,
            title: pr.title,
            author: pr
                .author
                .map_or_else(|| "ghost".into(), |author| author.login),
            is_draft: pr.is_draft,
            url: pr.url,
            labels: pr.labels.nodes,
            head_ref: pr.head_ref_name,
            base_ref: pr.base_ref_name,
            is_cross_repository: pr.is_cross_repository,
            head_sha: pr.head_ref_oid,
            created_at: pr.created_at,
            updated_at: pr.updated_at,
            additions: pr.additions,
            deletions: pr.deletions,
            changed_files: pr.changed_files,
            review_decision: pr.review_decision.filter(|decision| !decision.is_empty()),
        })
        .collect::<Vec<_>>();
    Ok(PrPage {
        total: connection
            .total_count
            .or(connection.issue_count)
            .unwrap_or(prs.len() as u64),
        next: connection
            .page_info
            .has_next_page
            .then_some(connection.page_info.end_cursor)
            .flatten(),
        prs,
    })
}

/// The GitHub repository this checkout's remotes point at, as `(host, owner,
/// repo)`. Remotes are searched in `gh`'s own order of preference — `upstream`
/// before `origin` — so a fork finds the repository it was forked from, which
/// is where its pull requests live.
fn github_remote(root: &Path) -> Result<Option<(String, String, String)>, GitError> {
    let remotes = git::remote_urls(root)?;
    let named = |wanted: &str| {
        remotes
            .iter()
            .find(|(name, _)| name == wanted)
            .and_then(|(_, url)| remote_repo(url))
    };
    Ok(named("upstream")
        .or_else(|| named("origin"))
        .or_else(|| remotes.iter().find_map(|(_, url)| remote_repo(url))))
}

/// Who `gh` is signed in as on this checkout's GitHub host: the account its
/// lists, posts and reviews go out as. Read from `gh`'s own config rather than
/// asked of GitHub, so it is instant and works offline, and follows `gh auth
/// switch`. `None` with no GitHub remote, no `gh`, or no login on that host.
pub fn signed_in_login(root: &Path) -> Option<String> {
    let (host, _, _) = github_remote(root).ok()??;
    let raw = run_gh(&["config", "get", "--host", &host, "user"]).ok()?;
    let login = String::from_utf8_lossy(&raw).trim().to_owned();
    (!login.is_empty()).then_some(login)
}

pub fn refresh_pr(
    root: &Path,
    previous: &PrContext,
    keep: &[u64],
) -> Result<RefreshPrResult, GitError> {
    let pr = open_pr(root, &previous.url, keep)?;
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
        "url,number,title,body,author,state,isDraft,baseRefName,headRefName,headRefOid",
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
///
/// An inline comment with an `end_line` spans `line` through `end_line`, the
/// way a multi-line selection does on GitHub; the caller has checked that both
/// ends fall in one hunk of the patch, which GitHub requires.
pub fn post_pr_comment(
    root: &Path,
    pr: &PrContext,
    body: &str,
    path: Option<&str>,
    line: Option<u32>,
    end_line: Option<u32>,
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
            insert_line_span(&mut fields, line, end_line);
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
        reference.host.clone(),
        "-X".to_owned(),
        "POST".to_owned(),
        "--input".to_owned(),
        "-".to_owned(),
        endpoint,
    ];
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    let raw = run_gh_with_input(&borrowed, &payload)
        .map_err(|error| explain_pending_review(error, &reference))?;
    let posted: GhPostedComment = serde_json::from_slice(&raw).map_err(|error| {
        GitError::Command(format!(
            "GitHub accepted the comment but returned unreadable JSON: {error}"
        ))
    })?;
    Ok(PostedPrComment {
        url: posted.html_url,
    })
}

/// Anchors an inline comment to the new side of the diff. GitHub's `line` is
/// where a comment ends; a span also names where it starts.
fn insert_line_span(
    fields: &mut serde_json::Map<String, serde_json::Value>,
    line: u32,
    end_line: Option<u32>,
) {
    let right = || serde_json::Value::String("RIGHT".into());
    match end_line {
        Some(end) if end > line => {
            fields.insert("start_line".into(), serde_json::Value::from(line));
            fields.insert("start_side".into(), right());
            fields.insert("line".into(), serde_json::Value::from(end));
        }
        _ => {
            fields.insert("line".into(), serde_json::Value::from(line));
        }
    }
    fields.insert("side".into(), right());
}

/// Submits a review of the PR: approve, comment, or request changes, with the
/// conclusion as its body. Anchored to the fetched head for the same reason as
/// `post_pr_comment`: an approval must not land on commits nobody reviewed.
pub fn submit_pr_review(
    pr: &PrContext,
    verdict: PrReviewVerdict,
    body: &str,
) -> Result<PostedPrComment, GitError> {
    // GitHub rejects these two without a body; say so before the round trip.
    if body.trim().is_empty() && verdict != PrReviewVerdict::Approve {
        return Err(GitError::Command(
            "A comment or a request for changes needs some text.".into(),
        ));
    }
    let reference = parse_pr_ref(&pr.url)?;
    let current = read_pr(&reference)?;
    if current.head_ref_oid != pr.head_sha {
        return Err(GitError::Command(
            "This pull request has new commits. Refresh it and review them before submitting."
                .into(),
        ));
    }

    let payload = serde_json::to_vec(&serde_json::json!({
        "commit_id": pr.head_sha,
        "event": verdict.event(),
        "body": body,
    }))
    .map_err(|error| {
        GitError::Command(format!("Could not encode the review for GitHub: {error}"))
    })?;
    let endpoint = format!(
        "repos/{}/{}/pulls/{}/reviews",
        reference.owner, reference.repo, reference.number
    );
    let raw = run_gh_with_input(
        &[
            "api",
            "--hostname",
            &reference.host,
            "-X",
            "POST",
            "--input",
            "-",
            &endpoint,
        ],
        &payload,
    )
    .map_err(|error| explain_pending_review(error, &reference))?;
    let posted: GhPostedComment = serde_json::from_slice(&raw).map_err(|error| {
        GitError::Command(format!(
            "GitHub accepted the review but returned unreadable JSON: {error}"
        ))
    })?;
    Ok(PostedPrComment {
        url: posted.html_url,
    })
}

/// GitHub allows one unsubmitted review per person per pull request, and an
/// inline comment or a new review each counts as one. A review started on
/// github.com and left pending blocks both, with an error that names neither
/// the review nor the way out.
fn explain_pending_review(error: GitError, reference: &PrRef) -> GitError {
    match error {
        GitError::Detailed { message, detail }
            if message.contains("one pending review per pull request") =>
        {
            GitError::detailed(
                format!(
                    "You have an unsubmitted review on this pull request, started on GitHub, and GitHub won't take more comments from you until it's submitted or discarded. Finish it at {}/files, then try again.",
                    pr_target(reference)
                ),
                detail,
            )
        }
        other => other,
    }
}

/// Everything said on the PR: its comments, top-level and inline, oldest first,
/// and the review threads the inline ones form. Three reads of GitHub, made at
/// once rather than one after another.
fn read_discussion(reference: &PrRef) -> Result<(Vec<PrComment>, Vec<PrThread>), GitError> {
    let (inline, top_level, threads) = std::thread::scope(|scope| {
        let inline = scope.spawn(|| read_comments(reference, "pulls"));
        let top_level = scope.spawn(|| read_comments(reference, "issues"));
        let threads = read_threads(reference);
        let joined = |read: std::thread::ScopedJoinHandle<'_, _>| {
            read.join().unwrap_or_else(|_| {
                Err(GitError::Command(
                    "Reading the pull request's comments stopped unexpectedly.".into(),
                ))
            })
        };
        (joined(inline), joined(top_level), threads)
    });
    let threads = threads?;
    let mut comments = inline?;
    for comment in &mut comments {
        // GitHub's own word on which threads are outdated, over the guess from
        // a comment's lines.
        if let Some(thread) = threads
            .iter()
            .find(|thread| thread.comment_ids.contains(&comment.id))
        {
            comment.outdated = thread.outdated;
        }
    }
    comments.extend(top_level?);
    comments.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
    Ok((comments, threads))
}

/// One kind of comment, every page of it: `pulls` for inline comments,
/// `issues` for top-level ones.
fn read_comments(reference: &PrRef, kind: &str) -> Result<Vec<PrComment>, GitError> {
    let endpoint = format!(
        "repos/{}/{}/{kind}/{}/comments",
        reference.owner, reference.repo, reference.number
    );
    parse_comments(&run_gh(&[
        "api",
        "--hostname",
        &reference.host,
        &endpoint,
        "--paginate",
        "--slurp",
    ])?)
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
        all.extend(page.into_iter().map(|comment| {
            // Once its lines change, a comment has no place on the head, and
            // is shown where it was made.
            let current = comment.line.is_some();
            PrComment {
                id: comment.id,
                author: comment.user.login,
                body: comment.body,
                created_at: comment.created_at,
                path: comment.path,
                line: comment.line.or(comment.original_line),
                start_line: if current {
                    comment.start_line
                } else {
                    comment.original_start_line
                },
                outdated: !current && comment.original_line.is_some(),
            }
        }));
        Ok(all)
    })
}

/// What a review thread is read as, by `read_threads` and by the mutations
/// that resolve and reopen one. A thread past its hundredth comment loses the
/// rest of their ids, never the first, which is the one a posted finding is.
const THREAD_FIELDS: &str =
    "id isResolved isOutdated resolvedBy { login } comments(first: 100) { nodes { databaseId } }";

/// The PR's review threads, every page of them.
fn read_threads(reference: &PrRef) -> Result<Vec<PrThread>, GitError> {
    let query = format!(
        "query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {{ \
         repository(owner: $owner, name: $name) {{ pullRequest(number: $number) {{ \
         reviewThreads(first: 100, after: $endCursor) {{ \
         pageInfo {{ hasNextPage endCursor }} nodes {{ {THREAD_FIELDS} }} }} }} }} }}"
    );
    let owner = format!("owner={}", reference.owner);
    let name = format!("name={}", reference.repo);
    let number = format!("number={}", reference.number);
    let query = format!("query={query}");
    parse_threads(&run_gh(&[
        "api",
        "graphql",
        "--hostname",
        &reference.host,
        "--paginate",
        "--slurp",
        "-f",
        &owner,
        "-f",
        &name,
        "-F",
        &number,
        "-f",
        &query,
    ])?)
}

fn parse_threads(raw: &[u8]) -> Result<Vec<PrThread>, GitError> {
    let unreadable = |error: serde_json::Error| {
        GitError::Command(format!(
            "Could not read the review threads from gh: {error}"
        ))
    };
    // `--slurp` makes an array of the pages; one page on its own is an object.
    let pages: Vec<GhThreadsResponse> = match serde_json::from_slice(raw).map_err(unreadable)? {
        serde_json::Value::Array(pages) => pages
            .into_iter()
            .map(serde_json::from_value)
            .collect::<Result<_, _>>()
            .map_err(unreadable)?,
        page => vec![serde_json::from_value(page).map_err(unreadable)?],
    };
    let mut threads = Vec::new();
    for page in pages {
        if let Some(error) = page.errors.first() {
            return Err(GitError::Command(format!("GitHub said: {}", error.message)));
        }
        let pr = page
            .data
            .and_then(|data| data.repository)
            .and_then(|repository| repository.pull_request)
            .ok_or_else(|| GitError::Command("gh returned no review threads.".into()))?;
        threads.extend(pr.review_threads.nodes.into_iter().map(PrThread::from));
    }
    Ok(threads)
}

/// Resolves a review thread on GitHub, or with `resolved: false` reopens one,
/// and answers with the thread as it then stands.
pub fn set_thread_resolved(
    pr: &PrContext,
    thread_id: &str,
    resolved: bool,
) -> Result<PrThread, GitError> {
    let reference = parse_pr_ref(&pr.url)?;
    let mutation = if resolved {
        "resolveReviewThread"
    } else {
        "unresolveReviewThread"
    };
    let query = format!(
        "query=mutation($id: ID!) {{ change: {mutation}(input: {{ threadId: $id }}) {{ \
         thread {{ {THREAD_FIELDS} }} }} }}"
    );
    let id = format!("id={thread_id}");
    let raw = run_gh(&[
        "api",
        "graphql",
        "--hostname",
        &reference.host,
        "-f",
        &id,
        "-f",
        &query,
    ])?;
    parse_thread_change(&raw)
}

fn parse_thread_change(raw: &[u8]) -> Result<PrThread, GitError> {
    let response: GhThreadChangeResponse = serde_json::from_slice(raw).map_err(|error| {
        GitError::Command(format!(
            "GitHub changed the thread but returned unreadable JSON: {error}"
        ))
    })?;
    if let Some(error) = response.errors.first() {
        return Err(GitError::Command(format!("GitHub said: {}", error.message)));
    }
    response
        .data
        .and_then(|data| data.change)
        .map(|change| change.thread.into())
        .ok_or_else(|| GitError::Command("GitHub returned no thread.".into()))
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
        return Ok(output.stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let mut message = if stderr.is_empty() {
        stdout.clone()
    } else {
        stderr.clone()
    };
    for reason in github_error_reasons(&stdout) {
        message.push('\n');
        message.push_str(&reason);
    }
    Err(GitError::detailed(
        message,
        format!(
            "gh {}\n{}\n\nstderr:\n{stderr}\n\nstdout:\n{stdout}",
            args.join(" "),
            output.status
        ),
    ))
}

/// The specific reasons in a GitHub API error body. `gh api` prints the body on
/// stdout and only a status line on stderr ("Validation Failed (HTTP 422)"), so
/// without these the message says a request failed but never why.
fn github_error_reasons(body: &str) -> Vec<String> {
    let Ok(body) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };
    let Some(errors) = body["errors"].as_array() else {
        return Vec::new();
    };
    errors
        .iter()
        .filter_map(|error| error.as_str().or_else(|| error["message"].as_str()))
        .map(str::to_owned)
        .collect()
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
    fn a_span_anchors_from_its_first_line_to_its_last_on_the_new_side() {
        let mut fields = serde_json::Map::new();
        insert_line_span(&mut fields, 12, Some(18));
        assert_eq!(
            serde_json::Value::Object(fields),
            serde_json::json!({"start_line": 12, "start_side": "RIGHT", "line": 18, "side": "RIGHT"})
        );

        // No span, or one that ends where it starts: a single line.
        for end_line in [None, Some(12)] {
            let mut fields = serde_json::Map::new();
            insert_line_span(&mut fields, 12, end_line);
            assert_eq!(
                serde_json::Value::Object(fields),
                serde_json::json!({"line": 12, "side": "RIGHT"})
            );
        }
    }

    #[test]
    fn review_verdicts_map_to_githubs_review_events() {
        let parse = |raw: &str| serde_json::from_str::<PrReviewVerdict>(raw).expect("verdict");
        assert_eq!(parse(r#""approve""#).event(), "APPROVE");
        assert_eq!(parse(r#""comment""#).event(), "COMMENT");
        assert_eq!(parse(r#""request_changes""#).event(), "REQUEST_CHANGES");
    }

    /// Checked before any `gh` call, so this never reaches the network.
    #[test]
    fn only_an_approval_can_be_submitted_without_a_body() {
        let pr = PrContext {
            url: "https://github.com/acme/widgets/pull/7".into(),
            number: 7,
            title: "Avoid duplicate widgets".into(),
            body: String::new(),
            author: "octo".into(),
            state: "open".into(),
            is_draft: false,
            base_ref: "main".into(),
            base_remote: "origin".into(),
            head_ref: "avoid-duplicate-widgets".into(),
            head_sha: "abc123".into(),
            compare_ref: "tk-review/pr/7".into(),
            comments: Vec::new(),
            threads: Vec::new(),
        };
        for verdict in [PrReviewVerdict::Comment, PrReviewVerdict::RequestChanges] {
            let err = submit_pr_review(&pr, verdict, "  ").expect_err("needs a body");
            assert!(err.to_string().contains("needs some text"), "{err}");
        }
    }

    #[test]
    fn parses_a_page_of_the_repositorys_pull_requests() {
        let raw = br#"{"data":{"repository":{"pullRequests":{"totalCount":120,
            "pageInfo":{"hasNextPage":true,"endCursor":"abc"},
            "nodes":[
              {"number":2,"title":"New","author":{"login":"b"},"isDraft":true,"url":"u2",
               "headRefName":"two","baseRefName":"main","isCrossRepository":true,"headRefOid":"bbb",
               "createdAt":"2026-09-18T10:00:00Z","updatedAt":"2026-09-20T10:00:00Z",
               "additions":10,"deletions":0,"changedFiles":4,"reviewDecision":"APPROVED",
               "labels":{"nodes":[{"name":"bug","color":"d73a4a"}]}},
              {"number":1,"title":"Old","author":null,"isDraft":false,"url":"u1",
               "headRefName":"one","baseRefName":"main","isCrossRepository":false,"headRefOid":"aaa",
               "createdAt":"2026-09-01T09:00:00Z","updatedAt":"2026-09-01T10:00:00Z",
               "additions":3,"deletions":1,"changedFiles":1,"reviewDecision":null,
               "labels":{"nodes":[]}}
            ]}}}}"#;
        let page = parse_pr_page(raw).unwrap();
        assert_eq!(page.total, 120);
        assert_eq!(page.next.as_deref(), Some("abc"));
        let prs = &page.prs;
        assert_eq!(prs.iter().map(|pr| pr.number).collect::<Vec<_>>(), [2, 1]);
        assert_eq!(prs[0].review_decision.as_deref(), Some("APPROVED"));
        assert_eq!(prs[1].review_decision, None);
        assert_eq!(prs[0].head_ref, "two");
        assert!(prs[0].is_cross_repository);
        assert_eq!(
            prs[0].labels,
            [PrLabel {
                name: "bug".into(),
                color: "d73a4a".into()
            }]
        );
        assert_eq!(prs[0].changed_files, 4);
        // A deleted account shows as GitHub shows it.
        assert_eq!(prs[1].author, "ghost");
    }

    #[test]
    fn parses_the_last_page_of_a_search() {
        let raw = br#"{"data":{"search":{"issueCount":1,
            "pageInfo":{"hasNextPage":false,"endCursor":"zzz"},
            "nodes":[{},
              {"number":7,"title":"Mine","author":{"login":"me"},"isDraft":false,"url":"u7",
               "headRefName":"seven","baseRefName":"main","isCrossRepository":false,"headRefOid":"ccc",
               "createdAt":"2026-09-01T09:00:00Z","updatedAt":"2026-09-02T10:00:00Z",
               "additions":1,"deletions":1,"changedFiles":1,"reviewDecision":"REVIEW_REQUIRED",
               "labels":{"nodes":[]}}]}}}"#;
        let page = parse_pr_page(raw).unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.next, None);
        // The empty node is search turning up something that isn't a pull request.
        assert_eq!(page.prs.iter().map(|pr| pr.number).collect::<Vec<_>>(), [7]);
    }

    #[test]
    fn reports_graphql_errors() {
        let raw = br#"{"data":null,"errors":[{"message":"Could not resolve to a Repository"}]}"#;
        let err = parse_pr_page(raw).expect_err("an error");
        assert!(err.to_string().contains("Could not resolve"), "{err}");
    }

    #[test]
    fn reads_review_threads_across_every_page() {
        let raw = br#"[
          {"data":{"repository":{"pullRequest":{"reviewThreads":{
            "pageInfo":{"hasNextPage":true,"endCursor":"a"},
            "nodes":[{"id":"T1","isResolved":true,"isOutdated":false,"resolvedBy":{"login":"mona"},
                      "comments":{"nodes":[{"databaseId":11},{"databaseId":12}]}}]}}}}},
          {"data":{"repository":{"pullRequest":{"reviewThreads":{
            "pageInfo":{"hasNextPage":false,"endCursor":"b"},
            "nodes":[{"id":"T2","isResolved":false,"isOutdated":true,"resolvedBy":null,
                      "comments":{"nodes":[{"databaseId":21},{"databaseId":null}]}}]}}}}}
        ]"#;
        let threads = parse_threads(raw).expect("threads");
        assert_eq!(
            threads,
            [
                PrThread {
                    id: "T1".into(),
                    resolved: true,
                    resolved_by: Some("mona".into()),
                    outdated: false,
                    comment_ids: vec![11, 12],
                },
                // A comment GraphQL gives no id has nothing to match, so it is left out.
                PrThread {
                    id: "T2".into(),
                    resolved: false,
                    resolved_by: None,
                    outdated: true,
                    comment_ids: vec![21],
                },
            ]
        );
    }

    #[test]
    fn a_thread_read_reports_what_github_said() {
        let raw = br#"[{"data":null,"errors":[{"message":"Could not resolve to a PullRequest"}]}]"#;
        let err = parse_threads(raw).expect_err("an error");
        assert!(err.to_string().contains("Could not resolve"), "{err}");
    }

    #[test]
    fn reads_a_thread_back_from_resolving_it() {
        let raw = br#"{"data":{"change":{"thread":{"id":"T1","isResolved":true,"isOutdated":false,
            "resolvedBy":{"login":"me"},"comments":{"nodes":[{"databaseId":11}]}}}}}"#;
        let thread = parse_thread_change(raw).expect("thread");
        assert!(thread.resolved);
        assert_eq!(thread.resolved_by.as_deref(), Some("me"));

        let refused =
            br#"{"data":{"change":null},"errors":[{"message":"Resource not accessible"}]}"#;
        let err = parse_thread_change(refused).expect_err("refused");
        assert!(err.to_string().contains("Resource not accessible"), "{err}");
    }

    /// REST drops a comment's current lines once they change; it is shown
    /// where it was made instead.
    #[test]
    fn an_outdated_comment_keeps_the_lines_it_was_made_on() {
        let raw = br#"[[
          {"id":1,"body":"span","created_at":"t","user":{"login":"a"},"path":"a.ts",
           "line":18,"start_line":12,"original_line":9,"original_start_line":3},
          {"id":2,"body":"moved on","created_at":"t","user":{"login":"a"},"path":"a.ts",
           "line":null,"start_line":null,"original_line":40,"original_start_line":38},
          {"id":3,"body":"whole file","created_at":"t","user":{"login":"a"},"path":"a.ts",
           "line":null,"start_line":null,"original_line":null,"original_start_line":null}
        ]]"#;
        let comments = parse_comments(raw).expect("comments");
        let lines = |comment: &PrComment| (comment.start_line, comment.line, comment.outdated);
        assert_eq!(lines(&comments[0]), (Some(12), Some(18), false));
        assert_eq!(lines(&comments[1]), (Some(38), Some(40), true));
        assert_eq!(lines(&comments[2]), (None, None, false));
    }

    #[test]
    fn finds_the_thread_a_posted_comment_belongs_to() {
        assert_eq!(
            review_comment_id("https://github.com/acme/widgets/pull/7#discussion_r4168342556"),
            Some(4168342556)
        );
        assert_eq!(
            review_comment_id("https://github.com/acme/widgets/pull/7#issuecomment-99"),
            None
        );

        let thread = PrThread {
            id: "T1".into(),
            resolved: false,
            resolved_by: None,
            outdated: false,
            comment_ids: vec![5, 6],
        };
        let pr = PrContext {
            url: "https://github.com/acme/widgets/pull/7".into(),
            number: 7,
            title: String::new(),
            body: String::new(),
            author: "octo".into(),
            state: "open".into(),
            is_draft: false,
            base_ref: "main".into(),
            base_remote: "origin".into(),
            head_ref: "topic".into(),
            head_sha: "abc".into(),
            compare_ref: "tk-review/pr/7".into(),
            comments: Vec::new(),
            threads: vec![thread.clone()],
        };
        assert_eq!(
            pr.thread_for("https://github.com/acme/widgets/pull/7#discussion_r5"),
            Some(&thread)
        );
        assert_eq!(
            pr.thread_for("https://github.com/acme/widgets/pull/7#discussion_r9"),
            None
        );
    }

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

    /// Both shapes GitHub uses: objects for validation errors, bare strings
    /// for the rest.
    #[test]
    fn reads_the_reasons_out_of_a_github_error_body() {
        let validation = r#"{"message":"Validation Failed","errors":[{"resource":"PullRequestReviewComment","code":"custom","field":"pull_request_review_thread.line","message":"pull_request_review_thread.line must be part of the diff"}],"status":"422"}"#;
        let review = r#"{"message":"Unprocessable Entity","errors":["Review Can not approve your own pull request"]}"#;

        assert_eq!(
            github_error_reasons(validation),
            ["pull_request_review_thread.line must be part of the diff"]
        );
        assert_eq!(
            github_error_reasons(review),
            ["Review Can not approve your own pull request"]
        );
        assert!(github_error_reasons("not json").is_empty());
        assert!(github_error_reasons(r#"{"message":"Not Found"}"#).is_empty());
    }

    #[test]
    fn points_a_blocked_post_at_the_pending_review_behind_it() {
        let reference = parse_pr_ref("https://github.com/acme/widgets/pull/7").expect("PR URL");
        let blocked = GitError::detailed(
            "gh: Validation Failed (HTTP 422)\nuser_id can only have one pending review per pull request",
            "raw gh output",
        );

        let explained = explain_pending_review(blocked, &reference);
        assert!(explained
            .to_string()
            .contains("Finish it at https://github.com/acme/widgets/pull/7/files"));
        assert_eq!(explained.detail(), Some("raw gh output"));

        let other = GitError::detailed("gh: Not Found (HTTP 404)", "raw");
        assert_eq!(
            explain_pending_review(other, &reference).to_string(),
            "gh: Not Found (HTTP 404)"
        );
    }
}
