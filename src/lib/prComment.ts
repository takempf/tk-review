import type { PrCommentDestination, ReviewFinding } from "../ipc/git";
import { findingLines, formatLines } from "./lineSpan";

export interface PrPostLocation {
  destination: PrCommentDestination;
  path: string | null;
  line: number | null;
  /** Where an inline comment's span ends; `null` for a single line. */
  endLine: number | null;
  note: string;
  oldSide?: boolean;
  replyTo?: number;
  quoteCommentId?: number;
  /** The diff commit the user selected; preserved if the PR is refreshed. */
  headSha?: string;
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

/**
 * Adds location context only when GitHub cannot anchor the note where the
 * finding points. `asOf` is the commit those lines belong to, when it isn't
 * the PR's head: GitHub links the short SHA.
 */
export function postBodyForFinding(
  finding: ReviewFinding | null,
  location: PrPostLocation,
  asOf?: string | null,
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
  const commit = asOf ? ` as of ${asOf.slice(0, 7)}` : "";
  return `${body}\n\n_Originally noted at ${intended}${commit}._`;
}

/** One file's hunks in a unified diff, with the path it had before and has after. */
interface FileDiff {
  from: string | null;
  to: string | null;
  hunks: { oldStart: number; newStart: number; lines: string[] }[];
}

function fileDiffs(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | null = null;
  // Between `diff --git` and the first hunk; after it, a `--- ` line is a removed `-- `.
  let header = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = { from: null, to: null, hunks: [] };
      files.push(file);
      header = true;
      continue;
    }
    if (!file) continue;
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      header = false;
      // A side with no lines names the line before the hunk, not the first in it.
      const oldStart = Number(hunk[1]) + (hunk[2] === "0" ? 1 : 0);
      const newStart = Number(hunk[3]) + (hunk[4] === "0" ? 1 : 0);
      file.hunks.push({ oldStart, newStart, lines: [] });
      continue;
    }
    if (header) {
      if (line.startsWith("--- a/")) file.from = line.slice(6);
      else if (line.startsWith("+++ b/")) file.to = line.slice(6);
      // A rename that changes nothing has no `---`/`+++` lines, only these.
      else if (line.startsWith("rename from ")) file.from = line.slice(12);
      else if (line.startsWith("rename to ")) file.to = line.slice(10);
      continue;
    }
    file.hunks.at(-1)?.lines.push(line);
  }
  return files;
}

/** Where an old-side line ends up on the new side, or `null` when it was removed. */
function lineAfter(line: number, hunks: FileDiff["hunks"]): number | null {
  let shift = 0;
  for (const hunk of hunks) {
    if (line < hunk.oldStart) break;
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const row of hunk.lines) {
      if (row.startsWith("+")) newLine += 1;
      else if (row.startsWith("-")) {
        if (oldLine === line) return null;
        oldLine += 1;
      } else if (row.startsWith(" ")) {
        if (oldLine === line) return newLine;
        oldLine += 1;
        newLine += 1;
      }
    }
    shift = newLine - oldLine;
  }
  return line + shift;
}

/**
 * Where a finding raised on an earlier commit sits now, given the diff from
 * that commit to this one: its path followed through a rename, its lines moved
 * by what was added and removed above them. `null` when its file is gone or
 * its first or last line was itself changed, so there is nothing to follow.
 */
export function findingAfter(finding: ReviewFinding, patch: string): ReviewFinding | null {
  const file = fileDiffs(patch).find((diff) => diff.from === finding.path);
  // Untouched in between: it reads as it did.
  if (!file) return finding;
  if (!file.to) return null;
  const moved = { ...finding, path: file.to };
  const lines = findingLines(finding);
  if (!lines) return moved;
  const start = lineAfter(lines.start, file.hunks);
  const end = lineAfter(lines.end, file.hunks);
  if (start == null || end == null || end < start) return null;
  return { ...moved, line: start, endLine: finding.endLine == null ? finding.endLine : end };
}

/**
 * Where to post a finding an earlier review raised, from where it sits on the
 * PR's head now (`findingAfter`): wherever a finding there would go. When its
 * lines couldn't be followed, on its file instead, rather than on whatever
 * those line numbers hold now.
 */
export function postLocationForPriorFinding(
  finding: ReviewFinding,
  now: ReviewFinding | null,
  patch: string | null,
): PrPostLocation {
  if (now) return postLocationForFinding(now, patch);
  const location = postLocationForFinding({ ...finding, line: null, endLine: null }, patch);
  if (location.destination !== "file") return location;
  return {
    ...location,
    note: `Posts as a file comment on ${finding.path}: its lines can't be followed from the review that raised it to the PR's head.`,
  };
}
