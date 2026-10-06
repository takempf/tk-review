import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import type { PrPostLocation } from "./prComment";

/** Only lines in one original patch hunk can be anchored on GitHub. */
export function diffCommentLocation(
  file: FileDiffMetadata,
  range: SelectedLineRange,
  headSha: string,
): PrPostLocation | null {
  const side = range.side ?? "additions";
  if ((range.endSide ?? side) !== side) return null;
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);
  const oldSide = side === "deletions";
  if (
    !file.hunks.some((hunk) => {
      const first = oldSide ? hunk.deletionStart : hunk.additionStart;
      const count = oldSide ? hunk.deletionCount : hunk.additionCount;
      return count > 0 && start >= first && end < first + count;
    })
  )
    return null;
  return {
    destination: "inline",
    path: file.name,
    line: start,
    endLine: end > start ? end : null,
    oldSide,
    headSha,
    note: `Comment on ${file.name}:${start}${end > start ? `–${end}` : ""}${oldSide ? " (old side)" : ""}.`,
  };
}
