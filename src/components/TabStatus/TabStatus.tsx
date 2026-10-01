import type { ComponentProps } from "react";
import { cx, Icon } from "tk-design-system";
import { useStore } from "zustand";
import type { ReviewVerdict } from "../../ipc/git";
import { knownVerdict, REVIEWED_ICON, VERDICT_ICONS } from "../../lib/verdict";
import { reviewsNewestFirst, type TabState, type TabStore } from "../../store/tabStore";
import { Spinner } from "../Spinner/Spinner";
import css from "./TabStatus.module.css";

/** Where a tab's review stands, most pressing first. */
export type TabStatusKind =
  | "opening"
  | "working"
  | "error"
  | "moved"
  | ReviewVerdict
  | "reviewed"
  | "none";

const LABELS: Record<TabStatusKind, string> = {
  opening: "Opening",
  working: "Agent at work",
  error: "Something failed",
  moved: "New commits since it was opened",
  approve: "Reviewed: approve",
  comment: "Reviewed: comment",
  request_changes: "Reviewed: request changes",
  reviewed: "Reviewed",
  none: "Not reviewed",
};

/**
 * The tab's status. The verdict is the most recent review's, as the panel's
 * conclusion is: the one sent to GitHub once there is one, and the agent's
 * recommendation until then.
 */
export function tabStatus(state: TabState): TabStatusKind {
  if (state.openingPr || (state.loadingDiff && !state.summary)) return "opening";
  if (state.reviewing || state.reReviewing || state.explaining) return "working";
  if (state.error || state.reviewError || state.explainError) return "error";
  if (state.prHeadMoved) return "moved";
  const [stored] = reviewsNewestFirst(state.reviews);
  if (!stored) return "none";
  return stored.review.submitted?.verdict ?? knownVerdict(stored.review.verdict) ?? "reviewed";
}

function Glyph({ status }: { status: TabStatusKind }) {
  switch (status) {
    case "opening":
    case "working":
      return <Spinner />;
    case "error":
      return <Icon name="warning" />;
    case "moved":
      return <Icon name="arrow-up" />;
    case "approve":
    case "comment":
    case "request_changes":
      return <Icon name={VERDICT_ICONS[status]} />;
    case "reviewed":
      return <Icon name={REVIEWED_ICON} />;
    case "none":
      return <Icon name="circle" />;
  }
}

/**
 * One icon-sized mark for where a tab's review stands: loading, an agent at
 * work, a failure, new commits, the verdict, or nothing yet. A dot on it means
 * something finished while the tab was out of sight. Shown on the tab.
 */
export function TabStatus({
  store,
  className,
  ...props
}: { store: TabStore } & Omit<ComponentProps<"span">, "children">) {
  const status = useStore(store, tabStatus);
  const unseen = useStore(store, (state) => state.unseen);
  const label = unseen ? `${LABELS[status]}, since you last looked` : LABELS[status];

  return (
    <span
      {...props}
      className={cx(css.status, className)}
      data-status={status}
      role="img"
      aria-label={label}
      title={label}
    >
      <Glyph status={status} />
      {unseen ? <span className={css.unseen} /> : null}
    </span>
  );
}
