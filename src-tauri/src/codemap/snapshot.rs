//! A repository's files at one commit, read from git objects without a checkout, or in the working tree.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::error::GitError;
use crate::git::{run_git, run_git_with_stdin};

/// Files larger than this are listed but not read: minified bundles, data dumps.
const MAX_READ_BYTES: u64 = 8 * 1024 * 1024;

pub(super) struct SnapshotFile {
    pub path: String,
    pub size: u64,
    /// `None` past `MAX_READ_BYTES`.
    pub contents: Option<Vec<u8>>,
}

/// The working tree as `git status` sees it: tracked files plus untracked ones not ignored.
pub(super) fn read_worktree(
    root: &Path,
    include: impl Fn(&str) -> bool,
) -> Result<Vec<SnapshotFile>, GitError> {
    let listed = run_git(
        root,
        &[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
    )?;
    let mut seen = HashSet::new();
    let mut files = Vec::new();
    for path in listed.split(|byte| *byte == 0) {
        let path = String::from_utf8_lossy(path).into_owned();
        if path.is_empty() || !include(&path) || !seen.insert(path.clone()) {
            continue;
        }
        let on_disk = root.join(&path);
        // Deleted but not staged, or a submodule's folder.
        let Ok(metadata) = std::fs::metadata(&on_disk) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let size = metadata.len();
        let contents = (size <= MAX_READ_BYTES)
            .then(|| std::fs::read(&on_disk).ok())
            .flatten();
        files.push(SnapshotFile {
            path,
            size,
            contents,
        });
    }
    Ok(files)
}

/// The blobs at `rev`, skipping symlinks and submodules.
pub(super) fn read_commit(
    root: &Path,
    rev: &str,
    include: impl Fn(&str) -> bool,
) -> Result<Vec<SnapshotFile>, GitError> {
    let listed = run_git(root, &["ls-tree", "-r", "-z", "--long", rev])?;
    let mut entries = Vec::new();
    for line in listed.split(|byte| *byte == 0) {
        let Some(tab) = line.iter().position(|byte| *byte == b'\t') else {
            continue;
        };
        let header = String::from_utf8_lossy(&line[..tab]);
        let path = String::from_utf8_lossy(&line[tab + 1..]).into_owned();
        let fields: Vec<&str> = header.split_whitespace().collect();
        let [mode, kind, sha, size] = fields[..] else {
            continue;
        };
        if kind != "blob" || mode == "120000" || !include(&path) {
            continue;
        }
        entries.push((path, sha.to_owned(), size.parse::<u64>().unwrap_or(0)));
    }

    let mut wanted: Vec<&str> = Vec::new();
    let mut requested = HashSet::new();
    for (_, sha, size) in &entries {
        if *size <= MAX_READ_BYTES && requested.insert(sha.as_str()) {
            wanted.push(sha);
        }
    }
    let blobs = read_blobs(root, &wanted)?;
    Ok(entries
        .into_iter()
        .map(|(path, sha, size)| SnapshotFile {
            contents: blobs.get(&sha).cloned(),
            path,
            size,
        })
        .collect())
}

/// Reads many blobs in one `git cat-file --batch`.
fn read_blobs(root: &Path, shas: &[&str]) -> Result<HashMap<String, Vec<u8>>, GitError> {
    let mut blobs = HashMap::new();
    if shas.is_empty() {
        return Ok(blobs);
    }
    let input = format!("{}\n", shas.join("\n"));
    let output = run_git_with_stdin(root, &["cat-file", "--batch"], input.as_bytes())?;
    let mut at = 0;
    while at < output.len() {
        let Some(newline) = output[at..].iter().position(|byte| *byte == b'\n') else {
            break;
        };
        let header = String::from_utf8_lossy(&output[at..at + newline]).into_owned();
        at += newline + 1;
        let fields: Vec<&str> = header.split(' ').collect();
        let [sha, _kind, size] = fields[..] else {
            // "<sha> missing"
            continue;
        };
        let size: usize = size
            .parse()
            .map_err(|_| GitError::Command(format!("unexpected cat-file header: {header}")))?;
        let end = (at + size).min(output.len());
        blobs.insert(sha.to_owned(), output[at..end].to_vec());
        // The blob, then the newline that ends its record.
        at = end + 1;
    }
    Ok(blobs)
}
