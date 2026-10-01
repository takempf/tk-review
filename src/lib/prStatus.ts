import type { PrSummary } from "../ipc/git";

/**
 * Where a pull request stands, as the list's Status column shows it and its
 * filter chooses between. `closed` is a PR reviewed here that GitHub no longer
 * lists as open.
 */
export type PrStatus =
  | "changesRequested"
  | "reviewRequired"
  | "approved"
  | "noReview"
  | "draft"
  | "closed";

/** In the order a reviewer gets to them: what most needs attention first. */
export const STATUS_LABELS: Record<PrStatus, string> = {
  changesRequested: "Changes requested",
  reviewRequired: "Awaiting review",
  approved: "Approved",
  noReview: "No review required",
  draft: "Draft",
  closed: "Not open",
};

export const STATUSES = Object.keys(STATUS_LABELS) as PrStatus[];

/** An open PR's status: a draft is a draft whatever its reviews say. */
export function prStatus(pr: PrSummary): Exclude<PrStatus, "closed"> {
  if (pr.isDraft) return "draft";
  switch (pr.reviewDecision) {
    case "CHANGES_REQUESTED":
      return "changesRequested";
    case "REVIEW_REQUIRED":
      return "reviewRequired";
    case "APPROVED":
      return "approved";
    default:
      return "noReview";
  }
}
