import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import css from "./App.module.css";
import { ComparisonPicker } from "./components/ComparisonPicker/ComparisonPicker";
import { DiffStats } from "./components/DiffStats/DiffStats";
import { DiffSurface } from "./components/DiffSurface/DiffSurface";
import { FileList } from "./components/FileList/FileList";
import { Layout } from "./components/Layout/Layout";
import { RepoPicker, RepoPickerHero } from "./components/RepoPicker/RepoPicker";
import { ReviewPanel } from "./components/ReviewPanel/ReviewPanel";
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

export function App() {
  const repo = useReviewStore((state) => state.repo);
  const error = useReviewStore((state) => state.error);
  const summary = useReviewStore((state) => state.summary);
  const loadingDiff = useReviewStore((state) => state.loadingDiff);
  // With a PR open, refreshing re-reads it from GitHub before the diff reloads;
  // the button stays busy for that leg too, not only for the diff.
  const refreshingPr = useReviewStore((state) => state.refreshingPr);
  const restoreLastRepo = useReviewStore((state) => state.restoreLastRepo);
  const refresh = useReviewStore((state) => state.refresh);
  const dismissError = useReviewStore((state) => state.dismissError);

  useFileKeyboardNav();
  useWindowTitle();

  useEffect(() => {
    void restoreLastRepo();
  }, [restoreLastRepo]);

  if (!repo) return <RepoPickerHero />;

  return (
    <Layout
      error={error}
      onDismissError={dismissError}
      header={
        <>
          <div className={css.headerGroup}>
            <RepoPicker />
            <span className={css.divider} />
            <ComparisonPicker key={repo.root} />
          </div>
          <span className={css.spacer} />
          <DiffStats />
          <button
            type="button"
            className={css.refresh}
            onClick={() => void refresh()}
            disabled={loadingDiff || refreshingPr}
          >
            {loadingDiff || refreshingPr ? "Refreshing…" : "Refresh"}
          </button>
        </>
      }
      sidebar={<FileList />}
      aside={<ReviewPanel />}
      main={
        summary ? (
          <DiffSurface />
        ) : (
          <p className={css.placeholder}>
            {loadingDiff ? "Comparing…" : "Choose two refs to compare."}
          </p>
        )
      }
    />
  );
}
