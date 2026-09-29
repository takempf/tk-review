import { parsePatchFiles, preloadHighlighter } from "@pierre/diffs";
import {
  CodeView,
  type CodeViewHandle,
  type CodeViewItem,
  type CodeViewReactOptions,
  type FileDiffContentsLoader,
} from "@pierre/diffs/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Checkbox, Icon, Toggle, ToggleGroup } from "tk-design-system";
import { gitApi } from "../../ipc/git";
import { useScreenSettled } from "../../lib/screenTransition";
import { HIGHLIGHTER } from "../../lib/warmHighlighter";
import { type DiffLayout, reviewsWorkingTree, useReviewStore } from "../../store/reviewStore";
import { Skeleton, SkeletonGroup } from "../Skeleton/Skeleton";
import css from "./DiffSurface.module.css";
import { DIFF_THEME, DIFFS_THEME_CSS } from "./diffsTheme";

/**
 * Longest line the tokenizer will attempt, in characters.
 *
 * Long lines are the one axis the renderer does not virtualize, so minified
 * bundles are where it hurts. Past this the line renders as plain text instead of
 * being refused — the library's own graceful degradation, applied to the
 * dimension that actually costs something rather than to total file size.
 */
const MAX_LINE_LENGTH = 2_000;

/**
 * Above this many lines a file is highlighted no further and shown as plain
 * text. It still renders, and virtualization keeps it scrollable.
 */
const MAX_HIGHLIGHT_LINES = 100_000;

function Toolbar({
  fileCount,
  layout,
  onLayoutChange,
}: {
  fileCount: number;
  layout: DiffLayout;
  onLayoutChange: (layout: DiffLayout) => void;
}) {
  return (
    <div className={css.toolbar}>
      <span className={css.toolbarLabel}>
        {fileCount} {fileCount === 1 ? "file" : "files"} in this review
      </span>
      <ToggleGroup
        size="sm"
        aria-label="Diff layout"
        value={[layout]}
        onValueChange={(value) => {
          const next = value[0] as DiffLayout | undefined;
          if (next) onLayoutChange(next);
        }}
      >
        <Toggle value="split">
          <Icon name="columns" /> Split
        </Toggle>
        <Toggle value="unified">
          <Icon name="rows" /> Unified
        </Toggle>
      </ToggleGroup>
    </div>
  );
}

/** Line widths, in percent, for the placeholder files: ragged, like code. */
const SKELETON_FILES = [
  [58, 44, 71, 36, 80, 52, 64],
  [42, 67, 55, 74],
  [69, 38, 61, 50, 46],
];

/** Stands in for the files while the diff loads, shaped like them. */
function FilesSkeleton({ instant }: { instant?: boolean }) {
  return (
    <SkeletonGroup label="Loading the diff" instant={instant} className={css.skeletonFiles}>
      {SKELETON_FILES.map((lines, file) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed, static list
        <div key={file} className={css.skeletonFile}>
          <div className={css.skeletonHeader}>
            <Skeleton width={`${24 + file * 9}%`} />
          </div>
          {lines.map((width, line) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed, static list
            <div key={line} className={css.skeletonLine}>
              <Skeleton width="1.5em" className={css.skeletonGutter} />
              <Skeleton width={`${width}%`} />
            </div>
          ))}
        </div>
      ))}
    </SkeletonGroup>
  );
}

/** The diff area before there is a diff: while a PR opens, or the refs compare. */
export function DiffSkeleton() {
  return (
    <div className={css.wrap}>
      <div className={css.toolbar}>
        <Skeleton width="9rem" />
      </div>
      <FilesSkeleton />
    </div>
  );
}

/** Preloads the themes once so the first paint is not an empty surface. */
function useThemesReady(start: boolean): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!start) return;
    let cancelled = false;
    const settle = () => {
      if (!cancelled) setReady(true);
    };
    preloadHighlighter({
      themes: [DIFF_THEME.light, DIFF_THEME.dark],
      langs: [],
      preferredHighlighter: HIGHLIGHTER,
    }).then(settle, settle);
    return () => {
      cancelled = true;
    };
  }, [start]);

  return ready;
}

function DiffSurfaceInner() {
  const repo = useReviewStore((state) => state.repo);
  const summary = useReviewStore((state) => state.summary);
  const patch = useReviewStore((state) => state.patch);
  const diffLoadId = useReviewStore((state) => state.diffLoadId);
  const compare = useReviewStore((state) => state.compare);
  const worktree = useReviewStore(reviewsWorkingTree);
  const selectedPath = useReviewStore((state) => state.selectedPath);
  const selectedLines = useReviewStore((state) => state.selectedLines);
  const selectionTick = useReviewStore((state) => state.selectionTick);
  const layout = useReviewStore((state) => state.layout);
  const setLayout = useReviewStore((state) => state.setLayout);

  const viewed = useReviewStore((state) => state.viewed);
  const expanded = useReviewStore((state) => state.expanded);
  const toggleViewed = useReviewStore((state) => state.toggleViewed);
  const expandFile = useReviewStore((state) => state.expandFile);

  const viewRef = useRef<CodeViewHandle<undefined>>(null);
  // Parsing, highlighting and laying out the diff is the heaviest work in the
  // app, all on the main thread. Arriving with the review screen, it waits for
  // the screen's transition to land rather than freezing it halfway.
  const settled = useScreenSettled();
  const themesReady = useThemesReady(settled);
  // Which selection has already been acted on. CodeView has no expand affordance
  // of its own, so opening happens here — but only when the selection actually
  // changes, not every time the item list is rebuilt. Keyed on the tick as well
  // as the path, so choosing the open file again scrolls back to it.
  const openedFor = useRef<string | null>(null);

  const root = repo?.root ?? null;
  const mergeBase = summary?.mergeBase ?? null;
  const compareHead = summary?.compareHead ?? null;
  // What is on the compare side, by commit rather than by name. A ref name
  // survives a push, so it cannot key a cache: `tk-review/pr/47` means something
  // different after the author pushes. The working tree has no commit to name
  // and can change between any two loads, so it is keyed per load instead.
  const revision = worktree ? `worktree:${diffLoadId}` : (compareHead ?? compare);

  // One parse of the whole patch produces every file's diff. The cache key
  // prefix lets the worker pool reuse highlighted results across re-renders —
  // it must therefore change whenever the contents do.
  //
  // Binary files are left out: there is no text to diff, and including them makes
  // the renderer ask the loader below for contents it cannot supply.
  const items = useMemo<CodeViewItem<undefined>[]>(() => {
    if (!settled || !patch || !mergeBase || !compare) return [];
    const files = summary?.files ?? [];
    const binaryPaths = new Set(files.filter((file) => file.isBinary).map((file) => file.path));
    const generatedPaths = new Set(
      files.filter((file) => file.isGenerated).map((file) => file.path),
    );

    return parsePatchFiles(patch, `${mergeBase}..${revision}`)
      .flatMap((parsed) => parsed.files)
      .filter((fileDiff) => !binaryPaths.has(fileDiff.name))
      .map((fileDiff) => {
        // Two reasons to start closed: it is generated, or it has been read
        // already. Either way an explicit open wins.
        const startsClosed = generatedPaths.has(fileDiff.name) || viewed.has(fileDiff.name);
        const collapsed = startsClosed && !expanded.has(fileDiff.name);
        return {
          id: fileDiff.name,
          type: "diff" as const,
          fileDiff,
          collapsed,
          // Signals to CodeView that the item's own state changed, not just the
          // surrounding list. Both halves matter: the item is re-rendered when it
          // opens or closes, and when a reload brought different contents for the
          // same path — which is what a file id alone cannot express.
          version: diffLoadId * 2 + (collapsed ? 0 : 1),
        };
      });
  }, [settled, patch, mergeBase, compare, revision, diffLoadId, summary, viewed, expanded]);

  /**
   * Supplies whole-file contents when the reader expands context past what the
   * patch carries. Added and deleted files already have their only side in the
   * patch, so this is never called for them.
   */
  const loadDiffFiles = useMemo<FileDiffContentsLoader>(
    () => async (fileDiff) => {
      if (!root || !mergeBase || !compare) {
        throw new Error("no repository is open");
      }
      const oldName = fileDiff.prevName ?? fileDiff.name;
      const versions = await gitApi.getFileVersions(root, mergeBase, worktree ? null : compare, {
        path: fileDiff.name,
        oldPath: fileDiff.prevName ?? null,
      });

      const newFile = {
        name: fileDiff.name,
        contents: versions.new ?? "",
        // Keyed by commit, never by ref name: `tk-review/pr/47:src/App.tsx` would
        // hand back the pre-push contents after the author pushes. The working
        // tree has no commit to key against, so it goes unkeyed.
        cacheKey: worktree ? undefined : `${compareHead ?? compare}:${fileDiff.name}`,
      };
      // A pure rename has no old side to show, which the loader signals with null.
      if (versions.old === null) return { oldFile: null, newFile };
      return {
        oldFile: { name: oldName, contents: versions.old, cacheKey: `${mergeBase}:${oldName}` },
        newFile,
      };
    },
    [root, mergeBase, compare, compareHead, worktree],
  );

  // CodeView treats its options as the single source of truth for every item, so
  // this object must stay stable rather than being rebuilt per file.
  const options = useMemo<CodeViewReactOptions<undefined>>(
    () => ({
      diffStyle: layout,
      theme: DIFF_THEME,
      // The app is dark-only; left to "system" the renderer would follow the OS.
      themeType: "dark",
      stickyHeaders: true,
      // Hunks only, the way a pull request reads. `expandUnchanged` would swap
      // every partial diff for its whole file, which both pulls in contents for
      // files that have none to give and resizes every item under the reader's
      // scroll position. `loadDiffFiles` supplies the contents on demand instead,
      // when someone actually expands a gap.
      loadDiffFiles,
      preferredHighlighter: HIGHLIGHTER,
      tokenizeMaxLineLength: MAX_LINE_LENGTH,
      tokenizeMaxLength: MAX_HIGHLIGHT_LINES,
      // Injected into the renderer's last cascade layer; see diffsTheme.ts.
      unsafeCSS: DIFFS_THEME_CSS,
    }),
    [layout, loadDiffFiles],
  );

  // Selecting a file scrolls the shared surface to it rather than swapping panes,
  // and opens it if it was collapsed for being generated — choosing a file is a
  // clear enough signal that you want to read it. A selection that names lines
  // — a finding's path, say — lands on them instead of the file header, and
  // highlights them until the next selection. Binary files have no item to
  // scroll to, so leave the view where it is.
  useEffect(() => {
    if (!selectedPath) return;
    // Wait for the item to exist, so the first selection still lands once the
    // patch has been parsed.
    const item = items.find((entry) => entry.id === selectedPath);
    if (!item) return;
    const selection = `${selectionTick}:${selectedPath}:${selectedLines ? `${selectedLines.start}-${selectedLines.end}` : ""}`;
    if (openedFor.current === selection) return;

    // A collapsed file has no lines laid out, so opening it has to land before
    // the scroll can resolve one. Expanding rebuilds `items`, which runs this
    // effect again with the file open — and the selection still unspent.
    if (item.collapsed) {
      expandFile(selectedPath);
      return;
    }

    openedFor.current = selection;
    const view = viewRef.current;
    if (!selectedLines) {
      view?.clearSelectedLines();
      view?.scrollTo({ type: "item", id: selectedPath, align: "start" });
      return;
    }
    // Findings anchor to new-file line numbers.
    const range = {
      start: selectedLines.start,
      end: selectedLines.end,
      side: "additions",
      endSide: "additions",
    } as const;
    view?.setSelectedLines({ id: selectedPath, range });
    // Centred when it fits; a span taller than the view lands on its start.
    view?.scrollTo({ type: "range", id: selectedPath, range, align: "center" });
  }, [selectedPath, selectedLines, selectionTick, items, expandFile]);

  if (!summary) return null;
  if (summary.files.length === 0) {
    return <p className={css.message}>These refs are identical.</p>;
  }

  return (
    <div className={css.wrap}>
      <Toolbar fileCount={summary.files.length} layout={layout} onLayoutChange={setLayout} />
      {themesReady && items.length > 0 ? (
        // The file headers CodeView draws already carry each path and its line
        // counts, so there is no metadata to add here — only a marker showing
        // which file the sidebar has selected, and the Viewed checkbox.
        <CodeView
          /*
           * Highlighting stays on the main thread, on the Oniguruma engine (see
           * `HIGHLIGHTER`). In a worker the renderer can't use it — the WASM
           * binary doesn't resolve there and nothing renders at all — and falls
           * back to Shiki's JavaScript regex engine, which cannot compile every
           * TextMate grammar: SQL is one it silently gives up on, rendering the
           * file as plain text while JS/TS look fine, so the failure is easy to
           * miss. Virtualization, the far bigger win, is unaffected by this, and
           * the preload below keeps the first paint from being empty.
           */
          disableWorkerPool
          ref={viewRef}
          className={css.surface}
          items={items}
          options={options}
          // Renders nothing visible: its presence is what the stylesheet's
          // `:has()` looks for to draw the border on this file's container.
          renderHeaderPrefix={(item) =>
            item.id === selectedPath ? <span aria-hidden="true" /> : null
          }
          renderHeaderMetadata={(item) => (
            <span className={css.viewedToggle}>
              <Checkbox checked={viewed.has(item.id)} onCheckedChange={() => toggleViewed(item.id)}>
                Viewed
              </Checkbox>
            </span>
          )}
        />
      ) : (
        // Takes over from the screen's own skeleton without fading in again.
        <FilesSkeleton instant />
      )}
    </div>
  );
}

export function DiffSurface() {
  const mergeBase = useReviewStore((state) => state.summary?.mergeBase ?? null);
  const compare = useReviewStore((state) => state.compare);
  const worktree = useReviewStore(reviewsWorkingTree);

  // Keyed on the comparison so a new one starts with fresh state — nothing left
  // scrolled or open from the review just navigated away from. Toggling
  // uncommitted changes is a new comparison in the same sense.
  return <DiffSurfaceInner key={`${mergeBase}..${compare}${worktree ? "+uncommitted" : ""}`} />;
}
