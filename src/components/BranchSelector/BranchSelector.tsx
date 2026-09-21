import { useReviewStore } from "../../store/reviewStore";
import { BranchCombobox } from "./BranchCombobox";
import css from "./BranchSelector.module.css";

/** Base and compare, stacked, with fetch and the working-tree toggle beneath. */
export function BranchSelector() {
  const branches = useReviewStore((state) => state.branches);
  const base = useReviewStore((state) => state.base);
  const compare = useReviewStore((state) => state.compare);
  const currentBranch = useReviewStore((state) => state.repo?.currentBranch ?? null);
  const setBase = useReviewStore((state) => state.setBase);
  const setCompare = useReviewStore((state) => state.setCompare);
  const swapRefs = useReviewStore((state) => state.swapRefs);
  const includeUncommitted = useReviewStore((state) => state.includeUncommitted);
  const setIncludeUncommitted = useReviewStore((state) => state.setIncludeUncommitted);
  const fetching = useReviewStore((state) => state.fetching);
  const fetchRemotes = useReviewStore((state) => state.fetchRemotes);

  // The working tree extends the checked-out branch and no other revision, so
  // the toggle only applies while that branch is the compare side.
  const onCheckedOutBranch = compare !== null && compare === currentBranch;

  return (
    <div className={css.wrap}>
      <span className={css.refLabel}>Base</span>
      <BranchCombobox
        ariaLabel="Base"
        className={css.refField}
        value={base}
        branches={branches}
        onChange={setBase}
      />
      <button
        type="button"
        className={css.swap}
        onClick={() => void swapRefs()}
        title="Swap base and compare"
        aria-label="Swap base and compare"
      >
        ⇅
      </button>
      <span className={css.refLabel}>Compare</span>
      <BranchCombobox
        ariaLabel="Compare"
        className={css.refField}
        value={compare}
        branches={branches}
        onChange={setCompare}
      />
      <div className={css.footer}>
        <button
          type="button"
          className={css.fetch}
          onClick={() => void fetchRemotes()}
          disabled={fetching}
          title="git fetch --all --prune — pull in new and deleted branches from every remote"
        >
          {fetching ? "Fetching…" : "Fetch"}
        </button>
        <label
          className={css.uncommitted}
          title={
            onCheckedOutBranch
              ? "Include staged, unstaged, and untracked changes from the working tree"
              : "Available when compare is the checked-out branch"
          }
        >
          <input
            type="checkbox"
            disabled={!onCheckedOutBranch}
            checked={includeUncommitted && onCheckedOutBranch}
            onChange={(event) => void setIncludeUncommitted(event.target.checked)}
          />
          Include uncommitted changes
        </label>
      </div>
    </div>
  );
}
