import { Checkbox, Icon } from "tk-design-system";
import { useTab } from "../../store/tabStore";
import { Spinner } from "../Spinner/Spinner";
import { BranchCombobox } from "./BranchCombobox";
import css from "./BranchSelector.module.css";

/** Base and compare, stacked, with fetch and the working-tree toggle beneath. */
export function BranchSelector() {
  const branches = useTab((state) => state.branches);
  const base = useTab((state) => state.base);
  const compare = useTab((state) => state.compare);
  const currentBranch = useTab((state) => state.repo?.currentBranch ?? null);
  const setBase = useTab((state) => state.setBase);
  const setCompare = useTab((state) => state.setCompare);
  const swapRefs = useTab((state) => state.swapRefs);
  const includeUncommitted = useTab((state) => state.includeUncommitted);
  const setIncludeUncommitted = useTab((state) => state.setIncludeUncommitted);
  const fetching = useTab((state) => state.fetching);
  const fetchRemotes = useTab((state) => state.fetchRemotes);

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
        <Icon name="swap" />
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
          {fetching ? <Spinner /> : <Icon name="download" />}
          {fetching ? "Fetching…" : "Fetch"}
        </button>
        <span
          className={css.uncommitted}
          title={
            onCheckedOutBranch
              ? "Include staged, unstaged, and untracked changes from the working tree"
              : "Available when compare is the checked-out branch"
          }
        >
          <Checkbox
            disabled={!onCheckedOutBranch}
            checked={includeUncommitted && onCheckedOutBranch}
            onCheckedChange={(checked) => void setIncludeUncommitted(checked)}
          >
            Include uncommitted changes
          </Checkbox>
        </span>
      </div>
    </div>
  );
}
