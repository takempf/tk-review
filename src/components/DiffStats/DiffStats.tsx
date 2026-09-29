import { useReviewStore } from "../../store/reviewStore";
import { Skeleton, SkeletonGroup } from "../Skeleton/Skeleton";
import css from "./DiffStats.module.css";

/** Proportion bar for the additions-to-deletions ratio, as a PR page shows. */
function ChangeBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  if (total === 0) return null;

  // The track carries the deletion colour; the filled portion covers it.
  return (
    <span className={css.bar} aria-hidden="true">
      <span className={css.barAdded} style={{ width: `${(additions / total) * 100}%` }} />
    </span>
  );
}

export function DiffStats() {
  const summary = useReviewStore((state) => state.summary);
  const loading = useReviewStore((state) => state.loadingDiff || state.openingPr);

  // Nothing to count yet: hold the space. A refresh keeps the old counts up.
  if (loading && !summary) {
    return (
      <SkeletonGroup label="Counting changes" className={css.stats}>
        <Skeleton width="11rem" />
      </SkeletonGroup>
    );
  }
  if (loading) return <span className={css.files}>Comparing…</span>;
  if (!summary) return null;

  const count = summary.files.length;
  return (
    <div className={css.stats}>
      <span className={css.files}>
        {count} {count === 1 ? "file" : "files"} changed
      </span>
      <span className={css.additions}>+{summary.totalAdditions}</span>
      <span className={css.deletions}>−{summary.totalDeletions}</span>
      <ChangeBar additions={summary.totalAdditions} deletions={summary.totalDeletions} />
    </div>
  );
}
