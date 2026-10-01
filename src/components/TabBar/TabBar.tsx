import { Button, cx, Icon } from "tk-design-system";
import { useStore } from "zustand";
import { ScreenMorph } from "../../lib/screenTransition";
import { type ReviewTab, shownTab, tabBarShown, useAppStore } from "../../store/appStore";
import { TabStatus } from "../TabStatus/TabStatus";
import css from "./TabBar.module.css";

function Tab({
  tab,
  active,
  onShow,
  onClose,
}: {
  tab: ReviewTab;
  /** The tab whose review is on screen. */
  active: boolean;
  onShow: () => void;
  onClose: () => void;
}) {
  // While it opens, the list's number and title stand in for the fetched ones.
  const pr = useStore(tab.store, (state) => state.pr ?? state.pendingPr);
  const base = useStore(tab.store, (state) => state.base);
  const compare = useStore(tab.store, (state) => state.compare);
  const title = pr ? pr.title : `${base ?? "…"} … ${compare ?? "…"}`;
  const name = pr ? `#${pr.number} ${pr.title}` : title;

  return (
    <ScreenMorph id={tab.morphKey} part="tab">
      <li
        className={css.tab}
        data-active={active || undefined}
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
        <button
          type="button"
          className={css.show}
          onClick={onShow}
          title={name}
          aria-current={active ? "page" : undefined}
        >
          <TabStatus store={tab.store} />
          <span className={css.label}>
            {pr ? (
              <ScreenMorph id={tab.morphKey} part="number">
                <span className={css.number}>#{pr.number}</span>
              </ScreenMorph>
            ) : (
              <Icon name="branch" className={css.branch} />
            )}
            <ScreenMorph id={tab.morphKey} part="title">
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
      </li>
    </ScreenMorph>
  );
}

/**
 * The title bar's second row: in a review, the way back to the list, and every
 * open tab, the one on screen marked as such. A tab stays while it is shown,
 * while an agent is at work in it, or once one finished out of sight; a tab
 * left with none of those closes (`keepsTab`).
 *
 * Each tab shows its number, title and status. Opening a PR carries its number
 * and title up from its row on the list into its tab. The back button's label
 * is the list's "Pull requests" heading, scaled down on the way in.
 */
export function TabBar({ className }: { className?: string }) {
  const tabs = useAppStore((state) => state.tabs);
  const visible = useAppStore(tabBarShown);
  const inReview = useAppStore((state) => state.view === "review");
  const shown = useAppStore((state) => shownTab(state)?.id ?? null);
  const showTab = useAppStore((state) => state.showTab);
  const closeTab = useAppStore((state) => state.closeTab);
  const goHome = useAppStore((state) => state.goHome);

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
              <ScreenMorph id="home" part="heading">
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
              active={tab.id === shown}
              onShow={() => void showTab(tab.id)}
              onClose={() => closeTab(tab.id)}
            />
          ))}
        </ul>
      </nav>
    </div>
  );
}
