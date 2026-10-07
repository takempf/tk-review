//! Review rules kept for a repository on this machine.
//!
//! Some guidance only makes sense for one codebase — which tables are large,
//! which triggers fire on an update — and some is private to the team that
//! owns it, so it belongs neither in the app's own prompts nor necessarily in
//! the repository. These rules live in one JSON file in the app's config
//! directory, keyed by the repository's GitHub identity, so every clone and
//! worktree of a repository shares them. A checkout with no GitHub remote is
//! keyed by its path.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::GitError;
use crate::github;

/// The rules for one repository. Either part may be empty.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RepoRules {
    /// Added to every review and re-review of the repository.
    pub review: String,
    /// Handed to the migration reviewer when a diff changes migrations.
    pub migrations: String,
}

impl RepoRules {
    fn is_empty(&self) -> bool {
        self.review.trim().is_empty() && self.migrations.trim().is_empty()
    }
}

/// A repository's rules, with where they are kept, for the settings dialog.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoRulesEntry {
    /// What the rules are keyed by: `github.com/owner/repo`, or a path.
    pub repo: String,
    pub rules: RepoRules,
    /// The file every repository's rules are kept in.
    pub file: String,
}

/// The key a checkout's rules are kept under: the GitHub repository its
/// remotes point at, lowercased since GitHub names are case-insensitive, or
/// failing that the checkout's own path.
pub fn repo_key(root: &Path) -> String {
    match github::github_remote(root) {
        Ok(Some((host, owner, repo))) => format!("{host}/{owner}/{repo}").to_lowercase(),
        _ => root
            .canonicalize()
            .unwrap_or_else(|_| root.to_path_buf())
            .display()
            .to_string(),
    }
}

/// Every repository's rules in `file`. A missing file holds none; a file that
/// can't be read is an error rather than no rules, so a review never silently
/// runs without them and a save never overwrites them.
fn read_all(file: &Path) -> Result<BTreeMap<String, RepoRules>, GitError> {
    let text = match std::fs::read_to_string(file) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(err) => return Err(unreadable(file, err)),
    };
    serde_json::from_str(&text).map_err(|err| unreadable(file, err))
}

fn unreadable(file: &Path, err: impl std::fmt::Display) -> GitError {
    GitError::Command(format!(
        "Could not read the review rules in {}: {err}",
        file.display()
    ))
}

/// The rules kept for the checkout at `root`.
pub fn load(file: &Path, root: &Path) -> Result<RepoRulesEntry, GitError> {
    let repo = repo_key(root);
    let rules = read_all(file)?.remove(&repo).unwrap_or_default();
    Ok(RepoRulesEntry {
        repo,
        rules,
        file: file.display().to_string(),
    })
}

/// Replaces the rules kept for the checkout at `root`, leaving every other
/// repository's alone. Empty rules remove the repository's entry.
pub fn save(file: &Path, root: &Path, rules: RepoRules) -> Result<RepoRulesEntry, GitError> {
    let repo = repo_key(root);
    let mut all = read_all(file)?;
    if rules.is_empty() {
        all.remove(&repo);
    } else {
        all.insert(repo.clone(), rules.clone());
    }

    let failed = |err: std::io::Error| {
        GitError::Command(format!(
            "Could not save the review rules to {}: {err}",
            file.display()
        ))
    };
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(failed)?;
    }
    let json = serde_json::to_string_pretty(&all)
        .map_err(|err| GitError::Command(format!("Could not save the review rules: {err}")))?;
    // Written beside and renamed over, so a crash mid-write can't leave every
    // repository's rules half-written.
    let staged = file.with_extension("json.tmp");
    std::fs::write(&staged, json).map_err(failed)?;
    std::fs::rename(&staged, file).map_err(failed)?;

    Ok(RepoRulesEntry {
        repo,
        rules,
        file: file.display().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A checkout with a GitHub remote, in a temp dir, with a rules file
    /// beside it.
    fn checkout(remote: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("temp dir");
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).expect("repo dir");
        let git = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo)
                .output()
                .expect("git");
            assert!(status.status.success(), "{status:?}");
        };
        git(&["init", "-q"]);
        git(&["remote", "add", "origin", remote]);
        (dir, repo)
    }

    #[test]
    fn rules_are_kept_per_github_repository_whatever_the_checkout() {
        let (dir, repo) = checkout("git@github.com:Acme/Widgets.git");
        let (_other_dir, clone) = checkout("https://github.com/acme/widgets");
        let file = dir.path().join("config/repo-rules.json");

        let empty = load(&file, &repo).expect("no file yet");
        assert_eq!(empty.repo, "github.com/acme/widgets");
        assert_eq!(empty.rules, RepoRules::default());

        let rules = RepoRules {
            review: "Money is in cents.".into(),
            migrations: "Orders is a big table.".into(),
        };
        save(&file, &repo, rules.clone()).expect("save");
        assert_eq!(load(&file, &clone).expect("load").rules, rules);
    }

    #[test]
    fn saving_one_repository_leaves_the_others_alone() {
        let (dir, repo) = checkout("git@github.com:acme/widgets.git");
        let (_other_dir, other) = checkout("git@github.com:acme/gadgets.git");
        let file = dir.path().join("repo-rules.json");
        let rules = |text: &str| RepoRules {
            review: text.into(),
            migrations: String::new(),
        };

        save(&file, &repo, rules("widgets")).expect("save");
        save(&file, &other, rules("gadgets")).expect("save");
        assert_eq!(load(&file, &repo).expect("load").rules, rules("widgets"));

        // Emptied rules drop the repository's entry rather than keep a blank.
        save(&file, &other, RepoRules::default()).expect("save");
        let kept = std::fs::read_to_string(&file).expect("file");
        assert!(!kept.contains("gadgets"), "{kept}");
        assert!(kept.contains("widgets"), "{kept}");
    }

    #[test]
    fn a_file_that_cannot_be_read_is_an_error_not_an_empty_set() {
        let (dir, repo) = checkout("git@github.com:acme/widgets.git");
        let file = dir.path().join("repo-rules.json");
        std::fs::write(&file, "{ not json").expect("write");

        let err = load(&file, &repo).expect_err("corrupt");
        assert!(
            err.to_string().contains("Could not read the review rules"),
            "{err}"
        );
        save(&file, &repo, RepoRules::default()).expect_err("must not overwrite");
        assert_eq!(std::fs::read_to_string(&file).expect("file"), "{ not json");
    }

    #[test]
    fn a_checkout_without_a_github_remote_is_keyed_by_its_path() {
        let dir = tempfile::tempdir().expect("temp dir");
        let key = repo_key(dir.path());
        assert_eq!(
            key,
            dir.path()
                .canonicalize()
                .expect("canonical")
                .display()
                .to_string()
        );
    }
}
