/**
 * Workarounds for places where Comark's output differs from what GitHub
 * renders for the same Markdown.
 */
import type { ComarkPlugin, ElementNode, Node } from "comark";
import { visit } from "comark/utils";

function isInlineHtml(node: Node): node is ElementNode {
  return (
    Array.isArray(node) &&
    typeof node[0] === "string" &&
    node[1].$?.html === 1 &&
    node[1].$?.block === 0
  );
}

let decoder: HTMLTextAreaElement | null = null;

/** A textarea's contents are text, so this resolves references and parses nothing else. */
function decodeEntities(value: string): string {
  if (!value.includes("&")) return value;
  decoder ??= document.createElement("textarea");
  decoder.innerHTML = value;
  return decoder.value;
}

/**
 * Comark reads inline HTML (a tag inside a paragraph or a table cell) without
 * decoding character references, so `<img src="…?a=1&amp;b=2">` requests
 * `&amp;b=2` and the server rejects it. Sanitized input always arrives that
 * way, since DOMPurify writes every `&` in an attribute back out as `&amp;`.
 * This decodes inline HTML's attributes once, as a browser would, which gives
 * back exactly the values DOMPurify checked.
 *
 * Block HTML is decoded by Comark already and left alone here: decoding it a
 * second time would turn `&amp;#106;` into `j`, and so a URL DOMPurify passed
 * as harmless into one it never saw.
 */
export function inlineHtmlEntities(): ComarkPlugin {
  return {
    name: "inline-html-entities",
    post(state) {
      visit(state.tree, isInlineHtml, (node) => {
        const attrs = (node as ElementNode)[1];
        for (const key of Object.keys(attrs)) {
          const value = attrs[key];
          if (key !== "$" && typeof value === "string") attrs[key] = decodeEntities(value);
        }
      });
    },
  };
}

function isEmptyComponent(node: Node): boolean {
  return (
    Array.isArray(node) &&
    node[0] === "component" &&
    node.length === 2 &&
    Object.keys(node[1]).every((key) => key === "$")
  );
}

/**
 * Comark leaves an empty `component` element wherever a link reference
 * definition (`[label]: url`) stood, which React then warns about as an
 * unknown tag. GitHub renders nothing there, and bots lean on that: Vercel
 * hides its deployment metadata in a `[vc]: #…` definition. User Markdown
 * cannot ask for components (see `safePrMarkdown`), so an empty one is always
 * this leftover.
 */
export function dropReferenceDefinitions(): ComarkPlugin {
  return {
    name: "drop-reference-definitions",
    post(state) {
      visit(state.tree, isEmptyComponent, () => false);
    },
  };
}

/** A block-level `<details>`, cut out of the Markdown around it. */
interface DetailsBlock {
  open: boolean;
  /** The summary's contents, as written. */
  summary: string;
  /** Everything after the summary, as Markdown of its own. */
  body: string;
}

const DETAILS_OPEN = /^ {0,3}<details\b([^>]*)>/gim;
const DETAILS_TAG = /<(\/?)details\b[^>]*>/gi;
const SUMMARY = /^\s*<summary\b[^>]*>([\s\S]*?)<\/summary>/i;
const WRAPPING_P = /^\s*<p>[ \t]*\n([\s\S]*)\n[ \t]*<\/p>\s*$/i;

/** Where fenced code sits, as `[start, end)` offsets: a tag in there is code. */
function fencedRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let open: { marker: string; start: number } | null = null;
  let offset = 0;
  for (const line of text.split("\n")) {
    if (open) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
      if (close && close[0] === open.marker[0] && close.length >= open.marker.length) {
        ranges.push([open.start, offset + line.length]);
        open = null;
      }
    } else {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) open = { marker, start: offset };
    }
    offset += line.length + 1;
  }
  // An unclosed fence runs to the end, as it renders.
  if (open) ranges.push([open.start, text.length]);
  return ranges;
}

const inFence = (fences: [number, number][], index: number) =>
  fences.some(([start, end]) => index >= start && index < end);

/** The `</details>` that closes the one opened just before `from`. */
function matchingClose(text: string, from: number, fences: [number, number][]) {
  const tags = new RegExp(DETAILS_TAG);
  tags.lastIndex = from;
  let depth = 1;
  for (let tag = tags.exec(text); tag; tag = tags.exec(text)) {
    if (inFence(fences, tag.index)) continue;
    depth += tag[1] ? -1 : 1;
    if (depth === 0) return { start: tag.index, end: tag.index + tag[0].length };
  }
  return null;
}

/**
 * Linear folds a whole issue into one `<p>`, with blank lines inside it, which
 * on GitHub the browser closes as soon as a heading or a list starts. What it
 * holds is Markdown, so the wrapper goes, unless it isn't the only paragraph.
 */
function unwrapParagraph(body: string): string {
  const wrapped = WRAPPING_P.exec(body);
  return wrapped?.[1] !== undefined && !/<\/?p\b/i.test(wrapped[1]) ? wrapped[1] : body;
}

/** The text around each block-level `<details>`, and the blocks themselves. */
function splitDetails(text: string): (string | DetailsBlock)[] {
  const fences = fencedRanges(text);
  const parts: (string | DetailsBlock)[] = [];
  const opens = new RegExp(DETAILS_OPEN);
  let from = 0;
  for (let open = opens.exec(text); open; open = opens.exec(text)) {
    if (inFence(fences, open.index)) continue;
    const close = matchingClose(text, open.index + open[0].length, fences);
    // Never closed: left to Comark, as it was.
    if (!close) break;
    const inner = text.slice(open.index + open[0].length, close.start);
    const summary = SUMMARY.exec(inner);
    parts.push(text.slice(from, open.index), {
      open: /\bopen\b/i.test(open[1] ?? ""),
      summary: summary?.[1] ?? "Details",
      body: unwrapParagraph(summary ? inner.slice(summary[0].length) : inner),
    });
    from = close.end;
    opens.lastIndex = from;
  }
  parts.push(text.slice(from));
  return parts;
}

/** A summary is a line of inline content, and parsed alone it comes back as a paragraph. */
function inlineContent(nodes: Node[]): Node[] {
  const [only] = nodes;
  return nodes.length === 1 && Array.isArray(only) && only[0] === "p"
    ? (only.slice(2) as Node[])
    : nodes;
}

/**
 * Parses Markdown with its `<details>` blocks holding what they hold. Comark
 * ends an HTML block at a blank line, as Markdown does, then closes the tags
 * it left open, so `<details><summary>…</summary>` and a blank line came out
 * as an empty box with its contents rendered after it, always showing. GitHub
 * hands the raw HTML to the browser instead, which nests the Markdown between
 * the tags. Here each block's summary and body are parsed on their own (nested
 * blocks included) and put back together as one element, so they render
 * through the same components as everything else.
 */
export async function parseWithDetails(
  text: string,
  parse: (markdown: string) => Promise<{ nodes: Node[] }>,
): Promise<Node[]> {
  const parts = splitDetails(text);
  if (parts.length === 1) return (await parse(text)).nodes;
  const nodes = await Promise.all(
    parts.map(async (part): Promise<Node[]> => {
      if (typeof part === "string") return part.trim() ? (await parse(part)).nodes : [];
      const [summary, body] = await Promise.all([
        parseWithDetails(part.summary, parse),
        parseWithDetails(part.body, parse),
      ]);
      const details: ElementNode = [
        "details",
        part.open ? { open: true } : {},
        ["summary", {}, ...inlineContent(summary)],
        ...body,
      ];
      return [details];
    }),
  );
  return nodes.flat();
}
