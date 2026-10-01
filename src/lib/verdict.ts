import type { IconName } from "tk-design-system";
import type { ReviewVerdict } from "../ipc/git";

const VERDICTS: readonly ReviewVerdict[] = ["comment", "approve", "request_changes"];

/** The agent's verdict when it is one GitHub knows; `null` for anything else. */
export function knownVerdict(verdict: string | undefined): ReviewVerdict | null {
  const key = verdict
    ?.trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return VERDICTS.find((option) => option === key) ?? null;
}

/** The mark for a review that ended in each verdict, wherever a review is marked. */
export const VERDICT_ICONS: Record<ReviewVerdict, IconName> = {
  approve: "check",
  comment: "comment",
  request_changes: "close",
};

/** The mark for a review whose verdict is not one GitHub knows, or is missing. */
export const REVIEWED_ICON: IconName = "dot-in-circle";
