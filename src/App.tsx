import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { Button, Icon } from "tk-design-system";
import css from "./App.module.css";
import { ComparisonPicker } from "./components/ComparisonPicker/ComparisonPicker";
import { DiffStats } from "./components/DiffStats/DiffStats";
import { DiffSkeleton, DiffSurface } from "./components/DiffSurface/DiffSurface";
import { FileList } from "./components/FileList/FileList";
import { Home } from "./components/Home/Home";
import { Layout } from "./components/Layout/Layout";
import { ReviewPanel } from "./components/ReviewPanel/ReviewPanel";
import { Spinner } from "./components/Spinner/Spinner";
import { TitleBar } from "./components/TitleBar/TitleBar";
import { useScreenHistory } from "./lib/screenHistory";
import { ScreenMorph, ScreenStack } from "./lib/screenTransition";
import { reviewsWorkingTree, useReviewStore } from "./store/reviewStore";

/** `j`/`k` move through the file list, the way a pager would. */
function useFileKeyboardNav() {
  const moveSelection = useReviewStore((state) => state.moveSelection);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      // Never steal keystrokes aimed at a form control.
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, select, textarea, [contenteditable='true']")) return;

      if (event.key === "j") moveSelection(1);
      else if (event.key === "k") moveSelection(-1);
      else return;

      event.preventDefault();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [moveSelection]);
}

function useWindowTitle() {
  const name = useReviewStore((state) => state.repo?.name ?? null);
  const base = useReviewStore((state) => state.base);
  const compare = useReviewStore((state) => state.compare);
  const worktree = useReviewStore(reviewsWorkingTree);

  useEffect(() => {
    const suffix = worktree ? " + uncommitted" : "";
    const title =
      name && base && compare ? `${name} — ${base} … ${compare}${suffix}` : (name ?? "tk-review");
    document.title = title;
    // Best effort: the native title bar is separate from the document title, and
    // may be denied by capabilities without that meaning anything is broken.
    void getCurrentWindow()
      .setTitle(title)
      .catch(() => {});
  }, [name, base, compare, worktree]);
}

/** The pull request under review, set like its row in the list so the two can morph. */
function PrHeading() {
  // While it opens, the list's number and title stand in for the fetched ones.
  const pr = useReviewStore((state) => state.pr ?? state.pendingPr);
  if (!pr) return null;
  return (
    <h1 className={css.prHeading} title={pr.title}>
      <ScreenMorph part="prNumber">
        <span className={css.prNumber}>#{pr.number}</span>
      </ScreenMorph>
      <ScreenMorph part="prTitle">
        <span className={css.prTitle}>{pr.title}</span>
      </ScreenMorph>
    </h1>
  );
}

/** A comparison open in the diff, with the file list and the review beside it. */
function ReviewScreen() {
  const repo = useReviewStore((state) => state.repo);
  const hasPr = useReviewStore((state) => state.pr != null || state.pendingPr != null);
  const openingPr = useReviewStore((state) => state.openingPr);
  const error = useReviewStore((state) => state.error);
  const summary = useReviewStore((state) => state.summary);
  const loadingDiff = useReviewStore((state) => state.loadingDiff);
  // With a PR open, refreshing re-reads it from GitHub before the diff reloads;
  // the button stays busy for that leg too, not only for the diff.
  const refreshingPr = useReviewStore((state) => state.refreshingPr);
  const refresh = useReviewStore((state) => state.refresh);
  const dismissError = useReviewStore((state) => state.dismissError);
  const goHome = useReviewStore((state) => state.goHome);

  if (!repo) return null;

  return (
    <Layout
      error={error}
      onDismissError={dismissError}
      header={
        <>
          <div className={css.headerGroup}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => goHome()}
              title="Back to pull requests"
            >
              <Icon name="arrow-left" />
              Pull requests
            </Button>
            <span className={css.divider} />
            {/* A PR is chosen from the list; only a branch comparison is picked here. */}
            {hasPr ? <PrHeading /> : <ComparisonPicker key={repo.root} />}
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
      sidebar={<FileList />}
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

export function App() {
  const view = useReviewStore((state) => state.view);
  const repo = useReviewStore((state) => state.repo);
  const restoreLastRepo = useReviewStore((state) => state.restoreLastRepo);

  useFileKeyboardNav();
  useWindowTitle();
  useScreenHistory();

  useEffect(() => {
    void restoreLastRepo();
  }, [restoreLastRepo]);

  return (
    <div className={css.window}>
      <TitleBar />
      <ScreenStack
        screen={!repo || view === "home" ? "home" : "review"}
        render={(screen) => (screen === "home" ? <Home /> : <ReviewScreen />)}
      />
    </div>
  );
}
