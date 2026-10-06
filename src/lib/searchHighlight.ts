import { matchOffsets, type SearchOptions } from "./textSearch";

/** Paint matches without changing React's DOM, including text split by Markdown formatting. */
export function highlightSearch(element: HTMLElement, query: string, options: SearchOptions) {
  if (!("highlights" in CSS) || typeof Highlight === "undefined") return () => {};
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest("textarea, input, script, style, [aria-hidden='true']")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: { node: Text; start: number; end: number }[] = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const start = text.length;
    text += node.textContent ?? "";
    nodes.push({ node: node as Text, start, end: text.length });
  }
  const ranges: Range[] = [];
  for (const offset of matchOffsets(text, query, options)) {
    const first = nodes.find((node) => node.start <= offset && node.end > offset);
    const last = nodes.find(
      (node) => node.start < offset + query.length && node.end >= offset + query.length,
    );
    if (!first || !last) continue;
    const range = new Range();
    range.setStart(first.node, offset - first.start);
    range.setEnd(last.node, offset + query.length - last.start);
    ranges.push(range);
  }
  const highlight = new Highlight(...ranges);
  CSS.highlights.set("review-search", highlight);
  return () => {
    if (CSS.highlights.get("review-search") === highlight) CSS.highlights.delete("review-search");
  };
}
