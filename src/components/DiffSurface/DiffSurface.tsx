import { parsePatchFiles, preloadHighlighter } from "@pierre/diffs";
import {
  CodeView,
  type CodeViewHandle,
  type CodeViewItem,
  type CodeViewReactOptions,
  type DiffLineAnnotation,
  type FileDiffContentsLoader,
} from "@pierre/diffs/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Checkbox, Icon, Toggle, ToggleGroup } from "tk-design-system";
import { gitApi } from "../../ipc/git";
import { describeLines } from "../../lib/lineSpan";
import { type CommentAnchor, inlineDiscussion } from "../../lib/prThreads";
import { useScreenSettled } from "../../lib/screenTransition";
import { HIGHLIGHTER } from "../../lib/warmHighlighter";
import { type DiffLayout, useAppStore } from "../../store/appStore";
import { reviewsWorkingTree, useTab } from "../../store/tabStore";
import { Author, githubHost } from "../Author/Author";
import { GitHubMarkdown } from "../Markdown/Markdown";
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
  hasNotes,
  layout,
  onLayoutChange,
}: {
  fileCount: number;
  /** An explanation left notes on files, so there is something to show or hide. */
  hasNotes: boolean;
  layout: DiffLayout;
  onLayoutChange: (layout: DiffLayout) => void;
}) {
  const fileNotes = useAppStore((state) => state.fileNotes);
  const setFileNotes = useAppStore((state) => state.setFileNotes);
  return (
    <div className={css.toolbar}>
      <span className={css.toolbarLabel}>
        {fileCount} {fileCount === 1 ? "file" : "files"} in this review
      </span>
      {hasNotes ? (
        <ToggleGroup
          size="sm"
          aria-label="File notes"
          value={fileNotes ? ["notes"] : []}
          onValueChange={(value) => setFileNotes(value.includes("notes"))}
        >
          <Toggle value="notes" title="Show the explanation's note at the top of each file">
            <Icon name="info" /> Notes
          </Toggle>
        </ToggleGroup>
      ) : null}
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

/**
 * An explanation's note on one file, at the top of it: what its changes are
 * for. In a split diff it sits over the new side, which is what it describes
 * (the old side, for a deleted file).
 */
function FileNote({ note, stale }: { note: string; stale: boolean }) {
  return (
    <aside className={css.fileNote}>
      <p className={css.fileNoteLabel}>
        <Icon name="info" /> Note
        {stale ? (
          <span className={css.fileNoteStale}>from an older version of this diff</span>
        ) : null}
      </p>
      <GitHubMarkdown markdown={note} />
    </aside>
  );
}

/** Each file's note from the explanation on record, by path; none while they're hidden. */
function useFileNotes() {
  const explanation = useTab((state) => state.explanation);
  const mergeBase = useTab((state) => state.summary?.mergeBase ?? null);
  const shown = useAppStore((state) => state.fileNotes);

  const all = useMemo(() => {
    const byPath = new Map<string, string>();
    for (const file of explanation?.explanation.files ?? []) {
      const note = file.explanation.trim();
      if (note) byPath.set(file.path, note);
    }
    return byPath;
  }, [explanation]);

  return {
    notes: shown ? all : NO_NOTES,
    hasNotes: all.size > 0,
    stale: explanation != null && explanation.mergeBase !== mergeBase,
  };
}

const NO_NOTES = new Map<string, string>();

/**
 * What an annotation in the diff stands for: a file's note, or the PR's
 * comments at one place in it, by the key `inlineDiscussion` gives the place.
 * Only the key, so the comments themselves are always the latest read.
 */
type DiffAnnotation = { kind: "note" } | { kind: "comments"; key: string };

/**
 * Where the PR's comments go on each file, by path: every place GitHub still
 * shows them. Outdated ones were made on lines the diff no longer has, so
 * they are only in the PR tab.
 */
function useCommentAnchors() {
  const pr = useTab((state) => state.pr);
  return useMemo(() => {
    const byPath = new Map<string, CommentAnchor[]>();
    for (const file of pr ? inlineDiscussion(pr) : []) {
      const placed = file.anchors.filter((anchor) => !anchor.outdated);
      if (placed.length > 0) byPath.set(file.path, placed);
    }
    return { anchors: byPath, host: githubHost(pr?.url) };
  }, [pr]);
}

const NAMES = new Intl.ListFormat("en", { type: "conjunction" });

/**
 * The PR's comments at a place in a file, under the line they end on, or at
 * the top for the file as a whole: a byline of how much was said and who by,
 * each person as the PR tab shows them. It names two at most, to stay on one
 * line in a split diff; the tooltip has everyone. Pressing it opens the
 * conversation in the review panel's PR tab.
 */
function CommentMarker({
  path,
  anchor,
  host,
}: {
  path: string;
  anchor: CommentAnchor;
  host: string;
}) {
  const showComments = useTab((state) => state.showComments);
  const comments = anchor.threads.flatMap((conversation) => conversation.comments);
  const people = [...new Set(comments.map((comment) => comment.author))];
  const resolved = anchor.threads.every((conversation) => conversation.thread?.resolved);
  const count = `${comments.length} ${comments.length === 1 ? "comment" : "comments"}`;
  const where = anchor.lines ? describeLines(anchor.lines) : "this file";
  const label = `${count} on ${where} by ${NAMES.format(people)}${resolved ? ", resolved" : ""}. Show in the PR tab.`;
  const [first, second] = people;
  return (
    <button
      type="button"
      className={css.commentMarker}
      data-resolved={resolved || undefined}
      onClick={() => showComments(path, anchor.key)}
      aria-label={label}
      title={label}
    >
      <span>{count} by</span>
      {first ? <Author login={first} host={host} className={css.commentAuthor} /> : null}
      {people.length > 2 ? <span>and {people.length - 1} others</span> : null}
      {people.length === 2 && second ? (
        <>
          <span>and</span>
          <Author login={second} host={host} className={css.commentAuthor} />
        </>
      ) : null}
      {resolved ? <span className={css.commentResolved}>resolved</span> : null}
    </button>
  );
}

/**
 * A number for CodeView's `version` from everything that shapes an item. It
 * re-renders an item only when the version differs from the one it last had,
 * so any number that changes along with the item will do; a hash of its shape
 * is one, with no count of changes to keep. FNV-1a, 32-bit.
 */
function versionOf(shape: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < shape.length; index++) {
    hash ^= shape.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
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
  const repo = useTab((state) => state.repo);
  const summary = useTab((state) => state.summary);
  const patch = useTab((state) => state.patch);
  const diffLoadId = useTab((state) => state.diffLoadId);
  const compare = useTab((state) => state.compare);
  const worktree = useTab(reviewsWorkingTree);
  const selectedPath = useTab((state) => state.selectedPath);
  const selectedLines = useTab((state) => state.selectedLines);
  const selectionTick = useTab((state) => state.selectionTick);
  const layout = useAppStore((state) => state.layout);
  const setLayout = useAppStore((state) => state.setLayout);

  const viewed = useTab((state) => state.viewed);
  const expanded = useTab((state) => state.expanded);
  const toggleViewed = useTab((state) => state.toggleViewed);
  const expandFile = useTab((state) => state.expandFile);
  const { notes, hasNotes, stale } = useFileNotes();
  const { anchors, host } = useCommentAnchors();

  const viewRef = useRef<CodeViewHandle<DiffAnnotation>>(null);
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
  const items = useMemo<CodeViewItem<DiffAnnotation>[]>(() => {
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
        // A file-level annotation (line 0) sits above the first hunk, on the
        // side it describes: the note goes there, and comments on the file as
        // a whole. Comments on lines go under the last of them, on their side.
        // What each says comes from `renderAnnotation`, so a new explanation,
        // or a reply on GitHub, only has to re-render it.
        const top = fileDiff.type === "deleted" ? "deletions" : "additions";
        const annotations: DiffLineAnnotation<DiffAnnotation>[] = [];
        if (notes.has(fileDiff.name)) {
          annotations.push({ side: top, lineNumber: 0, metadata: { kind: "note" } });
        }
        for (const { key, lines } of anchors.get(fileDiff.name) ?? []) {
          annotations.push({
            side: lines?.side ?? top,
            lineNumber: lines?.end ?? 0,
            metadata: { kind: "comments", key },
          });
        }
        return {
          id: fileDiff.name,
          type: "diff" as const,
          fileDiff,
          collapsed,
          annotations: annotations.length > 0 ? annotations : undefined,
          // Signals to CodeView that the item's own state changed, not just the
          // surrounding list. Each part matters: the item is re-rendered when it
          // opens or closes, when its annotations come, go or move, and when a
          // reload brought different contents for the same path — which is
          // what a file id alone cannot express.
          version: versionOf(
            [
              diffLoadId,
              collapsed,
              ...annotations.map(
                ({ side, lineNumber, metadata }) =>
                  `${side}:${lineNumber}:${metadata.kind === "note" ? "note" : metadata.key}`,
              ),
            ].join(" "),
          ),
        };
      });
  }, [
    settled,
    patch,
    mergeBase,
    compare,
    revision,
    diffLoadId,
    summary,
    viewed,
    expanded,
    notes,
    anchors,
  ]);

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
  const options = useMemo<CodeViewReactOptions<DiffAnnotation>>(
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
    const selection = `${selectionTick}:${selectedPath}:${selectedLines ? `${selectedLines.side}:${selectedLines.start}-${selectedLines.end}` : ""}`;
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
      const target = { type: "item", id: selectedPath, align: "start" } as const;
      view?.scrollTo(target);
      // What sits at the top of a file — its note, comments on it as a whole
      // — is only measured once the file renders, and CodeView then keeps the
      // first line where the jump put it, which slides it up under the sticky
      // header. Going again once it has been measured lands on the header,
      // all of it in view.
      if (item.annotations?.some((annotation) => annotation.lineNumber === 0)) {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (openedFor.current === selection) viewRef.current?.scrollTo(target);
          }),
        );
      }
      return;
    }
    // Findings anchor to new-file line numbers; a comment on the old side
    // counts the base's.
    const side = selectedLines.side ?? "additions";
    const range = { start: selectedLines.start, end: selectedLines.end, side, endSide: side };
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
      <Toolbar
        fileCount={summary.files.length}
        hasNotes={hasNotes}
        layout={layout}
        onLayoutChange={setLayout}
      />
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
          // Renders nothing itself: the stylesheet draws the slot it lands in
          // as a bar on the selected file's header.
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
          renderAnnotation={({ metadata }, item) => {
            if (metadata.kind === "note") {
              const note = notes.get(item.id);
              return note ? <FileNote note={note} stale={stale} /> : null;
            }
            const anchor = anchors.get(item.id)?.find(({ key }) => key === metadata.key);
            return anchor ? <CommentMarker path={item.id} anchor={anchor} host={host} /> : null;
          }}
        />
      ) : (
        // Takes over from the screen's own skeleton without fading in again.
        <FilesSkeleton instant />
      )}
    </div>
  );
}

export function DiffSurface() {
  const mergeBase = useTab((state) => state.summary?.mergeBase ?? null);
  const compare = useTab((state) => state.compare);
  const worktree = useTab(reviewsWorkingTree);

  // Keyed on the comparison so a new one starts with fresh state — nothing left
  // scrolled or open from the review just navigated away from. Toggling
  // uncommitted changes is a new comparison in the same sense.
  return <DiffSurfaceInner key={`${mergeBase}..${compare}${worktree ? "+uncommitted" : ""}`} />;
}
