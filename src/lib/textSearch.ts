export type SearchScope = "files" | "diff" | "conversations" | "commits" | "pullRequests";

export interface SearchDocument {
  id: string;
  scope: SearchScope;
  title: string;
  text: string;
  detail?: string;
  target?: string;
  tab?: "pr" | "ai" | "explain";
  activate?: () => void;
}

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
}

export interface SearchMatch {
  id: string;
  document: SearchDocument;
  offset: number;
  length: number;
}

const wordCharacter = /[\p{L}\p{N}_]/u;

/** Literal text search: punctuation is never interpreted as a regular expression. */
export function matchOffsets(text: string, query: string, options: SearchOptions): number[] {
  if (!query) return [];
  // Escaping a literal regex preserves original offsets for Unicode case folding.
  const pattern = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(pattern, options.caseSensitive ? "gu" : "giu");
  const offsets: number[] = [];
  for (const match of text.matchAll(expression)) {
    const offset = match.index;
    const before = Array.from(text.slice(Math.max(0, offset - 2), offset)).at(-1) ?? "";
    const after =
      Array.from(text.slice(offset + match[0].length, offset + match[0].length + 2))[0] ?? "";
    if (options.wholeWord && (wordCharacter.test(before) || wordCharacter.test(after))) continue;
    offsets.push(offset);
  }
  return offsets;
}

export const RESULT_LIMIT = 200;

export function searchDocuments(
  documents: SearchDocument[],
  query: string,
  scope: SearchScope | "all",
  options: SearchOptions,
) {
  const counts: Record<SearchScope | "all", number> = {
    all: 0,
    files: 0,
    diff: 0,
    conversations: 0,
    commits: 0,
    pullRequests: 0,
  };
  const matches: SearchMatch[] = [];
  for (const document of documents) {
    const offsets = matchOffsets(document.text, query, options);
    counts[document.scope] += offsets.length;
    counts.all += offsets.length;
    if (scope !== "all" && document.scope !== scope) continue;
    for (const offset of offsets) {
      if (matches.length === RESULT_LIMIT) break;
      matches.push({ id: `${document.id}:${offset}`, document, offset, length: query.length });
    }
  }
  return { matches, counts, total: counts[scope] };
}

/** A small window around the match, preserving whitespace in code. */
export function matchExcerpt(match: SearchMatch) {
  const { text } = match.document;
  const start = Math.max(0, match.offset - 55);
  const end = Math.min(text.length, match.offset + match.length + 100);
  return {
    before: `${start > 0 ? "…" : ""}${text.slice(start, match.offset)}`,
    match: text.slice(match.offset, match.offset + match.length),
    after: `${text.slice(match.offset + match.length, end)}${end < text.length ? "…" : ""}`,
  };
}
