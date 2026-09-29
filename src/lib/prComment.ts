import type { PrCommentDestination, ReviewFinding } from "../ipc/git";
import { findingLines, formatLines } from "./lineSpan";

export interface PrPostLocation {
  destination: PrCommentDestination;
  path: string | null;
  line: number | null;
  /** Where an inline comment's span ends; `null` for a single line. */
  endLine: number | null;
  note: string;
}

/**
 * Reads unified-diff hunk headers and maps each path's new-file lines to the
 * hunk that shows them. GitHub accepts inline comments only on lines shown in
 * the current patch — context lines count, removed (`-`) lines do not — and a
 * multi-line comment only within one hunk.
 */
function patchNewLines(patch: string): Map<string, Map<number, number>> {
  const linesByPath = new Map<string, Map<number, number>>();
  let path: string | null = null;
  let nextNewLine: number | null = null;
  let hunkIndex = 0;

  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ b/")) {
      path = line.slice(6);
      if (!linesByPath.has(path)) linesByPath.set(path, new Map());
      nextNewLine = null;
      continue;
    }
    if (line.startsWith("+++ /dev/null")) {
      path = null;
      nextNewLine = null;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      nextNewLine = Number(hunk[1]);
      hunkIndex += 1;
      continue;
    }
    if (!path || nextNewLine === null || line.startsWith("\\ No newline")) continue;
    // A deletion advances only the old-file cursor.
    if (line.startsWith("-")) continue;
    linesByPath.get(path)?.set(nextNewLine, hunkIndex);
    nextNewLine += 1;
  }
  return linesByPath;
}

export function postLocationForFinding(
  finding: ReviewFinding | null,
  patch: string | null,
): PrPostLocation {
  const conversation = {
    destination: "topLevel",
    path: null,
    line: null,
    endLine: null,
  } as const;
  if (!finding) return { ...conversation, note: "Posts to the PR conversation." };
  const lines = findingLines(finding);
  const pathLines = patch ? patchNewLines(patch).get(finding.path) : undefined;
  const startHunk = lines ? pathLines?.get(lines.start) : undefined;
  if (lines && startHunk !== undefined) {
    const where = `${finding.path}:${lines.start}`;
    if (pathLines?.get(lines.end) === startHunk) {
      return {
        destination: "inline",
        path: finding.path,
        line: lines.start,
        endLine: lines.end > lines.start ? lines.end : null,
        note: `Posts inline on ${finding.path}:${formatLines(lines)}.`,
      };
    }
    // The diff shows where the span starts but not all of it in one hunk, so
    // the comment anchors to its first line.
    return {
      destination: "inline",
      path: finding.path,
      line: lines.start,
      endLine: null,
      note: `Posts inline on ${where}; lines ${formatLines(lines)} are not all in one hunk of the diff.`,
    };
  }
  if (!pathLines) {
    return {
      ...conversation,
      note: `Posts to the PR conversation; ${finding.path} is not in this diff.`,
    };
  }
  if (finding.path) {
    return {
      destination: "file",
      path: finding.path,
      line: finding.line,
      endLine: null,
      note: `Posts as a file comment on ${finding.path}${lines ? ` (originally ${lines.end > lines.start ? "lines" : "line"} ${formatLines(lines)})` : ""}.`,
    };
  }
  return { ...conversation, note: "Posts to the PR conversation." };
}

/** Adds location context only when GitHub cannot anchor the note where the finding points. */
export function postBodyForFinding(
  finding: ReviewFinding | null,
  location: PrPostLocation,
): string {
  if (!finding) return "Review summary";
  const body = `${finding.title}\n\n${finding.body}`;
  const lines = findingLines(finding);
  const exact =
    location.destination === "inline" &&
    location.line === lines?.start &&
    (location.endLine ?? location.line) === lines?.end;
  if (exact) return body;
  const intended = `${finding.path}${lines ? `:${formatLines(lines)}` : ""}`;
  return `${body}\n\n_Originally noted at ${intended}._`;
}
