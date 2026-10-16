//! What a re-review looks at for new problems.
//!
//! A re-review that reads the whole diff again finds new things every time,
//! however little changed, because each run is a fresh sample of what a review
//! can notice. So by default a re-review looks for new problems only in what
//! changed since the review before it: the diff from the commit that review
//! read to the one read now, cut down to the comparison's own changes. New
//! findings outside that are folded away rather than shown, unless they're
//! critical. Reading the whole diff again stays one choice away.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::git;
use crate::review::ReviewFinding;
use crate::specialists::file_changes;

/// How far from a changed line a new finding can anchor and still count as
/// being about the change: a change often breaks the line beside it.
const LINE_SLACK: u32 = 5;

/// A span of new-file lines, first to last.
type Span = (u32, u32);

/// What changed since the review before a re-review.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Since {
    /// The commit that review read.
    pub head: String,
    /// The diff from that commit, cut down to the hunks that belong to the
    /// comparison's own changes.
    pub patch: String,
    /// The new-file lines those hunks changed, by path: lines added, and
    /// where lines were removed.
    pub lines: HashMap<String, Vec<Span>>,
}

impl Since {
    /// Nothing in the comparison changed since that review.
    pub fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }

    /// The paths that changed.
    pub fn paths(&self) -> HashSet<String> {
        self.lines.keys().cloned().collect()
    }

    /// The commit that review read, abbreviated for a prompt.
    pub fn short_head(&self) -> &str {
        &self.head[..self.head.len().min(7)]
    }

    /// Whether a new finding is about what changed: near a changed line, or
    /// about a changed file as a whole.
    pub fn covers(&self, finding: &ReviewFinding) -> bool {
        let Some(spans) = self.lines.get(&finding.path) else {
            return false;
        };
        let Some(start) = finding.line else {
            return true;
        };
        let end = finding.end_line.unwrap_or(start).max(start);
        spans
            .iter()
            .any(|&(from, to)| start <= to + LINE_SLACK && from <= end + LINE_SLACK)
    }
}

/// What changed in the comparison's `patch` since the commit `prior_head`, or
/// why that can't be told, in a sentence for the person reviewing, when the
/// whole diff has to be read again instead.
pub fn changes_since(
    root: &Path,
    prior_head: Option<&str>,
    compare: Option<&str>,
    patch: &str,
) -> Result<Since, String> {
    let Some(compare) = compare else {
        return Err("A review of the working tree keeps no record of the changes it read, so this re-review read the whole diff again.".into());
    };
    let Some(head) = prior_head.map(str::trim).filter(|head| !head.is_empty()) else {
        return Err("The last review didn't record the commit it read, so this re-review read the whole diff again.".into());
    };
    let since = git::get_patch(root, head, Some(compare)).map_err(|_| {
        format!(
            "The commit the last review read, `{}`, is gone from the repository, so this re-review read the whole diff again.",
            &head[..head.len().min(7)]
        )
    })?;
    Ok(cut_to_comparison(head, &since, patch))
}

/// The hunks of `since`, the diff from `head`, that change lines the
/// comparison's `patch` changes too. What the branch picked up from its base
/// in the meantime, by a merge or a rebase, is in `since` but not the
/// comparison, so it drops out.
fn cut_to_comparison(head: &str, since: &str, patch: &str) -> Since {
    let none = HashSet::new();
    let comparison: HashMap<String, Vec<Span>> = file_changes(patch, &none)
        .into_iter()
        .map(|file| {
            (
                file.path,
                hunks(file.section)
                    .1
                    .iter()
                    .map(|hunk| hunk_span(hunk))
                    .collect(),
            )
        })
        .collect();
    let mut kept = Since {
        head: head.to_owned(),
        ..Since::default()
    };
    for file in file_changes(since, &none) {
        let Some(ours) = comparison.get(&file.path) else {
            continue;
        };
        let (header, file_hunks) = hunks(file.section);
        let mut text = String::new();
        let mut changed = Vec::new();
        for hunk in file_hunks {
            let spans: Vec<Span> = changed_spans(hunk)
                .into_iter()
                .filter(|span| ours.iter().any(|our| overlaps(*span, *our)))
                .collect();
            if !spans.is_empty() {
                text.push_str(hunk);
                changed.extend(spans);
            }
        }
        if !changed.is_empty() {
            kept.patch.push_str(header);
            kept.patch.push_str(&text);
            kept.lines.insert(file.path, changed);
        }
    }
    kept
}

/// A file's section split into its header, up to the first hunk, and its
/// hunks, each from its `@@` line on.
fn hunks(section: &str) -> (&str, Vec<&str>) {
    let mut starts: Vec<usize> = Vec::new();
    let mut at = 0;
    for line in section.split_inclusive('\n') {
        if line.starts_with("@@") {
            starts.push(at);
        }
        at += line.len();
    }
    let Some(&first) = starts.first() else {
        return (section, Vec::new());
    };
    starts.push(section.len());
    let hunks = starts
        .windows(2)
        .map(|bounds| &section[bounds[0]..bounds[1]])
        .collect();
    (&section[..first], hunks)
}

/// Where a hunk's header says it starts in the new file, and how many lines
/// it covers there: `@@ -12,7 +14,9 @@` is 14 and 9.
fn hunk_start(hunk: &str) -> (u32, u32) {
    let new_side = hunk
        .lines()
        .next()
        .and_then(|header| header.split(' ').find(|part| part.starts_with('+')))
        .unwrap_or("+1");
    let mut parts = new_side[1..].splitn(2, ',');
    let start = parts.next().and_then(|n| n.parse().ok()).unwrap_or(1);
    let count = parts
        .next()
        .map_or(Some(1), |n| n.parse().ok())
        .unwrap_or(1);
    (start, count)
}

/// The new-file lines a hunk shows, context included.
fn hunk_span(hunk: &str) -> Span {
    let (start, count) = hunk_start(hunk);
    let start = start.max(1);
    (start, start + count.saturating_sub(1))
}

/// The new-file lines a hunk changes: each added line, and for removed lines
/// the line that now stands where they were. Neighbours run together.
fn changed_spans(hunk: &str) -> Vec<Span> {
    let (mut line, _) = hunk_start(hunk);
    let mut changed: Vec<Span> = Vec::new();
    let mut mark = |at: u32| match changed.last_mut() {
        Some((_, end)) if at <= *end + 1 => *end = (*end).max(at),
        _ => changed.push((at, at)),
    };
    for text in hunk.lines().skip(1) {
        match text.as_bytes().first() {
            Some(b'+') => {
                mark(line.max(1));
                line += 1;
            }
            Some(b'-') => mark(line.max(1)),
            // "\ No newline at end of file" stands for no line.
            Some(b'\\') => {}
            _ => line += 1,
        }
    }
    changed
}

fn overlaps(a: Span, b: Span) -> bool {
    a.0 <= b.1 && b.0 <= a.1
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finding(path: &str, line: Option<u32>, end_line: Option<u32>) -> ReviewFinding {
        ReviewFinding {
            path: path.to_owned(),
            line,
            end_line,
            severity: "warning".to_owned(),
            title: String::new(),
            body: String::new(),
            reviewers: Vec::new(),
            posted_url: None,
            failure: String::new(),
            fix: String::new(),
        }
    }

    #[test]
    fn a_hunk_changes_its_added_lines_and_where_lines_were_removed() {
        let hunk = "@@ -10,6 +10,6 @@ fn f() {\n context\n-old\n+new\n context\n context\n-gone\n context\n";
        // Line 11 replaced; the removed line sat before what is now line 14.
        assert_eq!(changed_spans(hunk), [(11, 11), (14, 14)]);
        assert_eq!(hunk_span(hunk), (10, 15));

        let added = "@@ -0,0 +1,3 @@\n+a\n+b\n+c\n";
        assert_eq!(changed_spans(added), [(1, 3)]);
        assert_eq!(hunk_start("@@ -3 +4 @@\n-x\n+y\n"), (4, 1));
    }

    /// The PR's own patch: `a.ts` changes lines 20 to 26 (context included),
    /// and `b.ts` is new.
    const COMPARISON: &str = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -20,6 +20,7 @@\n x\n x\n x\n+added by the PR\n x\n x\n x\ndiff --git a/b.ts b/b.ts\nnew file mode 100644\n--- /dev/null\n+++ b/b.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n";

    #[test]
    fn what_changed_since_is_cut_to_the_comparisons_own_changes() {
        // Since the last review: a fix inside the PR's hunk of `a.ts`, a
        // change far from it that came in with the base, the new file grown
        // by a line, and a file the PR doesn't touch.
        let since = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -2,3 +2,3 @@\n x\n-from the base\n+from the base, changed\n x\n@@ -21,4 +21,4 @@\n x\n-added by the PR, buggy\n+added by the PR\n x\ndiff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1,1 +1,2 @@\n one\n+two\ndiff --git a/c.ts b/c.ts\n--- a/c.ts\n+++ b/c.ts\n@@ -1 +1 @@\n-c\n+d\n";
        let cut = cut_to_comparison("0123456789abcdef", since, COMPARISON);

        assert_eq!(cut.short_head(), "0123456");
        assert_eq!(cut.lines.get("a.ts"), Some(&vec![(22, 22)]));
        assert_eq!(cut.lines.get("b.ts"), Some(&vec![(2, 2)]));
        assert!(!cut.lines.contains_key("c.ts"));
        assert!(cut.patch.contains("+added by the PR\n"), "{}", cut.patch);
        assert!(!cut.patch.contains("from the base"), "{}", cut.patch);
        assert!(!cut.patch.contains("c.ts"), "{}", cut.patch);
        assert_eq!(
            cut.paths(),
            HashSet::from(["a.ts".to_owned(), "b.ts".to_owned()])
        );
    }

    #[test]
    fn nothing_changed_since_when_the_commit_is_the_same() {
        let cut = cut_to_comparison("abc", "", COMPARISON);
        assert!(cut.is_empty());
        assert!(cut.patch.is_empty());
    }

    /// Runs git in `dir`, for the test below, and returns what it printed.
    fn git(dir: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn write_lines(dir: &Path, changed: &[(usize, &str)]) {
        let text: String = (1..=30)
            .map(|line| {
                let replaced = changed.iter().find(|(at, _)| *at == line);
                format!(
                    "{}\n",
                    replaced.map_or(format!("line {line}"), |(_, text)| (*text).to_owned())
                )
            })
            .collect();
        std::fs::write(dir.join("a.ts"), text).expect("write");
    }

    #[test]
    fn what_changed_since_leaves_out_what_a_merge_from_the_base_brought() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path();
        git(root, &["init", "--initial-branch=main"]);
        git(root, &["config", "user.email", "test@example.com"]);
        git(root, &["config", "user.name", "Test"]);
        write_lines(root, &[]);
        git(root, &["add", "-A"]);
        git(root, &["commit", "-m", "base"]);
        git(root, &["checkout", "-b", "feature"]);
        write_lines(root, &[(5, "pr change")]);
        git(root, &["commit", "-am", "pr"]);
        let reviewed = git(root, &["rev-parse", "HEAD"]);

        // The base moves on, the branch merges it, and then gets a fix.
        git(root, &["checkout", "main"]);
        write_lines(root, &[(25, "base change")]);
        git(root, &["commit", "-am", "base moves"]);
        git(root, &["checkout", "feature"]);
        git(root, &["merge", "main", "--no-edit"]);
        write_lines(
            root,
            &[(5, "pr change"), (6, "pr fix"), (25, "base change")],
        );
        git(root, &["commit", "-am", "fix"]);

        let merge_base = git(root, &["merge-base", "main", "feature"]);
        let patch = git::get_patch(root, &merge_base, Some("feature")).expect("patch");
        let since = changes_since(root, Some(&reviewed), Some("feature"), &patch).expect("since");
        assert_eq!(since.lines.get("a.ts"), Some(&vec![(6, 6)]));
        assert!(since.patch.contains("+pr fix"), "{}", since.patch);
        assert!(!since.patch.contains("base change"), "{}", since.patch);

        let gone = changes_since(root, Some(&"0".repeat(40)), Some("feature"), &patch);
        assert!(gone.expect_err("gone").contains("is gone"));
        let unrecorded = changes_since(root, None, Some("feature"), &patch);
        assert!(unrecorded
            .expect_err("unrecorded")
            .contains("didn't record"));
        let worktree = changes_since(root, Some(&reviewed), None, &patch);
        assert!(worktree.expect_err("worktree").contains("working tree"));
    }

    #[test]
    fn a_finding_is_about_what_changed_when_it_is_near_a_changed_line() {
        let since = Since {
            head: "abc".into(),
            patch: String::new(),
            lines: HashMap::from([("a.ts".to_owned(), vec![(40, 42)])]),
        };
        assert!(since.covers(&finding("a.ts", Some(41), None)));
        assert!(since.covers(&finding("a.ts", Some(45), None)));
        assert!(since.covers(&finding("a.ts", Some(20), Some(36))));
        assert!(since.covers(&finding("a.ts", None, None)));
        assert!(!since.covers(&finding("a.ts", Some(48), None)));
        assert!(!since.covers(&finding("a.ts", Some(10), Some(30))));
        assert!(!since.covers(&finding("b.ts", Some(41), None)));
    }
}
