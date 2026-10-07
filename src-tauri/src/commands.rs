//! Tauri command surface.
//!
//! Every command hands its git work to the blocking pool: git is synchronous and
//! can take a noticeable moment on a large repository, which would otherwise
//! stall the async runtime.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::GitError;
use crate::git::{self, Branch, CommitLog, DiffSummary, FileVersions, RepoInfo};
use crate::github::{
    self, PostedPrComment, PrCommentDestination, PrContext, PrListFilter, PrPage, PrReviewVerdict,
    PrThread, RefreshPrResult,
};
use crate::models::{self, EngineModels};
use crate::review::{
    self, ExplainResult, ReReviewResult, ReviewFinding, ReviewResult, ThreadComment,
};
use crate::rules::{self, RepoRules, RepoRulesEntry};
use crate::runs::{AgentRun, AgentRuns};

async fn blocking<T, F>(task: F) -> Result<T, GitError>
where
    F: FnOnce() -> Result<T, GitError> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|err| GitError::Command(format!("git task failed to run: {err}")))?
}

/// Registers an agent run under the page's id, so the page can cancel it, and
/// tells the page (`agent-run-output`, carrying the id) whenever its CLI writes
/// something, so the page can show that the run is still alive.
fn agent_run(app: &AppHandle, runs: &AgentRuns, run_id: String) -> AgentRun {
    let app = app.clone();
    let id = run_id.clone();
    runs.start(run_id, move || {
        let _ = app.emit("agent-run-output", &id);
    })
}

/// The file the review rules for every repository are kept in, in the app's
/// config directory.
fn rules_file(app: &AppHandle) -> Result<PathBuf, GitError> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("repo-rules.json"))
        .map_err(|err| GitError::Command(format!("could not find the app's config folder: {err}")))
}

/// The review rules kept on this machine for the repository at `root`.
#[tauri::command]
pub async fn get_repo_rules(app: AppHandle, root: String) -> Result<RepoRulesEntry, GitError> {
    let file = rules_file(&app)?;
    blocking(move || rules::load(&file, Path::new(&root))).await
}

/// Replaces the review rules kept for the repository at `root`.
#[tauri::command]
pub async fn set_repo_rules(
    app: AppHandle,
    root: String,
    rules: RepoRules,
) -> Result<RepoRulesEntry, GitError> {
    let file = rules_file(&app)?;
    blocking(move || rules::save(&file, Path::new(&root), rules)).await
}

#[tauri::command]
pub async fn select_repo(path: String) -> Result<RepoInfo, GitError> {
    blocking(move || {
        let mut repo = git::select_repo(&PathBuf::from(path))?;
        repo.github_login = github::signed_in_login(Path::new(&repo.root));
        Ok(repo)
    })
    .await
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
pub async fn list_prs(
    root: String,
    filter: PrListFilter,
    after: Option<String>,
) -> Result<PrPage, GitError> {
    blocking(move || github::list_prs(&PathBuf::from(root), filter, after.as_deref())).await
}

#[tauri::command]
pub async fn open_pr(root: String, url: String, keep: Vec<u64>) -> Result<PrContext, GitError> {
    blocking(move || github::open_pr(&PathBuf::from(root), &url, &keep)).await
}

#[tauri::command]
pub async fn refresh_pr(
    root: String,
    pr: PrContext,
    keep: Vec<u64>,
) -> Result<RefreshPrResult, GitError> {
    blocking(move || github::refresh_pr(&PathBuf::from(root), &pr, &keep)).await
}

#[tauri::command]
pub async fn post_pr_comment(
    root: String,
    pr: PrContext,
    body: String,
    path: Option<String>,
    line: Option<u32>,
    end_line: Option<u32>,
    destination: PrCommentDestination,
    old_side: Option<bool>,
    reply_to: Option<u64>,
) -> Result<PostedPrComment, GitError> {
    blocking(move || {
        github::post_pr_comment(
            &PathBuf::from(root),
            &pr,
            &body,
            path.as_deref(),
            line,
            end_line,
            destination,
            old_side.unwrap_or(false),
            reply_to,
        )
    })
    .await
}

#[tauri::command]
pub async fn pr_discussion(
    pr: PrContext,
) -> Result<(Vec<github::PrComment>, Vec<PrThread>), GitError> {
    blocking(move || github::pr_discussion(&pr)).await
}

/// Finishes a review on GitHub: approve, comment, or request changes.
#[tauri::command]
pub async fn submit_pr_review(
    pr: PrContext,
    verdict: PrReviewVerdict,
    body: String,
) -> Result<PostedPrComment, GitError> {
    blocking(move || github::submit_pr_review(&pr, verdict, &body)).await
}

/// Resolves a review thread on GitHub, or reopens one, through `gh`.
#[tauri::command]
pub async fn set_pr_thread_resolved(
    pr: PrContext,
    thread_id: String,
    resolved: bool,
) -> Result<PrThread, GitError> {
    blocking(move || github::set_thread_resolved(&pr, &thread_id, resolved)).await
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

/// The commits on the compare side since the merge base; a `None` compare
/// lists the ones under the working tree.
#[tauri::command]
pub async fn list_commits(
    root: String,
    merge_base: String,
    compare: Option<String>,
) -> Result<CommitLog, GitError> {
    blocking(move || git::list_commits(&PathBuf::from(root), &merge_base, compare.as_deref())).await
}

/// Reviews the comparison with an agent CLI (`claude` or `codex`). Slow — an
/// agentic session reading real files — so it runs on the blocking pool like
/// everything else. A `None` model or effort uses the CLI's own default.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn review_diff(
    app: AppHandle,
    runs: State<'_, AgentRuns>,
    run_id: String,
    root: String,
    merge_base: String,
    compare: Option<String>,
    engine: String,
    model: Option<String>,
    effort: Option<String>,
    pr_context: Option<PrContext>,
) -> Result<ReviewResult, GitError> {
    let rules_file = rules_file(&app)?;
    let run = agent_run(&app, &runs, run_id);
    blocking(move || {
        let root = PathBuf::from(root);
        let rules = rules::load(&rules_file, &root)?.rules;
        review::review_diff(
            &root,
            &merge_base,
            compare.as_deref(),
            &engine,
            model.as_deref(),
            effort.as_deref(),
            pr_context.as_ref(),
            &rules,
            &run,
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
    app: AppHandle,
    runs: State<'_, AgentRuns>,
    run_id: String,
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
    let rules_file = rules_file(&app)?;
    let run = agent_run(&app, &runs, run_id);
    blocking(move || {
        let root = PathBuf::from(root);
        let rules = rules::load(&rules_file, &root)?.rules;
        review::re_review_diff(
            &root,
            &merge_base,
            compare.as_deref(),
            &engine,
            model.as_deref(),
            effort.as_deref(),
            &prior_summary,
            &prior_findings,
            pr_context.as_ref(),
            &rules,
            &run,
        )
    })
    .await
}

/// Explains the comparison in plain language: a walkthrough plus a note for
/// each file that needs one. Runs the same agent CLIs as `review_diff`, and
/// just as slowly.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn explain_diff(
    app: AppHandle,
    runs: State<'_, AgentRuns>,
    run_id: String,
    root: String,
    merge_base: String,
    compare: Option<String>,
    engine: String,
    model: Option<String>,
    effort: Option<String>,
    pr_context: Option<PrContext>,
) -> Result<ExplainResult, GitError> {
    let run = agent_run(&app, &runs, run_id);
    blocking(move || {
        review::explain_diff(
            &PathBuf::from(root),
            &merge_base,
            compare.as_deref(),
            &engine,
            model.as_deref(),
            effort.as_deref(),
            pr_context.as_ref(),
            &run,
        )
    })
    .await
}

/// Answers a follow-up comment on a stored review, in the reviewer's voice.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn review_reply(
    app: AppHandle,
    runs: State<'_, AgentRuns>,
    run_id: String,
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
    let run = agent_run(&app, &runs, run_id);
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
            &run,
        )
    })
    .await
}

/// Stops an agent run the page started. The run's own command then fails
/// with a `cancelled` error, which the page treats as no error at all.
#[tauri::command]
pub fn cancel_agent_run(runs: State<'_, AgentRuns>, run_id: String) {
    runs.cancel(&run_id);
}

/// Stops every agent run. The page calls this as it loads: a reloaded page has
/// lost whatever the one before it was waiting on, and could never receive or
/// save the results.
#[tauri::command]
pub fn abandon_agent_runs(runs: State<'_, AgentRuns>) {
    runs.cancel_all();
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
