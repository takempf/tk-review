import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button, Tooltip } from "tk-design-system";
import type { AppError } from "../../ipc/git";
import { ErrorNotice } from "../ErrorNotice/ErrorNotice";
import { ResizeHandle, useStoredSize } from "../ResizeHandle/ResizeHandle";
import css from "./Layout.module.css";

const SIDEBAR = { storageKey: "tk-review:sidebar-width", min: 180, max: 640, fallback: 280 };
const ASIDE = { storageKey: "tk-review:aside-width", min: 260, max: 800, fallback: 360 };
/** The diff never gives up more than this to the side panels. */
const MIN_MAIN = 320;

/** A side panel sliding in or out, in ms. */
const SLIDE_MS = 280;
/** `--ease-out-expo` in global.css; script animations can't read custom properties. */
const EASE_OUT_EXPO = "cubic-bezier(0.16, 1, 0.3, 1)";

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Width of the element, tracked live so panel limits follow the window. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

/** Whether a side panel is showing, remembered across launches like its width. */
function useStoredShown(storageKey: string) {
  const [shown, setShown] = useState(() => {
    try {
      return localStorage.getItem(storageKey) !== "false";
    } catch {
      return true;
    }
  });

  const toggle = () => {
    setShown(!shown);
    try {
      localStorage.setItem(storageKey, String(!shown));
    } catch {
      // An unavailable localStorage shouldn't stop the panel from toggling.
    }
  };

  return { shown, toggle };
}

/**
 * Whether the grid gives a panel its column. Hiding, it gives the column up at
 * once, and the diff widens underneath it as it slides away; showing, it slides
 * in over the diff and takes the column once it has arrived. Either way the
 * diff is laid out once, at the wider of its two sizes while anything moves,
 * so no gap opens beside it.
 */
function useLaidOut(shown: boolean) {
  const [laidOut, setLaidOut] = useState(shown);
  if (laidOut !== shown && (!shown || prefersReducedMotion())) setLaidOut(shown);

  // A timer rather than the animation's `finished`, which waits on the
  // document's timeline and may never come in a window that's hidden.
  useEffect(() => {
    if (!shown || laidOut) return;
    const timer = setTimeout(() => setLaidOut(true), SLIDE_MS);
    return () => clearTimeout(timer);
  }, [shown, laidOut]);

  return laidOut;
}

/**
 * Slides a panel to where it now rests, in place or just past the window's
 * edge on the side it leaves by (`away`), from wherever it is on screen: at
 * rest, or partway through a slide the other way. `follower` keeps pace with
 * it, `width` further along. Transforms only, so the diff isn't laid out again
 * on any frame.
 */
function slide(
  panel: HTMLElement,
  {
    shown,
    width,
    away,
    running,
    follower,
  }: {
    shown: boolean;
    width: number;
    away: -1 | 1;
    running: Animation[];
    follower?: HTMLElement | null;
  },
): Animation[] {
  const from = running.some((animation) => animation.playState === "running")
    ? new DOMMatrixReadOnly(getComputedStyle(panel).transform).m41
    : shown
      ? away * width
      : 0;
  for (const animation of running) animation.cancel();
  const to = shown ? 0 : away * width;
  const frames = (offset: number) => [
    { transform: `translateX(${from + offset}px)` },
    { transform: `translateX(${to + offset}px)` },
  ];
  const timing = { duration: SLIDE_MS, easing: EASE_OUT_EXPO };
  const animations = [panel.animate(frames(0), timing)];
  if (follower) animations.push(follower.animate(frames(width), timing));
  return animations;
}

/** A side panel's edge drawn in a window's outline, filled in while it shows. */
function PanelIcon({ edge, shown }: { edge: "start" | "end"; shown: boolean }) {
  const start = edge === "start";
  return (
    <svg
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      className={`tk-icon ${css.panelIcon}`}
      data-edge={edge}
      data-shown={shown || undefined}
      aria-hidden="true"
    >
      <path d="M2.75 3.25h10.5v9.5h-10.5z" />
      <path d={start ? "M6.25 3.25v9.5" : "M9.75 3.25v9.5"} className="tk-icon-inner" />
      <path
        d={start ? "M2.75 3.25h3.5v9.5h-3.5z" : "M9.75 3.25h3.5v9.5h-3.5z"}
        className={`tk-icon-fill ${css.panelFill}`}
      />
    </svg>
  );
}

function PanelToggle({
  edge,
  name,
  controls,
  shown,
  onToggle,
}: {
  edge: "start" | "end";
  name: string;
  controls: string;
  shown: boolean;
  onToggle: () => void;
}) {
  const label = `${shown ? "Hide" : "Show"} ${name}`;
  return (
    <Tooltip content={label} side="bottom">
      <Button
        variant="ghost"
        size="sm"
        square
        className={css.toggle}
        onClick={onToggle}
        aria-label={label}
        aria-expanded={shown}
        aria-controls={controls}
      >
        <PanelIcon edge={edge} shown={shown} />
      </Button>
    </Tooltip>
  );
}

interface LayoutProps {
  header: ReactNode;
  sidebar: ReactNode;
  main: ReactNode;
  /** Third column to the right of the diff surface; omitted, the grid stays two columns. */
  aside?: ReactNode;
  error: AppError | null;
  onDismissError: () => void;
}

export function Layout({ header, sidebar, main, aside, error, onDismissError }: LayoutProps) {
  const sidebarWidth = useStoredSize(SIDEBAR);
  const asideWidth = useStoredSize(ASIDE);
  const sidebarShown = useStoredShown("tk-review:sidebar-shown");
  const asideShown = useStoredShown("tk-review:aside-shown");
  const sidebarLaidOut = useLaidOut(sidebarShown.shown);
  const asideLaidOut = useLaidOut(asideShown.shown);
  const body = useWidth<HTMLDivElement>();
  const sidebarRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const sidebarId = useId();
  const asideId = useId();

  // Each panel is its stored width unless the window can't hold both plus a
  // usable diff. The review panel yields first — the diff is the point — and
  // the file list yields only once the review panel is at its minimum. Stored
  // widths are untouched, so a wider window brings the panels back. A hidden
  // panel takes no room from the other.
  const room = body.width ?? Number.POSITIVE_INFINITY;
  const sidebarRoom = sidebarShown.shown ? sidebarWidth.size : 0;
  const asideMax = Math.max(ASIDE.min, Math.min(ASIDE.max, room - sidebarRoom - MIN_MAIN));
  const asideSize = aside ? Math.min(asideWidth.size, asideMax) : 0;
  const asideRoom = asideShown.shown ? asideSize : 0;
  const sidebarMax = Math.max(SIDEBAR.min, Math.min(SIDEBAR.max, room - asideRoom - MIN_MAIN));
  const sidebarSize = Math.min(sidebarWidth.size, sidebarMax);
  const columns = [
    `${sidebarLaidOut ? sidebarSize : 0}px`,
    "minmax(0, 1fr)",
    ...(aside ? [`${asideLaidOut ? asideSize : 0}px`] : []),
  ].join(" ");

  // The file list slides the diff along with it; the review panel slides over
  // the diff's far edge, which doesn't move. While the file list is still
  // arriving, the diff rests where it has pushed it to.
  const slides = useRef<{ sidebar: Animation[]; aside: Animation[] }>({ sidebar: [], aside: [] });
  const wasShown = useRef({ sidebar: sidebarShown.shown, aside: asideShown.shown });
  useLayoutEffect(() => {
    const was = wasShown.current;
    wasShown.current = { sidebar: sidebarShown.shown, aside: asideShown.shown };
    if (prefersReducedMotion()) return;
    const sidebarPanel = sidebarRef.current;
    if (sidebarPanel && sidebarShown.shown !== was.sidebar) {
      slides.current.sidebar = slide(sidebarPanel, {
        shown: sidebarShown.shown,
        width: sidebarSize,
        away: -1,
        running: slides.current.sidebar,
        follower: mainRef.current,
      });
    }
    const asidePanel = asideRef.current;
    if (asidePanel && asideShown.shown !== was.aside) {
      slides.current.aside = slide(asidePanel, {
        shown: asideShown.shown,
        width: asideSize,
        away: 1,
        running: slides.current.aside,
      });
    }
  }, [sidebarShown.shown, asideShown.shown, sidebarSize, asideSize]);

  // Once a panel takes its column, the diff's rest is its own place again; a
  // slide still on its last frame would push it a panel's width too far.
  useLayoutEffect(() => {
    if (sidebarLaidOut) for (const animation of slides.current.sidebar) animation.cancel();
  }, [sidebarLaidOut]);
  useLayoutEffect(() => {
    if (asideLaidOut) for (const animation of slides.current.aside) animation.cancel();
  }, [asideLaidOut]);

  const timing = { "--slide": `${SLIDE_MS}ms` } as CSSProperties;
  const pushed = sidebarShown.shown && !sidebarLaidOut;

  return (
    <div className={css.app} style={timing}>
      <header className={css.header}>
        <PanelToggle
          edge="start"
          name="file list"
          controls={sidebarId}
          shown={sidebarShown.shown}
          onToggle={sidebarShown.toggle}
        />
        {header}
        {aside ? (
          <PanelToggle
            edge="end"
            name="review panel"
            controls={asideId}
            shown={asideShown.shown}
            onToggle={asideShown.toggle}
          />
        ) : null}
      </header>
      {error ? (
        <ErrorNotice
          error={error}
          onDismiss={onDismissError}
          variant="banner"
          className={css.banner}
        />
      ) : null}
      <div ref={body.ref} className={css.body} style={{ gridTemplateColumns: columns }}>
        <aside
          ref={sidebarRef}
          id={sidebarId}
          className={css.sidebar}
          style={{ width: sidebarSize }}
          data-shown={sidebarShown.shown}
          inert={!sidebarShown.shown}
        >
          {sidebar}
          <ResizeHandle
            axis="width"
            edge="end"
            label="Resize file list"
            size={sidebarSize}
            min={SIDEBAR.min}
            max={sidebarMax}
            onResize={sidebarWidth.resize}
            onResizeEnd={sidebarWidth.resizeAndPersist}
            onReset={sidebarWidth.reset}
          />
        </aside>
        <main
          ref={mainRef}
          className={css.main}
          style={pushed ? { transform: `translateX(${sidebarSize}px)` } : undefined}
        >
          {main}
        </main>
        {aside ? (
          <aside
            ref={asideRef}
            id={asideId}
            className={css.aside}
            style={{ width: asideSize }}
            data-shown={asideShown.shown}
            inert={!asideShown.shown}
          >
            {aside}
            <ResizeHandle
              axis="width"
              edge="start"
              label="Resize review panel"
              size={asideSize}
              min={ASIDE.min}
              max={asideMax}
              onResize={asideWidth.resize}
              onResizeEnd={asideWidth.resizeAndPersist}
              onReset={asideWidth.reset}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
