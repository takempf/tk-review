import { useEffect, useRef, useState } from "react";
import { Button, Icon, Spinner } from "tk-design-system";
import { type AppError, type Codemap as CodemapData, gitApi, toAppError } from "../../ipc/git";
import { reviewsWorkingTree, useTab } from "../../store/tabStore";
import { ErrorNotice } from "../ErrorNotice/ErrorNotice";
import css from "./Codemap.module.css";
import { VIEWER_PAGE, viewerTheme } from "./viewerPage";

type ViewerMessage =
  | { type: "tk-review:codemap-ready" }
  | { type: "tk-review:show-file"; path: string };

function isViewerMessage(data: unknown): data is ViewerMessage {
  if (typeof data !== "object" || data === null || !("type" in data)) return false;
  if (data.type === "tk-review:codemap-ready") return true;
  return data.type === "tk-review:show-file" && "path" in data && typeof data.path === "string";
}

/** A file to find on the map; the tick tells a second pick of the same file from the first. */
export interface FileFocus {
  path: string;
  tick: number;
}

type Build =
  | { loadId: number; status: "loading" }
  | { loadId: number; status: "ready"; map: CodemapData }
  | { loadId: number; status: "error"; error: AppError };

/** The labels the map's header gives each side, as the review names them. */
function useSideLabels() {
  const base = useTab((state) => state.pr?.baseRef ?? state.base ?? "base");
  const compare = useTab((state) => state.pr?.headRef ?? state.compare ?? "compare");
  const worktree = useTab(reviewsWorkingTree);
  return { baseLabel: base, compareLabel: worktree ? `${compare} + uncommitted` : compare };
}

/** The comparison drawn by tk-codemap's viewer, built when first shown and again after each diff reload. */
export function Codemap({
  shown,
  focus,
  onShowFile,
}: {
  shown: boolean;
  focus: FileFocus | null;
  onShowFile: (path: string) => void;
}) {
  const root = useTab((state) => state.repo.root);
  const summary = useTab((state) => state.summary);
  const diffLoadId = useTab((state) => state.diffLoadId);
  const loadingDiff = useTab((state) => state.loadingDiff || state.openingPr);
  const { baseLabel, compareLabel } = useSideLabels();
  const [build, setBuild] = useState<Build | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const latestRequest = useRef(0);
  const latest = useRef({ build, onShowFile, focus });
  latest.current = { build, onShowFile, focus };
  // The map the frame has been given, so a focus isn't sent to a frame still waiting for one.
  const deliveredLoadId = useRef<number | null>(null);

  const stale = build?.loadId !== diffLoadId;
  useEffect(() => {
    if (!shown || !summary || !stale) return;
    const request = ++latestRequest.current;
    const settle = (next: Build) => {
      if (request === latestRequest.current) setBuild(next);
    };
    setBuild({ loadId: diffLoadId, status: "loading" });
    gitApi
      .buildCodemap({
        root,
        mergeBase: summary.mergeBase,
        compare: summary.compareHead,
        baseLabel,
        compareLabel,
      })
      .then(
        (map) => settle({ loadId: diffLoadId, status: "ready", map }),
        (error: unknown) =>
          settle({
            loadId: diffLoadId,
            status: "error",
            error: toAppError(error, "The codemap couldn't be drawn"),
          }),
      );
  }, [shown, summary, stale, diffLoadId, root, baseLabel, compareLabel]);

  // Listening from mount, so the frame's ready message can't arrive before the listener.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const frame = frameRef.current?.contentWindow;
      if (!frame || event.source !== frame || !isViewerMessage(event.data)) return;
      const { build, onShowFile, focus } = latest.current;
      if (event.data.type === "tk-review:show-file") {
        onShowFile(event.data.path);
      } else if (build?.status === "ready") {
        frame.postMessage({ type: "tk-review:codemap", ...build.map, theme: viewerTheme() }, "*");
        deliveredLoadId.current = build.loadId;
        if (focus) frame.postMessage({ type: "tk-review:focus-file", path: focus.path }, "*");
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const readyLoadId = build?.status === "ready" ? build.loadId : null;
  useEffect(() => {
    const frame = frameRef.current?.contentWindow;
    if (!focus || !frame || readyLoadId === null || deliveredLoadId.current !== readyLoadId) return;
    frame.postMessage({ type: "tk-review:focus-file", path: focus.path }, "*");
  }, [focus, readyLoadId]);

  if (!summary) {
    return loadingDiff ? <Drawing /> : <p className={css.message}>Choose two refs to compare.</p>;
  }
  if (build?.status === "error") {
    return (
      <div className={css.message}>
        <ErrorNotice error={build.error}>
          <Button size="sm" onClick={() => setBuild(null)}>
            <Icon name="refresh" /> Try again
          </Button>
        </ErrorNotice>
      </div>
    );
  }
  if (build?.status !== "ready") return <Drawing />;
  return (
    <iframe
      // A new viewer for each map, rather than one told to start over.
      key={build.loadId}
      ref={frameRef}
      className={css.frame}
      title="Codemap"
      sandbox="allow-scripts"
      srcDoc={VIEWER_PAGE}
    />
  );
}

function Drawing() {
  return <Spinner className={css.message}>Drawing the codemap…</Spinner>;
}
