import type { ReviewFinding } from "../ipc/git";

/** A run of new-file lines, both ends included; a single line has `start === end`. */
export interface LineSpan {
  start: number;
  end: number;
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
