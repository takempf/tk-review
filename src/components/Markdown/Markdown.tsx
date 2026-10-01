import { MarkdownDocument } from "@comark/react";
import { createMarkdownParser, type MarkdownDocument as ParsedMarkdown } from "comark";
import emoji from "comark/plugins/emoji";
import footnotes from "comark/plugins/footnotes";
import DOMPurify from "dompurify";
import {
  Children,
  Fragment,
  type HTMLAttributes,
  type ImgHTMLAttributes,
  isValidElement,
  type ReactNode,
  type SourceHTMLAttributes,
  Suspense,
  use,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Checkbox, Code, CodeBlock, cx } from "tk-design-system";
import { gitApi } from "../../ipc/git";
import {
  dropReferenceDefinitions,
  inlineHtmlEntities,
  parseWithDetails,
} from "../../lib/comarkFixes";
import { shieldCode } from "../../lib/markdownCode";
import css from "./Markdown.module.css";

/**
 * GitHub-flavoured Markdown, for PR descriptions and comments and for what the
 * agents write. It brings its own spacing, the same everywhere (see the CSS);
 * each place that shows it sets its type, colour and padding through
 * `className`.
 */

/** Comark enables GFM tables, strikethrough, autolinks, task lists, and alerts
 * by default. These plugins round it out with GitHub's emoji and footnotes, and
 * work around where Comark renders the same Markdown differently (see
 * comarkFixes.ts). */
const GITHUB_MARKDOWN_PLUGINS = [
  emoji(),
  footnotes(),
  inlineHtmlEntities(),
  dropReferenceDefinitions(),
];

// PR descriptions and comments are third-party input. GitHub allows a useful
// subset of HTML, so sanitize that subset before letting Comark parse it. This
// preserves common bot output (`<a>`, `<picture>`, tables, details) without
// allowing executable or embedded content.
const GITHUB_HTML_OPTIONS = {
  ALLOWED_TAGS: [
    "a",
    "abbr",
    "b",
    "blockquote",
    "br",
    "code",
    "dd",
    "del",
    "details",
    "div",
    "dl",
    "dt",
    "em",
    "figcaption",
    "figure",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "i",
    "img",
    "ins",
    "kbd",
    "li",
    "mark",
    "ol",
    "p",
    "picture",
    "pre",
    "s",
    "samp",
    "small",
    "source",
    "span",
    "strong",
    "sub",
    "summary",
    "sup",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "u",
    "ul",
    "var",
  ],
  ALLOWED_ATTR: [
    "align",
    "alt",
    "colspan",
    "height",
    "href",
    "id",
    "loading",
    "media",
    "open",
    "rel",
    "rowspan",
    "src",
    "srcset",
    "target",
    "title",
    "type",
    "width",
  ],
  FORBID_ATTR: ["style"],
};
const GITHUB_MARKDOWN_OPTIONS = { html: true };

const GITHUB_ATTACHMENT_URL =
  /^https:\/\/github\.com\/user-attachments\/assets\/[a-f\d-]+(?:[?#].*)?$/i;

function GitHubImage({ src, alt, ...props }: ImgHTMLAttributes<HTMLImageElement>) {
  // Comark hands an empty attribute (`alt=""`) over as `true`.
  const altText = typeof alt === "string" ? alt : "";
  const [resolvedSrc, setResolvedSrc] = useState(src);
  // Which address failed, so the fetched attachment that replaces it still
  // gets its chance to load.
  const [failedSrc, setFailedSrc] = useState<string | undefined>();

  useEffect(() => {
    setResolvedSrc(src);
    if (!src || !GITHUB_ATTACHMENT_URL.test(src)) return;

    let cancelled = false;
    void gitApi
      .getGitHubImage(src)
      .then(({ contentType, data }) => {
        if (!cancelled) setResolvedSrc(`data:${contentType};base64,${data}`);
      })
      .catch(() => {
        // Keep the original URL as a fallback; if that fails too, the image
        // gives way to its alt text below.
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  // A broken image says nothing a reader can use (WebKit draws a "?" box), so
  // it gives way to its alt text, or to nothing when it was decorative.
  if (failedSrc !== undefined && failedSrc === resolvedSrc) {
    return altText ? <span>{altText}</span> : null;
  }
  return (
    <img {...props} alt={altText} src={resolvedSrc} onError={() => setFailedSrc(resolvedSrc)} />
  );
}

/** Comark passes `srcset` through as written, where React only knows `srcSet`. */
function GitHubSource({
  srcset,
  ...props
}: SourceHTMLAttributes<HTMLSourceElement> & { srcset?: string }) {
  return <source {...props} srcSet={srcset ?? props.srcSet} />;
}

/**
 * A `<picture>` that drops its `<source>`s when the one chosen fails, leaving
 * the `<img>` inside to load its own `src`. Bots ship a variant per colour
 * scheme, and a dead dark one would otherwise break the image outright in a
 * dark-only app. React's `onError` bubbles, so the image's failure lands here.
 */
function GitHubPicture({ children, ...props }: HTMLAttributes<HTMLElement>) {
  const [sourcesFailed, setSourcesFailed] = useState(false);
  const shown = sourcesFailed
    ? Children.toArray(children).filter(
        (child) => !isValidElement(child) || child.type !== GitHubSource,
      )
    : children;
  return (
    <picture {...props} onError={() => setSourcesFailed(true)}>
      {/* Keyed so the image mounts afresh, forgetting the failure it just had. */}
      <Fragment key={sourcesFailed ? "img" : "sources"}>{shown}</Fragment>
    </picture>
  );
}

/** The text inside rendered Markdown, however deeply it is wrapped. */
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

/**
 * A fenced block (or a raw `<pre>`), as the design system's code block: its
 * copy button, and highlighting for the languages it knows. Any other language
 * reads as plain text, as it did before.
 */
function MarkdownCodeBlock({ language, children }: { language?: string; children?: ReactNode }) {
  return <CodeBlock code={textOf(children)} language={language} />;
}

/**
 * A task list's box, as the design system's checkbox. Read-only, as on GitHub
 * for anyone but the author: ticking it here could not change the Markdown.
 * The sanitizer drops raw `<input>`s, so task lists are the only source.
 */
function TaskCheckbox({ checked }: { checked?: boolean }) {
  return <Checkbox checked={checked === true} readOnly className="task-list-item-checkbox" />;
}

const GITHUB_MARKDOWN_COMPONENTS = {
  img: GitHubImage,
  picture: GitHubPicture,
  source: GitHubSource,
  code: Code,
  pre: MarkdownCodeBlock,
  input: TaskCheckbox,
};

function safePrMarkdown(markdown: string): string {
  // Comark's `::component` extension is not part of GitHub Markdown. Escape
  // it so third-party content cannot request arbitrary React/HTML elements.
  const withoutComponents = markdown.replace(/^::/gm, "\\::");
  return String(DOMPurify.sanitize(withoutComponents, GITHUB_HTML_OPTIONS));
}

const parseMarkdown = createMarkdownParser({
  ...GITHUB_MARKDOWN_OPTIONS,
  plugins: GITHUB_MARKDOWN_PLUGINS,
});

async function parseGitHubMarkdown(markdown: string): Promise<ParsedMarkdown> {
  // Code is set aside while the rest is sanitized as HTML, so a `<Foo>` in
  // backticks stays code rather than being dropped as a tag (markdownCode.ts).
  const { text, restore } = shieldCode(markdown);
  const nodes = await parseWithDetails(safePrMarkdown(text), parseMarkdown);
  return { nodes: restore(nodes), frontmatter: {}, meta: {} };
}

function Parsed({ parsing, className }: { parsing: Promise<ParsedMarkdown>; className?: string }) {
  return (
    <MarkdownDocument
      value={use(parsing)}
      components={GITHUB_MARKDOWN_COMPONENTS}
      className={cx(css.markdown, className)}
    />
  );
}

/**
 * Parses, newest last, kept so a screen coming back (or a thread re-rendering)
 * finds its Markdown already parsed: `use` reads a settled parse at once, so
 * it renders in the same commit rather than after a Suspense round trip.
 */
const PARSED = new Map<string, Promise<ParsedMarkdown>>();
const PARSED_LIMIT = 300;

function parsed(markdown: string): Promise<ParsedMarkdown> {
  const cached = PARSED.get(markdown);
  if (cached) {
    PARSED.delete(markdown);
    PARSED.set(markdown, cached);
    return cached;
  }
  const parsing = parseGitHubMarkdown(markdown);
  PARSED.set(markdown, parsing);
  // A failed parse is tried again next time rather than remembered.
  parsing.catch(() => PARSED.delete(markdown));
  const oldest = PARSED.keys().next().value;
  if (PARSED.size > PARSED_LIMIT && oldest !== undefined) PARSED.delete(oldest);
  return parsing;
}

export function GitHubMarkdown({ markdown, className }: { markdown: string; className?: string }) {
  const parsing = useMemo(() => parsed(markdown), [markdown]);
  // While a new parse is pending the last one stays up, rather than blanking.
  const shown = useDeferredValue(parsing);
  return (
    <Suspense fallback={null}>
      <Parsed parsing={shown} className={className} />
    </Suspense>
  );
}
