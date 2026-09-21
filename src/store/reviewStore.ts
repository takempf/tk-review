import { create } from "zustand";
import {
  type Branch,
  type DiffSummary,
  type ExplainResult,
  errorMessage,
  gitApi,
  type PrCommentDestination,
  type PrContext,
  type RepoInfo,
  type ReviewComment,
  type ReviewEngine,
  type ReviewFinding,
  type ReviewResult,
} from "../ipc/git";

/** One prior finding paired with the re-review's verdict on it. */
export interface ResolvedFinding {
  finding: ReviewFinding;
  /** addressed | unaddressed | partial | obsolete — model-written, so a label.
   * `"unknown"` is ours, for a prior finding the re-review failed to mention. */
  status: string;
  note: string;
}

/** A review as kept for a comparison: the result plus everything around it. */
export interface StoredReview {
  review: ReviewResult;
  /**
   * Present after a re-review: every finding of the review this one replaced,
   * each with a verdict on whether it was addressed.
   */
  resolutions?: ResolvedFinding[];
  engine: ReviewEngine;
  /** `null` means the CLI's configured default at the time. */
  model: string | null;
  /** Reasoning effort the review ran at; `null` means the CLI's default. */
  effort?: string | null;
  /** The commit the reviewed diff was anchored to. */
  mergeBase: string;
  /** ISO timestamp of when the review finished. */
  createdAt: string;
  /** Comment threads, keyed by finding (or `REVIEW_THREAD_KEY` for the whole review). */
  threads: Record<string, ReviewComment[]>;
}

/** Each engine keeps its own review of the same comparison. */
export type ReviewsByEngine = Partial<Record<ReviewEngine, StoredReview>>;

/**
 * An explanation as kept for a comparison.
 *
 * Only one is kept, whichever engine wrote it — unlike a review, which is an
 * opinion worth having twice, an explanation is a description of the same code.
 */
export interface StoredExplanation {
  explanation: ExplainResult;
  engine: ReviewEngine;
  /** `null` means the CLI's configured default at the time. */
  model: string | null;
  /** Reasoning effort it ran at; `null` means the CLI's default. */
  effort: string | null;
  /** The commit the explained diff was anchored to. */
  mergeBase: string;
  /** ISO timestamp of when the explanation finished. */
  createdAt: string;
}

/** Thread key for discussing the review as a whole rather than one finding. */
export const REVIEW_THREAD_KEY = "review";

/** Thread key for one finding; matches how the panel identifies finding cards. */
export const findingThreadKey = (finding: ReviewFinding): string =>
  `f:${finding.path}:${finding.line ?? "file"}:${finding.title}`;

/**
 * Thread key for a prior finding shown as a resolution after a re-review.
 * Namespaced apart from the live findings' keys so an old conversation stays
 * with the old finding — a new finding that happens to share a path, line, and
 * title starts its own thread rather than inheriting the previous one.
 */
export const resolutionThreadKey = (finding: ReviewFinding): string =>
  `prev:${findingThreadKey(finding)}`;

const LAST_REPO_KEY = "tk-review:last-repo";
const REVIEW_ENGINE_KEY = "tk-review:review-engine";
const EXPLAIN_MODE_KEY = "tk-review:explain-mode";
const reviewModelKey = (engine: ReviewEngine) => `tk-review:review-model:${engine}`;
const reviewEffortKey = (engine: ReviewEngine) => `tk-review:review-effort:${engine}`;

function readReviewEngine(): ReviewEngine {
  return localStorage.getItem(REVIEW_ENGINE_KEY) === "codex" ? "codex" : "claude";
}

function readExplainMode(): boolean {
  return localStorage.getItem(EXPLAIN_MODE_KEY) === "true";
}

function readReviewModel(engine: ReviewEngine): string {
  return localStorage.getItem(reviewModelKey(engine)) ?? "";
}

function readReviewEffort(engine: ReviewEngine): string {
  return localStorage.getItem(reviewEffortKey(engine)) ?? "";
}
const viewedKey = (root: string, base: string, compare: string) =>
  `tk-review:viewed:${root}:${base}...${compare}`;

export type DiffLayout = "split" | "unified";

interface ReviewState {
  repo: RepoInfo | null;
  branches: Branch[];
  base: string | null;
  compare: string | null;
  summary: DiffSummary | null;
  /** Unified diff for the whole range, parsed into per-file diffs by the viewer. */
  patch: string | null;
  /**
   * Incremented by every successful diff load. The viewer's renderer keeps a
   * rendered record per file id and only replaces it when the item's `version`
   * changes, so a file whose contents moved under a fixed ref name — a PR head
   * after a push, a branch after a pull — would otherwise keep rendering the
   * diff it was first given. This is what makes every reload a new version.
   */
  diffLoadId: number;
  selectedPath: string | null;
  /**
   * Bumped by every explicit `selectFile`, so re-choosing the file already open
   * still counts as a selection. The diff surface scrolls on this rather than on
   * `selectedPath`, which cannot distinguish "again" from "no change".
   */
  selectionTick: number;
  layout: DiffLayout;
  /**
   * Compare the working tree instead of the compare ref, folding staged,
   * unstaged, and untracked changes into the review. Only takes effect while the
   * compare ref is the checked-out branch — the working tree belongs to no other
   * revision.
   */
  includeUncommitted: boolean;
  /** Paths the user ticked off, scoped to the current repo and ref pair. */
  viewed: Set<string>;
  /**
   * Files the reader has explicitly opened, overriding the reasons a file starts
   * collapsed (generated, or already viewed). Lives here rather than in the viewer
   * so that marking a file viewed can close it in the same update.
   */
  expanded: Set<string>;
  loadingRepo: boolean;
  loadingDiff: boolean;
  /** A `git fetch` is in flight. */
  fetching: boolean;
  error: string | null;
  /**
   * Stored reviews of the current comparison, one slot per engine, loaded from
   * localStorage alongside the diff and persisted back on every change — so a
   * comparison shows its old reviews (and their comment threads) when revisited.
   * Strictly on demand: nothing runs until `runReview` is called.
   */
  reviews: ReviewsByEngine;
  reviewing: boolean;
  /** A re-review is in flight; kept apart so the button can say which. */
  reReviewing: boolean;
  reviewError: string | null;
  /**
   * Ask for plain-language explanations alongside the next review, and show the
   * stored ones on the diff. Turning it off hides them without discarding them.
   */
  explainMode: boolean;
  /** The explanation on record for this comparison, whichever engine wrote it. */
  explanation: StoredExplanation | null;
  explaining: boolean;
  /** Kept apart from `reviewError`: either agent can fail without the other. */
  explainError: string | null;
  /** Which agent CLI runs the next review — and whose stored review is shown. */
  reviewEngine: ReviewEngine;
  /** Model override for the engine; empty means the CLI's configured default. */
  reviewModel: string;
  /** Reasoning-effort override for the engine; empty means the CLI's default. */
  reviewEffort: string;
  /** Thread key currently waiting on an agent reply, or `null`. */
  replyingTo: string | null;
  /** Review thread or finding currently being sent to GitHub. */
  postingTo: string | null;
  /** PR metadata only while its refs remain the active comparison. */
  pr: PrContext | null;
  /** True after refreshing detected a different PR head commit. */
  prHeadMoved: boolean;
  openingPr: boolean;
  refreshingPr: boolean;

  openRepo: (path: string) => Promise<void>;
  restoreLastRepo: () => Promise<void>;
  closeRepo: () => void;
  setBase: (base: string) => Promise<void>;
  setCompare: (compare: string) => Promise<void>;
  swapRefs: () => Promise<void>;
  refresh: () => Promise<void>;
  fetchRemotes: () => Promise<void>;
  openPr: (url: string) => Promise<boolean>;
  refreshPr: () => Promise<void>;
  selectFile: (path: string | null) => void;
  moveSelection: (offset: number) => void;
  setLayout: (layout: DiffLayout) => void;
  setIncludeUncommitted: (include: boolean) => Promise<void>;
  toggleViewed: (path: string) => void;
  expandFile: (path: string) => void;
  runReview: () => Promise<void>;
  /**
   * Follows up on the stored review: one agent run that judges whether each
   * prior finding was addressed and reads the current diff for new issues.
   */
  runReReview: () => Promise<void>;
  /** Appends a user comment to a thread and asks the review's engine to respond. */
  addComment: (threadKey: string, text: string) => Promise<void>;
  /** Sends a finding or review summary to the open PR and saves its permalink. */
  postPrComment: (
    finding: ReviewFinding | null,
    body: string,
    destination: PrCommentDestination,
  ) => Promise<boolean>;
  setReviewEngine: (engine: ReviewEngine) => void;
  setReviewModel: (model: string) => void;
  setReviewEffort: (effort: string) => void;
  setExplainMode: (explain: boolean) => void;
  dismissReviewError: () => void;
  dismissExplainError: () => void;
  dismissError: () => void;
}

/** Whether the current review targets the working tree rather than the compare ref. */
export function reviewsWorkingTree(
  state: Pick<ReviewState, "includeUncommitted" | "compare" | "repo">,
): boolean {
  return (
    state.includeUncommitted &&
    state.compare !== null &&
    state.compare === state.repo?.currentBranch
  );
}

/**
 * Viewed marks for a working-tree review live under their own key: the same ref
 * pair with uncommitted changes folded in is a different set of files.
 */
function viewedScope(compare: string, worktree: boolean): string {
  return worktree ? `${compare}+uncommitted` : compare;
}

const reviewsKey = (root: string, base: string, compareScope: string) =>
  `tk-review:reviews:${root}:${base}...${compareScope}`;

function readReviews(root: string, base: string, compareScope: string): ReviewsByEngine {
  try {
    const raw = localStorage.getItem(reviewsKey(root, base, compareScope));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as ReviewsByEngine) : {};
  } catch {
    return {};
  }
}

function writeReviews(
  root: string,
  base: string,
  compareScope: string,
  reviews: ReviewsByEngine,
): void {
  try {
    localStorage.setItem(reviewsKey(root, base, compareScope), JSON.stringify(reviews));
  } catch {
    // A full or unavailable localStorage should never break reviewing.
  }
}

const explanationKey = (root: string, base: string, compareScope: string) =>
  `tk-review:explanations:${root}:${base}...${compareScope}`;

function readExplanation(
  root: string,
  base: string,
  compareScope: string,
): StoredExplanation | null {
  try {
    const raw = localStorage.getItem(explanationKey(root, base, compareScope));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as StoredExplanation) : null;
  } catch {
    return null;
  }
}

function writeExplanation(
  root: string,
  base: string,
  compareScope: string,
  explanation: StoredExplanation,
): void {
  try {
    localStorage.setItem(explanationKey(root, base, compareScope), JSON.stringify(explanation));
  } catch {
    // A full or unavailable localStorage should never break explaining.
  }
}

/** A copy of `stored` with one comment appended to the given thread. */
function withComment(
  stored: StoredReview,
  threadKey: string,
  comment: ReviewComment,
): StoredReview {
  return {
    ...stored,
    threads: {
      ...stored.threads,
      [threadKey]: [...(stored.threads[threadKey] ?? []), comment],
    },
  };
}

/** Records GitHub's permalink on the item that was posted. */
function withPostedComment(
  stored: StoredReview,
  finding: ReviewFinding | null,
  postedUrl: string,
  postedAt: string,
): StoredReview {
  if (!finding) return { ...stored, review: { ...stored.review, postedUrl, postedAt } };
  const key = findingThreadKey(finding);
  return {
    ...stored,
    review: {
      ...stored.review,
      findings: stored.review.findings.map((item) =>
        findingThreadKey(item) === key ? { ...item, postedUrl, postedAt } : item,
      ),
    },
  };
}

function readViewed(root: string, base: string, compare: string): Set<string> {
  try {
    const raw = localStorage.getItem(viewedKey(root, base, compare));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((p) => typeof p === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function writeViewed(root: string, base: string, compare: string, viewed: Set<string>): void {
  try {
    localStorage.setItem(viewedKey(root, base, compare), JSON.stringify([...viewed]));
  } catch {
    // A full or unavailable localStorage should never break reviewing.
  }
}

export const useReviewStore = create<ReviewState>((set, get) => {
  /** Fetches the diff for the current ref pair. Shared by every path that changes refs. */
  async function loadDiff(): Promise<void> {
    const { repo, base, compare } = get();
    if (!repo || !base || !compare) return;

    const worktree = reviewsWorkingTree(get());
    // The backend reads a null compare as "the working tree".
    const target = worktree ? null : compare;

    set({ loadingDiff: true, error: null });
    try {
      const summary = await gitApi.diffBranches(repo.root, base, target);
      // One patch for the whole range, rather than two `git show`s per file.
      const patch = await gitApi.getPatch(repo.root, summary.mergeBase, target);
      const viewed = readViewed(repo.root, base, viewedScope(compare, worktree));
      const previous = get().selectedPath;
      set({
        summary,
        patch,
        diffLoadId: get().diffLoadId + 1,
        viewed,
        expanded: new Set(),
        loadingDiff: false,
        // Reviews belong to one comparison; load what this one has on record.
        reviews: readReviews(repo.root, base, viewedScope(compare, worktree)),
        explanation: readExplanation(repo.root, base, viewedScope(compare, worktree)),
        reviewError: null,
        explainError: null,
        replyingTo: null,
        postingTo: null,
        // Keep the open file across a refresh when it is still part of the diff.
        // Otherwise start on the first file that actually has a diff to show —
        // a binary file has nothing to render or scroll to.
        selectedPath:
          previous && summary.files.some((file) => file.path === previous)
            ? previous
            : (summary.files.find((file) => !file.isBinary)?.path ??
              summary.files[0]?.path ??
              null),
      });
    } catch (error) {
      set({
        loadingDiff: false,
        summary: null,
        patch: null,
        selectedPath: null,
        expanded: new Set(),
        reviews: {},
        explanation: null,
        reviewError: null,
        explainError: null,
        replyingTo: null,
        postingTo: null,
        pr: null,
        prHeadMoved: false,
        error: errorMessage(error),
      });
    }
  }

  /**
   * Re-reads an open PR and re-points the comparison at whatever refs it now
   * names. The head ref name is stable (`tk-review/pr/<n>`), but a retargeted
   * PR compares against a different base branch, so both are reapplied exactly
   * as `openPr` set them — otherwise a refresh would keep diffing the old base.
   * Throws; callers own the busy flag and the error slot.
   */
  async function syncPr(root: string, pr: PrContext): Promise<void> {
    const result = await gitApi.refreshPr(root, pr);
    set({
      pr: result.pr,
      prHeadMoved: result.headMoved,
      base: `${result.pr.baseRemote}/${result.pr.baseRef}`,
      compare: result.pr.compareRef,
    });
  }

  async function open(path: string, { remember }: { remember: boolean }): Promise<void> {
    set({ loadingRepo: true, error: null });
    try {
      const repo = await gitApi.selectRepo(path);
      const branches = await gitApi.listBranches(repo.root);

      // Default to the comparison a PR would show: default branch → current branch.
      const names = new Set(branches.map((branch) => branch.name));
      const compare = repo.currentBranch ?? branches.find((branch) => branch.isHead)?.name ?? null;
      const preferredBase = repo.defaultBranch ?? null;
      const base =
        preferredBase && names.has(preferredBase) && preferredBase !== compare
          ? preferredBase
          : (branches.find((branch) => branch.name !== compare)?.name ?? preferredBase);

      set({
        repo,
        branches,
        base,
        compare,
        summary: null,
        patch: null,
        selectedPath: null,
        includeUncommitted: false,
        reviews: {},
        explanation: null,
        reviewError: null,
        explainError: null,
        replyingTo: null,
        postingTo: null,
        pr: null,
        viewed: new Set(),
        expanded: new Set(),
        loadingRepo: false,
      });
      if (remember) localStorage.setItem(LAST_REPO_KEY, repo.root);
      await loadDiff();
    } catch (error) {
      set({ loadingRepo: false, error: errorMessage(error) });
      if (remember) localStorage.removeItem(LAST_REPO_KEY);
    }
  }

  return {
    repo: null,
    branches: [],
    base: null,
    compare: null,
    summary: null,
    patch: null,
    diffLoadId: 0,
    selectedPath: null,
    selectionTick: 0,
    layout: "split",
    includeUncommitted: false,
    viewed: new Set(),
    expanded: new Set(),
    loadingRepo: false,
    loadingDiff: false,
    fetching: false,
    error: null,
    reviews: {},
    reviewing: false,
    reReviewing: false,
    reviewError: null,
    explainMode: readExplainMode(),
    explanation: null,
    explaining: false,
    explainError: null,
    reviewEngine: readReviewEngine(),
    reviewModel: readReviewModel(readReviewEngine()),
    reviewEffort: readReviewEffort(readReviewEngine()),
    replyingTo: null,
    postingTo: null,
    pr: null,
    prHeadMoved: false,
    openingPr: false,
    refreshingPr: false,

    openRepo: (path) => open(path, { remember: true }),

    async restoreLastRepo() {
      const last = localStorage.getItem(LAST_REPO_KEY);
      if (!last) return;
      // A remembered repo may have been moved or deleted; forget it quietly
      // rather than greeting the user with an error.
      set({ loadingRepo: true });
      try {
        await gitApi.selectRepo(last);
      } catch {
        localStorage.removeItem(LAST_REPO_KEY);
        set({ loadingRepo: false });
        return;
      }
      await open(last, { remember: true });
    },

    closeRepo() {
      localStorage.removeItem(LAST_REPO_KEY);
      set({
        repo: null,
        branches: [],
        base: null,
        compare: null,
        summary: null,
        patch: null,
        selectedPath: null,
        includeUncommitted: false,
        reviews: {},
        explanation: null,
        reviewError: null,
        explainError: null,
        replyingTo: null,
        postingTo: null,
        pr: null,
        prHeadMoved: false,
        viewed: new Set(),
        expanded: new Set(),
        error: null,
      });
    },

    async setBase(base) {
      set({ base, pr: null, prHeadMoved: false });
      await loadDiff();
    },

    async setCompare(compare) {
      set({ compare, pr: null, prHeadMoved: false });
      await loadDiff();
    },

    async swapRefs() {
      const { base, compare } = get();
      set({ base: compare, compare: base, pr: null, prHeadMoved: false });
      await loadDiff();
    },

    async fetchRemotes() {
      const { repo, fetching } = get();
      if (!repo || fetching) return;

      set({ fetching: true, error: null });
      try {
        await gitApi.fetchRemotes(repo.root);
      } catch (error) {
        set({ fetching: false, error: errorMessage(error) });
        return;
      }
      set({ fetching: false });
      // The point of fetching: fold whatever arrived into the branch list and
      // the diff, exactly as the Refresh button would.
      await get().refresh();
    },

    async openPr(url) {
      const { repo, openingPr } = get();
      if (!repo || openingPr) return false;

      set({ openingPr: true, error: null });
      try {
        const pr = await gitApi.openPr(repo.root, url);
        const branches = await gitApi.listBranches(repo.root);
        set({
          branches,
          base: `${pr.baseRemote}/${pr.baseRef}`,
          compare: pr.compareRef,
          includeUncommitted: false,
          pr,
          prHeadMoved: false,
          openingPr: false,
        });
        await loadDiff();
        return true;
      } catch (error) {
        set({ openingPr: false, error: errorMessage(error) });
        return false;
      }
    },

    async refreshPr() {
      const { repo, pr, refreshingPr, loadingDiff } = get();
      if (!repo || !pr || refreshingPr || loadingDiff) return;

      set({ refreshingPr: true, error: null });
      try {
        await syncPr(repo.root, pr);
        set({ refreshingPr: false });
        await loadDiff();
      } catch (error) {
        set({ refreshingPr: false, error: errorMessage(error) });
      }
    },

    async refresh() {
      // Refs move under the app whenever the user fetches, pulls, or switches
      // branches in a terminal, so a refresh re-reads the repo and its branch
      // list rather than only re-running the diff.
      const { repo, pr, refreshingPr, loadingDiff } = get();
      if (!repo || refreshingPr || loadingDiff) return;

      if (pr) {
        // Re-reading the PR is a network round-trip through `gh`, and nothing
        // else is marked busy until `loadDiff` starts — so hold `refreshingPr`
        // across it. Both Refresh buttons watch that flag, so neither can be
        // pressed into a second concurrent run while this one talks to GitHub.
        set({ refreshingPr: true, error: null });
        try {
          await syncPr(repo.root, pr);
        } catch (error) {
          set({ refreshingPr: false, error: errorMessage(error) });
          return;
        }
        set({ refreshingPr: false });
      }
      try {
        const [fresh, branches] = await Promise.all([
          gitApi.selectRepo(repo.root),
          gitApi.listBranches(repo.root),
        ]);
        set({ repo: fresh, branches });
      } catch {
        // A repo that has genuinely broken will fail the diff below too, which
        // is where the error is surfaced.
      }
      await loadDiff();
    },

    selectFile(path) {
      // The counter, not the path, is what the diff surface watches: choosing
      // the file you are already on is a request to go back to it, so it has to
      // register as a new selection rather than as no change at all.
      set({ selectedPath: path, selectionTick: get().selectionTick + 1 });
    },

    moveSelection(offset) {
      const { summary, selectedPath } = get();
      const files = summary?.files ?? [];
      if (files.length === 0) return;

      const current = files.findIndex((file) => file.path === selectedPath);
      const next = Math.min(Math.max(current + offset, 0), files.length - 1);
      const target = files[current === -1 ? 0 : next];
      if (target) set({ selectedPath: target.path });
    },

    setLayout(layout) {
      set({ layout });
    },

    async setIncludeUncommitted(includeUncommitted) {
      set({ includeUncommitted });
      await loadDiff();
    },

    toggleViewed(path) {
      const { repo, base, compare, viewed, expanded } = get();
      const nextViewed = new Set(viewed);
      const nextExpanded = new Set(expanded);

      if (nextViewed.has(path)) {
        nextViewed.delete(path);
      } else {
        nextViewed.add(path);
        // Ticking a file off collapses it, even if it was open at the time.
        nextExpanded.delete(path);
      }

      set({ viewed: nextViewed, expanded: nextExpanded });
      if (repo && base && compare) {
        writeViewed(repo.root, base, viewedScope(compare, reviewsWorkingTree(get())), nextViewed);
      }
    },

    expandFile(path) {
      const { expanded } = get();
      if (expanded.has(path)) return;
      const next = new Set(expanded);
      next.add(path);
      set({ expanded: next });
    },

    async runReview() {
      const {
        repo,
        base,
        compare,
        summary,
        reviewing,
        reReviewing,
        explaining,
        explainMode,
        reviewEngine,
        reviewModel,
        reviewEffort,
        pr,
      } = get();
      if (!repo || !base || !compare || !summary || reviewing || reReviewing || explaining) return;

      const worktree = reviewsWorkingTree(get());
      const scope = viewedScope(compare, worktree);
      const model = reviewModel.trim() || null;
      const effort = reviewEffort.trim() || null;
      const target = worktree ? null : compare;
      // These take a while; if the comparison changed under one, its result
      // still gets *persisted* for the comparison it belongs to — it just must
      // not land in the state of whatever is on screen now.
      const stillCurrent = () =>
        get().summary?.mergeBase === summary.mergeBase &&
        get().compare === compare &&
        reviewsWorkingTree(get()) === worktree;

      async function review(): Promise<void> {
        if (!repo || !base || !summary) return;
        set({ reviewing: true, reviewError: null });
        try {
          const result = await gitApi.reviewDiff(
            repo.root,
            summary.mergeBase,
            target,
            reviewEngine,
            model,
            effort,
            pr,
          );
          const stored: StoredReview = {
            review: result,
            engine: reviewEngine,
            model,
            effort,
            mergeBase: summary.mergeBase,
            createdAt: new Date().toISOString(),
            threads: {},
          };
          // Re-read rather than spread state: another engine's slot may have
          // changed while this review ran.
          const next = { ...readReviews(repo.root, base, scope), [reviewEngine]: stored };
          writeReviews(repo.root, base, scope, next);
          set(stillCurrent() ? { reviews: next, reviewing: false } : { reviewing: false });
        } catch (error) {
          set(
            stillCurrent()
              ? { reviewing: false, reviewError: errorMessage(error) }
              : { reviewing: false },
          );
        }
      }

      async function explain(): Promise<void> {
        if (!repo || !base || !summary) return;
        set({ explaining: true, explainError: null });
        try {
          const result = await gitApi.explainDiff(
            repo.root,
            summary.mergeBase,
            target,
            reviewEngine,
            model,
            effort,
            pr,
          );
          const stored: StoredExplanation = {
            explanation: result,
            engine: reviewEngine,
            model,
            effort,
            mergeBase: summary.mergeBase,
            createdAt: new Date().toISOString(),
          };
          writeExplanation(repo.root, base, scope, stored);
          set(stillCurrent() ? { explanation: stored, explaining: false } : { explaining: false });
        } catch (error) {
          set(
            stillCurrent()
              ? { explaining: false, explainError: errorMessage(error) }
              : { explaining: false },
          );
        }
      }

      // Two independent agent runs: a failed explanation must not cost a good
      // review, and neither should wait on the other to start.
      await Promise.all(explainMode ? [review(), explain()] : [review()]);
    },

    async runReReview() {
      const {
        repo,
        base,
        compare,
        summary,
        reviews,
        reviewing,
        reReviewing,
        explaining,
        reviewEngine,
        reviewModel,
        reviewEffort,
        pr,
      } = get();
      const prior = reviews[reviewEngine];
      if (!repo || !base || !compare || !summary || !prior) return;
      if (reviewing || reReviewing || explaining) return;

      const worktree = reviewsWorkingTree(get());
      const scope = viewedScope(compare, worktree);
      const model = reviewModel.trim() || null;
      const effort = reviewEffort.trim() || null;
      const target = worktree ? null : compare;
      const stillCurrent = () =>
        get().summary?.mergeBase === summary.mergeBase &&
        get().compare === compare &&
        reviewsWorkingTree(get()) === worktree;

      set({ reReviewing: true, reviewError: null });
      try {
        const result = await gitApi.reReviewDiff({
          root: repo.root,
          mergeBase: summary.mergeBase,
          compare: target,
          engine: reviewEngine,
          model,
          effort,
          priorSummary: prior.review.summary,
          priorFindings: prior.review.findings,
          prContext: pr,
        });
        // Zip verdicts back onto the findings they judged. The model writes
        // the indices, so out-of-range ones are dropped; a prior finding it
        // failed to mention is kept with an "unknown" verdict rather than
        // silently vanishing from the record.
        const byIndex = new Map(result.resolutions.map((r) => [r.index, r]));
        const resolutions: ResolvedFinding[] = prior.review.findings.map((finding, index) => {
          const verdict = byIndex.get(index);
          return {
            finding,
            status: verdict?.status ?? "unknown",
            note: verdict?.note ?? "",
          };
        });
        // Old conversations move with their findings into the resolutions'
        // namespaced keys; the new findings and the new summary start with
        // clean threads rather than inheriting the previous review's.
        const threads: Record<string, ReviewComment[]> = {};
        for (const resolution of resolutions) {
          const old = prior.threads[findingThreadKey(resolution.finding)];
          if (old?.length) threads[resolutionThreadKey(resolution.finding)] = old;
        }
        const stored: StoredReview = {
          review: { summary: result.summary, findings: result.findings },
          resolutions,
          engine: reviewEngine,
          model,
          effort,
          mergeBase: summary.mergeBase,
          createdAt: new Date().toISOString(),
          threads,
        };
        const next = { ...readReviews(repo.root, base, scope), [reviewEngine]: stored };
        writeReviews(repo.root, base, scope, next);
        set(stillCurrent() ? { reviews: next, reReviewing: false } : { reReviewing: false });
      } catch (error) {
        set(
          stillCurrent()
            ? { reReviewing: false, reviewError: errorMessage(error) }
            : { reReviewing: false },
        );
      }
    },

    async addComment(threadKey, text) {
      const { repo, base, compare, reviews, reviewEngine, replyingTo, pr } = get();
      const stored = reviews[reviewEngine];
      if (!repo || !base || !compare || !stored || replyingTo) return;

      const worktree = reviewsWorkingTree(get());
      const scope = viewedScope(compare, worktree);
      const engine = stored.engine;
      const stillCurrent = () =>
        get().compare === compare && reviewsWorkingTree(get()) === worktree;

      // Reads and writes go through localStorage so a reply landing after the
      // user navigated away is kept for when they come back.
      const persist = (updated: StoredReview): ReviewsByEngine => {
        const next = { ...readReviews(repo.root, base, scope), [engine]: updated };
        writeReviews(repo.root, base, scope, next);
        return next;
      };

      // A thread can hang off a current finding or off a prior one that lives
      // on as a resolution after a re-review; both know their file's diff.
      const finding =
        threadKey === REVIEW_THREAD_KEY
          ? null
          : threadKey.startsWith("prev:")
            ? (stored.resolutions?.find((r) => resolutionThreadKey(r.finding) === threadKey)
                ?.finding ?? null)
            : (stored.review.findings.find((f) => findingThreadKey(f) === threadKey) ?? null);
      const priorThread = stored.threads[threadKey] ?? [];

      const asked = withComment(stored, threadKey, {
        author: "user",
        text,
        at: new Date().toISOString(),
      });
      const askedReviews = persist(asked);
      set(stillCurrent() ? { reviews: askedReviews, replyingTo: threadKey } : {});

      try {
        const reply = await gitApi.reviewReply({
          root: repo.root,
          mergeBase: stored.mergeBase,
          compare: worktree ? null : compare,
          engine,
          model: stored.model,
          effort: stored.effort ?? null,
          summary: stored.review.summary,
          finding,
          thread: priorThread,
          comment: text,
          prContext: pr,
        });
        const answered = withComment(asked, threadKey, {
          author: "agent",
          text: reply,
          at: new Date().toISOString(),
        });
        const answeredReviews = persist(answered);
        set(stillCurrent() ? { reviews: answeredReviews, replyingTo: null } : { replyingTo: null });
      } catch (error) {
        set(
          stillCurrent()
            ? { replyingTo: null, reviewError: errorMessage(error) }
            : { replyingTo: null },
        );
      }
    },

    async postPrComment(finding, body, destination) {
      const { repo, base, compare, reviews, reviewEngine, pr, postingTo } = get();
      const stored = reviews[reviewEngine];
      const targetKey = finding ? findingThreadKey(finding) : REVIEW_THREAD_KEY;
      if (!repo || !base || !compare || !pr || !stored || postingTo || !body.trim()) return false;

      const worktree = reviewsWorkingTree(get());
      const scope = viewedScope(compare, worktree);
      const stillCurrent = () =>
        get().compare === compare && reviewsWorkingTree(get()) === worktree;
      const persist = (updated: StoredReview): ReviewsByEngine => {
        const next = { ...readReviews(repo.root, base, scope), [stored.engine]: updated };
        writeReviews(repo.root, base, scope, next);
        return next;
      };

      set({ postingTo: targetKey, reviewError: null });
      try {
        const posted = await gitApi.postPrComment({
          root: repo.root,
          pr,
          body: body.trim(),
          path: destination === "topLevel" ? null : (finding?.path ?? null),
          line: destination === "inline" ? (finding?.line ?? null) : null,
          destination,
        });
        const updated = withPostedComment(stored, finding, posted.url, new Date().toISOString());
        const next = persist(updated);
        set(stillCurrent() ? { reviews: next, postingTo: null } : { postingTo: null });
        return true;
      } catch (error) {
        set(
          stillCurrent()
            ? { postingTo: null, reviewError: errorMessage(error) }
            : { postingTo: null },
        );
        return false;
      }
    },

    setReviewEngine(reviewEngine) {
      // Each engine remembers its own model and effort: "sonnet" means nothing
      // to codex, and their effort scales differ too.
      set({
        reviewEngine,
        reviewModel: readReviewModel(reviewEngine),
        reviewEffort: readReviewEffort(reviewEngine),
      });
      try {
        localStorage.setItem(REVIEW_ENGINE_KEY, reviewEngine);
      } catch {
        // Preference persistence is best-effort.
      }
    },

    setReviewModel(reviewModel) {
      set({ reviewModel });
      try {
        localStorage.setItem(reviewModelKey(get().reviewEngine), reviewModel);
      } catch {
        // Preference persistence is best-effort.
      }
    },

    setReviewEffort(reviewEffort) {
      set({ reviewEffort });
      try {
        localStorage.setItem(reviewEffortKey(get().reviewEngine), reviewEffort);
      } catch {
        // Preference persistence is best-effort.
      }
    },

    setExplainMode(explainMode) {
      set({ explainMode });
      try {
        localStorage.setItem(EXPLAIN_MODE_KEY, String(explainMode));
      } catch {
        // Preference persistence is best-effort.
      }
    },

    dismissReviewError() {
      set({ reviewError: null });
    },

    dismissExplainError() {
      set({ explainError: null });
    },

    dismissError() {
      set({ error: null });
    },
  };
});
