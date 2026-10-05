import { createContext, useContext } from "react";
import { createStore, type StoreApi, useStore } from "zustand";
import {
  type AppError,
  type Branch,
  type CommitLog,
  type DiffSummary,
  type ExplainResult,
  gitApi,
  isCancelled,
  type PrContext,
  type RepoInfo,
  type ReviewComment,
  type ReviewEngine,
  type ReviewFinding,
  type ReviewResult,
  type ReviewVerdict,
  toAppError,
} from "../ipc/git";
import type { LineSpan } from "../lib/lineSpan";
import type { PrPostLocation } from "../lib/prComment";
import { invalidatePrLists } from "../lib/queries";
import { storageRoot } from "./account";
import { recordReview } from "./history";

/**
 * One tab: a comparison open for review, with everything that belongs to it —
 * its refs, its diff, its reviews and the agent runs producing them. Each tab
 * has a store of its own, so a review running in a tab that isn't on screen
 * lands in that tab rather than in whichever one is. What every tab shares —
 * the open repository, the review settings, the tab list — is `appStore.ts`.
 */

/** One prior finding paired with the re-review's verdict on it. */
export interface ResolvedFinding {
  finding: ReviewFinding;
  /** addressed | unaddressed | partial | obsolete — model-written, so a label.
   * `"unknown"` is ours, for a prior finding the re-review failed to mention. */
  status: string;
  note: string;
}

/** When a review ran and what it read: enough to place it on the commit list. */
export interface ReviewStamp {
  /** ISO timestamp of when the review finished. */
  createdAt: string;
  /**
   * The commit the review read; for a review of the working tree, the commit
   * its uncommitted changes sat on. Absent on reviews stored before it was
   * recorded, `null` when it couldn't be told.
   */
  head?: string | null;
  findings: number;
  /** The GitHub verdict submitted, else the agent's recommendation — model-written. */
  verdict?: string;
  /** It followed up on the review before it. */
  reReview: boolean;
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
  /** As `ReviewStamp.head`. */
  head?: string | null;
  /** ISO timestamp of when the review finished. */
  createdAt: string;
  /** Comment threads, keyed by finding (or `REVIEW_THREAD_KEY` for the whole review). */
  threads: Record<string, ReviewComment[]>;
  /** The reviews by the same engine that this one replaced, oldest first. */
  earlier?: ReviewStamp[];
}

/** Earlier reviews are kept only as stamps, which cost little; still, the history ends somewhere. */
const EARLIER_LIMIT = 20;

export function stampOf(stored: StoredReview): ReviewStamp {
  return {
    createdAt: stored.createdAt,
    head: stored.head,
    findings: stored.review.findings.length,
    verdict: stored.review.submitted?.verdict ?? stored.review.verdict,
    reReview: stored.resolutions != null,
  };
}

/** What a review replacing `previous` carries forward: every review before it, as stamps. */
function earlierThan(previous: StoredReview | undefined): ReviewStamp[] | undefined {
  if (!previous) return undefined;
  return [...(previous.earlier ?? []), stampOf(previous)].slice(-EARLIER_LIMIT);
}

/**
 * Each engine keeps its own review of the same comparison. The panel shows
 * them all at once, whichever engine is selected; the selection only decides
 * which one the next run replaces.
 */
export type ReviewsByEngine = Partial<Record<ReviewEngine, StoredReview>>;

/** The stored reviews, the most recent first. */
export function reviewsNewestFirst(reviews: ReviewsByEngine): StoredReview[] {
  return Object.values(reviews)
    .filter((stored): stored is StoredReview => stored != null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

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

/** `postingTo` while the conclusion is being submitted as a GitHub review. */
export const CONCLUSION_POST_KEY = "conclusion";

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

/**
 * A thread or post target within one engine's review. Every review has a
 * `REVIEW_THREAD_KEY` thread, and two engines can raise the same finding, so
 * `replyingTo` and `postingTo` name the engine too.
 */
export const sourcedKey = (engine: ReviewEngine, key: string): string => `${engine}:${key}`;

/**
 * `postingTo` while a finding of `engine`'s review is sent to the PR; a prior
 * one (shown as a resolution) by its own key, apart from a look-alike new one.
 * With no finding, the review as a whole.
 */
export function postTargetKey(
  engine: ReviewEngine,
  finding: ReviewFinding | null,
  prior = false,
): string {
  if (!finding) return sourcedKey(engine, REVIEW_THREAD_KEY);
  return sourcedKey(engine, prior ? resolutionThreadKey(finding) : findingThreadKey(finding));
}

const viewedKey = (root: string, base: string, compare: string) =>
  `tk-review:viewed:${root}:${base}...${compare}`;

/** What an agent run is for. One of each runs at a time. */
export type AgentRunKind = "review" | "explain" | "reply";

/** An agent run in flight, as its progress line needs it. */
export interface AgentRunInfo {
  kind: AgentRunKind;
  /** Who is doing it, which the settings no longer say once they change mid-run. */
  engine: ReviewEngine;
  /** `Date.now()` times. */
  startedAt: number;
  /** When its CLI last wrote anything; `null` until it first does. */
  lastOutputAt: number | null;
  /** Cancel was pressed, and the run hasn't ended yet. */
  cancelling: boolean;
}

/** An agent run's failure to show, or none for a run that was cancelled. */
function runFailure(error: unknown, title: string): AppError | null {
  return isCancelled(error) ? null : toAppError(error, title);
}

/** What the list already knows about a PR: enough to head the review while it opens. */
export interface PrPreview {
  number: number;
  title: string;
  /** `null` for an account that has since been deleted. */
  author?: string | null;
  /** Known when the PR came from a listed row; a recent entry doesn't keep them. */
  headRef?: string;
  baseRef?: string;
}

/** The app-wide settings an agent run starts with. */
export interface ReviewSettings {
  engine: ReviewEngine;
  /** `null` means the CLI's configured default. */
  model: string | null;
  /** `null` means the CLI's default. */
  effort: string | null;
}

/** What a tab needs to know from the app around it, asked at the moment it matters. */
export interface TabEnv {
  settings: () => ReviewSettings;
  /**
   * Every PR open in a tab on `root`. Fetching a PR prunes every other PR's
   * ref, so a fetch has to name the ones still in use.
   */
  openPrs: (root: string) => number[];
  /** Whether this tab is the one on screen. */
  isShown: () => boolean;
}

/** Where a new tab starts. */
export interface TabInit {
  repo: RepoInfo;
  branches: Branch[];
  base: string | null;
  compare: string | null;
  pr?: PrContext | null;
  pendingPr?: (PrPreview & { url: string }) | null;
}

/** The refs a PR is compared on: the base branch as fetched, and the fetched head. */
export function prComparison(pr: PrContext) {
  return {
    base: `${pr.baseRemote}/${pr.baseRef}`,
    compare: pr.compareRef,
    includeUncommitted: false,
    pr,
  } satisfies Partial<TabState>;
}

/** Everything that belongs to one comparison, emptied for the next. */
const NO_COMPARISON = {
  summary: null,
  patch: null,
  commits: null,
  pr: null,
  prHeadMoved: false,
  reviews: {},
  explanation: null,
  reviewError: null,
  explainError: null,
  replyingTo: null,
  postingTo: null,
} satisfies Partial<TabState>;

export interface TabState {
  /** The repository this tab compares in, which need not be the one the list shows. */
  repo: RepoInfo;
  branches: Branch[];
  base: string | null;
  compare: string | null;
  summary: DiffSummary | null;
  /** Unified diff for the whole range, parsed into per-file diffs by the viewer. */
  patch: string | null;
  /** The commits the comparison is made of; `null` until loaded, or when they couldn't be read. */
  commits: CommitLog | null;
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
   * New-file lines the selection points at, when it came from something
   * anchored to them — a finding, a verdict. Null means the whole file, which
   * is what choosing a file in the list means.
   */
  selectedLines: LineSpan | null;
  /**
   * Bumped by every explicit `selectFile`, so re-choosing the file already open
   * still counts as a selection. The diff surface scrolls on this rather than on
   * `selectedPath`, which cannot distinguish "again" from "no change".
   */
  selectionTick: number;
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
  loadingDiff: boolean;
  /** A `git fetch` is in flight. */
  fetching: boolean;
  error: AppError | null;
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
  reviewError: AppError | null;
  /** The explanation on record for this comparison, whichever engine wrote it. */
  explanation: StoredExplanation | null;
  explaining: boolean;
  /** Kept apart from `reviewError`: either agent can fail without the other. */
  explainError: AppError | null;
  /** The thread waiting on an agent reply, as a `sourcedKey`, or `null`. */
  replyingTo: string | null;
  /** Agent runs in flight, by the id the backend knows each by. */
  agentRuns: Record<string, AgentRunInfo>;
  /**
   * Review thread, finding, or conclusion (`CONCLUSION_POST_KEY`) currently
   * being sent to GitHub, as a `sourcedKey`.
   */
  postingTo: string | null;
  /** The review thread being resolved or reopened on GitHub, by its id. */
  settingThread: string | null;
  /**
   * A PR opened from the list, from the click until it is fetched and checked
   * out. The review shows it straight away — number and title from the list,
   * everything else as loading — rather than the list waiting on `gh`.
   */
  pendingPr: (PrPreview & { url: string }) | null;
  /** PR metadata only while its refs remain the active comparison. */
  pr: PrContext | null;
  /** True after refreshing detected a different PR head commit. */
  prHeadMoved: boolean;
  openingPr: boolean;
  refreshingPr: boolean;
  /** An agent run finished while this tab was out of sight, and it hasn't been looked at since. */
  unseen: boolean;

  /** Loads the diff, unless it is loaded or on its way. */
  ensureDiff: () => Promise<void>;
  /** Clears `unseen`: the tab is on screen. */
  markSeen: () => void;
  setBase: (base: string) => Promise<void>;
  setCompare: (compare: string) => Promise<void>;
  swapRefs: () => Promise<void>;
  refresh: () => Promise<void>;
  fetchRemotes: () => Promise<void>;
  /**
   * Fetches the PR `pendingPr` previews and loads its diff. False, with `error`
   * set, when it could not be opened.
   */
  openPr: (url: string) => Promise<boolean>;
  refreshPr: () => Promise<void>;
  /**
   * For a tab brought back from what it had loaded: checks its PR against
   * GitHub, and reloads the diff only if the head has moved since.
   */
  revalidatePr: () => Promise<void>;
  selectFile: (path: string | null, lines?: LineSpan | null) => void;
  moveSelection: (offset: number) => void;
  setIncludeUncommitted: (include: boolean) => Promise<void>;
  toggleViewed: (path: string) => void;
  expandFile: (path: string) => void;
  runReview: () => Promise<void>;
  /**
   * Explains the comparison: a walkthrough for the panel and a note for each
   * file that needs one. Independent of the review; either can run while the
   * other does.
   */
  runExplain: () => Promise<void>;
  /**
   * Follows up on the stored review: one agent run that judges whether each
   * prior finding was addressed and reads the current diff for new issues.
   */
  runReReview: () => Promise<void>;
  /**
   * Appends a user comment to a thread of `engine`'s review and asks that
   * engine to respond.
   */
  addComment: (engine: ReviewEngine, threadKey: string, text: string) => Promise<void>;
  /**
   * Sends a finding or summary of `engine`'s review to the open PR and saves
   * its permalink. `prior` says the finding is one the re-review judged.
   */
  postPrComment: (
    engine: ReviewEngine,
    finding: ReviewFinding | null,
    body: string,
    location: PrPostLocation,
    prior?: boolean,
  ) => Promise<boolean>;
  /** Submits `engine`'s conclusion as a GitHub review with the chosen verdict. */
  submitPrReview: (engine: ReviewEngine, verdict: ReviewVerdict, body: string) => Promise<boolean>;
  /** Resolves a review thread on the open PR, or reopens one. */
  setThreadResolved: (threadId: string, resolved: boolean) => Promise<boolean>;
  /** Records that an agent run's CLI just wrote something. */
  noteRunOutput: (runId: string) => void;
  /** Stops the agent runs of these kinds; each ends as if it never ran. */
  cancelAgentRuns: (kinds: AgentRunKind[]) => void;
  dismissReviewError: () => void;
  dismissExplainError: () => void;
  dismissError: () => void;
}

/**
 * Whether a tab stays open once it is left: an agent is still at work in it,
 * or finished out of sight and hasn't been looked at since. Otherwise it has
 * done its job, and leaving it closes it.
 */
export function keepsTab(state: TabState): boolean {
  return (
    Object.keys(state.agentRuns).length > 0 ||
    state.reviewing ||
    state.reReviewing ||
    state.explaining ||
    state.replyingTo != null ||
    state.unseen
  );
}

/**
 * The commit a review of the comparison reads: the compare ref's, or for the
 * working tree, the commit under it — the newest listed, or the merge base
 * when nothing is, which is then HEAD itself.
 */
function reviewedHead(state: Pick<TabState, "summary" | "commits">): string | null {
  const { summary, commits } = state;
  if (!summary) return null;
  if (summary.compareHead) return summary.compareHead;
  if (!commits) return null;
  return commits.commits[0]?.sha ?? summary.mergeBase;
}

/** Whether the current review targets the working tree rather than the compare ref. */
export function reviewsWorkingTree(
  state: Pick<TabState, "includeUncommitted" | "compare" | "repo">,
): boolean {
  return (
    state.includeUncommitted && state.compare !== null && state.compare === state.repo.currentBranch
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
  prior: boolean,
): StoredReview {
  if (!finding) return { ...stored, review: { ...stored.review, postedUrl, postedAt } };
  const key = findingThreadKey(finding);
  if (prior) {
    return {
      ...stored,
      resolutions: stored.resolutions?.map((resolution) =>
        findingThreadKey(resolution.finding) === key
          ? { ...resolution, finding: { ...resolution.finding, postedUrl, postedAt } }
          : resolution,
      ),
    };
  }
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

export type TabStore = StoreApi<TabState>;

export function createTabStore(init: TabInit, env: TabEnv): TabStore {
  return createStore<TabState>((set, get) => {
    /** Fetches the diff for the current ref pair. Shared by every path that changes refs. */
    async function loadDiff(): Promise<void> {
      const { repo, base, compare } = get();
      if (!base || !compare) return;

      const worktree = reviewsWorkingTree(get());
      // The backend reads a null compare as "the working tree".
      const target = worktree ? null : compare;

      set({ loadingDiff: true, error: null });
      try {
        const summary = await gitApi.diffBranches(repo.root, base, target);
        const [patch, commits] = await Promise.all([
          // One patch for the whole range, rather than two `git show`s per file.
          gitApi.getPatch(repo.root, summary.mergeBase, target),
          // The commit list is context beside the diff: failing to read it
          // costs the list, not the review.
          gitApi.listCommits(repo.root, summary.mergeBase, target).catch(() => null),
        ]);
        const viewed = readViewed(storageRoot(repo), base, viewedScope(compare, worktree));
        const previous = get().selectedPath;
        set({
          summary,
          patch,
          commits,
          diffLoadId: get().diffLoadId + 1,
          viewed,
          expanded: new Set(),
          loadingDiff: false,
          // Reviews belong to one comparison; load what this one has on record.
          reviews: readReviews(storageRoot(repo), base, viewedScope(compare, worktree)),
          explanation: readExplanation(storageRoot(repo), base, viewedScope(compare, worktree)),
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
          // A reload is not a jump: the file stays open, but any line a finding
          // scrolled to belongs to the diff that was just replaced.
          selectedLines: null,
        });
      } catch (error) {
        set({
          loadingDiff: false,
          summary: null,
          patch: null,
          commits: null,
          selectedPath: null,
          selectedLines: null,
          expanded: new Set(),
          reviews: {},
          explanation: null,
          reviewError: null,
          explainError: null,
          replyingTo: null,
          postingTo: null,
          pr: null,
          prHeadMoved: false,
          error: toAppError(error, "Could not load the diff"),
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
      const result = await gitApi.refreshPr(root, pr, env.openPrs(root));
      set({ ...prComparison(result.pr), prHeadMoved: result.headMoved });
      // The list's row for this PR still carries the old head, and would show a
      // review of the new one as having "New commits" until it next refetched.
      if (result.headMoved) void invalidatePrLists(root);
    }

    /** Registers an agent run for its progress line, under a fresh id for the backend. */
    function beginRun(kind: AgentRunKind, engine: ReviewEngine): string {
      const runId = crypto.randomUUID();
      const run: AgentRunInfo = {
        kind,
        engine,
        startedAt: Date.now(),
        lastOutputAt: null,
        cancelling: false,
      };
      set({ agentRuns: { ...get().agentRuns, [runId]: run } });
      return runId;
    }

    function endRun(runId: string) {
      const { [runId]: ended, ...rest } = get().agentRuns;
      // A run that finished out of sight is news for the tab bar; a cancelled
      // one ends as if it never ran.
      const news = ended != null && !ended.cancelling && !env.isShown();
      set(news ? { agentRuns: rest, unseen: true } : { agentRuns: rest });
    }

    return {
      repo: init.repo,
      branches: init.branches,
      base: init.base,
      compare: init.compare,
      summary: null,
      patch: null,
      commits: null,
      diffLoadId: 0,
      selectedPath: null,
      selectedLines: null,
      selectionTick: 0,
      includeUncommitted: false,
      viewed: new Set(),
      expanded: new Set(),
      loadingDiff: false,
      fetching: false,
      error: null,
      reviews: {},
      reviewing: false,
      reReviewing: false,
      reviewError: null,
      explanation: null,
      explaining: false,
      explainError: null,
      replyingTo: null,
      agentRuns: {},
      postingTo: null,
      settingThread: null,
      pendingPr: init.pendingPr ?? null,
      pr: init.pr ?? null,
      prHeadMoved: false,
      openingPr: false,
      refreshingPr: false,
      unseen: false,

      async ensureDiff() {
        const { summary, loadingDiff, openingPr } = get();
        if (summary || loadingDiff || openingPr) return;
        await loadDiff();
      },

      markSeen() {
        if (get().unseen) set({ unseen: false });
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
        if (fetching) return;

        set({ fetching: true, error: null });
        try {
          await gitApi.fetchRemotes(repo.root);
        } catch (error) {
          set({ fetching: false, error: toAppError(error, "Could not fetch from the remotes") });
          return;
        }
        set({ fetching: false });
        // The point of fetching: fold whatever arrived into the branch list and
        // the diff, exactly as the Refresh button would.
        await get().refresh();
      },

      async openPr(url) {
        const { repo } = get();
        set({ openingPr: true, error: null });
        try {
          // Neither needs the other: PR heads are fetched outside the branches listed.
          const [pr, branches] = await Promise.all([
            gitApi.openPr(repo.root, url, env.openPrs(repo.root)),
            gitApi.listBranches(repo.root),
          ]);
          set({
            // Nothing of the previous comparison lingers while this one loads.
            ...NO_COMPARISON,
            ...prComparison(pr),
            branches,
            pendingPr: null,
            openingPr: false,
          });
          await loadDiff();
          return true;
        } catch (error) {
          set({ openingPr: false, error: toAppError(error, "Could not open the pull request") });
          return false;
        }
      },

      async refreshPr() {
        const { repo, pr, refreshingPr, loadingDiff } = get();
        if (!pr || refreshingPr || loadingDiff) return;

        set({ refreshingPr: true, error: null });
        try {
          await syncPr(repo.root, pr);
          set({ refreshingPr: false });
          await loadDiff();
        } catch (error) {
          set({
            refreshingPr: false,
            error: toAppError(error, "Could not refresh the pull request"),
          });
        }
      },

      async revalidatePr() {
        const { repo, pr, refreshingPr, loadingDiff } = get();
        if (!pr || refreshingPr || loadingDiff) return;

        set({ refreshingPr: true, error: null });
        try {
          await syncPr(repo.root, pr);
          set({ refreshingPr: false });
          if (get().prHeadMoved) await loadDiff();
        } catch (error) {
          set({
            refreshingPr: false,
            error: toAppError(error, "Could not refresh the pull request"),
          });
        }
      },

      async refresh() {
        // Refs move under the app whenever the user fetches, pulls, or switches
        // branches in a terminal, so a refresh re-reads the repo and its branch
        // list rather than only re-running the diff.
        const { repo, pr, refreshingPr, loadingDiff, openingPr } = get();
        if (refreshingPr || loadingDiff || openingPr) return;

        if (pr) {
          // Re-reading the PR is a network round-trip through `gh`, and nothing
          // else is marked busy until `loadDiff` starts — so hold `refreshingPr`
          // across it. Both Refresh buttons watch that flag, so neither can be
          // pressed into a second concurrent run while this one talks to GitHub.
          set({ refreshingPr: true, error: null });
          try {
            await syncPr(repo.root, pr);
          } catch (error) {
            set({
              refreshingPr: false,
              error: toAppError(error, "Could not refresh the pull request"),
            });
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

      selectFile(path, lines = null) {
        // The counter, not the path, is what the diff surface watches: choosing
        // the file you are already on is a request to go back to it, so it has to
        // register as a new selection rather than as no change at all.
        set({ selectedPath: path, selectedLines: lines, selectionTick: get().selectionTick + 1 });
      },

      moveSelection(offset) {
        const { summary, selectedPath } = get();
        const files = summary?.files ?? [];
        if (files.length === 0) return;

        const current = files.findIndex((file) => file.path === selectedPath);
        const next = Math.min(Math.max(current + offset, 0), files.length - 1);
        const target = files[current === -1 ? 0 : next];
        // Stepping through files is a whole-file move, so any line a finding
        // pinned the selection to no longer applies.
        if (target) set({ selectedPath: target.path, selectedLines: null });
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
        if (base && compare) {
          writeViewed(
            storageRoot(repo),
            base,
            viewedScope(compare, reviewsWorkingTree(get())),
            nextViewed,
          );
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
        const { repo, base, compare, summary, reviewing, reReviewing, pr } = get();
        if (!base || !compare || !summary || reviewing || reReviewing) return;

        const { engine: reviewEngine, model, effort } = env.settings();
        const head = reviewedHead(get());
        const worktree = reviewsWorkingTree(get());
        const scope = viewedScope(compare, worktree);
        const target = worktree ? null : compare;
        // This takes a while; if the comparison changed under it, its result
        // still gets *persisted* for the comparison it belongs to — it just must
        // not land in the state of whatever is on screen now.
        const stillCurrent = () =>
          get().summary?.mergeBase === summary.mergeBase &&
          get().compare === compare &&
          reviewsWorkingTree(get()) === worktree;

        const runId = beginRun("review", reviewEngine);
        set({ reviewing: true, reviewError: null });
        try {
          const result = await gitApi.reviewDiff(
            runId,
            repo.root,
            summary.mergeBase,
            target,
            reviewEngine,
            model,
            effort,
            pr,
          );
          // Re-read rather than spread state: another engine's slot may have
          // changed while this review ran.
          const current = readReviews(storageRoot(repo), base, scope);
          const stored: StoredReview = {
            review: result,
            engine: reviewEngine,
            model,
            effort,
            mergeBase: summary.mergeBase,
            head,
            createdAt: new Date().toISOString(),
            threads: {},
            earlier: earlierThan(current[reviewEngine]),
          };
          const next = { ...current, [reviewEngine]: stored };
          writeReviews(storageRoot(repo), base, scope, next);
          if (pr) {
            recordReview(storageRoot(repo), pr, {
              engine: reviewEngine,
              createdAt: stored.createdAt,
              findings: result.findings.length,
            });
          }
          set(stillCurrent() ? { reviews: next, reviewing: false } : { reviewing: false });
        } catch (error) {
          set(
            stillCurrent()
              ? { reviewing: false, reviewError: runFailure(error, "The review failed") }
              : { reviewing: false },
          );
        } finally {
          endRun(runId);
        }
      },

      async runExplain() {
        const { repo, base, compare, summary, explaining, pr } = get();
        if (!base || !compare || !summary || explaining) return;

        const { engine, model, effort } = env.settings();
        const worktree = reviewsWorkingTree(get());
        const scope = viewedScope(compare, worktree);
        const stillCurrent = () =>
          get().summary?.mergeBase === summary.mergeBase &&
          get().compare === compare &&
          reviewsWorkingTree(get()) === worktree;

        const runId = beginRun("explain", engine);
        set({ explaining: true, explainError: null });
        try {
          const result = await gitApi.explainDiff(
            runId,
            repo.root,
            summary.mergeBase,
            worktree ? null : compare,
            engine,
            model,
            effort,
            pr,
          );
          const stored: StoredExplanation = {
            explanation: result,
            engine,
            model,
            effort,
            mergeBase: summary.mergeBase,
            createdAt: new Date().toISOString(),
          };
          writeExplanation(storageRoot(repo), base, scope, stored);
          set(stillCurrent() ? { explanation: stored, explaining: false } : { explaining: false });
        } catch (error) {
          set(
            stillCurrent()
              ? {
                  explaining: false,
                  explainError: runFailure(error, "Could not explain the change"),
                }
              : { explaining: false },
          );
        } finally {
          endRun(runId);
        }
      },

      async runReReview() {
        const { repo, base, compare, summary, reviews, reviewing, reReviewing, pr } = get();
        const { engine: reviewEngine, model, effort } = env.settings();
        const prior = reviews[reviewEngine];
        if (!base || !compare || !summary || !prior) return;
        if (reviewing || reReviewing) return;

        const head = reviewedHead(get());
        const worktree = reviewsWorkingTree(get());
        const scope = viewedScope(compare, worktree);
        const target = worktree ? null : compare;
        const stillCurrent = () =>
          get().summary?.mergeBase === summary.mergeBase &&
          get().compare === compare &&
          reviewsWorkingTree(get()) === worktree;

        const runId = beginRun("review", reviewEngine);
        set({ reReviewing: true, reviewError: null });
        try {
          const result = await gitApi.reReviewDiff({
            runId,
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
          const current = readReviews(storageRoot(repo), base, scope);
          const stored: StoredReview = {
            review: {
              summary: result.summary,
              findings: result.findings,
              verdict: result.verdict,
              conclusion: result.conclusion,
              cutShort: result.cutShort,
            },
            resolutions,
            engine: reviewEngine,
            model,
            effort,
            mergeBase: summary.mergeBase,
            head,
            createdAt: new Date().toISOString(),
            threads,
            earlier: earlierThan(current[reviewEngine] ?? prior),
          };
          const next = { ...current, [reviewEngine]: stored };
          writeReviews(storageRoot(repo), base, scope, next);
          if (pr) {
            recordReview(storageRoot(repo), pr, {
              engine: reviewEngine,
              createdAt: stored.createdAt,
              findings: result.findings.length,
            });
          }
          set(stillCurrent() ? { reviews: next, reReviewing: false } : { reReviewing: false });
        } catch (error) {
          set(
            stillCurrent()
              ? { reReviewing: false, reviewError: runFailure(error, "The re-review failed") }
              : { reReviewing: false },
          );
        } finally {
          endRun(runId);
        }
      },

      async addComment(engine, threadKey, text) {
        const { repo, base, compare, reviews, replyingTo, pr } = get();
        const stored = reviews[engine];
        if (!base || !compare || !stored || replyingTo) return;

        const worktree = reviewsWorkingTree(get());
        const scope = viewedScope(compare, worktree);
        const stillCurrent = () =>
          get().compare === compare && reviewsWorkingTree(get()) === worktree;

        // Reads and writes go through localStorage so a reply landing after the
        // user navigated away is kept for when they come back.
        const persist = (updated: StoredReview): ReviewsByEngine => {
          const next = { ...readReviews(storageRoot(repo), base, scope), [engine]: updated };
          writeReviews(storageRoot(repo), base, scope, next);
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
        set(
          stillCurrent()
            ? { reviews: askedReviews, replyingTo: sourcedKey(engine, threadKey) }
            : {},
        );

        const runId = beginRun("reply", engine);
        try {
          const reply = await gitApi.reviewReply({
            runId,
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
          set(
            stillCurrent() ? { reviews: answeredReviews, replyingTo: null } : { replyingTo: null },
          );
        } catch (error) {
          set(
            stillCurrent()
              ? { replyingTo: null, reviewError: runFailure(error, "No reply to your comment") }
              : { replyingTo: null },
          );
        } finally {
          endRun(runId);
        }
      },

      async postPrComment(engine, finding, body, location, prior = false) {
        const { destination } = location;
        const { repo, base, compare, reviews, pr, postingTo } = get();
        const stored = reviews[engine];
        const targetKey = postTargetKey(engine, finding, prior);
        if (!base || !compare || !pr || !stored || postingTo || !body.trim()) return false;

        const worktree = reviewsWorkingTree(get());
        const scope = viewedScope(compare, worktree);
        const stillCurrent = () =>
          get().compare === compare && reviewsWorkingTree(get()) === worktree;
        const persist = (updated: StoredReview): ReviewsByEngine => {
          const next = { ...readReviews(storageRoot(repo), base, scope), [stored.engine]: updated };
          writeReviews(storageRoot(repo), base, scope, next);
          return next;
        };

        set({ postingTo: targetKey, reviewError: null });
        try {
          const posted = await gitApi.postPrComment({
            root: repo.root,
            pr,
            body: body.trim(),
            path: destination === "topLevel" ? null : location.path,
            line: destination === "inline" ? location.line : null,
            endLine: destination === "inline" ? location.endLine : null,
            destination,
          });
          const updated = withPostedComment(
            stored,
            finding,
            posted.url,
            new Date().toISOString(),
            prior,
          );
          const next = persist(updated);
          set(stillCurrent() ? { reviews: next, postingTo: null } : { postingTo: null });
          return true;
        } catch (error) {
          set(
            stillCurrent()
              ? { postingTo: null, reviewError: toAppError(error, "Could not send to the PR") }
              : { postingTo: null },
          );
          return false;
        }
      },

      async submitPrReview(engine, verdict, body) {
        const { repo, base, compare, reviews, pr, postingTo } = get();
        const stored = reviews[engine];
        if (!base || !compare || !pr || !stored || postingTo) return false;
        // GitHub takes a bare approval, but nothing else without a body.
        if (verdict !== "approve" && !body.trim()) return false;

        const worktree = reviewsWorkingTree(get());
        const scope = viewedScope(compare, worktree);
        const stillCurrent = () =>
          get().compare === compare && reviewsWorkingTree(get()) === worktree;

        set({ postingTo: sourcedKey(engine, CONCLUSION_POST_KEY), reviewError: null });
        try {
          const posted = await gitApi.submitPrReview({ pr, verdict, body: body.trim() });
          // A submitted review moves the PR's decision, and off "Review requested".
          void invalidatePrLists(repo.root);
          const updated: StoredReview = {
            ...stored,
            review: {
              ...stored.review,
              submitted: { url: posted.url, verdict, at: new Date().toISOString() },
            },
          };
          const next = { ...readReviews(storageRoot(repo), base, scope), [stored.engine]: updated };
          writeReviews(storageRoot(repo), base, scope, next);
          set(stillCurrent() ? { reviews: next, postingTo: null } : { postingTo: null });
          return true;
        } catch (error) {
          set(
            stillCurrent()
              ? { postingTo: null, reviewError: toAppError(error, "Could not submit the review") }
              : { postingTo: null },
          );
          return false;
        }
      },

      async setThreadResolved(threadId, resolved) {
        const { pr, settingThread } = get();
        if (!pr || settingThread) return false;

        set({ settingThread: threadId, reviewError: null });
        try {
          const thread = await gitApi.setPrThreadResolved({ pr, threadId, resolved });
          // The PR may have been re-read meanwhile; only this thread changes in
          // whatever is on record for it now.
          const current = get().pr;
          set(
            current?.url === pr.url
              ? {
                  settingThread: null,
                  pr: {
                    ...current,
                    threads: current.threads.map((old) => (old.id === thread.id ? thread : old)),
                  },
                }
              : { settingThread: null },
          );
          return true;
        } catch (error) {
          set({
            settingThread: null,
            reviewError: toAppError(
              error,
              resolved ? "Could not resolve the thread" : "Could not reopen the thread",
            ),
          });
          return false;
        }
      },

      noteRunOutput(runId) {
        const run = get().agentRuns[runId];
        if (!run) return;
        set({ agentRuns: { ...get().agentRuns, [runId]: { ...run, lastOutputAt: Date.now() } } });
      },

      cancelAgentRuns(kinds) {
        const runs = { ...get().agentRuns };
        for (const [runId, run] of Object.entries(runs)) {
          if (!kinds.includes(run.kind) || run.cancelling) continue;
          runs[runId] = { ...run, cancelling: true };
          void gitApi.cancelAgentRun(runId);
        }
        set({ agentRuns: runs });
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
}

/** A tab as its screen knows it. */
export interface TabHandle {
  id: string;
  store: TabStore;
  /** Names the tab's parts that move between screens (`ScreenMorph`). */
  morphKey: string;
}

const TabContext = createContext<TabHandle | null>(null);

/** Provides the tab whose screen this is to every `useTab` below it. */
export const TabProvider = TabContext;

/** The tab this component belongs to. */
export function useTabHandle(): TabHandle {
  const tab = useContext(TabContext);
  if (!tab) throw new Error("useTab() needs a <TabProvider> above it");
  return tab;
}

/** The store of the tab this component belongs to. */
export function useTabStore(): TabStore {
  return useTabHandle().store;
}

/** Reads the state of the tab this component belongs to. */
export function useTab<T>(selector: (state: TabState) => T): T {
  return useStore(useTabStore(), selector);
}
