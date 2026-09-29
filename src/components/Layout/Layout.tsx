import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { Button, Icon } from "tk-design-system";
import { ResizeHandle, useStoredSize } from "../ResizeHandle/ResizeHandle";
import css from "./Layout.module.css";

const SIDEBAR = { storageKey: "tk-review:sidebar-width", min: 180, max: 640, fallback: 280 };
const ASIDE = { storageKey: "tk-review:aside-width", min: 260, max: 800, fallback: 360 };
/** The diff never gives up more than this to the side panels. */
const MIN_MAIN = 320;

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

interface LayoutProps {
  header: ReactNode;
  sidebar: ReactNode;
  main: ReactNode;
  /** Third column to the right of the diff surface; omitted, the grid stays two columns. */
  aside?: ReactNode;
  error: string | null;
  onDismissError: () => void;
}

export function Layout({ header, sidebar, main, aside, error, onDismissError }: LayoutProps) {
  const sidebarWidth = useStoredSize(SIDEBAR);
  const asideWidth = useStoredSize(ASIDE);
  const body = useWidth<HTMLDivElement>();

  // Each panel is its stored width unless the window can't hold both plus a
  // usable diff. The review panel yields first — the diff is the point — and
  // the file list yields only once the review panel is at its minimum. Stored
  // widths are untouched, so a wider window brings the panels back.
  const room = body.width ?? Number.POSITIVE_INFINITY;
  const asideMax = Math.max(ASIDE.min, Math.min(ASIDE.max, room - sidebarWidth.size - MIN_MAIN));
  const asideSize = aside ? Math.min(asideWidth.size, asideMax) : 0;
  const sidebarMax = Math.max(SIDEBAR.min, Math.min(SIDEBAR.max, room - asideSize - MIN_MAIN));
  const sidebarSize = Math.min(sidebarWidth.size, sidebarMax);
  const columns = aside
    ? `${sidebarSize}px minmax(0, 1fr) ${asideSize}px`
    : `${sidebarSize}px minmax(0, 1fr)`;

  return (
    <div className={css.app}>
      <header className={css.header}>{header}</header>
      {error ? (
        <div className={css.banner} role="alert">
          <p className={css.bannerText}>{error}</p>
          <Button variant="ghost" size="sm" onClick={onDismissError}>
            <Icon name="close" /> Dismiss
          </Button>
        </div>
      ) : null}
      <div ref={body.ref} className={css.body} style={{ gridTemplateColumns: columns }}>
        <aside className={css.sidebar}>
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
        <main className={css.main}>{main}</main>
        {aside ? (
          <aside className={css.aside}>
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
