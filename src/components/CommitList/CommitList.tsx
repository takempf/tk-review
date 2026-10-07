import { useMemo } from "react";
import { Icon, Tooltip } from "tk-design-system";
import type { Commit, ReviewVerdict } from "../../ipc/git";
import { ENGINE_LABELS } from "../../lib/engines";
import { placeReviews, type ReviewMark } from "../../lib/reviewTimeline";
import { absoluteTime, shortTime } from "../../lib/time";
import { knownVerdict, REVIEWED_ICON, VERDICT_ICONS } from "../../lib/verdict";
import { reviewsWorkingTree, useTab } from "../../store/tabStore";
import { useCopy } from "../CopyButton/CopyButton";
import { ScrollArea } from "../ScrollArea/ScrollArea";
import css from "./CommitList.module.css";

/** Past this many on one commit, the older ones are counted rather than drawn. */
const MARKS_SHOWN = 3;

const VERDICT_LABELS: Record<ReviewVerdict, string> = {
  approve: "Approve",
  comment: "Comment",
  request_changes: "Request changes",
};

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** A review's tooltip, a line per fact. `withUncommitted` for one placed on a commit of a working-tree review. */
function describe(mark: ReviewMark, withUncommitted: boolean): string[] {
  const { stamp } = mark;
  const verdict = knownVerdict(stamp.verdict);
  const lines = [
    `${ENGINE_LABELS[mark.engine] ?? mark.engine} ${stamp.reReview ? "re-review" : "review"}, ${shortTime(stamp.createdAt)}`,
    [plural(stamp.findings, "finding"), verdict ? VERDICT_LABELS[verdict] : null]
      .filter(Boolean)
      .join(" · "),
  ];
  if (withUncommitted) lines.push("With the uncommitted changes on top of it at the time");
  if (mark.approximate) {
    lines.push(
      stamp.head
        ? "Placed by time: the commit it read is no longer on the branch"
        : "Placed by time: it ran before reviews recorded their commit",
    );
  }
  if (!mark.current) lines.push("Replaced by a later review");
  return lines;
}

function Mark({ mark, withUncommitted }: { mark: ReviewMark; withUncommitted: boolean }) {
  const verdict = knownVerdict(mark.stamp.verdict);
  const lines = describe(mark, withUncommitted);
  return (
    <Tooltip
      content={
        <span className={css.tip}>
          {lines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </span>
      }
    >
      <span
        className={css.mark}
        data-verdict={verdict ?? "reviewed"}
        data-earlier={!mark.current || undefined}
        data-approximate={mark.approximate || undefined}
        role="img"
        aria-label={lines.join(". ")}
      >
        <Icon name={verdict ? VERDICT_ICONS[verdict] : REVIEWED_ICON} />
      </span>
    </Tooltip>
  );
}

function Marks({ marks, withUncommitted }: { marks: ReviewMark[]; withUncommitted: boolean }) {
  if (marks.length === 0) return null;
  const shown = marks.slice(-MARKS_SHOWN);
  const hidden = marks.length - shown.length;
  return (
    <span className={css.marks}>
      {hidden > 0 ? (
        <span className={css.more} title={`${plural(hidden, "earlier review")} of this commit`}>
          +{hidden}
        </span>
      ) : null}
      {shown.map((mark) => (
        <Mark
          key={`${mark.engine}:${mark.stamp.createdAt}`}
          mark={mark}
          withUncommitted={withUncommitted}
        />
      ))}
    </span>
  );
}

function CommitRow({
  commit,
  marks,
  worktree,
}: {
  commit: Commit;
  marks: ReviewMark[];
  worktree: boolean;
}) {
  const { copied, copy } = useCopy(commit.sha);
  return (
    <li className={css.item} data-search-id={`commit:${commit.sha}`} tabIndex={-1}>
      <Tooltip content={copied ? "Copied" : "Copy commit hash"}>
        <button
          type="button"
          className={css.sha}
          onClick={copy}
          aria-label={copied ? "Copied" : `Copy commit hash ${commit.sha}`}
          data-copied={copied || undefined}
        >
          {commit.sha.slice(0, 7)}
        </button>
      </Tooltip>
      <span
        className={css.subject}
        title={`${commit.subject}\n${commit.author}, ${absoluteTime(commit.committedAt)}`}
      >
        {commit.subject}
      </span>
      <Marks marks={marks} withUncommitted={worktree} />
    </li>
  );
}

const NO_MARKS: ReviewMark[] = [];

/**
 * The commits the comparison is made of, newest first, each marked with the
 * reviews that read it — earlier ones too, which a re-review replaced in the
 * panel. The heading counts the commits that came after the latest review.
 */
export function CommitList() {
  const log = useTab((state) => state.commits);
  const mergeBase = useTab((state) => state.summary?.mergeBase ?? null);
  const reviews = useTab((state) => state.reviews);
  const worktree = useTab(reviewsWorkingTree);

  const timeline = useMemo(
    () => (log && mergeBase ? placeReviews(log.commits, reviews, worktree, mergeBase) : null),
    [log, mergeBase, reviews, worktree],
  );

  if (!log || !timeline) return null;
  // Nothing committed and nothing uncommitted: the refs are the same.
  if (log.commits.length === 0 && !worktree) return null;

  const { sinceLatest, unplaced } = timeline;
  const count = `${log.commits.length}${log.truncated ? "+" : ""}`;

  return (
    <section className={css.wrap} aria-label="Commits">
      <div className={css.heading}>
        <span>Commits</span>
        <span className={css.progress}>
          {count}
          {sinceLatest ? ` · ${sinceLatest} since last review` : null}
        </span>
      </div>
      <ScrollArea label="Commits" viewportClassName={css.scroll}>
        <ul className={css.list}>
          {worktree ? (
            <li className={css.item}>
              <span className={css.worktree} aria-hidden="true">
                <Icon name="plus" />
              </span>
              <span className={css.subjectMuted}>Uncommitted changes</span>
              <Marks marks={timeline.uncommitted} withUncommitted={false} />
            </li>
          ) : null}
          {log.commits.map((commit) => (
            <CommitRow
              key={commit.sha}
              commit={commit}
              marks={timeline.byCommit.get(commit.sha) ?? NO_MARKS}
              worktree={worktree}
            />
          ))}
        </ul>
        {log.truncated ? (
          <p className={css.footnote}>The newest {log.commits.length} commits.</p>
        ) : null}
        {unplaced.length > 0 ? (
          <p
            className={css.footnote}
            title={unplaced.map((mark) => describe(mark, false).join("\n")).join("\n\n")}
          >
            {plural(unplaced.length, "review")} read commits not listed here.
          </p>
        ) : null}
      </ScrollArea>
    </section>
  );
}
