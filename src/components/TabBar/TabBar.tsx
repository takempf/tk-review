import { Button, cx, Icon } from "tk-design-system";
import { useStore } from "zustand";
import { ScreenMorph } from "../../lib/screenTransition";
import { barTabs, type ReviewTab, tabBarShown, useAppStore } from "../../store/appStore";
import { TabStatus } from "../TabStatus/TabStatus";
import css from "./TabBar.module.css";

function Tab({
  tab,
  onShow,
  onClose,
}: {
  tab: ReviewTab;
  onShow: () => void;
  onClose: () => void;
}) {
  // While it opens, the list's number and title stand in for the fetched ones.
  const pr = useStore(tab.store, (state) => state.pr ?? state.pendingPr);
  const base = useStore(tab.store, (state) => state.base);
  const compare = useStore(tab.store, (state) => state.compare);
  const title = pr ? pr.title : `${base ?? "…"} … ${compare ?? "…"}`;
  const shifting = useAppStore((state) => state.screenChange?.shifting ?? false);
  // Named apart from the tab so resizing doesn't stretch it; a closing tab's text folds away with it.
  const textShifting = useAppStore(
    (state) => state.screenChange?.shifting === true && state.screenChange.folding !== tab.id,
  );
  const name = pr ? `#${pr.number} ${pr.title}` : title;

  return (
    <ScreenMorph id={tab.morphKey} part="tab" active={shifting}>
      <li
        className={css.tab}
        // A middle click closes, as it does a browser's tab.
        onMouseDown={(event) => {
          if (event.button === 1) event.preventDefault();
        }}
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          onClose();
        }}
      >
        {/* A part of its own, so the tab's snapshot is its background alone,
            which scales as the tab comes and goes while this fades. */}
        <ScreenMorph id={tab.morphKey} part="content" active={shifting}>
          <div className={css.content}>
            <button type="button" className={css.show} onClick={onShow} title={name}>
              <TabStatus store={tab.store} />
              <span className={css.label}>
                {pr ? (
                  <ScreenMorph id={tab.morphKey} part="number" active={textShifting}>
                    <span className={css.number}>#{pr.number}</span>
                  </ScreenMorph>
                ) : (
                  <Icon name="branch" className={css.branch} />
                )}
                <ScreenMorph id={tab.morphKey} part="title" active={textShifting}>
                  <span className={css.title}>{title}</span>
                </ScreenMorph>
              </span>
            </button>
            <button
              type="button"
              className={css.close}
              onClick={onClose}
              aria-label={`Close ${name}`}
              title="Close tab"
            >
              <Icon name="close" />
            </button>
          </div>
        </ScreenMorph>
      </li>
    </ScreenMorph>
  );
}

/** The way back to the list and every open tab but the one on screen, whose header names it. */
export function TabBar({ className }: { className?: string }) {
  const allTabs = useAppStore((state) => state.tabs);
  const view = useAppStore((state) => state.view);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const tabs = barTabs({ view, tabs: allTabs, activeTabId });
  const visible = useAppStore(tabBarShown);
  const inReview = view === "review";
  const showTab = useAppStore((state) => state.showTab);
  const closeTab = useAppStore((state) => state.closeTab);
  const goHome = useAppStore((state) => state.goHome);
  const heading = useAppStore((state) => state.screenChange?.heading ?? false);

  // Always mounted, so the row can open and close rather than appear.
  return (
    <div className={cx(css.row, className)} data-open={visible || undefined} inert={!visible}>
      <nav className={css.bar} aria-label="Open reviews">
        {inReview ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              className={css.back}
              onClick={() => goHome()}
              title="Back to pull requests"
            >
              <Icon name="arrow-left" className={css.backArrow} />
              <ScreenMorph id="home" part="heading" active={heading}>
                <span className={css.backLabel}>Pull requests</span>
              </ScreenMorph>
            </Button>
            {tabs.length > 0 ? <span className={css.divider} /> : null}
          </>
        ) : null}
        <ul className={css.list}>
          {tabs.map((tab) => (
            <Tab
              key={tab.id}
              tab={tab}
              onShow={() => void showTab(tab.id)}
              onClose={() => closeTab(tab.id)}
            />
          ))}
        </ul>
      </nav>
    </div>
  );
}
