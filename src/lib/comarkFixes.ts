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
