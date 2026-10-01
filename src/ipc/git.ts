/**
 * Typed wrappers over the Rust git commands.
 *
 * These types mirror the serde structs in `src-tauri/src/git.rs` one for one.
 * Nothing here touches the UI, so the same shapes can feed an LLM analysis layer
 * later without going through React.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type ChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typeChanged"
  | "unmerged"
  | "unknown";

export interface FileChange {
  path: string;
  /** Present for renames and copies. */
  oldPath: string | null;
  status: ChangeStatus;
  additions: number;
  deletions: number;
  isBinary: boolean;
  /** Marked `linguist-generated` in the compare revision's gitattributes. */
  isGenerated: boolean;
}

export interface DiffSummary {
  /** Commit the comparison is anchored to — the merge base of the two refs. */
  mergeBase: string;
  /**
   * Commit the compare ref resolved to, or `null` for the working tree. A ref
   * name keeps its identity across a push, so this is what tells the viewer that
   * what it has rendered and cached is no longer what the ref points at.
   */
  compareHead: string | null;
  files: FileChange[];
  totalAdditions: number;
  totalDeletions: number;
}

/** One commit of a comparison, as the commit list shows it. */
export interface Commit {
  sha: string;
  /** The first line of the message. */
  subject: string;
  author: string;
  /**
   * Committer date, ISO 8601: when the commit took its current form, which a
   * rebase or an amend moves along with the commit itself.
   */
  committedAt: string;
}

/** The commits a comparison is made of, newest first. */
export interface CommitLog {
  commits: Commit[];
  /** There were more than the backend lists, and only the newest are here. */
  truncated: boolean;
}

export interface RepoInfo {
  root: string;
  name: string;
  /** `null` when HEAD is detached. */
  currentBranch: string | null;
  defaultBranch: string | null;
  /** Who `gh` is signed in as on the repository's GitHub host; `null` with none. */
  githubLogin: string | null;
}

export interface Branch {
  name: string;
  isRemote: boolean;
  isHead: boolean;
}

/**
 * Full contents of both sides of a file. `null` means the file does not exist on
 * that side, which is normal for an addition or a deletion.
 */
export interface FileVersions {
  old: string | null;
  new: string | null;
}

/** One problem the reviewer found, anchored to a file (and lines, when it has them). */
export interface ReviewFinding {
  /** Path as it appears in the diff's compare side. */
  path: string;
  /** New-file line number — the first, for a span — or `null` for whole-file findings. */
  line: number | null;
  /**
   * Last new-file line of a finding that spans several; `null` (or absent, on
   * reviews stored before spans existed) for a single line or the whole file.
   */
  endLine?: number | null;
  /** critical | warning | suggestion | nit — written by the model, so treat as a label. */
  severity: string;
  title: string;
  body: string;
  /** GitHub URL after this finding was sent to the PR. */
  postedUrl?: string;
  /** ISO timestamp for the most recent post. */
  postedAt?: string;
}

/** The three ways GitHub lets a review finish, spelled as the agent recommends them. */
export type ReviewVerdict = "approve" | "comment" | "request_changes";

/** A review submitted to GitHub from its conclusion. */
export interface SubmittedReview {
  url: string;
  verdict: ReviewVerdict;
  /** ISO timestamp of the submission. */
  at: string;
}

export interface ReviewResult {
  summary: string;
  findings: ReviewFinding[];
  /**
   * The GitHub review the agent recommends — model-written, so anything but a
   * `ReviewVerdict` is possible. Empty or absent on reviews from before it
   * was asked for.
   */
  verdict?: string;
  /** A draft body for that GitHub review, addressed to the author. */
  conclusion?: string;
  /** GitHub URL after the review-level note was sent to the PR. */
  postedUrl?: string;
  /** ISO timestamp for the most recent review-level post. */
  postedAt?: string;
  /** Set once the conclusion was submitted as a GitHub review. */
  submitted?: SubmittedReview;
  /**
   * The agent ran out of turns and answered from what it had read by then, so
   * the review may have gaps.
   */
  cutShort?: boolean;
}

/** The re-review's verdict on one finding from the previous review. */
export interface FindingResolution {
  /** Index into the prior findings list the re-review was given. */
  index: number;
  /** addressed | unaddressed | partial | obsolete — written by the model, so treat as a label. */
  status: string;
  /** What the verdict is grounded in — the fix found, or what still remains. */
  note: string;
}

export interface ReReviewResult {
  summary: string;
  /** One entry per prior finding, in principle; gaps and bad indices are the model's to make. */
  resolutions: FindingResolution[];
  /** New problems only — the prior findings are covered by `resolutions`. */
  findings: ReviewFinding[];
  /** As on `ReviewResult`, weighing the prior findings still open too. */
  verdict?: string;
  conclusion?: string;
  cutShort?: boolean;
}

/** A short note on what one file's changes are for, shown at the top of it in the diff. */
export interface FileExplanation {
  /** Path as it appears in the diff's compare side, matching `ReviewFinding`. */
  path: string;
  explanation: string;
}

export interface ExplainResult {
  /** The walkthrough of the whole change, for the explain panel. */
  overall: string;
  /** Notes for the files that benefit from one; the rest are left out. */
  files: FileExplanation[];
  /** As on `ReviewResult`. Absent on explanations stored before it was recorded. */
  cutShort?: boolean;
}

/** One existing GitHub conversation or inline review comment on an open PR. */
export interface PrComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  path: string | null;
  line: number | null;
  outdated: boolean;
}

/** GitHub metadata bound to the comparison configured by an open PR. */
export interface PrContext {
  url: string;
  number: number;
  title: string;
  body: string;
  author: string;
  state: string;
  isDraft: boolean;
  baseRef: string;
  baseRemote: string;
  /** The PR's branch as GitHub names it; the diff reads `compareRef` instead. */
  headRef: string;
  headSha: string;
  compareRef: string;
  comments: PrComment[];
}

/** One row of the pull-request list: enough to recognise, search and choose between. */
/** A GitHub label: `color` is six hex digits, without the `#`. */
export interface PrLabel {
  name: string;
  color: string;
}

export interface PrSummary {
  number: number;
  title: string;
  author: string;
  isDraft: boolean;
  url: string;
  labels: PrLabel[];
  headRef: string;
  baseRef: string;
  /** The head branch lives in a fork, so it cannot be another PR's base. */
  isCrossRepository: boolean;
  headSha: string;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** `APPROVED`, `CHANGES_REQUESTED` or `REVIEW_REQUIRED`; `null` when no review is required. */
  reviewDecision: string | null;
}

/** Which open pull requests to list, relative to the signed-in `gh` account. */
export type PrListFilter = "all" | "reviewRequested" | "mine";

export interface RefreshPrResult {
  pr: PrContext;
  headMoved: boolean;
}

/** GitHub endpoint selected after checking a finding's location in the patch. */
export type PrCommentDestination = "inline" | "file" | "topLevel";

export interface PostedPrComment {
  url: string;
}

export interface GitHubImage {
  contentType: string;
  /** Base64-encoded image bytes returned by the authenticated GitHub CLI. */
  data: string;
}

/** One entry of a finding's (or the review's) comment thread. */
export interface ReviewComment {
  author: "user" | "agent";
  text: string;
  /** ISO timestamp — display plus a stable key. */
  at: string;
}

/** Which agent CLI runs the review. */
export type ReviewEngine = "claude" | "codex";

export interface ModelOption {
  /** What the CLI's model flag accepts. */
  id: string;
  /** Human name from the catalog, e.g. "Fable 5.1". */
  label: string;
}

/** The model catalog an engine's CLI has cached on disk. */
export interface EngineModels {
  models: ModelOption[];
  /** Effort levels any listed model accepts, in the catalog's order. */
  efforts: string[];
}

export type GitErrorKind =
  | "gitNotFound"
  | "claudeNotFound"
  | "codexNotFound"
  | "ghNotFound"
  | "notARepo"
  | "badRevision"
  | "command"
  /** The page cancelled the agent run; nothing went wrong. */
  | "cancelled";

export interface GitError {
  kind: GitErrorKind;
  message: string;
  /** The raw output behind `message`, for debugging; null when the message is all there is. */
  detail?: string | null;
}

/** A failure ready to show: what went wrong in words, and the raw record behind it. */
export interface AppError {
  /** What failed, as a heading: "The review failed". Null when the message says it all. */
  title: string | null;
  message: string;
  /** Output, log or trace for debugging, kept out of sight until asked for. */
  detail: string | null;
}

export function isGitError(value: unknown): value is GitError {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "message" in value &&
    typeof (value as GitError).message === "string"
  );
}

/** An agent run that ended because it was cancelled, which is no failure to show. */
export function isCancelled(value: unknown): boolean {
  return isGitError(value) && value.kind === "cancelled";
}

/** Turns whatever `invoke` rejected with into something worth showing a person. */
export function errorMessage(value: unknown): string {
  if (isGitError(value)) {
    switch (value.kind) {
      case "gitNotFound":
        return "Could not find git. Install it or make sure it is on your PATH.";
      case "claudeNotFound":
        return "Could not find the claude CLI. Install Claude Code and make sure `claude` is on your PATH.";
      case "codexNotFound":
        return "Could not find the codex CLI. Install it with `npm i -g @openai/codex` (it reuses your ChatGPT sign-in).";
      case "ghNotFound":
        return "Could not find the GitHub CLI. Install it from cli.github.com, then run `gh auth login`.";
      case "notARepo":
        return `That folder is not a git repository.\n${value.message}`;
      default:
        return value.message || "git reported an unknown failure.";
    }
  }
  if (value instanceof Error) return value.message;
  return String(value);
}

/** Lines of a message shown before the rest moves into the detail. */
const MESSAGE_LINES = 4;

/** `errorMessage`, keeping whatever raw detail came with the failure. */
export function toAppError(value: unknown, title: string | null = null): AppError {
  const message = errorMessage(value).trim();
  const detail = isGitError(value)
    ? (value.detail ?? null)
    : value instanceof Error
      ? (value.stack ?? null)
      : null;
  if (detail?.trim()) return { title, message, detail: detail.trim() };

  // A long message with no detail is raw output, git's stderr say, where the
  // line that matters is often last, under the hints. Lead with its fatal and
  // error lines, and keep the whole of it as the detail.
  const lines = message.split("\n");
  if (lines.length <= MESSAGE_LINES) return { title, message, detail: null };
  const errors = lines.filter((line) => /^(fatal|error): /i.test(line));
  const lead = errors.length > 0 ? errors : [...lines.slice(0, MESSAGE_LINES), "…"];
  return { title, message: lead.join("\n"), detail: message };
}

export const gitApi = {
  selectRepo: (path: string) => invoke<RepoInfo>("select_repo", { path }),

  /**
   * Models and effort levels the engine's CLI currently offers, read from the
   * catalog it caches locally; `null` when no cache exists. Reads a file, so
   * quick — but it only knows what the CLI last fetched.
   */
  listAgentModels: (engine: ReviewEngine) =>
    invoke<EngineModels | null>("list_agent_models", { engine }),

  listBranches: (root: string) => invoke<Branch[]>("list_branches", { root }),

  /** `git fetch --all --prune` — contacts every remote, so as slow as the network. */
  fetchRemotes: (root: string) => invoke<void>("fetch_remotes", { root }),

  /** Open PRs on the repository this checkout's remotes point at, through `gh`. */
  listPrs: (root: string, filter: PrListFilter = "all") =>
    invoke<PrSummary[]>("list_prs", { root, filter }),

  /**
   * Opens a GitHub PR and fetches its head to a stable local review ref. `keep`
   * is the other PRs open in tabs: every other PR's ref is pruned.
   */
  openPr: (root: string, url: string, keep: number[]) =>
    invoke<PrContext>("open_pr", { root, url, keep }),

  /** Re-reads PR metadata and conversation, updating the fetched head ref. */
  refreshPr: (root: string, pr: PrContext, keep: number[]) =>
    invoke<RefreshPrResult>("refresh_pr", { root, pr, keep }),

  /** Posts through the user's authenticated `gh` CLI; no token enters the app. */
  postPrComment: (args: {
    root: string;
    pr: PrContext;
    body: string;
    path: string | null;
    line: number | null;
    /** Where an inline comment's span ends; `null` for a single line. */
    endLine: number | null;
    destination: PrCommentDestination;
  }) => invoke<PostedPrComment>("post_pr_comment", { ...args }),

  /** Submits a GitHub review — approve, comment, or request changes — through `gh`. */
  submitPrReview: (args: { pr: PrContext; verdict: ReviewVerdict; body: string }) =>
    invoke<PostedPrComment>("submit_pr_review", { ...args }),

  /** Loads GitHub's auth-protected Markdown attachments for desktop rendering. */
  getGitHubImage: (url: string) => invoke<GitHubImage>("get_github_image", { url }),

  /** A `null` compare reviews the working tree, uncommitted changes included. */
  diffBranches: (root: string, base: string, compare: string | null) =>
    invoke<DiffSummary>("diff_branches", { root, base, compare }),

  /** The unified diff for the whole range; the renderer splits it per file. */
  getPatch: (root: string, mergeBase: string, compare: string | null) =>
    invoke<string>("get_patch", { root, mergeBase, compare }),

  /** The commits since the merge base; a `null` compare lists the ones under the working tree. */
  listCommits: (root: string, mergeBase: string, compare: string | null) =>
    invoke<CommitLog>("list_commits", { root, mergeBase, compare }),

  /**
   * Reviews the whole comparison with an agent CLI. Slow — it runs an agentic
   * session that reads real files — so callers should show progress. A `null`
   * model uses whatever the CLI itself is configured to default to.
   *
   * Every agent run takes a `runId` the caller makes up, which is what
   * `cancelAgentRun` and `onAgentRunOutput` know it by.
   */
  reviewDiff: (
    runId: string,
    root: string,
    mergeBase: string,
    compare: string | null,
    engine: ReviewEngine,
    model: string | null,
    effort: string | null,
    prContext: PrContext | null,
  ) =>
    invoke<ReviewResult>("review_diff", {
      runId,
      root,
      mergeBase,
      compare,
      engine,
      model,
      effort,
      prContext,
    }),

  /**
   * Re-reviews the comparison against an earlier review: a verdict per prior
   * finding, plus new findings from a fresh read of the current diff. One
   * agent run, as slow as `reviewDiff`.
   */
  reReviewDiff: (args: {
    runId: string;
    root: string;
    mergeBase: string;
    compare: string | null;
    engine: ReviewEngine;
    model: string | null;
    effort: string | null;
    priorSummary: string;
    priorFindings: ReviewFinding[];
    prContext: PrContext | null;
  }) => invoke<ReReviewResult>("re_review_diff", { ...args }),

  /**
   * Explains the comparison in plain language: a walkthrough of the whole
   * change, plus a note for each file that benefits from one. An agent run of
   * its own, independent of any review, and just as slow.
   */
  explainDiff: (
    runId: string,
    root: string,
    mergeBase: string,
    compare: string | null,
    engine: ReviewEngine,
    model: string | null,
    effort: string | null,
    prContext: PrContext | null,
  ) =>
    invoke<ExplainResult>("explain_diff", {
      runId,
      root,
      mergeBase,
      compare,
      engine,
      model,
      effort,
      prContext,
    }),

  /**
   * Answers a follow-up comment on a stored review, in the reviewer's voice.
   * Stateless: the summary, finding, and thread ride along on every call, so
   * it works after restarts. Returns the reply text.
   */
  reviewReply: (args: {
    runId: string;
    root: string;
    mergeBase: string;
    compare: string | null;
    engine: ReviewEngine;
    model: string | null;
    effort: string | null;
    summary: string;
    finding: ReviewFinding | null;
    thread: ReviewComment[];
    comment: string;
    prContext: PrContext | null;
  }) => invoke<string>("review_reply", { ...args }),

  /**
   * Stops an agent run: its CLI and everything it started. The run's own call
   * then rejects with a `cancelled` error (`isCancelled`).
   */
  cancelAgentRun: (runId: string) => invoke<void>("cancel_agent_run", { runId }),

  /**
   * Stops every agent run the backend has in flight. For page load: a reloaded
   * page has lost whatever the last one was waiting on.
   */
  abandonAgentRuns: () => invoke<void>("abandon_agent_runs"),

  /**
   * Calls `handler` with a run's id whenever its CLI writes something, at most
   * once a second per run. Resolves to the function that stops listening.
   */
  onAgentRunOutput: (handler: (runId: string) => void) =>
    listen<string>("agent-run-output", (event) => handler(event.payload)),

  /**
   * Full contents of both sides. Only needed when the reader expands context
   * beyond what the patch carries — the patch itself covers normal review.
   */
  getFileVersions: (
    root: string,
    mergeBase: string,
    compare: string | null,
    file: Pick<FileChange, "path" | "oldPath">,
  ) =>
    invoke<FileVersions>("get_file_versions", {
      root,
      mergeBase,
      compare,
      path: file.path,
      oldPath: file.oldPath,
    }),
};
