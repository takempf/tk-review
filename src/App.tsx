import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo } from "react";
import { Button, Icon } from "tk-design-system";
import css from "./App.module.css";
import { githubHost } from "./components/Author/Author";
import { CommitList } from "./components/CommitList/CommitList";
import { ComparisonPicker } from "./components/ComparisonPicker/ComparisonPicker";
import { DiffStats } from "./components/DiffStats/DiffStats";
import { DiffSkeleton, DiffSurface } from "./components/DiffSurface/DiffSurface";
import { FileList } from "./components/FileList/FileList";
import { Home } from "./components/Home/Home";
import { Layout } from "./components/Layout/Layout";
import { PrBranches } from "./components/PrBranches/PrBranches";
import { ReviewPanel } from "./components/ReviewPanel/ReviewPanel";
import { Spinner } from "./components/Spinner/Spinner";
import { TabBar } from "./components/TabBar/TabBar";
import { TitleBar } from "./components/TitleBar/TitleBar";
import { gitApi } from "./ipc/git";
import { useScreenHistory } from "./lib/screenHistory";
import { ScreenStack } from "./lib/screenTransition";
import { findTab, shownTab, useAppStore } from "./store/appStore";
import { reviewsWorkingTree, TabProvider, useTab } from "./store/tabStore";

/** `j`/`k` move through the file list, the way a pager would. */
function useFileKeyboardNav() {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      // Never steal keystrokes aimed at a form control.
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, select, textarea, [contenteditable='true']")) return;

      const tab = shownTab(useAppStore.getState());
      if (!tab) return;
      const { moveSelection } = tab.store.getState();
      if (event.key === "j") moveSelection(1);
      else if (event.key === "k") moveSelection(-1);
      else return;

      event.preventDefault();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

/** The comparison on screen, or the repository the list shows. */
function useWindowTitle() {
  const name = useAppStore((state) => state.repo?.name ?? null);
  const tab = useAppStore(shownTab);

  useEffect(() => {
    let last = "";
    const apply = () => {
      const state = tab?.store.getState();
      const suffix = state && reviewsWorkingTree(state) ? " + uncommitted" : "";
      const title =
        state?.base && state.compare
          ? `${state.repo.name} — ${state.base} … ${state.compare}${suffix}`
          : (name ?? "TK Review");
      // The tab's store changes far more often than its title does.
      if (title === last) return;
      last = title;
      document.title = title;
      // Best effort: the native title bar is separate from the document title, and
      // may be denied by capabilities without that meaning anything is broken.
      void getCurrentWindow()
        .setTitle(title)
        .catch(() => {});
    };
    apply();
    return tab?.store.subscribe(apply);
  }, [name, tab]);
}

/** Keeps each agent run's last-output time current, for its progress line. */
function useAgentRunOutput() {
  const noteRunOutput = useAppStore((state) => state.noteRunOutput);
  useEffect(() => {
    const listening = gitApi.onAgentRunOutput(noteRunOutput);
    return () => void listening.then((stop) => stop());
  }, [noteRunOutput]);
}

/**
 * The pull request's author and branches. Its number, title and status are its
 * tab's to show, in the tab bar above.
 */
function PrHeading() {
  // While it opens, the list's author and branches stand in for the fetched ones.
  const pr = useTab((state) => state.pr ?? state.pendingPr);
  if (!pr?.headRef || !pr.baseRef) return null;
  return (
    <PrBranches
      author={pr.author ?? null}
      host={githubHost(pr.url)}
      headRef={pr.headRef}
      baseRef={pr.baseRef}
    />
  );
}

/** A tab's comparison open in the diff, with the file list and the review beside it. */
function ReviewScreen() {
  const root = useTab((state) => state.repo.root);
  const hasPr = useTab((state) => state.pr != null || state.pendingPr != null);
  const openingPr = useTab((state) => state.openingPr);
  const error = useTab((state) => state.error);
  const summary = useTab((state) => state.summary);
  const loadingDiff = useTab((state) => state.loadingDiff);
  // With a PR open, refreshing re-reads it from GitHub before the diff reloads;
  // the button stays busy for that leg too, not only for the diff.
  const refreshingPr = useTab((state) => state.refreshingPr);
  const refresh = useTab((state) => state.refresh);
  const dismissError = useTab((state) => state.dismissError);
  // A comment marker in the diff opens its conversation in the review panel.
  const commentFocus = useTab((state) => state.commentFocus?.tick);

  return (
    <Layout
      revealAside={commentFocus}
      error={error}
      onDismissError={dismissError}
      header={
        <>
          <div className={css.headerGroup}>
            {/* A PR is chosen from the list; only a branch comparison is picked here. */}
            {hasPr ? <PrHeading /> : <ComparisonPicker key={root} />}
          </div>
          <span className={css.spacer} />
          <DiffStats />
          <Button
            size="sm"
            onClick={() => void refresh()}
            disabled={loadingDiff || refreshingPr || openingPr}
          >
            {loadingDiff || refreshingPr ? (
              <>
                <Spinner /> Refreshing…
              </>
            ) : (
              <>
                <Icon name="refresh" /> Refresh
              </>
            )}
          </Button>
        </>
      }
      sidebar={
        <div className={css.sidebar}>
          <FileList />
          <CommitList />
        </div>
      }
      aside={<ReviewPanel />}
      main={
        summary ? (
          <DiffSurface />
        ) : loadingDiff || openingPr ? (
          <DiffSkeleton />
        ) : (
          <p className={css.placeholder}>Choose two refs to compare.</p>
        )
      }
    />
  );
}

type Screen = "home" | `tab:${string}`;

function renderScreen(screen: Screen) {
  if (screen === "home") return <Home />;
  // Found even once closed, so its screen can fade out.
  const tab = findTab(screen.slice("tab:".length));
  if (!tab) return null;
  return (
    <TabProvider value={tab}>
      <ReviewScreen />
    </TabProvider>
  );
}

export function App() {
  const tab = useAppStore(shownTab);
  const tabs = useAppStore((state) => state.tabs);
  // The list and every open tab stay mounted, the one on show in front.
  const screens = useMemo<Screen[]>(
    () => ["home", ...tabs.map((open) => `tab:${open.id}` as const)],
    [tabs],
  );
  const restoreLastRepo = useAppStore((state) => state.restoreLastRepo);

  useFileKeyboardNav();
  useWindowTitle();
  useAgentRunOutput();
  useScreenHistory();

  useEffect(() => {
    void restoreLastRepo();
  }, [restoreLastRepo]);

  return (
    <div className={css.window}>
      <TitleBar>
        <TabBar />
      </TitleBar>
      <div className={css.screen}>
        <ScreenStack<Screen>
          screens={screens}
          screen={tab ? `tab:${tab.id}` : "home"}
          render={renderScreen}
        />
      </div>
    </div>
  );
}
