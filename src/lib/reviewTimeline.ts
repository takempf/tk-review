import type { Commit, ReviewEngine } from "../ipc/git";
import { type ReviewStamp, type ReviewsByEngine, stampOf } from "../store/tabStore";

/** One review, as the commit list marks it. */
export interface ReviewMark {
  engine: ReviewEngine;
  stamp: ReviewStamp;
  /** The engine's review on record, the one the panel shows, rather than one it replaced. */
  current: boolean;
  /**
   * Placed by when it ran rather than by the commit it read: that commit is no
   * longer on the branch (a rebase or a force-push rewrote it), or the review
   * is older than recording it.
   */
  approximate: boolean;
}

export interface ReviewTimeline {
  /** By commit, oldest review first. */
  byCommit: Map<string, ReviewMark[]>;
  /** Reviews of the working tree on the commit it sits on now. */
  uncommitted: ReviewMark[];
  /** Reviews of commits not listed: rewritten, past the list's end, or the merge base itself. */
  unplaced: ReviewMark[];
  /** How many commits came after the most recent review; `null` when there is none to count from. */
  sinceLatest: number | null;
}

/**
 * Puts each review of the comparison, earlier ones included, on the commit it
 * read. `commits` is newest first. In a review of the working tree, every
 * review is one, and those of the commit it sits on now go on `uncommitted`.
 */
export function placeReviews(
  commits: Commit[],
  reviews: ReviewsByEngine,
  worktree: boolean,
  mergeBase: string,
): ReviewTimeline {
  const marks: Omit<ReviewMark, "approximate">[] = Object.values(reviews).flatMap((stored) =>
    stored
      ? [
          ...(stored.earlier ?? []).map((stamp) => ({
            engine: stored.engine,
            stamp,
            current: false,
          })),
          { engine: stored.engine, stamp: stampOf(stored), current: true },
        ]
      : [],
  );
  marks.sort((a, b) => a.stamp.createdAt.localeCompare(b.stamp.createdAt));

  const index = new Map(commits.map((commit, at) => [commit.sha, at]));
  // What the working tree sits on: the newest commit, or with none since the
  // merge base, the merge base, which is then HEAD.
  const under = commits[0]?.sha ?? mergeBase;
  const timeline: ReviewTimeline = {
    byCommit: new Map(),
    uncommitted: [],
    unplaced: [],
    sinceLatest: null,
  };
  /** Where each mark went, as an index into `commits`; -1 for `uncommitted`. */
  const placedAt = new Map<Omit<ReviewMark, "approximate">, number>();

  for (const mark of marks) {
    const { head, createdAt } = mark.stamp;
    if (worktree && head === under) {
      timeline.uncommitted.push({ ...mark, approximate: false });
      placedAt.set(mark, -1);
      continue;
    }
    const exact = head != null ? index.get(head) : undefined;
    // Otherwise the newest commit that already existed when the review ran.
    // Committer dates, which a rebase moves, so a rewritten branch's commits
    // all postdate a review of the old one and it is left unplaced.
    const ran = Date.parse(createdAt);
    const at = exact ?? commits.findIndex((commit) => Date.parse(commit.committedAt) <= ran);
    const approximate = exact === undefined;
    if (at === -1) {
      timeline.unplaced.push({ ...mark, approximate });
    } else if (worktree && at === 0 && approximate) {
      // After the newest commit, in a review that took in uncommitted work.
      timeline.uncommitted.push({ ...mark, approximate });
      placedAt.set(mark, -1);
    } else {
      const commit = commits[at] as Commit;
      const list = timeline.byCommit.get(commit.sha) ?? [];
      list.push({ ...mark, approximate });
      timeline.byCommit.set(commit.sha, list);
      placedAt.set(mark, at);
    }
  }

  const latest = marks.at(-1);
  const latestAt = latest ? placedAt.get(latest) : undefined;
  if (latestAt !== undefined) timeline.sinceLatest = Math.max(latestAt, 0);
  return timeline;
}
