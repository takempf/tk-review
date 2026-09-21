/**
 * Typed wrappers over the Rust git commands.
 *
 * These types mirror the serde structs in `src-tauri/src/git.rs` one for one.
 * Nothing here touches the UI, so the same shapes can feed an LLM analysis layer
 * later without going through React.
 */
import { invoke } from "@tauri-apps/api/core";

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

export interface RepoInfo {
  root: string;
  name: string;
  /** `null` when HEAD is detached. */
  currentBranch: string | null;
  defaultBranch: string | null;
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

/** One problem the reviewer found, anchored to a file (and line, when it has one). */
export interface ReviewFinding {
  /** Path as it appears in the diff's compare side. */
  path: string;
  /** New-file line number, or `null` for whole-file findings. */
  line: number | null;
  /** critical | warning | suggestion | nit — written by the model, so treat as a label. */
  severity: string;
  title: string;
  body: string;
  /** GitHub URL after this finding was sent to the PR. */
  postedUrl?: string;
  /** ISO timestamp for the most recent post. */
  postedAt?: string;
}

export interface ReviewResult {
  summary: string;
  findings: ReviewFinding[];
  /** GitHub URL after the review-level note was sent to the PR. */
  postedUrl?: string;
  /** ISO timestamp for the most recent review-level post. */
  postedAt?: string;
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
}

/** Plain-language account of one file's part in the change. */
export interface FileExplanation {
  /** Path as it appears in the diff's compare side, matching `ReviewFinding`. */
  path: string;
  explanation: string;
}

export interface ExplainResult {
  /** What the whole change does, as a readable paragraph or two. */
  overall: string;
  files: FileExplanation[];
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
  headSha: string;
  compareRef: string;
  comments: PrComment[];
}

/** One row of the pull-request picker: enough to recognise and to search. */
export interface PrSummary {
  number: number;
  title: string;
  author: string;
  isDraft: boolean;
  url: string;
}

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
  | "command";

export interface GitError {
  kind: GitErrorKind;
  message: string;
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
  listPrs: (root: string) => invoke<PrSummary[]>("list_prs", { root }),

  /** Opens a GitHub PR and fetches its head to a stable local review ref. */
  openPr: (root: string, url: string) => invoke<PrContext>("open_pr", { root, url }),

  /** Re-reads PR metadata and conversation, updating the fetched head ref. */
  refreshPr: (root: string, pr: PrContext) => invoke<RefreshPrResult>("refresh_pr", { root, pr }),

  /** Posts through the user's authenticated `gh` CLI; no token enters the app. */
  postPrComment: (args: {
    root: string;
    pr: PrContext;
    body: string;
    path: string | null;
    line: number | null;
    destination: PrCommentDestination;
  }) => invoke<PostedPrComment>("post_pr_comment", { ...args }),

  /** Loads GitHub's auth-protected Markdown attachments for desktop rendering. */
  getGitHubImage: (url: string) => invoke<GitHubImage>("get_github_image", { url }),

  /** A `null` compare reviews the working tree, uncommitted changes included. */
  diffBranches: (root: string, base: string, compare: string | null) =>
    invoke<DiffSummary>("diff_branches", { root, base, compare }),

  /** The unified diff for the whole range; the renderer splits it per file. */
  getPatch: (root: string, mergeBase: string, compare: string | null) =>
    invoke<string>("get_patch", { root, mergeBase, compare }),

  /**
   * Reviews the whole comparison with an agent CLI. Slow — it runs an agentic
   * session that reads real files — so callers should show progress. A `null`
   * model uses whatever the CLI itself is configured to default to.
   */
  reviewDiff: (
    root: string,
    mergeBase: string,
    compare: string | null,
    engine: ReviewEngine,
    model: string | null,
    effort: string | null,
    prContext: PrContext | null,
  ) =>
    invoke<ReviewResult>("review_diff", {
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
   * Explains the comparison in plain language — an overview plus one entry per
   * file. A separate agent run from `reviewDiff` and just as slow, so callers
   * run the two concurrently rather than in sequence.
   */
  explainDiff: (
    root: string,
    mergeBase: string,
    compare: string | null,
    engine: ReviewEngine,
    model: string | null,
    effort: string | null,
    prContext: PrContext | null,
  ) =>
    invoke<ExplainResult>("explain_diff", {
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
