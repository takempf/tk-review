import type { PrCommentDestination, ReviewFinding } from "../ipc/git";

export interface PrPostLocation {
  destination: PrCommentDestination;
  path: string | null;
  line: number | null;
  note: string;
}

/**
 * Reads unified-diff hunk headers and maps their new-file sides to paths.
 * GitHub accepts inline comments only for a line shown in the current patch;
 * context lines count, removed (`-`) lines do not.
 */
function patchNewLines(patch: string): Map<string, Set<number>> {
  const linesByPath = new Map<string, Set<number>>();
  let path: string | null = null;
  let nextNewLine: number | null = null;

  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ b/")) {
      path = line.slice(6);
      if (!linesByPath.has(path)) linesByPath.set(path, new Set());
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
      continue;
    }
    if (!path || nextNewLine === null || line.startsWith("\\ No newline")) continue;
    if (line.startsWith("+")) {
      linesByPath.get(path)?.add(nextNewLine);
      nextNewLine += 1;
    } else if (line.startsWith("-")) {
      // A deletion advances only the old-file cursor.
    } else {
      linesByPath.get(path)?.add(nextNewLine);
      nextNewLine += 1;
    }
  }
  return linesByPath;
}

export function postLocationForFinding(
  finding: ReviewFinding | null,
  patch: string | null,
): PrPostLocation {
  if (!finding) {
    return {
      destination: "topLevel",
      path: null,
      line: null,
      note: "Posts to the PR conversation.",
    };
  }
  const linesByPath = patch ? patchNewLines(patch) : null;
  const pathLines = linesByPath?.get(finding.path);
  const inPatch = pathLines?.has(finding.line ?? -1) ?? false;
  if (finding.line !== null && inPatch) {
    return {
      destination: "inline",
      path: finding.path,
      line: finding.line,
      note: `Posts inline on ${finding.path}:${finding.line}.`,
    };
  }
  if (!pathLines) {
    return {
      destination: "topLevel",
      path: null,
      line: null,
      note: `Posts to the PR conversation; ${finding.path} is not in this diff.`,
    };
  }
  if (finding.path) {
    return {
      destination: "file",
      path: finding.path,
      line: finding.line,
      note: `Posts as a file comment on ${finding.path}${finding.line !== null ? ` (originally line ${finding.line})` : ""}.`,
    };
  }
  return { destination: "topLevel", path: null, line: null, note: "Posts to the PR conversation." };
}

/** Adds location context only when GitHub cannot attach a normal inline note. */
export function postBodyForFinding(
  finding: ReviewFinding | null,
  location: PrPostLocation,
): string {
  if (!finding) return "Review summary";
  const body = `${finding.title}\n\n${finding.body}`;
  if (location.destination === "inline") return body;
  const intended = `${finding.path}${finding.line !== null ? `:${finding.line}` : ""}`;
  return `${body}\n\n_Originally noted at ${intended}._`;
}
