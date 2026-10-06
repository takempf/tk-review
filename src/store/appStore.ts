import { flushSync } from "react-dom";
import { create } from "zustand";
import {
  type AppError,
  type Branch,
  gitApi,
  type RepoInfo,
  type ReviewEngine,
  toAppError,
} from "../ipc/git";
import { prMorphKey, screenSettling, transitionScreen } from "../lib/screenTransition";
import { claimUnscopedStorage } from "./account";
import { forgetRepo, rememberRepo } from "./history";
import {
  createTabStore,
  keepsTab,
  type PrPreview,
  prComparison,
  type TabHandle,
  type TabInit,
  type TabStore,
} from "./tabStore";

/**
 * What the whole window shares: the repository the pull-request list shows,
 * the review settings, and the tabs. Each tab's comparison lives in a store of
 * its own (`tabStore.ts`).
 */

const LAST_REPO_KEY = "tk-review:last-repo";
const REVIEW_ENGINE_KEY = "tk-review:review-engine";
const FILE_NOTES_KEY = "tk-review:file-notes";
const reviewModelKey = (engine: ReviewEngine) => `tk-review:review-model:${engine}`;
const reviewEffortKey = (engine: ReviewEngine) => `tk-review:review-effort:${engine}`;

function readReviewEngine(): ReviewEngine {
  return localStorage.getItem(REVIEW_ENGINE_KEY) === "codex" ? "codex" : "claude";
}

function readFileNotes(): boolean {
  return localStorage.getItem(FILE_NOTES_KEY) !== "false";
}

function readReviewModel(engine: ReviewEngine): string {
  return localStorage.getItem(reviewModelKey(engine)) ?? "";
}

function readReviewEffort(engine: ReviewEngine): string {
  return localStorage.getItem(reviewEffortKey(engine)) ?? "";
}

export type DiffLayout = "split" | "unified";

/** Home is the pull-request list; review is a tab's comparison open in the diff. */
export type AppView = "home" | "review";

export interface NavigateOptions {
  /**
   * Run the screen transition. Off when something else already animated the
   * change — the system's swipe-back gesture slides its own snapshot.
   */
  animate?: boolean;
}

/** One open comparison, as the tab bar lists it. */
export interface ReviewTab extends TabHandle {
  root: string;
  /** The pull request it reviews; `null` for a comparison of two branches. */
  number: number | null;
}

interface AppState {
  view: AppView;
  /** The repository the pull-request list shows, and new tabs open in. */
  repo: RepoInfo | null;
  branches: Branch[];
  loadingRepo: boolean;
  /** Shown on the home screen: a repository or pull request that failed to open. */
  error: AppError | null;
  /**
   * In the order they were opened. A tab lasts until it is closed, or left with
   * nothing more to show (`keepsTab`).
   */
  tabs: ReviewTab[];
  /** The tab the review shows — on screen, or waiting behind the list. */
  activeTabId: string | null;
  /**
   * The `morphKey` of a tab that closed on the way back to the list, while
   * that change settles: its row on the list takes the number and title its
   * tab gives up.
   */
  returning: string | null;
  /**
   * What moves in the screen change under way, set just before the change
   * captures the old screen, so only those parts are named for it. `null`
   * between changes, and for one where nothing moves (a switch between tabs),
   * which is a plain crossfade.
   */
  screenChange: ScreenChange | null;
  layout: DiffLayout;
  /**
   * Show links to explanations at the top of each file in the diff.
   * Turning it off hides them without discarding them.
   */
  fileNotes: boolean;
  /** Which agent CLI runs the next review or explanation. */
  reviewEngine: ReviewEngine;
  /** Model override for the engine; empty means the CLI's configured default. */
  reviewModel: string;
  /** Reasoning-effort override for the engine; empty means the CLI's default. */
  reviewEffort: string;

  openRepo: (path: string) => Promise<void>;
  restoreLastRepo: () => Promise<void>;
  closeRepo: () => void;
  /** Back to the pull-request list. The tab left closes unless `keepsTab`. */
  goHome: (options?: NavigateOptions) => void;
  /** Into a tab's review, loading its diff if it hasn't been. The tab left closes unless `keepsTab`. */
  showTab: (id: string, options?: NavigateOptions) => Promise<void>;
  /** Back into the tab last shown. False when there is none left to show. */
  showReview: (options?: NavigateOptions) => Promise<boolean>;
  /**
   * Opens a PR by URL or reference in a tab of its own, or shows the tab it is
   * already open in. With a `preview` from the list, the tab shows at once and
   * fills in as the PR loads; without one, the screen changes once it has.
   * `from` is the tab asking, whose repository the PR is looked up in and
   * whose banner a failure shows in.
   */
  openPr: (url: string, options?: { preview?: PrPreview; from?: TabStore }) => Promise<boolean>;
  /** Shows the repository's branch comparison, opening a tab for it the first time. */
  compareBranches: () => Promise<void>;
  /** Closes a tab, stopping its agent runs. Its neighbour takes its place on screen. */
  closeTab: (id: string) => void;
  setLayout: (layout: DiffLayout) => void;
  setReviewEngine: (engine: ReviewEngine) => void;
  setReviewModel: (model: string) => void;
  setReviewEffort: (effort: string) => void;
  setFileNotes: (shown: boolean) => void;
  /** Records that an agent run's CLI just wrote something, in whichever tab runs it. */
  noteRunOutput: (runId: string) => void;
  dismissError: () => void;
}

/** The tab on screen, if a review is. */
/** What moves in a screen change. */
export interface ScreenChange {
  /** Tabs come or go, so every tab slides to its new place. */
  shifting: boolean;
  /** The list's heading and the review's way back to it trade places. */
  heading: boolean;
  /** The `morphKey` whose number and title glide between a list row and a tab. */
  carrying: string | null;
  /** The id of the tab closing, whose number and title fold away with it. */
  folding: string | null;
}

export function shownTab(state: Pick<AppState, "view" | "tabs" | "activeTabId">): ReviewTab | null {
  if (state.view !== "review") return null;
  return state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
}

/**
 * Whether the tab bar shows: always in a review, which keeps its way back to
 * the list there, and on the list whenever a tab is open.
 */
export function tabBarShown(state: Pick<AppState, "view" | "tabs">): boolean {
  return state.view === "review" || state.tabs.length > 0;
}

/**
 * Tabs closed while their screen may still be fading out. The leaving screen
 * keeps rendering from its store until the change settles.
 */
const closing = new Map<string, ReviewTab>();

/** A tab by id, including one that has just been closed. */
export function findTab(id: string): ReviewTab | null {
  return useAppStore.getState().tabs.find((tab) => tab.id === id) ?? closing.get(id) ?? null;
}

/** The comparison a pull request would show: default branch → current branch. */
function defaultComparison(repo: RepoInfo, branches: Branch[]) {
  const names = new Set(branches.map((branch) => branch.name));
  const compare = repo.currentBranch ?? branches.find((branch) => branch.isHead)?.name ?? null;
  const preferredBase = repo.defaultBranch ?? null;
  const base =
    preferredBase && names.has(preferredBase) && preferredBase !== compare
      ? preferredBase
      : (branches.find((branch) => branch.name !== compare)?.name ?? preferredBase);
  return { base, compare };
}

export const useAppStore = create<AppState>((set, get) => {
  /**
   * Applies `patch` inside the screen transition, so whatever moves between the
   * tab bar and the list glides there. Resolves once the store
   * holds the new state.
   */
  function transition(patch: Partial<AppState>, { animate = true }: NavigateOptions = {}) {
    const left = shownTab(get());
    let retired: ReviewTab | null = null;
    const change = animate ? plannedChange(patch) : null;
    if (change) flushSync(() => set({ screenChange: change }));
    const update = () => {
      set(patch);
      // Looked at now: its status loses the "finished while away" dot in the
      // same frame its tab becomes the one on screen.
      const shown = shownTab(get());
      shown?.store.getState().markSeen();
      // The tab just left, with nothing still coming, has done its job: it
      // closes rather than wait in the tab bar.
      if (!left || left.id === shown?.id || !get().tabs.includes(left)) return;
      if (keepsTab(left.store.getState())) return;
      retired = left;
      closing.set(left.id, left);
      rememberClosed(left);
      const { tabs, activeTabId, view } = get();
      set({
        tabs: tabs.filter((tab) => tab !== left),
        activeTabId: activeTabId === left.id ? null : activeTabId,
        returning: view === "home" ? left.morphKey : null,
      });
    };
    const settle = async () => {
      await (screenSettling() ?? Promise.resolve());
      if (change && get().screenChange === change) set({ screenChange: null });
      if (!retired) return;
      closing.delete(retired.id);
      if (get().returning === retired.morphKey) set({ returning: null });
    };
    if (!animate) {
      update();
      void settle();
      return Promise.resolve();
    }
    const done = transitionScreen(update, { shared: change != null });
    void done.then(settle);
    return done;
  }

  /**
   * What moves in the screen change `patch` makes, or `null` when nothing does
   * and the screens only crossfade. A tab closes by being taken out of the
   * list, or by being left with nothing to keep it (`keepsTab`); a PR opened
   * from the list takes its number and title from its row, and one left for
   * the list hands them back.
   */
  function plannedChange(patch: Partial<AppState>): ScreenChange | null {
    const before = get();
    const after = { ...before, ...patch };
    const left = shownTab(before);
    const shown = shownTab(after);
    const removed = before.tabs.find((tab) => !after.tabs.includes(tab)) ?? null;
    const added = after.tabs.some((tab) => !before.tabs.includes(tab));
    const retires =
      left != null &&
      left.id !== shown?.id &&
      after.tabs.includes(left) &&
      !keepsTab(left.store.getState());
    const home = after.view === "home";
    const heading = (before.view === "home") !== home;
    if (!added && !removed && !retires && !heading) return null;
    const opened = before.view === "home" && shown != null && !before.tabs.includes(shown);
    return {
      shifting: added || removed != null || retires,
      heading,
      carrying: opened ? shown.morphKey : retires && home ? left.morphKey : null,
      folding: removed?.id ?? (retires && !home ? left.id : null),
    };
  }

  /**
   * Tabs closed lately, newest last: reopening one of their PRs shows it at
   * once from what it had loaded, and checks it against GitHub behind that,
   * rather than fetching and diffing it all again.
   */
  const recentlyClosed: ReviewTab[] = [];
  const RECENTLY_CLOSED = 4;

  function rememberClosed(tab: ReviewTab) {
    const { summary, error } = tab.store.getState();
    if (tab.number == null || !summary || error) return;
    const index = recentlyClosed.findIndex((other) => other.morphKey === tab.morphKey);
    if (index !== -1) recentlyClosed.splice(index, 1);
    recentlyClosed.push(tab);
    if (recentlyClosed.length > RECENTLY_CLOSED) recentlyClosed.shift();
  }

  function takeClosed(root: string, number: number): ReviewTab | null {
    const index = recentlyClosed.findIndex((tab) => tab.root === root && tab.number === number);
    return index === -1 ? null : (recentlyClosed.splice(index, 1)[0] ?? null);
  }

  /** Brings a recently closed tab back, and checks its PR behind it. */
  async function reopen(tab: ReviewTab): Promise<true> {
    await addTab(tab);
    void tab.store.getState().revalidatePr();
    return true;
  }

  function openPrs(root: string): number[] {
    return get()
      .tabs.filter((tab) => tab.root === root && tab.number != null)
      .map((tab) => tab.number as number);
  }

  function makeTab(init: TabInit, number: number | null): ReviewTab {
    const id = crypto.randomUUID();
    const store = createTabStore(init, {
      settings: () => {
        const { reviewEngine, reviewModel, reviewEffort } = get();
        return {
          engine: reviewEngine,
          model: reviewModel.trim() || null,
          effort: reviewEffort.trim() || null,
        };
      },
      openPrs,
      isShown: () => shownTab(get())?.id === id,
    });
    const root = init.repo.root;
    const morphKey = number != null ? prMorphKey(root, number) : `branches-${id}`;
    return { id, root, number, morphKey, store };
  }

  function prTab(root: string, number: number): ReviewTab | null {
    return get().tabs.find((tab) => tab.root === root && tab.number === number) ?? null;
  }

  /** Opens `tab` on screen after the rest. */
  function addTab(tab: ReviewTab): Promise<void> {
    return transition({
      view: "review",
      tabs: [...get().tabs, tab],
      activeTabId: tab.id,
      error: null,
    });
  }

  /**
   * Takes `id` out of the tab list, and off screen if it was showing — for the
   * tab after it, else the one before, else the list, as closing a browser
   * tab does.
   */
  function removeTab(id: string, patch: Partial<AppState> = {}): Promise<void> {
    const { tabs, activeTabId } = get();
    const index = tabs.findIndex((tab) => tab.id === id);
    const tab = tabs[index];
    if (!tab) return Promise.resolve();
    const rest = tabs.filter((other) => other.id !== id);
    const wasShown = shownTab(get())?.id === id;
    const next = wasShown ? (rest[index] ?? rest[index - 1] ?? null) : null;

    closing.set(id, tab);
    rememberClosed(tab);
    const done = transition({
      ...patch,
      tabs: rest,
      ...(wasShown
        ? { view: next ? "review" : "home", activeTabId: next?.id ?? null }
        : { activeTabId: activeTabId === id ? null : activeTabId }),
    }).then(async () => {
      await (screenSettling() ?? Promise.resolve());
      closing.delete(id);
    });
    if (next) void next.store.getState().ensureDiff();
    return done;
  }

  async function open(path: string, { remember }: { remember: boolean }): Promise<void> {
    set({ loadingRepo: true, error: null });
    try {
      const repo = await gitApi.selectRepo(path);
      claimUnscopedStorage(repo);
      const branches = await gitApi.listBranches(repo.root);
      set({ loadingRepo: false });
      // Tabs stay open, whichever repository they are in; the list is what changes.
      await transition({ view: "home", repo, branches }, { animate: get().view !== "home" });
      if (remember) {
        localStorage.setItem(LAST_REPO_KEY, repo.root);
        rememberRepo(repo);
      }
    } catch (error) {
      set({ loadingRepo: false, error: toAppError(error, "Could not open the repository") });
      if (remember) {
        localStorage.removeItem(LAST_REPO_KEY);
        forgetRepo(path);
      }
    }
  }

  return {
    view: "home",
    repo: null,
    branches: [],
    loadingRepo: false,
    error: null,
    tabs: [],
    activeTabId: null,
    returning: null,
    screenChange: null,
    layout: "split",
    fileNotes: readFileNotes(),
    reviewEngine: readReviewEngine(),
    reviewModel: readReviewModel(readReviewEngine()),
    reviewEffort: readReviewEffort(readReviewEngine()),

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
      set({ view: "home", repo: null, branches: [], error: null });
    },

    goHome(options) {
      if (get().view === "home") return;
      void transition({ view: "home", error: null }, options);
    },

    async showTab(id, options) {
      const tab = get().tabs.find((candidate) => candidate.id === id);
      if (!tab || shownTab(get())?.id === id) return;
      await transition({ view: "review", activeTabId: id, error: null }, options);
      await tab.store.getState().ensureDiff();
    },

    async showReview(options) {
      const { activeTabId } = get();
      if (!activeTabId || !get().tabs.some((tab) => tab.id === activeTabId)) return false;
      await get().showTab(activeTabId, options);
      return true;
    },

    async openPr(url, { preview, from } = {}) {
      const repo = from?.getState().repo ?? get().repo;
      if (!repo) return false;
      const fail = (error: unknown) => {
        const shown = toAppError(error, "Could not open the pull request");
        if (from) from.setState({ error: shown });
        else set({ error: shown });
      };

      if (preview) {
        const already = prTab(repo.root, preview.number);
        if (already) {
          await get().showTab(already.id);
          return true;
        }
        const recent = takeClosed(repo.root, preview.number);
        if (recent) return reopen(recent);
        const tab = makeTab(
          {
            repo,
            branches: repo.root === get().repo?.root ? get().branches : [],
            base: null,
            compare: null,
            pendingPr: { url, ...preview },
          },
          preview.number,
        );
        await addTab(tab);
        if (await tab.store.getState().openPr(url)) return true;
        // A review of nothing is a dead end: back to the list, which shows why.
        const { error } = tab.store.getState();
        if (get().tabs.includes(tab)) await removeTab(tab.id, { error });
        // Left while it opened, and closed with it; the list still says why.
        else if (get().view === "home") set({ error });
        return false;
      }

      // A pasted link says nothing about its PR until `gh` has read it, so
      // whoever asked waits on it, "Opening…", and the screen changes after.
      try {
        // Neither needs the other: PR heads are fetched outside the branches listed.
        const [pr, branches] = await Promise.all([
          gitApi.openPr(repo.root, url, openPrs(repo.root)),
          gitApi.listBranches(repo.root),
        ]);
        const already = prTab(repo.root, pr.number);
        if (already) {
          await get().showTab(already.id);
          return true;
        }
        const recent = takeClosed(repo.root, pr.number);
        if (recent) return reopen(recent);
        const tab = makeTab({ repo, branches, ...prComparison(pr) }, pr.number);
        await addTab(tab);
        await tab.store.getState().ensureDiff();
        return true;
      } catch (error) {
        fail(error);
        return false;
      }
    },

    async compareBranches() {
      const { repo, branches, tabs } = get();
      if (!repo) return;
      const already = tabs.find((tab) => tab.root === repo.root && tab.number == null);
      if (already) {
        await get().showTab(already.id);
        return;
      }
      const tab = makeTab({ repo, branches, ...defaultComparison(repo, branches) }, null);
      await addTab(tab);
      await tab.store.getState().ensureDiff();
    },

    closeTab(id) {
      const tab = get().tabs.find((candidate) => candidate.id === id);
      if (!tab) return;
      // Nobody is left to read what they would write.
      tab.store.getState().cancelAgentRuns(["review", "explain", "reply"]);
      void removeTab(id);
    },

    setLayout(layout) {
      set({ layout });
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

    setFileNotes(fileNotes) {
      set({ fileNotes });
      try {
        localStorage.setItem(FILE_NOTES_KEY, String(fileNotes));
      } catch {
        // Preference persistence is best-effort.
      }
    },

    noteRunOutput(runId) {
      for (const tab of get().tabs) tab.store.getState().noteRunOutput(runId);
    },

    dismissError() {
      set({ error: null });
    },
  };
});
