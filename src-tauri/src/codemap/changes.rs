//! What git says changed between the two snapshots: each file's status and its changed line ranges.

use std::collections::HashMap;
use std::path::Path;

use crate::error::GitError;
use crate::git::{parse_name_status, run_git, untracked_files, ChangeStatus};

pub(super) enum Change {
    Added,
    Modified,
    Renamed { from: String },
    Deleted,
}

/// A changed range: where it starts and how many lines it has, new side then old.
pub(super) type Hunk = [u32; 4];

pub(super) struct Changes {
    /// By path on the head side.
    pub status: HashMap<String, Change>,
    /// By path on the head side; a deleted file has none.
    pub hunks: HashMap<String, Vec<Hunk>>,
}

/// Compares `base` with `head`, or with the working tree, untracked files included, when `head` is `None`.
pub(super) fn read_changes(
    root: &Path,
    base: &str,
    head: Option<&str>,
) -> Result<Changes, GitError> {
    let mut range = vec![base];
    range.extend(head);
    let diff = |extra: &[&str]| {
        let mut args = vec![
            "-c",
            "core.quotePath=false",
            "diff",
            "--find-renames",
            "--no-color",
            "--no-ext-diff",
            // Pinned, since `diff.noprefix` or `diff.mnemonicPrefix` would change them.
            "--src-prefix=a/",
            "--dst-prefix=b/",
        ];
        args.extend(extra);
        args.extend(&range);
        run_git(root, &args)
    };

    let mut status = HashMap::new();
    for entry in parse_name_status(&diff(&["-z", "--name-status"])?) {
        let change = match entry.status {
            ChangeStatus::Added | ChangeStatus::Copied => Change::Added,
            ChangeStatus::Modified | ChangeStatus::TypeChanged => Change::Modified,
            ChangeStatus::Deleted => Change::Deleted,
            ChangeStatus::Renamed => Change::Renamed {
                from: entry.old_path.unwrap_or_default(),
            },
            ChangeStatus::Unmerged | ChangeStatus::Unknown => continue,
        };
        status.insert(entry.path, change);
    }
    if head.is_none() {
        for path in untracked_files(root)? {
            status.entry(path).or_insert(Change::Added);
        }
    }

    let patch = diff(&["-U0"])?;
    Ok(Changes {
        status,
        hunks: parse_hunks(&String::from_utf8_lossy(&patch)),
    })
}

fn parse_hunks(patch: &str) -> HashMap<String, Vec<Hunk>> {
    let mut hunks: HashMap<String, Vec<Hunk>> = HashMap::new();
    let mut current: Option<String> = None;
    for line in patch.lines() {
        if line.starts_with("diff --git ") {
            current = None;
        } else if let Some(path) = line.strip_prefix("+++ ") {
            // Git ends the name with a tab when it contains a space.
            current = path
                .strip_prefix("b/")
                .map(|path| path.trim_end_matches('\t').to_owned());
        } else if let (Some(path), Some(header)) = (&current, line.strip_prefix("@@ -")) {
            if let Some(hunk) = parse_hunk_header(header) {
                hunks.entry(path.clone()).or_default().push(hunk);
            }
        }
    }
    hunks
}

/// Reads `12,3 +14,0 @@`, where a missing count means one line.
fn parse_hunk_header(header: &str) -> Option<Hunk> {
    let (old, rest) = header.split_once(" +")?;
    let (new, _) = rest.split_once(" @@")?;
    let range = |text: &str| -> Option<(u32, u32)> {
        match text.split_once(',') {
            Some((start, count)) => Some((start.parse().ok()?, count.parse().ok()?)),
            None => Some((text.parse().ok()?, 1)),
        }
    };
    let (old_start, old_lines) = range(old)?;
    let (new_start, new_lines) = range(new)?;
    Some([new_start, new_lines, old_start, old_lines])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_hunks_by_new_path() {
        let patch = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -3 +3,2 @@ fn\n-a\n+b\n+c\n\
                     diff --git a/gone.ts b/gone.ts\n--- a/gone.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n";
        let hunks = parse_hunks(patch);
        assert_eq!(hunks["x.ts"], vec![[3, 2, 3, 1]]);
        assert!(!hunks.contains_key("gone.ts"));
    }
}
