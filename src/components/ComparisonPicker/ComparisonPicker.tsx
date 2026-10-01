import { useState } from "react";
import { Button, Icon, Popover } from "tk-design-system";
import { reviewsWorkingTree, useTab } from "../../store/tabStore";
import { BranchSelector } from "../BranchSelector/BranchSelector";
import css from "./ComparisonPicker.module.css";
import { PrSelector } from "./PrSelector";

/**
 * The header control for a branch comparison. The button reads back the
 * current pair; the popover behind it offers a pull request search first, and
 * the manual base/compare pair below. A PR under review shows its branches
 * instead (see `App`), since it was chosen from the list.
 *
 * Keyed on the repository by the caller: another project's pull requests are
 * not this one's, so the list starts empty rather than stale.
 */
export function ComparisonPicker() {
  const base = useTab((state) => state.base);
  const compare = useTab((state) => state.compare);
  const worktree = useTab(reviewsWorkingTree);
  const [open, setOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(true);

  const summary = base && compare ? `${base} … ${compare}` : "Choose a comparison";

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger render={<Button size="sm" className={css.trigger} />} title={summary}>
        <span className={css.triggerText}>{summary}</span>
        {worktree ? <span className={css.badge}>+ uncommitted</span> : null}
        <Icon name="chevron-down" className={css.chevron} />
      </Popover.Trigger>
      <Popover.Popup sideOffset={6} align="start" className={css.popup}>
        <section className={css.section}>
          <Popover.Title className={css.heading}>Pull request</Popover.Title>
          <PrSelector className={css.prField} onOpened={() => setOpen(false)} />
        </section>
        <section className={css.section}>
          <button
            type="button"
            className={css.disclosure}
            aria-expanded={manualOpen}
            onClick={() => setManualOpen(!manualOpen)}
          >
            <Icon name={manualOpen ? "chevron-down" : "chevron-right"} />
            Compare branches manually
          </button>
          {manualOpen ? <BranchSelector /> : null}
        </section>
      </Popover.Popup>
    </Popover.Root>
  );
}
