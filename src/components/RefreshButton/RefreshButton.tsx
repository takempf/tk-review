import { Button, Icon, Tooltip } from "tk-design-system";
import { useStore } from "zustand";
import { invalidatePrLists, usePrListsFetching } from "../../lib/queries";
import { shownTab, useAppStore } from "../../store/appStore";
import type { TabStore } from "../../store/tabStore";

function RefreshIconButton({
  label,
  busy,
  onRefresh,
}: {
  label: string;
  busy: boolean;
  onRefresh: () => void;
}) {
  return (
    <Tooltip content={label} side="bottom">
      <Button
        variant="ghost"
        size="sm"
        square
        loading={busy}
        aria-label={label}
        onClick={onRefresh}
      >
        <Icon name="refresh" />
      </Button>
    </Tooltip>
  );
}

function ReviewRefresh({ store }: { store: TabStore }) {
  const hasPr = useStore(store, (state) => state.pr != null || state.pendingPr != null);
  const busy = useStore(
    store,
    (state) => state.loadingDiff || state.refreshingPr || state.openingPr,
  );
  return (
    <RefreshIconButton
      label={hasPr ? "Refresh pull request" : "Refresh comparison"}
      busy={busy}
      onRefresh={() => void store.getState().refresh()}
    />
  );
}

function PrListRefresh({ root }: { root: string }) {
  const busy = usePrListsFetching(root);
  return (
    <RefreshIconButton
      label="Refresh pull requests"
      busy={busy}
      onRefresh={() => void invalidatePrLists(root)}
    />
  );
}

/** Refreshes whatever is on screen: the review in front, or else the repository's PR list. */
export function RefreshButton() {
  const tab = useAppStore(shownTab);
  const root = useAppStore((state) => state.repo?.root ?? null);
  if (tab) return <ReviewRefresh key={tab.id} store={tab.store} />;
  if (root) return <PrListRefresh root={root} />;
  return null;
}
