import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { errorMessage } from "../../ipc/git";
import { prListQuery } from "../../lib/queries";
import { useReviewStore } from "../../store/reviewStore";
import { Combobox } from "../Combobox/Combobox";

/** `#47 · Fix the thing` — the searchable spelling of a PR, number first. */
export function prLabel(pr: { number: number; title: string; isDraft?: boolean }): string {
  return `#${pr.number} · ${pr.isDraft ? "[draft] " : ""}${pr.title}`;
}

/**
 * Picks a pull request to review, listing the repository's open ones.
 *
 * A combobox rather than a URL field because the number and the title are both
 * things people remember, and the field filters on either. Anything typed that
 * matches no row is still handed to `openPr`, so a pasted URL — a closed PR, a
 * PR in another repository, anything past the listing limit — opens exactly as
 * it always did.
 */
export function PrSelector({
  className,
  onOpened,
}: {
  className?: string;
  /** Called once a PR has been opened and its diff requested. */
  onOpened?: () => void;
}) {
  const repo = useReviewStore((state) => state.repo);
  const pr = useReviewStore((state) => state.pr);
  const openingPr = useReviewStore((state) => state.openingPr);
  const openPr = useReviewStore((state) => state.openPr);

  const root = repo?.root ?? null;

  // The home screen's "All open" list, from the same cache, so the popup opens
  // on whatever that last listed. Listing costs a `gh` round trip, so it never
  // fetches by itself: it re-lists each time the popup opens, since PRs are
  // raised and merged while the app is running.
  const listing = useQuery({ ...prListQuery(root ?? "", "all"), enabled: false });
  const prs = listing.data;

  function load(open: boolean) {
    if (open && root) void listing.refetch();
  }

  const byLabel = useMemo(() => new Map((prs ?? []).map((item) => [prLabel(item), item])), [prs]);
  const label =
    listing.isFetching && !prs
      ? "Loading pull requests…"
      : listing.isError && !prs
        ? `Could not list pull requests — paste a URL instead. ${errorMessage(listing.error)}`
        : prs && prs.length > 0
          ? "Open pull requests"
          : prs
            ? "No open pull requests"
            : "Pull requests";

  return (
    <Combobox
      ariaLabel="Pull request"
      className={className}
      value={pr ? prLabel(pr) : null}
      groups={[{ label, items: [...byLabel.keys()] }]}
      onOpenChange={load}
      onChange={(next) => {
        const chosen = next.trim();
        if (!chosen) return;
        // A row carries its own URL; anything else is a pasted reference, which
        // `open_pr` parses in every spelling it already accepted.
        void openPr(byLabel.get(chosen)?.url ?? chosen).then((opened) => {
          if (opened) onOpened?.();
        });
      }}
      placeholder={openingPr ? "Opening…" : "Find a PR, or paste a URL"}
      disabled={openingPr}
    />
  );
}
