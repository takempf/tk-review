//! Tauri command surface.
//!
//! Every command hands its git work to the blocking pool: git is synchronous and
//! can take a noticeable moment on a large repository, which would otherwise
//! stall the async runtime.

use std::path::PathBuf;

use crate::error::GitError;
use crate::git::{self, Branch, DiffSummary, FileVersions, RepoInfo};
use crate::github::{
    self, PostedPrComment, PrCommentDestination, PrContext, PrSummary, RefreshPrResult,
};
use crate::models::{self, EngineModels};
use crate::review::{self, ExplainResult, ReReviewResult, ReviewFinding, ReviewResult, ThreadComment};

async fn blocking<T, F>(task: F) -> Result<T, GitError>
where
    F: FnOnce() -> Result<T, GitError> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|err| GitError::Command(format!("git task failed to run: {err}")))?
}

#[tauri::command]
pub async fn select_repo(path: String) -> Result<RepoInfo, GitError> {
    blocking(move || git::select_repo(&PathBuf::from(path))).await
}

#[tauri::command]
pub async fn list_branches(root: String) -> Result<Vec<Branch>, GitError> {
    blocking(move || git::list_branches(&PathBuf::from(root))).await
}

/// Contacts every remote, so it can take as long as the network does.
#[tauri::command]
pub async fn fetch_remotes(root: String) -> Result<(), GitError> {
    blocking(move || git::fetch_remotes(&PathBuf::from(root))).await
}

/// Talks to GitHub through `gh`, so it costs a network round trip.
#[tauri::command]
pub async fn list_prs(root: String) -> Result<Vec<PrSummary>, GitError> {
    blocking(move || github::list_prs(&PathBuf::from(root))).await
}

#[tauri::command]
pub async fn open_pr(root: String, url: String) -> Result<PrContext, GitError> {
    blocking(move || github::open_pr(&PathBuf::from(root), &url)).await
}

#[tauri::command]
pub async fn refresh_pr(root: String, pr: PrContext) -> Result<RefreshPrResult, GitError> {
    blocking(move || github::refresh_pr(&PathBuf::from(root), &pr)).await
}

#[tauri::command]
pub async fn post_pr_comment(
    root: String,
    pr: PrContext,
    body: String,
    path: Option<String>,
    line: Option<u32>,
    destination: PrCommentDestination,
) -> Result<PostedPrComment, GitError> {
    blocking(move || {
        github::post_pr_comment(
            &PathBuf::from(root),
            &pr,
            &body,
            path.as_deref(),
            line,
            destination,
        )
    })
    .await
}

/// Loads a GitHub-hosted Markdown attachment through the user's authenticated
/// `gh` session. GitHub returns these attachments as 404s to unauthenticated
/// clients, which includes the desktop WebView.
#[tauri::command]
pub async fn get_github_image(url: String) -> Result<github::GitHubImage, GitError> {
    blocking(move || github::get_github_image(&url)).await
}

/// A `None` compare means the working tree, uncommitted changes included.
#[tauri::command]
pub async fn diff_branches(
    root: String,
    base: String,
    compare: Option<String>,
) -> Result<DiffSummary, GitError> {
    blocking(move || git::diff_branches(&PathBuf::from(root), &base, compare.as_deref())).await
}

#[tauri::command]
pub async fn get_patch(
    root: String,
    merge_base: String,
    compare: Option<String>,
) -> Result<String, GitError> {
    blocking(move || git::get_patch(&PathBuf::from(root), &merge_base, compare.as_deref())).await
}

/// Reviews the comparison with an agent CLI (`claude` or `codex`). Slow — an
/// agentic session reading real files — so it runs on the blocking pool like
/// everything else. A `None` model or effort uses the CLI's own default.
#[tauri::command]
pub async fn review_diff(
    root: String,
    merge_base: String,
    compare: Option<String>,
    engine: String,
    model: Option<String>,
    effort: Option<String>,
    pr_context: Option<PrContext>,
) -> Result<ReviewResult, GitError> {
    blocking(move || {
        review::review_diff(
            &PathBuf::from(root),
            &merge_base,
            compare.as_deref(),
            &engine,
            model.as_deref(),
            effort.as_deref(),
            pr_context.as_ref(),
        )
    })
    .await
}

/// Re-reviews the comparison against an earlier review: judges whether each
/// prior finding was addressed, then reviews the current diff for new issues.
/// One agent run, as slow as `review_diff`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn re_review_diff(
    root: String,
    merge_base: String,
    compare: Option<String>,
    engine: String,
    model: Option<String>,
    effort: Option<String>,
    prior_summary: String,
    prior_findings: Vec<ReviewFinding>,
    pr_context: Option<PrContext>,
) -> Result<ReReviewResult, GitError> {
    blocking(move || {
        review::re_review_diff(
            &PathBuf::from(root),
            &merge_base,
            compare.as_deref(),
            &engine,
            model.as_deref(),
            effort.as_deref(),
            &prior_summary,
            &prior_findings,
            pr_context.as_ref(),
        )
    })
    .await
}

/// Explains the comparison in plain language — an overview plus one entry per
/// file. Runs the same agent CLIs as `review_diff`, and just as slowly.
#[tauri::command]
pub async fn explain_diff(
    root: String,
    merge_base: String,
    compare: Option<String>,
    engine: String,
    model: Option<String>,
    effort: Option<String>,
    pr_context: Option<PrContext>,
) -> Result<ExplainResult, GitError> {
    blocking(move || {
        review::explain_diff(
            &PathBuf::from(root),
            &merge_base,
            compare.as_deref(),
            &engine,
            model.as_deref(),
            effort.as_deref(),
            pr_context.as_ref(),
        )
    })
    .await
}

/// Answers a follow-up comment on a stored review, in the reviewer's voice.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn review_reply(
    root: String,
    merge_base: String,
    compare: Option<String>,
    engine: String,
    model: Option<String>,
    effort: Option<String>,
    summary: String,
    finding: Option<ReviewFinding>,
    thread: Vec<ThreadComment>,
    comment: String,
    pr_context: Option<PrContext>,
) -> Result<String, GitError> {
    blocking(move || {
        review::review_reply(
            &PathBuf::from(root),
            &merge_base,
            compare.as_deref(),
            &engine,
            model.as_deref(),
            effort.as_deref(),
            &summary,
            finding.as_ref(),
            &thread,
            &comment,
            pr_context.as_ref(),
        )
    })
    .await
}

#[tauri::command]
pub async fn get_file_versions(
    root: String,
    merge_base: String,
    compare: Option<String>,
    path: String,
    old_path: Option<String>,
) -> Result<FileVersions, GitError> {
    blocking(move || {
        git::get_file_versions(
            &PathBuf::from(root),
            &merge_base,
            compare.as_deref(),
            &path,
            old_path.as_deref(),
        )
    })
    .await
}

/// The model catalog the engine's CLI has cached on disk, or `None` when there
/// is none — the frontend then keeps its built-in suggestions.
#[tauri::command]
pub async fn list_agent_models(engine: String) -> Result<Option<EngineModels>, GitError> {
    blocking(move || Ok(models::agent_models(&engine))).await
}
