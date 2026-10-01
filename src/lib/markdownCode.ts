/**
 * Finding the code in Markdown before it is parsed, so the steps that read it
 * as HTML (the sanitizer, the `<details>` splitter) can leave code alone.
 */
import type { Node } from "comark";

/** A fenced code block: the whole of it, and the lines between its fences. */
export interface Fence {
  start: number;
  end: number;
  /** The opening fence's indentation, which its contents' lines drop. */
  indent: string;
  contentStart: number;
  contentEnd: number;
}

/** Every fenced block in `text`, in order. */
export function findFences(text: string): Fence[] {
  const fences: Fence[] = [];
  let open: { marker: string; indent: string; start: number; contentStart: number } | null = null;
  let offset = 0;
  for (const line of text.split("\n")) {
    if (open) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
      if (close && close[0] === open.marker[0] && close.length >= open.marker.length) {
        fences.push({
          start: open.start,
          end: offset + line.length,
          indent: open.indent,
          contentStart: open.contentStart,
          contentEnd: Math.max(open.contentStart, offset - 1),
        });
        open = null;
      }
    } else {
      const fence = /^( {0,3})(`{3,}|~{3,})/.exec(line);
      if (fence?.[2]) {
        open = {
          marker: fence[2],
          indent: fence[1] ?? "",
          start: offset,
          contentStart: offset + line.length + 1,
        };
      }
    }
    offset += line.length + 1;
  }
  // An unclosed fence runs to the end, as it renders.
  if (open) {
    const end = text.length;
    fences.push({ ...open, end, contentStart: Math.min(open.contentStart, end), contentEnd: end });
  }
  return fences;
}

/**
 * Code the sanitizer would change: anything it could read as a tag or an
 * entity, and the `::` that `safePrMarkdown` escapes at the start of a line.
 */
const SANITIZER_CHANGES = /[<>&]|^::/m;

/** Stands in for a piece of code: private-use characters, which nothing reads as Markdown or HTML. */
const token = (index: number) => `\uE000${index}\uE001`;
const TOKEN = /\uE000(\d+)\uE001/g;

/** A code span's contents as CommonMark reads them: one line, and one space of padding dropped. */
function spanText(raw: string): string {
  const text = raw.replace(/\r?\n/g, " ");
  return /^ .* $/s.test(text) && text.trim() ? text.slice(1, -1) : text;
}

/** A fence's contents, less the indentation its opening fence had. */
function fenceText(raw: string, indent: number): string {
  if (!indent) return raw;
  const leading = new RegExp(`^ {0,${indent}}`, "gm");
  return raw.replace(leading, "");
}

interface Replacement {
  start: number;
  end: number;
  with: string;
}

/** The code spans in a stretch of text with no fences in it. */
function spanReplacements(
  text: string,
  from: number,
  to: number,
  code: string[],
  out: Replacement[],
) {
  const runs = /`+/g;
  runs.lastIndex = from;
  for (let run = runs.exec(text); run && run.index < to; run = runs.exec(text)) {
    let start = run.index;
    let length = run[0].length;
    // A backslash before the run escapes its first backtick.
    let slashes = 0;
    while (text[start - 1 - slashes] === "\\") slashes++;
    if (slashes % 2 === 1) {
      start++;
      length--;
      if (length === 0) continue;
    }
    // The span closes at the next run of exactly as many backticks, within the paragraph.
    const closing = new RegExp(`(?<!\`)\`{${length}}(?!\`)`, "g");
    closing.lastIndex = start + length;
    const close = closing.exec(text);
    if (!close || close.index >= to) continue;
    const contents = text.slice(start + length, close.index);
    if (/\n[ \t]*\n/.test(contents)) continue;
    if (SANITIZER_CHANGES.test(contents)) {
      out.push({ start: start + length, end: close.index, with: token(code.length) });
      code.push(spanText(contents));
    }
    runs.lastIndex = close.index + length;
  }
}

/**
 * Sets the code in `markdown` aside, each piece behind a token, for the
 * sanitizer to pass over: it reads the Markdown as HTML, so it took a `<Foo>`
 * between backticks for a tag and dropped it, and wrote `&&` back out as
 * `&amp;&amp;`, which code shows as written. `restore` puts the code back
 * into the parsed tree.
 *
 * Only ever as text: a token is replaced in text nodes, which React escapes,
 * and never in an attribute or anything parsed again. Where this reads code
 * that Comark doesn't (a backtick inside raw HTML, say), the original shows
 * as plain text rather than rendering unsanitized.
 */
export function shieldCode(markdown: string): {
  text: string;
  restore: (nodes: Node[]) => Node[];
} {
  const code: string[] = [];
  const replacements: Replacement[] = [];
  let from = 0;
  for (const fence of findFences(markdown)) {
    spanReplacements(markdown, from, fence.start, code, replacements);
    const contents = markdown.slice(fence.contentStart, fence.contentEnd);
    if (contents && SANITIZER_CHANGES.test(contents)) {
      // Indented as the fence is, so a fence in a list item stays in it.
      replacements.push({
        start: fence.contentStart,
        end: fence.contentEnd,
        with: fence.indent + token(code.length),
      });
      code.push(fenceText(contents, fence.indent.length));
    }
    from = fence.end;
  }
  spanReplacements(markdown, from, markdown.length, code, replacements);
  if (code.length === 0) return { text: markdown, restore: (nodes) => nodes };

  let text = "";
  let at = 0;
  for (const { start, end, with: replacement } of replacements) {
    text += markdown.slice(at, start) + replacement;
    at = end;
  }
  text += markdown.slice(at);

  const restoreNode = (node: Node): Node => {
    if (typeof node === "string") {
      return node.replace(TOKEN, (token, index: string) => code[Number(index)] ?? token);
    }
    // Comments, and every element's attributes, keep their tokens.
    if (node[0] === null) return node;
    const [tag, attrs, ...children] = node;
    return [tag, attrs, ...children.map(restoreNode)];
  };
  return { text, restore: (nodes) => nodes.map(restoreNode) };
}
