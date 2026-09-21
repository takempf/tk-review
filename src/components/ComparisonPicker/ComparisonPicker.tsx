import { Popover } from "@base-ui/react/popover";
import { useState } from "react";
import { reviewsWorkingTree, useReviewStore } from "../../store/reviewStore";
import { BranchSelector } from "../BranchSelector/BranchSelector";
import css from "./ComparisonPicker.module.css";
import { PrSelector, prLabel } from "./PrSelector";

/**
 * The one header control for choosing what to review. The button reads back
 * the current comparison; the popover behind it offers a pull request search
 * first, and a manual base/compare pair for everything that isn't a PR.
 *
 * Keyed on the repository by the caller: another project's pull requests are
 * not this one's, so the list starts empty rather than stale.
 */
export function ComparisonPicker() {
  const pr = useReviewStore((state) => state.pr);
  const base = useReviewStore((state) => state.base);
  const compare = useReviewStore((state) => state.compare);
  const worktree = useReviewStore(reviewsWorkingTree);
  const [open, setOpen] = useState(false);
  // Manual comparison is the fallback, so it starts folded while a PR is the
  // thing being reviewed — and unfolded when branches are all there is.
  const [manual, setManual] = useState<boolean | null>(null);
  const manualOpen = manual ?? pr === null;

  const summary = pr
    ? prLabel(pr)
    : base && compare
      ? `${base} … ${compare}`
      : "Choose a comparison";

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className={css.trigger} title={summary}>
        <span className={css.triggerText}>{summary}</span>
        {worktree ? <span className={css.badge}>+ uncommitted</span> : null}
        <svg className={css.chevron} viewBox="0 0 10 8.6603" aria-hidden="true">
          <polygon points="0,0 10,0 5,8.6603" />
        </svg>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className={css.positioner} sideOffset={6} align="start">
          <Popover.Popup className={css.popup}>
            <section className={css.section}>
              <Popover.Title className={css.heading}>Pull request</Popover.Title>
              <PrSelector className={css.prField} onOpened={() => setOpen(false)} />
              {pr ? (
                <p className={css.hint}>
                  Reviewing {pr.baseRemote}/{pr.baseRef} … {pr.compareRef}
                </p>
              ) : null}
            </section>
            <section className={css.section}>
              <button
                type="button"
                className={css.disclosure}
                aria-expanded={manualOpen}
                onClick={() => setManual(!manualOpen)}
              >
                <span className={css.disclosureChevron} aria-hidden="true">
                  {manualOpen ? "▾" : "▸"}
                </span>
                Compare branches manually
              </button>
              {manualOpen ? <BranchSelector /> : null}
            </section>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
