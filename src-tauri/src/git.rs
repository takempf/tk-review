//! Git access layer.
//!
//! Everything here shells out to the system `git` binary with argument slices —
//! never through a shell — so paths containing spaces, quotes, or globs need no
//! escaping and there is no injection surface. All output that can contain
//! pathnames is read as bytes and parsed NUL-delimited, because git pathnames
//! may contain newlines and are not guaranteed to be UTF-8.

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;

use crate::error::GitError;

/// Lines of unchanged context included around each hunk, matching git's default.
const CONTEXT_LINES: &str = "-U3";

/// The gitattribute GitHub uses to mark machine-written files.
const GENERATED_ATTR: &str = "linguist-generated";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Unmerged,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// Present for renames and copies.
    pub old_path: Option<String>,
    pub status: ChangeStatus,
    pub additions: u32,
    pub deletions: u32,
    pub is_binary: bool,
    /// Marked `linguist-generated` in the compare revision's gitattributes.
    pub is_generated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSummary {
    /// Commit the comparison is anchored to — the merge base of the two refs.
    pub merge_base: String,
    /// Commit the compare ref resolved to, or `None` for the working tree.
    ///
    /// The ref name is not enough to identify what is being shown: a branch or a
    /// PR head keeps its name across a push. The viewer caches rendered files and
    /// their contents, so it needs the commit to know when that cache is stale.
    pub compare_head: Option<String>,
    pub files: Vec<FileChange>,
    pub total_additions: u32,
    pub total_deletions: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub root: String,
    pub name: String,
    /// `None` when HEAD is detached.
    pub current_branch: Option<String>,
    pub default_branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub is_remote: bool,
    pub is_head: bool,
}

/// One commit of a comparison, as the commit list shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub sha: String,
    /// The first line of the message.
    pub subject: String,
    pub author: String,
    /// Committer date, ISO 8601: when the commit took its current form, which a
    /// rebase or an amend moves along with the commit itself.
    pub committed_at: String,
}

/// The commits a comparison is made of, newest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitLog {
    pub commits: Vec<Commit>,
    /// There were more than `MAX_COMMITS`, and only the newest are listed.
    pub truncated: bool,
}

/// A branch is a handful of commits; comparing two distant refs can be
/// thousands, which no sidebar list is worth paying for.
const MAX_COMMITS: usize = 250;

/// Full contents of both sides of a file. `None` means the file does not exist
/// on that side, which is normal for an addition or a deletion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVersions {
    pub old: Option<String>,
    pub new: Option<String>,
}

fn run_git(root: &Path, args: &[&str]) -> Result<Vec<u8>, GitError> {
    run_git_allowing(root, args, &[])
}

/// Runs git accepting the listed non-zero exit codes as success. `git diff
/// --no-index` exits 1 whenever the files differ, which for us is the expected
/// case rather than a failure.
fn run_git_allowing(root: &Path, args: &[&str], allowed: &[i32]) -> Result<Vec<u8>, GitError> {
    // A missing cwd makes `Command::output` fail with the same NotFound error as
    // a missing git binary, so rule it out first to keep the two distinct.
    if !root.is_dir() {
        return Err(GitError::NotARepo(root.display().to_string()));
    }

    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|err| match err.kind() {
            std::io::ErrorKind::NotFound => GitError::GitNotFound,
            _ => GitError::Command(err.to_string()),
        })?;

    let tolerated = output
        .status
        .code()
        .is_some_and(|code| allowed.contains(&code));
    if !output.status.success() && !tolerated {
        return Err(GitError::Command(
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ));
    }
    Ok(output.stdout)
}

/// Same as `run_git`, but feeds the command a body on stdin.
fn run_git_with_stdin(root: &Path, args: &[&str], input: &[u8]) -> Result<Vec<u8>, GitError> {
    if !root.is_dir() {
        return Err(GitError::NotARepo(root.display().to_string()));
    }

    let mut child = Command::new("git")
        .args(args)
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| match err.kind() {
            std::io::ErrorKind::NotFound => GitError::GitNotFound,
            _ => GitError::Command(err.to_string()),
        })?;

    // Taking the handle here also closes it at the end of this statement, which
    // is what tells git the input is finished.
    child
        .stdin
        .take()
        .ok_or_else(|| GitError::Command("could not open git stdin".into()))?
        .write_all(input)
        .map_err(|err| GitError::Command(err.to_string()))?;

    let output = child
        .wait_with_output()
        .map_err(|err| GitError::Command(err.to_string()))?;

    if !output.status.success() {
        return Err(GitError::Command(
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ));
    }
    Ok(output.stdout)
}

fn run_git_text(root: &Path, args: &[&str]) -> Result<String, GitError> {
    Ok(String::from_utf8_lossy(&run_git(root, args)?)
        .trim()
        .to_owned())
}

pub fn select_repo(path: &Path) -> Result<RepoInfo, GitError> {
    let root = match run_git_text(path, &["rev-parse", "--show-toplevel"]) {
        Ok(root) if !root.is_empty() => root,
        Err(GitError::GitNotFound) => return Err(GitError::GitNotFound),
        _ => return Err(GitError::NotARepo(path.display().to_string())),
    };

    let root_path = PathBuf::from(&root);
    let name = root_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.clone());

    Ok(RepoInfo {
        root,
        name,
        // Fails on a detached HEAD, which is a valid state to review from.
        current_branch: run_git_text(&root_path, &["symbolic-ref", "--short", "HEAD"]).ok(),
        default_branch: detect_default_branch(&root_path),
    })
}

/// Best-effort guess at the branch a PR would target.
fn detect_default_branch(root: &Path) -> Option<String> {
    if let Ok(remote_head) = run_git_text(
        root,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    ) {
        if let Some(short) = remote_head.strip_prefix("origin/") {
            // Prefer the local branch when it exists so the default selection is
            // something the user can also check out.
            if local_branch_exists(root, short) {
                return Some(short.to_owned());
            }
            return Some(remote_head);
        }
    }

    ["main", "master", "trunk", "develop"]
        .into_iter()
        .find(|candidate| local_branch_exists(root, candidate))
        .map(str::to_owned)
}

fn local_branch_exists(root: &Path, name: &str) -> bool {
    run_git(
        root,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{name}"),
        ],
    )
    .is_ok()
}

/// Fetches every remote, pruning refs that no longer exist there, so newly
/// pushed branches show up in `list_branches`. A repository with no remotes
/// fetches nothing and succeeds.
pub fn fetch_remotes(root: &Path) -> Result<(), GitError> {
    run_git(root, &["fetch", "--all", "--prune"]).map(|_| ())
}

/// The fetch URLs for every configured remote. GitHub PR URLs identify a
/// repository rather than a local remote name, so callers match against these
/// instead of assuming the remote is called `origin`.
pub fn remote_urls(root: &Path) -> Result<Vec<(String, String)>, GitError> {
    let names = run_git_text(root, &["remote"])?;
    names
        .lines()
        .map(|name| {
            run_git_text(root, &["remote", "get-url", name]).map(|url| (name.to_owned(), url))
        })
        .collect()
}

/// Held across pruning and fetching PR refs. Two tabs opening at once would
/// otherwise race: PRs that share a base both update its remote-tracking ref,
/// and git refuses the second with `cannot lock ref`, while one tab's prune can
/// delete the ref another has just fetched. One lock for every repository,
/// since a fetch is a network round trip either way and opening is rare.
static PR_REFS: Mutex<()> = Mutex::new(());

/// Fetch a PR's immutable-on-purpose local review ref and its base branch.
/// The `pull/N/head` ref belongs to the base repository, including for fork
/// PRs, which avoids needing to add an untrusted fork as a remote.
///
/// `keep` names the other PRs whose refs are still in use — those open in
/// tabs — so fetching this one doesn't pull their diffs out from under them.
pub fn fetch_pr_head(
    root: &Path,
    remote: &str,
    number: u64,
    base_ref: &str,
    keep: &[u64],
) -> Result<(String, String), GitError> {
    // A poisoned lock only means another fetch panicked; the refs are still git's.
    let _refs = PR_REFS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut kept: HashSet<u64> = keep.iter().copied().collect();
    kept.insert(number);
    prune_pr_refs(root, &kept)?;
    let compare_ref = format!("refs/tk-review/pr/{number}");
    let pull_refspec = format!("+pull/{number}/head:{compare_ref}");
    let base_refspec = format!("+refs/heads/{base_ref}:refs/remotes/{remote}/{base_ref}");
    run_git(root, &["fetch", remote, &pull_refspec, &base_refspec])?;
    let head_sha = run_git_text(
        root,
        &[
            "rev-parse",
            "--verify",
            &format!("{compare_ref}^{{commit}}"),
        ],
    )?;
    if head_sha.is_empty() {
        return Err(GitError::Command(
            "GitHub did not return a pull-request head commit.".into(),
        ));
    }
    Ok((compare_ref.trim_start_matches("refs/").to_owned(), head_sha))
}

/// PR review refs are an app-owned cache, not user branches. Keep only the PRs
/// still open in a tab, so opening many unrelated PRs cannot accumulate refs.
fn prune_pr_refs(root: &Path, keep: &HashSet<u64>) -> Result<(), GitError> {
    let refs = run_git_text(
        root,
        &["for-each-ref", "--format=%(refname)", "refs/tk-review/pr"],
    )?;
    let kept = |reference: &str| {
        reference
            .strip_prefix("refs/tk-review/pr/")
            .and_then(|number| number.parse::<u64>().ok())
            .is_some_and(|number| keep.contains(&number))
    };
    for reference in refs.lines().filter(|reference| !kept(reference)) {
        run_git(root, &["update-ref", "-d", reference])?;
    }
    Ok(())
}

pub fn list_branches(root: &Path) -> Result<Vec<Branch>, GitError> {
    // `git check-ref-format` forbids spaces and control characters in ref names,
    // so a tab-delimited line format is unambiguous here.
    let raw = run_git_text(
        root,
        &[
            "for-each-ref",
            "--format=%(refname)\t%(refname:short)\t%(HEAD)\t%(committerdate:unix)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;

    let mut branches: Vec<(i64, Branch)> = raw
        .lines()
        .filter_map(|line| {
            let mut columns = line.split('\t');
            let refname = columns.next()?;
            let short = columns.next()?;
            // `origin/HEAD` is a symbolic alias for another branch, not something
            // to review against on its own.
            if short.ends_with("/HEAD") {
                return None;
            }
            let is_head = columns.next() == Some("*");
            // An unparseable date sorts to the bottom rather than dropping the ref.
            let committed = columns
                .next()
                .and_then(|date| date.parse().ok())
                .unwrap_or(0);
            Some((
                committed,
                Branch {
                    name: short.to_owned(),
                    is_remote: refname.starts_with("refs/remotes/"),
                    is_head,
                },
            ))
        })
        .collect();

    // Local branches first, then most recently committed to — the branch worth
    // reviewing is almost always one that just moved. Names break ties so the
    // order is stable when dates collide.
    branches.sort_by(|(a_date, a), (b_date, b)| {
        a.is_remote
            .cmp(&b.is_remote)
            .then_with(|| b_date.cmp(a_date))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(branches.into_iter().map(|(_, branch)| branch).collect())
}

/// Resolves a ref to a commit SHA, rejecting anything git cannot name.
fn resolve_rev(root: &Path, rev: &str) -> Result<String, GitError> {
    let sha = run_git_text(
        root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{rev}^{{commit}}"),
        ],
    )
    .map_err(|_| GitError::BadRevision(rev.to_owned()))?;

    if sha.is_empty() {
        return Err(GitError::BadRevision(rev.to_owned()));
    }
    Ok(sha)
}

/// Compares `base` to `compare`, or — when `compare` is `None` — to the working
/// tree, which folds staged, unstaged, and untracked changes into the review.
pub fn diff_branches(
    root: &Path,
    base: &str,
    compare: Option<&str>,
) -> Result<DiffSummary, GitError> {
    // Validate both refs up front so a typo reports as a bad revision rather
    // than as an opaque failure from the diff itself.
    resolve_rev(root, base)?;
    let compare_head = match compare {
        Some(compare) => Some(resolve_rev(root, compare)?),
        None => None,
    };

    // Anchor on the merge base, which is what a PR shows: changes made on
    // `compare` since it diverged, excluding commits `base` gained meanwhile.
    // Computing it explicitly (rather than using `base...compare`) keeps the diff
    // and the file contents fetched later pinned to the same commit, and leaves
    // room to fall back when the histories are unrelated. The working tree
    // extends whatever HEAD is, so that is its divergence point.
    let merge_base = match run_git_text(root, &["merge-base", base, compare.unwrap_or("HEAD")]) {
        Ok(found) if !found.is_empty() => found,
        _ => resolve_rev(root, base)?,
    };
    // With no second revision, git diffs the first one against the working tree.
    let range = match compare {
        Some(compare) => format!("{merge_base}..{compare}"),
        None => merge_base.clone(),
    };

    let numstat = parse_numstat(&run_git(
        root,
        &["diff", "--numstat", "--find-renames", "-z", &range],
    )?);
    let statuses = parse_name_status(&run_git(
        root,
        &["diff", "--name-status", "--find-renames", "-z", &range],
    )?);

    let mut status_by_path: HashMap<String, (ChangeStatus, Option<String>)> = statuses
        .into_iter()
        .map(|entry| (entry.path, (entry.status, entry.old_path)))
        .collect();

    let mut files = Vec::with_capacity(numstat.len());
    let mut total_additions = 0u32;
    let mut total_deletions = 0u32;

    for entry in numstat {
        // Both commands describe the same diff, so a miss here means git's two
        // outputs disagreed; infer from the numstat shape instead of dropping it.
        let (status, old_path) = status_by_path.remove(&entry.path).unwrap_or_else(|| {
            let inferred = if entry.old_path.is_some() {
                ChangeStatus::Renamed
            } else {
                ChangeStatus::Modified
            };
            (inferred, entry.old_path.clone())
        });

        total_additions = total_additions.saturating_add(entry.additions);
        total_deletions = total_deletions.saturating_add(entry.deletions);

        files.push(FileChange {
            path: entry.path,
            old_path: old_path.or(entry.old_path),
            status,
            additions: entry.additions,
            deletions: entry.deletions,
            is_binary: entry.is_binary,
            is_generated: false,
        });
    }

    // The one-revision diff above only covers tracked files; untracked files are
    // uncommitted changes too, so list them separately and report them as
    // additions.
    if compare.is_none() {
        for path in untracked_files(root)? {
            let (additions, is_binary) = measure_worktree_file(root, &path);
            total_additions = total_additions.saturating_add(additions);
            files.push(FileChange {
                path,
                old_path: None,
                status: ChangeStatus::Added,
                additions,
                deletions: 0,
                is_binary,
                is_generated: false,
            });
        }
    }

    let paths: Vec<String> = files.iter().map(|file| file.path.clone()).collect();
    let generated = generated_paths(root, compare, &paths);
    for file in &mut files {
        file.is_generated = generated.contains(&file.path);
    }

    Ok(DiffSummary {
        merge_base,
        compare_head,
        files,
        total_additions,
        total_deletions,
    })
}

/// Which of `paths` are marked `linguist-generated` at `rev`, or in the working
/// tree's gitattributes when the review targets the working tree.
///
/// One batched `check-attr` for the whole review rather than one per file. A
/// failure here only costs the generated markers, so it degrades to "none" rather
/// than failing the diff.
fn generated_paths(root: &Path, rev: Option<&str>, paths: &[String]) -> HashSet<String> {
    if paths.is_empty() {
        return HashSet::new();
    }

    let mut input = Vec::new();
    for path in paths {
        input.extend_from_slice(path.as_bytes());
        input.push(0);
    }

    // Read the attributes as they exist on the revision under review rather than
    // from whatever is checked out. `--source` needs git 2.40, so fall back to
    // the working tree's gitattributes on older versions. For a working-tree
    // review the checked-out gitattributes are exactly the right source.
    let raw = match rev {
        Some(rev) => {
            let source = format!("--source={rev}");
            run_git_with_stdin(
                root,
                &["check-attr", "--stdin", "-z", &source, GENERATED_ATTR],
                &input,
            )
            .or_else(|_| {
                run_git_with_stdin(
                    root,
                    &["check-attr", "--stdin", "-z", GENERATED_ATTR],
                    &input,
                )
            })
        }
        None => run_git_with_stdin(
            root,
            &["check-attr", "--stdin", "-z", GENERATED_ATTR],
            &input,
        ),
    };

    match raw {
        Ok(raw) => parse_check_attr(&raw),
        Err(_) => HashSet::new(),
    }
}

/// Untracked files, respecting the usual exclude rules. Sorted, NUL-delimited.
fn untracked_files(root: &Path) -> Result<Vec<String>, GitError> {
    let raw = run_git(root, &["ls-files", "--others", "--exclude-standard", "-z"])?;
    Ok(raw
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .map(lossy)
        .collect())
}

/// Line count and binary-ness of a file on disk, the way git would report a new
/// file: binary when a NUL appears in the first 8000 bytes, additions equal to
/// the line count otherwise. A file that vanishes mid-scan degrades to empty
/// rather than failing the diff.
fn measure_worktree_file(root: &Path, path: &str) -> (u32, bool) {
    let Ok(bytes) = std::fs::read(root.join(path)) else {
        return (0, false);
    };
    if bytes.iter().take(8000).any(|byte| *byte == 0) {
        return (0, true);
    }
    let mut lines = bytes.iter().filter(|byte| **byte == b'\n').count() as u32;
    // A final line without a trailing newline still counts.
    if bytes.last().is_some_and(|byte| *byte != b'\n') {
        lines += 1;
    }
    (lines, false)
}

/// Parses `git check-attr -z`: NUL-separated triplets of path, attribute, value.
fn parse_check_attr(raw: &[u8]) -> HashSet<String> {
    let fields: Vec<&[u8]> = raw.split(|byte| *byte == 0).collect();
    let mut generated = HashSet::new();

    for chunk in fields.chunks(3) {
        let (Some(path), Some(value)) = (chunk.first(), chunk.get(2)) else {
            continue;
        };
        // `true` comes from `linguist-generated=true`, `set` from the bare
        // attribute. `false` and `unspecified` are both "not generated".
        if *value == b"true".as_slice() || *value == b"set".as_slice() {
            generated.insert(lossy(path));
        }
    }
    generated
}

/// The unified diff for the whole range, in one call.
///
/// The renderer parses this into per-file diffs itself, so a review needs a
/// single git invocation rather than two `git show`s per file. Full file contents
/// are fetched separately by `get_file_versions`, and only when the reader
/// expands context beyond what the patch carries.
pub fn get_patch(root: &Path, merge_base: &str, compare: Option<&str>) -> Result<String, GitError> {
    // As in `diff_branches`: one revision means "against the working tree".
    let range = match compare {
        Some(compare) => format!("{merge_base}..{compare}"),
        None => merge_base.to_owned(),
    };
    let raw = run_git(
        root,
        &[
            "diff",
            "--find-renames",
            // A user's configured external difftool or colour output would both
            // corrupt the patch the renderer has to parse.
            "--no-ext-diff",
            "--no-color",
            CONTEXT_LINES,
            &range,
        ],
    )?;
    let mut patch = String::from_utf8_lossy(&raw).into_owned();

    // Untracked files never appear in a revision diff, so each contributes its
    // own new-file patch. `--no-index` against /dev/null produces exactly the
    // header shape the renderer parses, and exits 1 to say the sides differ.
    // Binary files are skipped: the summary already marks them and the diff
    // surface has no text to render for them.
    if compare.is_none() {
        for path in untracked_files(root)? {
            let (_, is_binary) = measure_worktree_file(root, &path);
            if is_binary {
                continue;
            }
            let raw = run_git_allowing(
                root,
                &[
                    "diff",
                    "--no-ext-diff",
                    "--no-color",
                    CONTEXT_LINES,
                    "--no-index",
                    "--",
                    "/dev/null",
                    &path,
                ],
                &[1],
            )?;
            patch.push_str(&String::from_utf8_lossy(&raw));
        }
    }
    Ok(patch)
}

/// The commits on `compare` since `merge_base`, newest first — or, when
/// `compare` is `None`, the ones the working tree sits on top of.
pub fn list_commits(
    root: &Path,
    merge_base: &str,
    compare: Option<&str>,
) -> Result<CommitLog, GitError> {
    let range = format!("{merge_base}..{}", compare.unwrap_or("HEAD"));
    // One past the cap, to tell a log that ends there from one that goes on.
    let limit = format!("--max-count={}", MAX_COMMITS + 1);
    // NUL between fields and, with `-z`, between commits: neither can appear in
    // a subject or a name.
    let raw = run_git(
        root,
        &[
            "log",
            "-z",
            "--no-show-signature",
            "--format=%H%x00%an%x00%cI%x00%s",
            &limit,
            &range,
        ],
    )?;
    let mut commits = parse_log(&raw);
    let truncated = commits.len() > MAX_COMMITS;
    commits.truncate(MAX_COMMITS);
    Ok(CommitLog { commits, truncated })
}

fn parse_log(raw: &[u8]) -> Vec<Commit> {
    let fields: Vec<&[u8]> = raw.split(|&byte| byte == 0).collect();
    // The log ends on a NUL, leaving one empty field that `chunks_exact` drops.
    fields
        .chunks_exact(4)
        .map(|chunk| Commit {
            sha: lossy(chunk[0]),
            author: lossy(chunk[1]),
            committed_at: lossy(chunk[2]),
            subject: lossy(chunk[3]),
        })
        .collect()
}

/// The unified diff for a single file of the comparison, for prompts that
/// discuss one finding and don't need the whole patch.
pub fn get_file_patch(
    root: &Path,
    merge_base: &str,
    compare: Option<&str>,
    path: &str,
) -> Result<String, GitError> {
    let range = match compare {
        Some(compare) => format!("{merge_base}..{compare}"),
        None => merge_base.to_owned(),
    };
    let raw = run_git(
        root,
        &[
            "diff",
            "--find-renames",
            "--no-ext-diff",
            "--no-color",
            CONTEXT_LINES,
            &range,
            "--",
            path,
        ],
    )?;
    if !raw.is_empty() || compare.is_some() {
        return Ok(String::from_utf8_lossy(&raw).into_owned());
    }

    // Empty on a working-tree review usually means the file is untracked, which
    // a revision diff can't see — same fallback `get_patch` uses.
    let raw = run_git_allowing(
        root,
        &[
            "diff",
            "--no-ext-diff",
            "--no-color",
            CONTEXT_LINES,
            "--no-index",
            "--",
            "/dev/null",
            path,
        ],
        &[1],
    )?;
    Ok(String::from_utf8_lossy(&raw).into_owned())
}

pub fn get_file_versions(
    root: &Path,
    merge_base: &str,
    compare: Option<&str>,
    path: &str,
    old_path: Option<&str>,
) -> Result<FileVersions, GitError> {
    let new = match compare {
        Some(compare) => show_file(root, compare, path)?,
        // A working-tree review reads the new side straight from disk. A missing
        // file mirrors what `show_file` reports for a deletion.
        None => std::fs::read(root.join(path))
            .ok()
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned()),
    };
    Ok(FileVersions {
        // For a rename, the old side lives under its previous name.
        old: show_file(root, merge_base, old_path.unwrap_or(path))?,
        new,
    })
}

fn show_file(root: &Path, rev: &str, path: &str) -> Result<Option<String>, GitError> {
    match run_git(root, &["show", &format!("{rev}:{path}")]) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        // A path absent on one side is expected for additions and deletions.
        // Anything else is a real failure and shouldn't masquerade as an empty
        // side, which would silently render a one-sided diff.
        Err(GitError::Command(message))
            if message.contains("does not exist") || message.contains("exists on disk") =>
        {
            Ok(None)
        }
        Err(other) => Err(other),
    }
}

#[derive(Debug, PartialEq, Eq)]
struct NumstatEntry {
    path: String,
    old_path: Option<String>,
    additions: u32,
    deletions: u32,
    is_binary: bool,
}

/// Parses `git diff --numstat -z`.
///
/// Records are NUL-terminated and take one of three shapes:
/// - `12\t3\tpath\0`                  — ordinary change
/// - `12\t3\t\0oldpath\0newpath\0`    — rename or copy: the in-record path is
///   empty and the two names follow as their own NUL-delimited fields
/// - `-\t-\tpath\0`                   — binary file, no line counts
#[allow(clippy::while_let_on_iterator)]
fn parse_numstat(raw: &[u8]) -> Vec<NumstatEntry> {
    let mut fields = raw.split(|byte: &u8| *byte == 0);
    let mut entries = Vec::new();

    while let Some(record) = fields.next() {
        // The split leaves a trailing empty field after the final NUL.
        if record.is_empty() {
            continue;
        }

        let mut columns = record.splitn(3, |byte: &u8| *byte == b'\t');
        let (Some(additions), Some(deletions), Some(path_column)) =
            (columns.next(), columns.next(), columns.next())
        else {
            continue;
        };

        let is_binary = additions == b"-" || deletions == b"-";
        let (old_path, path) = if path_column.is_empty() {
            // Rename form: consume the two path fields that follow. Either being
            // empty means the output was cut short — the trailing field after the
            // final NUL is empty, so accepting it would invent a pathless entry.
            let (Some(old), Some(new)) = (fields.next(), fields.next()) else {
                break;
            };
            if old.is_empty() || new.is_empty() {
                break;
            }
            (Some(lossy(old)), lossy(new))
        } else {
            (None, lossy(path_column))
        };

        entries.push(NumstatEntry {
            path,
            old_path,
            additions: if is_binary { 0 } else { parse_count(additions) },
            deletions: if is_binary { 0 } else { parse_count(deletions) },
            is_binary,
        });
    }

    entries
}

#[derive(Debug, PartialEq, Eq)]
struct StatusEntry {
    path: String,
    old_path: Option<String>,
    status: ChangeStatus,
}

/// Parses `git diff --name-status -z`.
///
/// Each entry is a status field followed by one path, except renames and copies
/// (`R100`, `C75`), which carry a similarity score and two paths.
#[allow(clippy::while_let_on_iterator)]
fn parse_name_status(raw: &[u8]) -> Vec<StatusEntry> {
    let mut fields = raw.split(|byte: &u8| *byte == 0);
    let mut entries = Vec::new();

    while let Some(code) = fields.next() {
        let Some(&letter) = code.first() else {
            continue;
        };
        let Some(first_path) = fields.next() else {
            break;
        };
        // Guards against truncated output, where the trailing empty field would
        // otherwise be accepted as a pathname.
        if first_path.is_empty() {
            break;
        }

        let entry = match letter {
            b'R' | b'C' => {
                let Some(second_path) = fields.next() else {
                    break;
                };
                if second_path.is_empty() {
                    break;
                }
                StatusEntry {
                    status: if letter == b'R' {
                        ChangeStatus::Renamed
                    } else {
                        ChangeStatus::Copied
                    },
                    old_path: Some(lossy(first_path)),
                    path: lossy(second_path),
                }
            }
            _ => StatusEntry {
                status: status_from_letter(letter),
                old_path: None,
                path: lossy(first_path),
            },
        };
        entries.push(entry);
    }

    entries
}

fn status_from_letter(letter: u8) -> ChangeStatus {
    match letter {
        b'A' => ChangeStatus::Added,
        b'M' => ChangeStatus::Modified,
        b'D' => ChangeStatus::Deleted,
        b'T' => ChangeStatus::TypeChanged,
        b'U' => ChangeStatus::Unmerged,
        _ => ChangeStatus::Unknown,
    }
}

/// Pathnames are not guaranteed to be UTF-8; keep rendering rather than failing.
fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn parse_count(bytes: &[u8]) -> u32 {
    std::str::from_utf8(bytes)
        .ok()
        .and_then(|text| text.parse().ok())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- Unit tests over the wire formats ------------------------------------

    #[test]
    fn parses_ordinary_and_binary_numstat_records() {
        let raw = b"12\t3\tsrc/main.rs\0-\t-\tlogo.png\0";
        let entries = parse_numstat(raw);

        assert_eq!(entries.len(), 2);
        assert_eq!(
            entries[0],
            NumstatEntry {
                path: "src/main.rs".into(),
                old_path: None,
                additions: 12,
                deletions: 3,
                is_binary: false,
            }
        );
        // Binary files report `-` rather than counts, which must not become garbage.
        assert_eq!(
            entries[1],
            NumstatEntry {
                path: "logo.png".into(),
                old_path: None,
                additions: 0,
                deletions: 0,
                is_binary: true,
            }
        );
    }

    #[test]
    fn parses_renamed_numstat_record() {
        let raw = b"4\t2\t\0old/name.ts\0new/name.ts\0";
        assert_eq!(
            parse_numstat(raw),
            vec![NumstatEntry {
                path: "new/name.ts".into(),
                old_path: Some("old/name.ts".into()),
                additions: 4,
                deletions: 2,
                is_binary: false,
            }]
        );
    }

    #[test]
    fn parses_paths_containing_whitespace_and_newlines() {
        // NUL-delimited parsing is the whole reason these survive. The separators
        // are spelled `\x00` because a following digit would otherwise read as an
        // octal escape.
        let raw = b"1\t0\tdir with spaces/a b.txt\x002\t0\tweird\nname.txt\x00";
        let entries = parse_numstat(raw);

        assert_eq!(entries[0].path, "dir with spaces/a b.txt");
        assert_eq!(entries[1].path, "weird\nname.txt");
    }

    #[test]
    fn parses_name_status_including_renames_and_copies() {
        let raw = b"A\0added.txt\0M\0changed.txt\0D\0gone.txt\0R100\0from.txt\0to.txt\0C75\0src.txt\0copy.txt\0";
        let entries = parse_name_status(raw);

        assert_eq!(
            entries,
            vec![
                StatusEntry {
                    path: "added.txt".into(),
                    old_path: None,
                    status: ChangeStatus::Added
                },
                StatusEntry {
                    path: "changed.txt".into(),
                    old_path: None,
                    status: ChangeStatus::Modified
                },
                StatusEntry {
                    path: "gone.txt".into(),
                    old_path: None,
                    status: ChangeStatus::Deleted
                },
                StatusEntry {
                    path: "to.txt".into(),
                    old_path: Some("from.txt".into()),
                    status: ChangeStatus::Renamed
                },
                StatusEntry {
                    path: "copy.txt".into(),
                    old_path: Some("src.txt".into()),
                    status: ChangeStatus::Copied
                },
            ]
        );
    }

    #[test]
    fn tolerates_empty_and_truncated_output() {
        assert!(parse_numstat(b"").is_empty());
        assert!(parse_name_status(b"").is_empty());
        // A record cut short must not panic or invent an entry.
        assert!(parse_numstat(b"4\t2\t\0only-one-path\0").is_empty());
        assert!(parse_name_status(b"R100\0only-old\0").is_empty());
    }

    // --- Integration tests against a real git repository --------------------

    struct TestRepo {
        dir: tempfile::TempDir,
    }

    impl TestRepo {
        fn new() -> Self {
            let dir = tempfile::tempdir().expect("create temp dir");
            let repo = Self { dir };
            repo.git(&["init", "--initial-branch=main"]);
            repo.git(&["config", "user.email", "test@example.com"]);
            repo.git(&["config", "user.name", "Test"]);
            repo
        }

        fn path(&self) -> &Path {
            self.dir.path()
        }

        fn git(&self, args: &[&str]) -> String {
            let output = Command::new("git")
                .args(args)
                .current_dir(self.path())
                .output()
                .expect("run git");
            assert!(
                output.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).trim().to_owned()
        }

        fn write(&self, relative: &str, contents: &str) {
            let target = self.path().join(relative);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).expect("create parent dirs");
            }
            std::fs::write(target, contents).expect("write file");
        }

        fn commit(&self, message: &str) {
            self.git(&["add", "-A"]);
            self.git(&["commit", "-m", message]);
        }

        /// Commits with a pinned committer date, for tests about recency.
        fn commit_at(&self, message: &str, date: &str) {
            self.git(&["add", "-A"]);
            let output = Command::new("git")
                .args(["commit", "-m", message])
                .env("GIT_COMMITTER_DATE", date)
                .env("GIT_AUTHOR_DATE", date)
                .current_dir(self.path())
                .output()
                .expect("run git commit");
            assert!(
                output.status.success(),
                "git commit failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    /// Everything downstream depends on the exact byte layout of `-z` output, so
    /// assert the parsers against real git rather than only against fixtures.
    #[test]
    fn parses_real_git_output_for_every_change_kind() {
        let repo = TestRepo::new();
        repo.write("keep.txt", "one\ntwo\nthree\n");
        repo.write("gone.txt", "delete me\n");
        repo.write("renamed-from.txt", "stable contents\n");
        repo.write("dir with spaces/spaced name.txt", "a\n");
        repo.commit("base");

        repo.git(&["checkout", "-q", "-b", "feature"]);
        repo.write("keep.txt", "one\ntwo\nthree\nfour\n");
        repo.write("added.txt", "brand new\n");
        std::fs::remove_file(repo.path().join("gone.txt")).expect("remove file");
        std::fs::rename(
            repo.path().join("renamed-from.txt"),
            repo.path().join("renamed-to.txt"),
        )
        .expect("rename file");
        // A NUL byte makes git classify this as binary.
        std::fs::write(repo.path().join("blob.bin"), [0u8, 1, 2, 3, 4]).expect("write binary");
        repo.commit("feature work");

        let summary = diff_branches(repo.path(), "main", Some("feature")).expect("diff branches");
        let by_path = |path: &str| {
            summary
                .files
                .iter()
                .find(|file| file.path == path)
                .unwrap_or_else(|| panic!("{path} missing from {:#?}", summary.files))
                .clone()
        };

        let modified = by_path("keep.txt");
        assert_eq!(modified.status, ChangeStatus::Modified);
        assert_eq!((modified.additions, modified.deletions), (1, 0));

        assert_eq!(by_path("added.txt").status, ChangeStatus::Added);
        assert_eq!(by_path("gone.txt").status, ChangeStatus::Deleted);

        let renamed = by_path("renamed-to.txt");
        assert_eq!(renamed.status, ChangeStatus::Renamed);
        assert_eq!(renamed.old_path.as_deref(), Some("renamed-from.txt"));

        let binary = by_path("blob.bin");
        assert!(binary.is_binary);
        assert_eq!((binary.additions, binary.deletions), (0, 0));

        // Unchanged files stay out of the diff entirely.
        assert!(
            !summary.files.iter().any(|f| f.path.contains("spaced name")),
            "untouched file leaked into the diff"
        );

        assert_eq!(summary.total_additions, 2, "keep.txt +1 and added.txt +1");
        assert_eq!(summary.total_deletions, 1, "gone.txt -1");
    }

    #[test]
    fn merge_base_excludes_commits_made_on_base_after_diverging() {
        let repo = TestRepo::new();
        repo.write("shared.txt", "start\n");
        repo.commit("base");

        repo.git(&["checkout", "-q", "-b", "feature"]);
        repo.write("feature-only.txt", "feature\n");
        repo.commit("feature work");

        repo.git(&["checkout", "-q", "main"]);
        repo.write("main-only.txt", "main moved on\n");
        repo.commit("later work on main");

        let summary = diff_branches(repo.path(), "main", Some("feature")).expect("diff branches");
        let paths: Vec<&str> = summary.files.iter().map(|f| f.path.as_str()).collect();

        // The point of anchoring on the merge base: work that landed on main
        // afterwards is not part of this review.
        assert_eq!(paths, vec!["feature-only.txt"]);
    }

    /// The viewer caches rendered files against this, so a ref that has moved
    /// has to report a different commit — reporting the ref name would let a
    /// pushed-to PR keep rendering the diff it was first given.
    #[test]
    fn compare_head_follows_the_ref_and_is_absent_for_the_working_tree() {
        let repo = TestRepo::new();
        repo.write("shared.txt", "start\n");
        repo.commit("base");
        repo.git(&["checkout", "-q", "-b", "feature"]);
        repo.write("feature.txt", "one\n");
        repo.commit("feature work");

        let before = diff_branches(repo.path(), "main", Some("feature")).expect("diff branches");
        assert_eq!(
            before.compare_head.as_deref(),
            Some(repo.git(&["rev-parse", "feature"]).as_str())
        );

        repo.write("feature.txt", "one\ntwo\n");
        repo.commit("more feature work");

        let after = diff_branches(repo.path(), "main", Some("feature")).expect("diff branches");
        assert_ne!(after.compare_head, before.compare_head);

        // The working tree is not a commit, and its contents can change without
        // one — nothing to report, and nothing safe to cache against.
        let worktree = diff_branches(repo.path(), "main", None).expect("diff branches");
        assert_eq!(worktree.compare_head, None);
    }

    #[test]
    fn reads_both_sides_of_a_renamed_file() {
        let repo = TestRepo::new();
        // The file needs enough shared content that appending one line stays above
        // git's 50% similarity threshold; a one-line file would be reported as a
        // separate add and delete instead of a rename.
        let original: String = (1..=10).map(|n| format!("line {n}\n")).collect();
        repo.write("before.txt", &original);
        repo.commit("base");

        repo.git(&["checkout", "-q", "-b", "feature"]);
        std::fs::rename(
            repo.path().join("before.txt"),
            repo.path().join("after.txt"),
        )
        .expect("rename");
        let edited = format!("{original}line 11\n");
        repo.write("after.txt", &edited);
        repo.commit("rename and edit");

        let summary = diff_branches(repo.path(), "main", Some("feature")).expect("diff branches");
        let file = summary.files.first().expect("one changed file");
        assert_eq!(
            file.status,
            ChangeStatus::Renamed,
            "expected a detected rename, got {:#?}",
            summary.files
        );
        assert_eq!(file.old_path.as_deref(), Some("before.txt"));

        let versions = get_file_versions(
            repo.path(),
            &summary.merge_base,
            Some("feature"),
            &file.path,
            file.old_path.as_deref(),
        )
        .expect("file versions");

        // The old side has to be read under the file's previous name.
        assert_eq!(versions.old.as_deref(), Some(original.as_str()));
        assert_eq!(versions.new.as_deref(), Some(edited.as_str()));
    }

    #[test]
    fn one_sided_versions_for_added_and_deleted_files() {
        let repo = TestRepo::new();
        repo.write("gone.txt", "goodbye\n");
        repo.commit("base");

        repo.git(&["checkout", "-q", "-b", "feature"]);
        std::fs::remove_file(repo.path().join("gone.txt")).expect("remove");
        repo.write("fresh.txt", "hello\n");
        repo.commit("add and delete");

        let summary = diff_branches(repo.path(), "main", Some("feature")).expect("diff branches");

        let added = get_file_versions(
            repo.path(),
            &summary.merge_base,
            Some("feature"),
            "fresh.txt",
            None,
        )
        .expect("added versions");
        assert_eq!(added.old, None, "an added file has no base side");
        assert_eq!(added.new.as_deref(), Some("hello\n"));

        let deleted = get_file_versions(
            repo.path(),
            &summary.merge_base,
            Some("feature"),
            "gone.txt",
            None,
        )
        .expect("deleted versions");
        assert_eq!(deleted.old.as_deref(), Some("goodbye\n"));
        assert_eq!(deleted.new, None, "a deleted file has no compare side");
    }

    /// Large files must render, not be refused: the renderer virtualizes and
    /// degrades highlighting on its own, so there is no size gate here.
    #[test]
    fn reads_large_files_without_a_size_limit() {
        let repo = TestRepo::new();
        repo.write("big.txt", "seed\n");
        repo.commit("base");

        repo.git(&["checkout", "-q", "-b", "feature"]);
        let big: String = (0..40_000)
            .map(|n| format!("line {n} of a deliberately large generated file\n"))
            .collect();
        assert!(big.len() > 1_000_000, "fixture should exceed a megabyte");
        repo.write("big.txt", &big);
        repo.commit("make it big");

        let summary = diff_branches(repo.path(), "main", Some("feature")).expect("diff branches");
        let versions = get_file_versions(
            repo.path(),
            &summary.merge_base,
            Some("feature"),
            "big.txt",
            None,
        )
        .expect("versions");

        assert_eq!(versions.new.as_deref(), Some(big.as_str()));
    }

    #[test]
    fn flags_files_marked_linguist_generated() {
        let repo = TestRepo::new();
        repo.write("seed.txt", "seed\n");
        repo.commit("base");

        repo.git(&["checkout", "-q", "-b", "feature"]);
        repo.write(
            ".gitattributes",
            // The three spellings that matter, plus an unlisted file.
            "api.pb.go linguist-generated=true\nbundle.js linguist-generated\nhand.ts linguist-generated=false\n",
        );
        for name in ["api.pb.go", "bundle.js", "hand.ts", "regular.ts"] {
            repo.write(name, "contents\n");
        }
        repo.commit("add generated files");

        let summary = diff_branches(repo.path(), "main", Some("feature")).expect("diff branches");
        let generated = |path: &str| {
            summary
                .files
                .iter()
                .find(|file| file.path == path)
                .unwrap_or_else(|| panic!("{path} missing"))
                .is_generated
        };

        assert!(generated("api.pb.go"), "explicit =true should count");
        assert!(generated("bundle.js"), "the bare attribute should count");
        assert!(!generated("hand.ts"), "=false must not count");
        assert!(!generated("regular.ts"), "unlisted files are not generated");
        assert!(
            !generated(".gitattributes"),
            "the rules file is not generated"
        );
    }

    /// The attributes that matter are the ones on the branch being reviewed, not
    /// whatever happens to be checked out.
    #[test]
    fn reads_generated_attributes_from_the_compare_revision() {
        let repo = TestRepo::new();
        repo.write("seed.txt", "seed\n");
        repo.commit("base");

        repo.git(&["checkout", "-q", "-b", "feature"]);
        repo.write(".gitattributes", "gen.txt linguist-generated=true\n");
        repo.write("gen.txt", "generated\n");
        repo.commit("mark as generated");

        // Leave the working tree on a branch with no such rule.
        repo.git(&["checkout", "-q", "main"]);

        let summary = diff_branches(repo.path(), "main", Some("feature")).expect("diff branches");
        let file = summary
            .files
            .iter()
            .find(|file| file.path == "gen.txt")
            .expect("gen.txt in diff");
        assert!(file.is_generated, "should read feature's gitattributes");
    }

    /// A `None` compare reviews the working tree: committed work on the branch,
    /// staged and unstaged edits, and untracked files all fold into one diff.
    #[test]
    fn working_tree_compare_includes_uncommitted_and_untracked_changes() {
        let repo = TestRepo::new();
        repo.write("tracked.txt", "one\ntwo\n");
        repo.commit("base");

        repo.git(&["checkout", "-q", "-b", "feature"]);
        repo.write("tracked.txt", "one\ntwo\nthree\n");
        repo.commit("committed feature work");

        // Every flavour of uncommitted work on top of the branch.
        repo.write("tracked.txt", "one\ntwo\nthree\nfour\n"); // unstaged edit
        repo.write("staged.txt", "staged\n");
        repo.git(&["add", "staged.txt"]);
        repo.write("untracked.txt", "brand new\nsecond line"); // no trailing newline
        std::fs::write(repo.path().join("untracked.bin"), [0u8, 1, 2]).expect("write binary");

        let summary = diff_branches(repo.path(), "main", None).expect("diff working tree");
        let by_path = |path: &str| {
            summary
                .files
                .iter()
                .find(|file| file.path == path)
                .unwrap_or_else(|| panic!("{path} missing from {:#?}", summary.files))
                .clone()
        };

        // The committed change and the unstaged edit fold into one entry.
        let tracked = by_path("tracked.txt");
        assert_eq!((tracked.additions, tracked.deletions), (2, 0));

        assert_eq!(by_path("staged.txt").status, ChangeStatus::Added);

        let untracked = by_path("untracked.txt");
        assert_eq!(untracked.status, ChangeStatus::Added);
        assert_eq!(untracked.additions, 2, "a final unterminated line counts");
        assert!(by_path("untracked.bin").is_binary);

        let patch = get_patch(repo.path(), &summary.merge_base, None).expect("patch");
        assert!(patch.contains("+four"), "unstaged edit missing: {patch}");
        assert!(patch.contains("+++ b/untracked.txt"), "{patch}");
        assert!(patch.contains("+second line"), "{patch}");
        assert!(
            !patch.contains("untracked.bin"),
            "binary untracked files have no text to patch: {patch}"
        );

        // The new side of a working-tree review reads straight from disk.
        let versions =
            get_file_versions(repo.path(), &summary.merge_base, None, "tracked.txt", None)
                .expect("versions");
        assert_eq!(versions.old.as_deref(), Some("one\ntwo\n"));
        assert_eq!(versions.new.as_deref(), Some("one\ntwo\nthree\nfour\n"));
    }

    #[test]
    fn parses_check_attr_values() {
        let raw = b"a.go\0linguist-generated\0true\0b.js\0linguist-generated\0set\0c.ts\0linguist-generated\0false\0d.ts\0linguist-generated\0unspecified\0";
        let generated = parse_check_attr(raw);

        assert!(generated.contains("a.go"));
        assert!(generated.contains("b.js"));
        assert_eq!(generated.len(), 2, "false and unspecified must be excluded");
    }

    #[test]
    fn lists_the_commits_since_the_merge_base_newest_first() {
        let repo = TestRepo::new();
        repo.write("shared.txt", "start\n");
        repo.commit("base");

        repo.git(&["checkout", "-q", "-b", "feature"]);
        repo.write("feature.txt", "one\n");
        repo.commit("first feature commit");
        repo.write("feature.txt", "one\ntwo\n");
        repo.git(&["add", "-A"]);
        repo.git(&[
            "commit",
            "-q",
            "-m",
            "second feature commit",
            "-m",
            "with a body",
        ]);

        repo.git(&["checkout", "-q", "main"]);
        repo.write("main-only.txt", "main moved on\n");
        repo.commit("later work on main");

        let summary = diff_branches(repo.path(), "main", Some("feature")).expect("diff branches");
        let log = list_commits(repo.path(), &summary.merge_base, Some("feature")).expect("log");
        let subjects: Vec<&str> = log.commits.iter().map(|c| c.subject.as_str()).collect();

        // Main's later commit is not part of the comparison, and a body stays
        // out of the subject.
        assert_eq!(
            subjects,
            vec!["second feature commit", "first feature commit"]
        );
        assert_eq!(
            log.commits[0].sha,
            repo.git(&["rev-parse", "feature"]),
            "the newest commit is the compare head"
        );
        assert_eq!(log.commits[0].author, "Test");
        assert!(!log.commits[0].committed_at.is_empty());
        assert!(!log.truncated);
    }

    #[test]
    fn lists_the_commits_under_the_working_tree() {
        let repo = TestRepo::new();
        repo.write("shared.txt", "start\n");
        repo.commit("base");
        repo.git(&["checkout", "-q", "-b", "feature"]);
        repo.write("feature.txt", "one\n");
        repo.commit("feature work");
        repo.write("feature.txt", "uncommitted\n");

        let summary = diff_branches(repo.path(), "main", None).expect("diff branches");
        let log = list_commits(repo.path(), &summary.merge_base, None).expect("log");
        let subjects: Vec<&str> = log.commits.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(subjects, vec!["feature work"]);
    }

    #[test]
    fn caps_a_long_log_at_the_newest_commits() {
        let repo = TestRepo::new();
        repo.write("shared.txt", "start\n");
        repo.commit("base");
        let base = repo.git(&["rev-parse", "HEAD"]);
        for index in 0..=MAX_COMMITS {
            repo.git(&[
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                &format!("commit {index}"),
            ]);
        }

        let log = list_commits(repo.path(), &base, Some("main")).expect("log");
        assert!(log.truncated);
        assert_eq!(log.commits.len(), MAX_COMMITS);
        assert_eq!(log.commits[0].subject, format!("commit {MAX_COMMITS}"));
    }

    #[test]
    fn patch_covers_every_file_in_the_range() {
        let repo = TestRepo::new();
        repo.write("kept.txt", "one\ntwo\n");
        repo.write("removed.txt", "gone soon\n");
        repo.commit("base");

        repo.git(&["checkout", "-q", "-b", "feature"]);
        repo.write("kept.txt", "one\ntwo\nthree\n");
        repo.write("fresh.txt", "new file\n");
        std::fs::remove_file(repo.path().join("removed.txt")).expect("remove");
        repo.commit("feature work");

        let summary = diff_branches(repo.path(), "main", Some("feature")).expect("diff branches");
        let patch = get_patch(repo.path(), &summary.merge_base, Some("feature")).expect("patch");

        // Standard git patch headers, which is what the renderer parses.
        assert!(
            patch.contains("diff --git a/kept.txt b/kept.txt"),
            "{patch}"
        );
        assert!(patch.contains("+three"), "{patch}");
        assert!(patch.contains("new file mode"), "{patch}");
        assert!(patch.contains("deleted file mode"), "{patch}");
        assert!(patch.contains("@@"), "hunk headers missing: {patch}");
    }

    #[test]
    fn file_patch_covers_one_file_including_untracked_ones() {
        let repo = TestRepo::new();
        repo.write("kept.txt", "one\n");
        repo.write("other.txt", "unrelated\n");
        repo.commit("base");

        repo.git(&["checkout", "-q", "-b", "feature"]);
        repo.write("kept.txt", "one\ntwo\n");
        repo.write("other.txt", "also changed\n");
        repo.commit("feature work");

        let summary = diff_branches(repo.path(), "main", Some("feature")).expect("diff");
        let patch = get_file_patch(
            repo.path(),
            &summary.merge_base,
            Some("feature"),
            "kept.txt",
        )
        .expect("file patch");
        assert!(patch.contains("+two"), "{patch}");
        assert!(!patch.contains("other.txt"), "leaked another file: {patch}");

        // Untracked files only exist for working-tree reviews, via --no-index.
        repo.write("fresh.txt", "brand new\n");
        let untracked = get_file_patch(repo.path(), &summary.merge_base, None, "fresh.txt")
            .expect("untracked patch");
        assert!(untracked.contains("+brand new"), "{untracked}");
    }

    #[test]
    fn patch_is_unaffected_by_a_configured_external_difftool() {
        let repo = TestRepo::new();
        repo.write("file.txt", "before\n");
        repo.commit("base");
        repo.git(&["checkout", "-q", "-b", "feature"]);
        repo.write("file.txt", "after\n");
        repo.commit("change");

        // A repo (or user) configuring these would otherwise replace the patch
        // body with the tool's output, or wrap it in colour escapes.
        repo.git(&["config", "diff.external", "/bin/echo"]);
        repo.git(&["config", "color.diff", "always"]);

        let summary = diff_branches(repo.path(), "main", Some("feature")).expect("diff branches");
        let patch = get_patch(repo.path(), &summary.merge_base, Some("feature")).expect("patch");

        assert!(patch.contains("-before"), "{patch}");
        assert!(patch.contains("+after"), "{patch}");
        assert!(!patch.contains('\u{1b}'), "escape codes leaked: {patch:?}");
    }

    #[test]
    fn identical_branches_produce_an_empty_summary() {
        let repo = TestRepo::new();
        repo.write("only.txt", "content\n");
        repo.commit("base");
        repo.git(&["branch", "twin"]);

        let summary = diff_branches(repo.path(), "main", Some("twin")).expect("diff branches");
        assert!(summary.files.is_empty());
        assert_eq!((summary.total_additions, summary.total_deletions), (0, 0));
    }

    #[test]
    fn reports_repo_metadata_and_branches() {
        let repo = TestRepo::new();
        repo.write("file.txt", "content\n");
        repo.commit("base");
        repo.git(&["branch", "feature"]);

        let info = select_repo(repo.path()).expect("select repo");
        assert_eq!(info.current_branch.as_deref(), Some("main"));
        assert_eq!(info.default_branch.as_deref(), Some("main"));

        let branches = list_branches(Path::new(&info.root)).expect("list branches");
        let names: Vec<&str> = branches.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(names, vec!["feature", "main"]);
        assert!(branches.iter().find(|b| b.name == "main").unwrap().is_head);
        assert!(branches.iter().all(|b| !b.is_remote));
    }

    #[test]
    fn branches_are_listed_most_recently_committed_first() {
        let repo = TestRepo::new();
        repo.write("file.txt", "one\n");
        repo.commit_at("base", "2024-01-01T12:00:00Z");

        repo.git(&["checkout", "-q", "-b", "older"]);
        repo.write("file.txt", "two\n");
        repo.commit_at("older work", "2024-02-01T12:00:00Z");

        repo.git(&["checkout", "-q", "main"]);
        repo.git(&["checkout", "-q", "-b", "newer"]);
        repo.write("file.txt", "three\n");
        repo.commit_at("newer work", "2024-03-01T12:00:00Z");

        let branches = list_branches(repo.path()).expect("list branches");
        let names: Vec<&str> = branches.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(names, vec!["newer", "older", "main"]);
    }

    #[test]
    fn fetch_remotes_picks_up_new_remote_branches() {
        let source = TestRepo::new();
        source.write("file.txt", "one\n");
        source.commit("base");

        // A repo with no remotes fetches nothing and succeeds.
        fetch_remotes(source.path()).expect("fetch with no remotes");

        // Clone it, so `origin` points back at the source repo.
        let clone_root = tempfile::tempdir().expect("temp dir");
        let clone_path = clone_root.path().join("clone");
        let output = Command::new("git")
            .args([
                "clone",
                "--quiet",
                &source.path().display().to_string(),
                &clone_path.display().to_string(),
            ])
            .output()
            .expect("run git clone");
        assert!(
            output.status.success(),
            "clone failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        // A branch born on the remote after the clone is invisible until a fetch.
        source.git(&["branch", "born-later"]);
        let before = list_branches(&clone_path).expect("list before fetch");
        assert!(!before.iter().any(|b| b.name == "origin/born-later"));

        fetch_remotes(&clone_path).expect("fetch");
        let after = list_branches(&clone_path).expect("list after fetch");
        assert!(
            after
                .iter()
                .any(|b| b.is_remote && b.name == "origin/born-later"),
            "fetched branch missing from {after:#?}"
        );
    }

    #[test]
    fn fetches_a_pr_head_from_a_local_remote() {
        let repo = TestRepo::new();
        repo.write("shared.txt", "base\n");
        repo.commit("base");

        let remote = tempfile::tempdir().expect("remote dir");
        let remote_path = remote.path().display().to_string();
        let output = Command::new("git")
            .args(["init", "--bare", &remote_path])
            .output()
            .expect("init bare remote");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        repo.git(&["remote", "add", "origin", &remote_path]);
        repo.git(&["push", "origin", "main"]);

        repo.git(&["checkout", "-q", "-b", "feature"]);
        repo.write("feature.txt", "review me\n");
        repo.commit("feature");
        let expected = repo.git(&["rev-parse", "HEAD"]);
        repo.git(&["push", "origin", "HEAD:refs/pull/7/head"]);

        let (compare_ref, head) =
            fetch_pr_head(repo.path(), "origin", 7, "main", &[]).expect("fetch PR");
        assert_eq!(compare_ref, "tk-review/pr/7");
        assert_eq!(head, expected);
        assert_eq!(repo.git(&["rev-parse", "tk-review/pr/7"]), expected);
    }

    #[test]
    fn fetching_a_pr_keeps_the_refs_of_prs_still_open() {
        let repo = TestRepo::new();
        repo.write("shared.txt", "base\n");
        repo.commit("base");

        let remote = tempfile::tempdir().expect("remote dir");
        let remote_path = remote.path().display().to_string();
        let output = Command::new("git")
            .args(["init", "--bare", &remote_path])
            .output()
            .expect("init bare remote");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        repo.git(&["remote", "add", "origin", &remote_path]);
        repo.git(&["push", "origin", "main"]);
        for number in [7, 8, 9] {
            repo.git(&["checkout", "-q", "-B", &format!("pr-{number}"), "main"]);
            repo.write(&format!("pr-{number}.txt"), "review me\n");
            repo.commit(&format!("pr {number}"));
            repo.git(&["push", "origin", &format!("HEAD:refs/pull/{number}/head")]);
        }

        fetch_pr_head(repo.path(), "origin", 7, "main", &[]).expect("fetch 7");
        fetch_pr_head(repo.path(), "origin", 8, "main", &[7]).expect("fetch 8");
        let refs = repo.git(&["for-each-ref", "--format=%(refname)", "refs/tk-review/pr"]);
        assert_eq!(refs, "refs/tk-review/pr/7\nrefs/tk-review/pr/8");

        // 7's tab closed: fetching 9 lets its ref go.
        fetch_pr_head(repo.path(), "origin", 9, "main", &[8]).expect("fetch 9");
        let refs = repo.git(&["for-each-ref", "--format=%(refname)", "refs/tk-review/pr"]);
        assert_eq!(refs, "refs/tk-review/pr/8\nrefs/tk-review/pr/9");
    }

    #[test]
    fn rejects_non_repositories_and_unknown_revisions() {
        let plain = tempfile::tempdir().expect("temp dir");
        assert!(matches!(
            select_repo(plain.path()),
            Err(GitError::NotARepo(_))
        ));

        let repo = TestRepo::new();
        repo.write("file.txt", "content\n");
        repo.commit("base");
        assert!(matches!(
            diff_branches(repo.path(), "main", Some("does-not-exist")),
            Err(GitError::BadRevision(_))
        ));
    }
}
