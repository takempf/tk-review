import type { ReviewFinding } from "../ipc/git";

/** Which file a diff's line numbers count in: the new one, or the base's. */
export type LineSide = "additions" | "deletions";

/**
 * A run of lines, both ends included; a single line has `start === end`. They
 * are the new file's unless `side` says they are the base's.
 */
export interface LineSpan {
  start: number;
  end: number;
  side?: LineSide;
}

/** The lines a finding points at, or `null` for one about the whole file. */
export function findingLines(finding: Pick<ReviewFinding, "line" | "endLine">): LineSpan | null {
  if (finding.line == null) return null;
  return { start: finding.line, end: Math.max(finding.line, finding.endLine ?? finding.line) };
}

/** A location's line part: `12`, or `12–18` for a span. */
export function formatLines(span: LineSpan): string {
  return span.end > span.start ? `${span.start}–${span.end}` : `${span.start}`;
}

/** A span in words: `line 12`, `lines 12–18`, and `old line 12` for the base's. */
export function describeLines(span: LineSpan): string {
  const old = span.side === "deletions" ? "old " : "";
  return `${old}${span.end > span.start ? "lines" : "line"} ${formatLines(span)}`;
}
