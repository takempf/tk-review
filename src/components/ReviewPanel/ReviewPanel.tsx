import { MarkdownClient } from "@comark/react";
import emoji from "comark/plugins/emoji";
import footnotes from "comark/plugins/footnotes";
import DOMPurify from "dompurify";
import {
  Children,
  Fragment,
  isValidElement,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Button,
  Checkbox,
  Icon,
  Popover,
  Radio,
  RadioGroup,
  Select,
  Tabs,
  Tooltip,
} from "tk-design-system";
import {
  type EngineModels,
  gitApi,
  type PrContext,
  type ReviewComment,
  type ReviewEngine,
  type ReviewFinding,
  type ReviewResult,
  type ReviewVerdict,
} from "../../ipc/git";
import { dropReferenceDefinitions, inlineHtmlEntities } from "../../lib/comarkFixes";
import { splitPath } from "../../lib/fileChange";
import { findingLines, formatLines, type LineSpan } from "../../lib/lineSpan";
import { postBodyForFinding, postLocationForFinding } from "../../lib/prComment";
import { absoluteTime, shortTime } from "../../lib/time";
import {
  CONCLUSION_POST_KEY,
  findingThreadKey,
  REVIEW_THREAD_KEY,
  type ResolvedFinding,
  resolutionThreadKey,
  type StoredReview,
  useReviewStore,
} from "../../store/reviewStore";
import { Combobox } from "../Combobox/Combobox";
import { CopyButton } from "../CopyButton/CopyButton";
import { Fold } from "../Fold/Fold";
import { ReviewLoader } from "../ReviewLoader/ReviewLoader";
import { Skeleton, SkeletonGroup } from "../Skeleton/Skeleton";
import { Spinner } from "../Spinner/Spinner";
import { Textarea } from "../Textarea/Textarea";
import css from "./ReviewPanel.module.css";

const ENGINE_LABELS: Record<ReviewEngine, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

const ENGINE_OPTIONS = (Object.keys(ENGINE_LABELS) as ReviewEngine[]).map((engine) => ({
  value: engine,
  label: ENGINE_LABELS[engine],
}));

/**
 * Fallback when the CLI has no cached catalog on disk (see `useAgentModels`).
 * Suggestions only — the field is free text, and empty means the CLI's own
 * configured default, so a stale list here never blocks a newer model. The
 * claude aliases always resolve to that line's latest model.
 */
const MODEL_SUGGESTIONS: Record<ReviewEngine, string[]> = {
  claude: ["fable", "opus", "sonnet", "haiku"],
  codex: [
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.6",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.3-codex",
    "gpt-5.2-codex",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
  ],
};

/**
 * Fallback for what each CLI's effort switch accepts: `claude --effort` and
 * codex's `model_reasoning_effort` config. Empty means the CLI's own default.
 */
const EFFORT_LEVELS: Record<ReviewEngine, string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
};

type Catalogs = Partial<Record<ReviewEngine, EngineModels>>;

/** Read once per app load; the panel can remount without re-reading the files. */
let catalogsPromise: Promise<Catalogs> | null = null;

function loadCatalogs(): Promise<Catalogs> {
  catalogsPromise ??= Promise.all(
    (Object.keys(ENGINE_LABELS) as ReviewEngine[]).map(async (engine) => {
      // A failed read is the same as no cache: the built-in list stands in.
      const catalog = await gitApi.listAgentModels(engine).catch(() => null);
      return [engine, catalog] as const;
    }),
  ).then((entries) => {
    const catalogs: Catalogs = {};
    for (const [engine, catalog] of entries) if (catalog) catalogs[engine] = catalog;
    return catalogs;
  });
  return catalogsPromise;
}

/**
 * Model and effort choices for the engine: what its CLI last fetched from the
 * service, so the picker keeps pace with the installed CLI rather than with
 * this app's release. Until the read lands, or when there is no cache, the
 * built-in fallback lists apply.
 */
function useAgentModels(engine: ReviewEngine) {
  const [catalogs, setCatalogs] = useState<Catalogs>({});
  useEffect(() => {
    let cancelled = false;
    void loadCatalogs().then((loaded) => {
      if (!cancelled) setCatalogs(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const catalog = catalogs[engine];
  return {
    fromCatalog: catalog !== undefined,
    models: catalog?.models.map((model) => model.id) ?? MODEL_SUGGESTIONS[engine],
    efforts: catalog?.efforts ?? EFFORT_LEVELS[engine],
  };
}

/** Severities the model is asked to use; anything else falls back to neutral. */
const SEVERITY_CLASS: Record<string, string | undefined> = {
  critical: "critical",
  warning: "warning",
  suggestion: "suggestion",
  nit: "nit",
};

function severityClass(severity: string): string {
  const key = SEVERITY_CLASS[severity.toLowerCase()] ?? "neutral";
  return css[`severity_${key}`] ?? "";
}

/** Statuses the re-review is asked to use; anything else falls back to neutral. */
const RESOLUTION_CLASS: Record<string, string | undefined> = {
  addressed: "addressed",
  unaddressed: "unaddressed",
  partial: "partial",
  obsolete: "obsolete",
};

function resolutionClass(status: string): string {
  const key = RESOLUTION_CLASS[status.toLowerCase()] ?? "neutral";
  return css[`status_${key}`] ?? "";
}

/** GitHub's order and wording for finishing a review. */
const VERDICTS: { value: ReviewVerdict; label: string; noun: string; done: string }[] = [
  { value: "comment", label: "Comment", noun: "a comment", done: "Commented" },
  { value: "approve", label: "Approve", noun: "an approval", done: "Approved" },
  {
    value: "request_changes",
    label: "Request changes",
    noun: "a request for changes",
    done: "Requested changes",
  },
];

/** The agent's verdict when it is one GitHub knows; `null` for anything else. */
function knownVerdict(verdict: string | undefined): ReviewVerdict | null {
  const key = verdict
    ?.trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return VERDICTS.find((option) => option.value === key)?.value ?? null;
}

/** Stable fallback: a fresh `[]` from a selector re-renders forever. */
const EMPTY_THREAD: ReviewComment[] = [];
const TAB_KEY = "tk-review:review-panel:tab";
type PanelTab = "pr" | "ai";
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

function GitHubImage({ src, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) {
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
}: React.SourceHTMLAttributes<HTMLSourceElement> & { srcset?: string }) {
  return <source {...props} srcSet={srcset ?? props.srcSet} />;
}

/**
 * A `<picture>` that drops its `<source>`s when the one chosen fails, leaving
 * the `<img>` inside to load its own `src`. Bots ship a variant per colour
 * scheme, and a dead dark one would otherwise break the image outright in a
 * dark-only app. React's `onError` bubbles, so the image's failure lands here.
 */
function GitHubPicture({ children, ...props }: React.HTMLAttributes<HTMLElement>) {
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

function safePrMarkdown(markdown: string): string {
  // Comark's `::component` extension is not part of GitHub Markdown. Escape
  // it so third-party content cannot request arbitrary React/HTML elements.
  const withoutComponents = markdown.replace(/^::/gm, "\\::");
  return String(DOMPurify.sanitize(withoutComponents, GITHUB_HTML_OPTIONS));
}

function GitHubMarkdown({ markdown, className }: { markdown: string; className?: string }) {
  return (
    <MarkdownClient
      className={className}
      value={safePrMarkdown(markdown)}
      options={GITHUB_MARKDOWN_OPTIONS}
      plugins={GITHUB_MARKDOWN_PLUGINS}
      components={{ img: GitHubImage, picture: GitHubPicture, source: GitHubSource }}
    />
  );
}

function persistedTab(): PanelTab {
  try {
    return localStorage.getItem(TAB_KEY) === "pr" ? "pr" : "ai";
  } catch {
    return "ai";
  }
}

function PrRefreshButton() {
  const refreshPr = useReviewStore((state) => state.refreshPr);
  const refreshingPr = useReviewStore((state) => state.refreshingPr);
  // The header's Refresh does the same work when a PR is open; don't offer a
  // second run while either one is still going.
  const loadingDiff = useReviewStore((state) => state.loadingDiff);
  const openingPr = useReviewStore((state) => state.openingPr);
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => void refreshPr()}
      disabled={refreshingPr || loadingDiff || openingPr}
      title="Refresh pull request details and discussion"
    >
      {refreshingPr || loadingDiff ? (
        <>
          <Spinner /> Refreshing…
        </>
      ) : (
        <>
          <Icon name="refresh" /> Refresh
        </>
      )}
    </Button>
  );
}

function PrSection({ pr }: { pr: PrContext }) {
  const selectFile = useReviewStore((state) => state.selectFile);
  const prHeadMoved = useReviewStore((state) => state.prHeadMoved);
  const topLevel = pr.comments.filter((comment) => !comment.path);
  const inlineByPath = useMemo(() => {
    const groups = new Map<string, PrContext["comments"]>();
    for (const comment of pr.comments) {
      if (!comment.path) continue;
      groups.set(comment.path, [...(groups.get(comment.path) ?? []), comment]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [pr.comments]);

  return (
    <div className={css.prBody}>
      <div className={css.prHeader}>
        <div className={`${css.itemHead} ${css.titleHead}`}>
          <p className={css.prName}>{pr.title}</p>
          {pr.body ? <CopyButton text={pr.body} label="Copy description" /> : null}
        </div>
        <a className={css.prLink} href={pr.url} target="_blank" rel="noreferrer">
          #{pr.number} on GitHub <Icon name="external" />
        </a>
        {prHeadMoved ? (
          <p className={css.prMoved}>PR has new commits; the comparison was refreshed.</p>
        ) : null}
      </div>
      {pr.body ? (
        <GitHubMarkdown markdown={pr.body} className={css.prMarkdown} />
      ) : (
        <p className={css.muted}>No description.</p>
      )}
      {topLevel.length > 0 ? (
        <div className={css.prDiscussion}>
          <p className={css.subheading}>Conversation</p>
          {topLevel.map((comment) => (
            <div key={comment.id}>
              <div className={css.itemHead}>
                <span className={css.prAuthor}>@{comment.author}</span>
                <CopyButton text={comment.body} label="Copy comment" />
              </div>
              <GitHubMarkdown markdown={comment.body} className={css.prCommentMarkdown} />
            </div>
          ))}
        </div>
      ) : null}
      {inlineByPath.length > 0 ? (
        <div className={css.prDiscussion}>
          <p className={css.subheading}>Inline comments</p>
          {inlineByPath.map(([path, comments]) => (
            <div className={css.inlineGroup} key={path}>
              <button type="button" className={css.inlinePath} onClick={() => selectFile(path)}>
                {path}
              </button>
              {comments.map((comment) => (
                <div key={comment.id}>
                  <div className={css.itemHead}>
                    <span className={css.prAuthor}>
                      @{comment.author}
                      {comment.line != null ? ` · line ${comment.line}` : ""}
                      {comment.outdated ? " · outdated" : ""}
                    </span>
                    <CopyButton text={comment.body} label="Copy comment" />
                  </div>
                  <GitHubMarkdown markdown={comment.body} className={css.prCommentMarkdown} />
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Who wrote a review or explanation and when, for the small print under its heading. */
function Provenance({
  engine,
  model,
  effort,
  createdAt,
  note,
}: {
  engine: ReviewEngine;
  model?: string | null;
  effort?: string | null;
  createdAt: string;
  note?: string;
}) {
  const parts = [
    ENGINE_LABELS[engine] ?? engine,
    model,
    effort ? `${effort} effort` : null,
    shortTime(createdAt),
    note,
  ];
  return (
    <p className={css.provenance} title={absoluteTime(createdAt)}>
      {parts.filter(Boolean).join(" · ")}
    </p>
  );
}

/**
 * A titled block of the AI review column. Collapsible, because the column
 * stacks several long things and the one you want is often the last: folding
 * the explanation away is how you reach the findings under it. Folded content
 * stays mounted, so a half-written question survives.
 */
function Section({
  title,
  count,
  reveal = false,
  children,
}: {
  title: string;
  count?: number;
  /** Part of a review's result, so it takes part in `useRevealInOrder`. */
  reveal?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className={css.section} data-reveal-frame={reveal || undefined}>
      <button
        type="button"
        className={css.sectionHeading}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        data-reveal={reveal || undefined}
      >
        <Icon name={open ? "chevron-down" : "chevron-right"} />
        {title}
        {count != null ? <span className={css.sectionCount}>{count}</span> : null}
      </button>
      <div className={css.sectionBody} hidden={!open} data-reveal={reveal || undefined}>
        {children}
      </div>
    </section>
  );
}

/** Sorts last; `FindingLocation` gives it no jump link, having nowhere to jump. */
const NOT_IN_DIFF = Number.MAX_SAFE_INTEGER;

/**
 * The plain-language explanation of the change, in the same column as the
 * findings it sits among.
 *
 * Findings and explanations are different kinds of thing — one is a judgement
 * to act on, the other is orientation — so they live in separate sections and
 * never read as one list. Each per-file entry links to its file, which selects
 * it and scrolls the diff surface there, exactly as a finding's path does.
 */
function ExplanationList() {
  const explainMode = useReviewStore((state) => state.explainMode);
  const stored = useReviewStore((state) => state.explanation);
  const explaining = useReviewStore((state) => state.explaining);
  const summary = useReviewStore((state) => state.summary);

  // Diff order, so the explanations read in the order the files are scrolled
  // through. A path the model invented, or one that has since left the diff,
  // sorts last and is shown without a link rather than being dropped — the
  // text is still worth reading, it just has nowhere to jump.
  const files = useMemo(() => {
    const order = new Map((summary?.files ?? []).map((file, index) => [file.path, index]));
    return (stored?.explanation.files ?? [])
      .filter((file) => file.explanation.trim())
      .map((file) => ({ ...file, index: order.get(file.path) ?? NOT_IN_DIFF }))
      .sort((a, b) => a.index - b.index);
  }, [stored, summary]);

  // Turning the mode off hides the explanation without discarding it, so
  // turning it back on costs nothing.
  if (!explainMode || (!stored && !explaining)) return null;
  const stale = stored != null && stored.mergeBase !== (summary?.mergeBase ?? null);
  const fileMarkdown = (file: { path: string; explanation: string }) =>
    `\`${file.path}\`\n\n${file.explanation.trim()}`;

  return (
    <Section title="Explanation">
      {stored ? (
        <div className={css.itemHead}>
          <Provenance
            engine={stored.engine}
            model={stored.model}
            createdAt={stored.createdAt}
            note={stale ? "from an older version of this diff" : undefined}
          />
          <CopyButton
            text={[stored.explanation.overall.trim(), ...files.map(fileMarkdown)].join("\n\n")}
            label="Copy explanation"
          />
        </div>
      ) : null}
      {explaining ? (
        <p className={css.status}>
          <Spinner /> {stored ? "Explaining again…" : "Explaining the change in plain language…"}
        </p>
      ) : null}
      {stored ? (
        <>
          <GitHubMarkdown markdown={stored.explanation.overall} className={css.agentMarkdown} />
          {files.map((file) => (
            <div className={css.explainFile} key={file.path}>
              <div className={css.itemHead}>
                <FindingLocation path={file.path} lines={null} />
                <CopyButton text={fileMarkdown(file)} label="Copy file explanation" />
              </div>
              <GitHubMarkdown markdown={file.explanation} className={css.agentMarkdown} />
            </div>
          ))}
        </>
      ) : null}
    </Section>
  );
}

/**
 * One conversation: its comments, a pending marker while the agent answers,
 * and the input that asks. Only one thread can await a reply at a time.
 *
 * Until there is something to show, the whole thread is one quiet "Ask" in the
 * item's action row, next to whatever `actions` the item brings: an input
 * under every finding is a column of empty boxes. Clicking it opens the input
 * focused, above the row; leaving it empty folds it away again.
 */
function Thread({
  threadKey,
  comments,
  engine,
  placeholder,
  askLabel,
  actions,
}: {
  threadKey: string;
  comments: ReviewComment[];
  engine: ReviewEngine;
  placeholder: string;
  askLabel: string;
  actions?: ReactNode;
}) {
  const [draft, setDraft] = useState("");
  const [asking, setAsking] = useState(false);
  const replyingTo = useReviewStore((state) => state.replyingTo);
  const addComment = useReviewStore((state) => state.addComment);

  const pending = replyingTo === threadKey;
  const busy = replyingTo !== null;
  const canSend = !busy && draft.trim() !== "";
  const open = asking || comments.length > 0 || pending;
  const agent = ENGINE_LABELS[engine] ?? engine;

  function send() {
    if (!canSend) return;
    setDraft("");
    void addComment(threadKey, draft.trim());
  }

  return (
    <>
      {open ? (
        <div className={css.thread}>
          {comments.map((comment) => (
            <div
              key={`${comment.at}:${comment.author}`}
              className={comment.author === "user" ? css.commentUser : css.commentAgent}
            >
              <div className={css.itemHead}>
                <span className={css.commentAuthor}>
                  {comment.author === "user" ? "You" : agent}
                </span>
                <CopyButton text={comment.text} label="Copy message" />
              </div>
              {comment.author === "user" ? (
                <p className={css.commentText}>{comment.text}</p>
              ) : (
                <GitHubMarkdown markdown={comment.text} className={css.agentMarkdown} />
              )}
            </div>
          ))}
          {pending ? (
            <p className={css.commentPending}>
              <Spinner /> Waiting for {agent}…
            </p>
          ) : null}
          <form
            className={css.commentForm}
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            <Textarea
              className={css.commentInput}
              value={draft}
              onChange={setDraft}
              onSubmit={send}
              submitOn="enter"
              canSubmit={canSend}
              autoFocus={asking && comments.length === 0}
              onBlur={() => {
                if (!draft.trim()) setAsking(false);
              }}
              placeholder={placeholder}
              disabled={busy}
            />
            <button type="submit" className={css.commentSend} disabled={!canSend}>
              <Icon name="send" /> Send
            </button>
          </form>
        </div>
      ) : null}
      {!open || actions ? (
        <div className={css.itemActions}>
          {!open ? (
            <Button
              variant="ghost"
              size="sm"
              className={css.askButton}
              onClick={() => setAsking(true)}
            >
              <Icon name="comment" /> {askLabel}
            </Button>
          ) : null}
          {actions}
        </div>
      ) : null}
    </>
  );
}

/** A deliberate, editable hand-off from an AI finding to a GitHub comment. */
function PrCommentComposer({
  finding,
  patch,
  pr,
  reviewBody,
  postedUrl,
}: {
  finding: ReviewFinding | null;
  patch: string | null;
  pr: PrContext;
  /** The summary body for the review-level thread. */
  reviewBody?: string;
  postedUrl?: string;
}) {
  const location = useMemo(() => postLocationForFinding(finding, patch), [finding, patch]);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [body, setBody] = useState(() => reviewBody ?? postBodyForFinding(finding, location));
  const postingTo = useReviewStore((state) => state.postingTo);
  const postPrComment = useReviewStore((state) => state.postPrComment);
  const targetKey = finding ? findingThreadKey(finding) : REVIEW_THREAD_KEY;
  const busy = postingTo !== null;
  const pending = postingTo === targetKey;
  const requiresConfirmation = pr.state !== "open" && !pr.isDraft;

  function close() {
    setOpen(false);
    setConfirming(false);
  }

  function post() {
    if (requiresConfirmation && !confirming) {
      setConfirming(true);
      return;
    }
    void postPrComment(finding, body, location).then((posted) => {
      // Failures stay visible in the review panel and leave the editable draft
      // intact; a successful response leaves behind the GitHub permalink.
      if (posted) close();
    });
  }

  return (
    <div className={css.prComposer}>
      {!open ? (
        <Button size="sm" onClick={() => setOpen(true)} disabled={busy}>
          <Icon name="send" /> {postedUrl ? "Post again" : "Send to PR"}
        </Button>
      ) : null}
      {postedUrl ? (
        <a className={css.postedLink} href={postedUrl} target="_blank" rel="noreferrer">
          Posted to PR <Icon name="external" />
        </a>
      ) : null}
      {open ? (
        <div className={css.composerEditor}>
          <Textarea
            className={css.composerInput}
            value={body}
            onChange={setBody}
            onSubmit={post}
            canSubmit={!busy && body.trim() !== ""}
            disabled={busy}
            ariaLabel="Pull request comment"
          />
          <p className={css.composerNote}>{location.note}</p>
          {confirming ? (
            <p className={css.composerWarning}>
              This PR is {pr.isDraft ? "a draft" : pr.state}. Post anyway?
            </p>
          ) : null}
          <div className={css.composerActions}>
            <Button variant="primary" size="sm" onClick={post} disabled={busy || !body.trim()}>
              {pending ? (
                <>
                  <Spinner /> Posting…
                </>
              ) : (
                <>
                  <Icon name="send" /> {confirming ? "Post anyway" : "Post"}
                </>
              )}
            </Button>
            <Button variant="ghost" size="sm" onClick={close} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Where a finding or a verdict points, on a line of its own under the title.
 *
 * The path is clipped at its start rather than its end: the file name and the
 * lines are what identify a location, so they are the part that has to survive
 * a narrow panel. The file name is also the bright part, as in the file list.
 * Clicking scrolls the diff surface to those lines and highlights them, not
 * just to the file — a whole-file finding has no lines and lands on the header.
 */
function FindingLocation({ path, lines }: { path: string; lines: LineSpan | null }) {
  const selectFile = useReviewStore((state) => state.selectFile);
  const inDiff = useReviewStore(
    (state) => state.summary?.files.some((file) => file.path === path) ?? false,
  );
  const at = lines ? `:${formatLines(lines)}` : "";
  const { dir, name } = splitPath(path);
  const text = (
    <>
      {dir}
      <span className={css.pathName}>{name}</span>
      {at}
    </>
  );
  const jump = !lines
    ? `Jump to ${path}`
    : lines.end > lines.start
      ? `Jump to ${path} lines ${formatLines(lines)}`
      : `Jump to ${path} line ${lines.start}`;

  return (
    <div className={css.findingLocation}>
      {/* Jumping only works for paths that are actually in the diff surface. */}
      {inDiff ? (
        <button
          type="button"
          className={css.findingPath}
          onClick={() => selectFile(path, lines)}
          title={jump}
        >
          {text}
        </button>
      ) : (
        <span className={css.findingPathPlain} title={`${path}${at}`}>
          {text}
        </span>
      )}
    </div>
  );
}

/**
 * A finding, or a verdict on one, as Markdown to paste elsewhere: the title
 * with its severity or status, where it points, then what the agent said.
 */
function findingMarkdown(finding: ReviewFinding, label: string, text: string): string {
  const lines = findingLines(finding);
  const at = finding.path ? `\`${finding.path}${lines ? `:${formatLines(lines)}` : ""}\`` : "";
  return [`**${label}:** ${finding.title}`, at, text.trim()].filter(Boolean).join("\n\n");
}

/**
 * One prior finding with the re-review's verdict on it. The card mirrors a
 * finding's, but the chip is the verdict rather than the severity — what the
 * reader needs here is "is this done?", not how bad it was the first time.
 * Its comment thread carries over from the finding it judges, under a key of
 * its own so a look-alike new finding cannot inherit it.
 */
function Resolution({ resolution, engine }: { resolution: ResolvedFinding; engine: ReviewEngine }) {
  const { finding, status, note } = resolution;
  const threadKey = resolutionThreadKey(finding);
  const comments = useReviewStore(
    (state) => state.reviews[state.reviewEngine]?.threads[threadKey] ?? EMPTY_THREAD,
  );

  return (
    <li className={css.finding} data-reveal>
      <div className={`${css.itemHead} ${css.titleHead}`}>
        <p className={`${css.findingTitle} ${resolutionClass(status)}`}>
          <span className={css.severity}>{status}</span> {finding.title}
        </p>
        <CopyButton text={findingMarkdown(finding, status, note ?? "")} label="Copy verdict" />
      </div>
      <FindingLocation path={finding.path} lines={findingLines(finding)} />
      {note ? <GitHubMarkdown markdown={note} className={css.agentMarkdown} /> : null}
      <Thread
        threadKey={threadKey}
        comments={comments}
        engine={engine}
        placeholder="Ask about this verdict…"
        askLabel="Ask about this"
      />
    </li>
  );
}

function Finding({
  finding,
  engine,
  patch,
  pr,
}: {
  finding: ReviewFinding;
  engine: ReviewEngine;
  patch: string | null;
  pr: PrContext | null;
}) {
  const threadKey = findingThreadKey(finding);
  const comments = useReviewStore(
    (state) => state.reviews[state.reviewEngine]?.threads[threadKey] ?? EMPTY_THREAD,
  );

  return (
    <li className={css.finding} data-reveal>
      <div className={`${css.itemHead} ${css.titleHead}`}>
        <p className={`${css.findingTitle} ${severityClass(finding.severity)}`}>
          <span className={css.severity}>{finding.severity}</span> {finding.title}
        </p>
        <CopyButton
          text={findingMarkdown(finding, finding.severity, finding.body)}
          label="Copy finding"
        />
      </div>
      <FindingLocation path={finding.path} lines={findingLines(finding)} />
      <GitHubMarkdown markdown={finding.body} className={css.agentMarkdown} />
      <Thread
        threadKey={threadKey}
        comments={comments}
        engine={engine}
        placeholder="Ask about this finding…"
        askLabel="Ask about this"
        actions={
          pr ? (
            <PrCommentComposer
              finding={finding}
              patch={patch}
              pr={pr}
              postedUrl={finding.postedUrl}
            />
          ) : null
        }
      />
    </li>
  );
}

/**
 * How the review ends: the verdict the agent recommends, already selected, over
 * its draft of the review body. Both are the reader's to change before
 * submitting, and the agent's pick keeps a "suggested" mark so an override
 * stays visible. Without a PR there is nowhere to submit, but the verdict still
 * says where the change stands.
 */
function Conclusion({ review, pr }: { review: ReviewResult; pr: PrContext | null }) {
  const suggested = knownVerdict(review.verdict);
  const [verdict, setVerdict] = useState<ReviewVerdict>(suggested ?? "comment");
  const [body, setBody] = useState(review.conclusion ?? "");
  const [confirming, setConfirming] = useState(false);
  const postingTo = useReviewStore((state) => state.postingTo);
  const submitPrReview = useReviewStore((state) => state.submitPrReview);

  const busy = postingTo !== null;
  const pending = postingTo === CONCLUSION_POST_KEY;
  // GitHub takes a bare approval, but nothing else without a body.
  const canSubmit = pr != null && !busy && (verdict === "approve" || body.trim() !== "");
  const requiresConfirmation = pr != null && pr.state !== "open" && !pr.isDraft;
  const submitted = review.submitted;
  const option = VERDICTS.find((item) => item.value === verdict);

  function submit() {
    if (!canSubmit) return;
    if (requiresConfirmation && !confirming) {
      setConfirming(true);
      return;
    }
    void submitPrReview(verdict, body).then((posted) => {
      if (posted) setConfirming(false);
    });
  }

  return (
    <Section title="Conclusion" reveal>
      <RadioGroup
        className={css.verdicts}
        aria-label="Review verdict"
        value={verdict}
        onValueChange={(value) => {
          setVerdict(value as ReviewVerdict);
          setConfirming(false);
        }}
        disabled={busy}
      >
        {VERDICTS.map((item) => (
          <Radio key={item.value} value={item.value}>
            {item.label}
            {item.value === suggested ? <span className={css.suggested}>suggested</span> : null}
          </Radio>
        ))}
      </RadioGroup>
      <Textarea
        className={css.composerInput}
        value={body}
        onChange={setBody}
        onSubmit={submit}
        canSubmit={canSubmit}
        disabled={busy}
        placeholder={verdict === "approve" ? "Optional note for the author" : "Note for the author"}
        ariaLabel="Review conclusion"
      />
      <p className={css.composerNote}>
        {pr
          ? `Submits to #${pr.number} as ${option?.noun ?? "a review"}.`
          : "Only a pull request can take a submitted review."}
      </p>
      {confirming && pr ? (
        <p className={css.composerWarning}>
          This PR is {pr.isDraft ? "a draft" : pr.state}. Submit anyway?
        </p>
      ) : null}
      <div className={css.itemActions}>
        {pr ? (
          <Button variant="primary" size="sm" onClick={submit} disabled={!canSubmit}>
            {pending ? (
              <>
                <Spinner /> Submitting…
              </>
            ) : (
              <>
                <Icon name="send" />{" "}
                {confirming ? "Submit anyway" : submitted ? "Submit again" : "Submit review"}
              </>
            )}
          </Button>
        ) : null}
        {submitted ? (
          <a className={css.postedLink} href={submitted.url} target="_blank" rel="noreferrer">
            {VERDICTS.find((item) => item.value === submitted.verdict)?.done ?? "Submitted"} on
            GitHub <Icon name="external" />
          </a>
        ) : null}
        {/* Without a PR there is nowhere to submit, so this is the way out. */}
        <CopyButton className={css.actionsEnd} text={body} label="Copy conclusion" />
      </div>
    </Section>
  );
}

/** Stands in for the PR's description while it is fetched. */
function PrSkeleton() {
  return (
    <div className={css.prBody}>
      <SkeletonGroup label="Loading the pull request" className={css.prSkeleton}>
        <Skeleton width="70%" />
        <Skeleton width="92%" />
        <Skeleton width="84%" />
        <Skeleton width="56%" />
      </SkeletonGroup>
    </div>
  );
}

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** `--ease-out-expo` in global.css; script animations can't read custom properties. */
const EASE_OUT_EXPO = "cubic-bezier(0.16, 1, 0.3, 1)";
/** How far apart, in ms, each part of a fresh review starts coming in. */
const REVEAL_STAGGER_MS = 70;
/** The previous review's fade-out as a run hands over; `.replacing` in the stylesheet. */
const REPLACE_FADE_MS = 240;

/**
 * Paces a review run in and out. The loader shows while the run goes; when it
 * ends, its shapes leave (`handingOver`) before the result is let through, so
 * the new review never lands under a loader still on its way out.
 *
 * Meanwhile the review on screen (`shown`) fades out — the previous one, on a
 * re-review — and the new one takes its place unseen, while the shapes are
 * still leaving: its Markdown renders asynchronously, and this way it has
 * settled before anything comes in, rather than landing in the middle of it.
 * `revealed` counts results let through, which is what sets off
 * `useRevealInOrder`.
 */
function useRunHandover(running: boolean, rerunning: boolean, stored: StoredReview | null) {
  const [wasRunning, setWasRunning] = useState(running);
  const [handingOver, setHandingOver] = useState(false);
  const [held, setHeld] = useState(false);
  // Fixed for the run, so the status text doesn't change as it ends.
  const [rerun, setRerun] = useState(rerunning);
  // A new run gets a new loader, even one started while the last was leaving.
  const [runId, setRunId] = useState(0);
  const [shown, setShown] = useState(stored);
  const [revealed, setRevealed] = useState(0);

  let holding = held;
  if (running !== wasRunning) {
    setWasRunning(running);
    holding = !running;
    setHandingOver(holding);
    setHeld(holding);
    if (running) {
      setRerun(rerunning);
      setRunId((id) => id + 1);
    }
  }
  if (!holding && shown !== stored) setShown(stored);

  useEffect(() => {
    if (!held) return;
    const timer = setTimeout(() => setHeld(false), REPLACE_FADE_MS);
    return () => clearTimeout(timer);
  }, [held]);

  return {
    handingOver,
    rerun,
    runId,
    shown,
    revealed,
    // Everything the loader drew has gone by now, so it can make way at once.
    shapesLeft: () => {
      if (!handingOver) return;
      setHandingOver(false);
      setHeld(false);
      setRevealed((count) => count + 1);
    },
  };
}

/**
 * Brings a fresh review in piece by piece, top to bottom in reading order: each
 * `[data-reveal]` that starts within view fades up a beat after the one above
 * it. Only the innermost are animated, so a section's findings arrive one by
 * one rather than riding in on their section. A `[data-reveal-frame]` around
 * them — a section, with its dividing rule — draws its border in with its
 * first part. Runs before paint, so nothing is seen fully drawn first.
 */
function useRevealInOrder(ref: RefObject<HTMLElement | null>, revealed: number) {
  useLayoutEffect(() => {
    const root = ref.current;
    if (revealed === 0 || !root || prefersReducedMotion()) return;
    const bottom = root.getBoundingClientRect().bottom;
    const parts = [...root.querySelectorAll<HTMLElement>("[data-reveal]")].filter((part) => {
      if (part.querySelector("[data-reveal]")) return false;
      // Folded-away sections have no box; parts below the fold arrive unseen.
      const box = part.getBoundingClientRect();
      return box.height > 0 && box.top < bottom;
    });
    const timing = (index: number): KeyframeAnimationOptions => ({
      duration: 520,
      delay: index * REVEAL_STAGGER_MS,
      easing: EASE_OUT_EXPO,
      fill: "backwards",
    });
    const animations = parts.map((part, index) =>
      part.animate(
        [
          { opacity: 0, transform: "translateY(8px)" },
          { opacity: 1, transform: "none" },
        ],
        timing(index),
      ),
    );
    for (const frame of root.querySelectorAll<HTMLElement>("[data-reveal-frame]")) {
      const first = parts.findIndex((part) => frame.contains(part));
      if (first === -1) continue;
      // To the frame's own border colour, whatever the stylesheet makes it.
      animations.push(frame.animate([{ borderColor: "transparent" }, {}], timing(first)));
    }
    return () => {
      for (const animation of animations) animation.cancel();
    };
  }, [ref, revealed]);
}

export function ReviewPanel() {
  const pr = useReviewStore((state) => state.pr);
  // A PR opening from the list gets its tab straight away, loading, so the
  // panel doesn't switch tabs under the reader when the PR arrives.
  const hasPr = useReviewStore((state) => state.pr != null || state.pendingPr != null);
  const stored = useReviewStore((state) => state.reviews[state.reviewEngine] ?? null);
  const reviewing = useReviewStore((state) => state.reviewing);
  const reReviewing = useReviewStore((state) => state.reReviewing);
  const reviewError = useReviewStore((state) => state.reviewError);
  const explainMode = useReviewStore((state) => state.explainMode);
  const explaining = useReviewStore((state) => state.explaining);
  const explainError = useReviewStore((state) => state.explainError);
  const reviewEngine = useReviewStore((state) => state.reviewEngine);
  const reviewModel = useReviewStore((state) => state.reviewModel);
  const reviewEffort = useReviewStore((state) => state.reviewEffort);
  const patch = useReviewStore((state) => state.patch);
  const hasDiff = useReviewStore(
    (state) => (state.summary?.files.length ?? 0) > 0 && !state.loadingDiff,
  );
  const fileCount = useReviewStore((state) => state.summary?.files.length ?? 0);
  const runReview = useReviewStore((state) => state.runReview);
  const runReReview = useReviewStore((state) => state.runReReview);
  const setReviewEngine = useReviewStore((state) => state.setReviewEngine);
  const setReviewModel = useReviewStore((state) => state.setReviewModel);
  const setReviewEffort = useReviewStore((state) => state.setReviewEffort);
  const setExplainMode = useReviewStore((state) => state.setExplainMode);
  const dismissReviewError = useReviewStore((state) => state.dismissReviewError);
  const dismissExplainError = useReviewStore((state) => state.dismissExplainError);
  const agentModels = useAgentModels(reviewEngine);

  const busy = reviewing || reReviewing || explaining;
  const running = reviewing || reReviewing;
  const { handingOver, rerun, runId, shown, revealed, shapesLeft } = useRunHandover(
    running,
    reReviewing,
    stored,
  );
  const bodyRef = useRef<HTMLDivElement>(null);
  useRevealInOrder(bodyRef, revealed);
  const [tab, setTab] = useState(persistedTab);
  // With no PR there is only the one tab, whatever was last remembered.
  const activeTab: PanelTab = hasPr ? tab : "ai";
  function selectTab(next: PanelTab) {
    setTab(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      // The remembered tab is a convenience, never a dependency.
    }
  }

  // Diff order, so the panel reads top-to-bottom alongside the surface.
  const ordered = useMemo(() => {
    if (!shown) return [];
    return [...shown.review.findings].sort(
      (a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0),
    );
  }, [shown]);

  return (
    <Tabs.Root
      className={css.panel}
      value={activeTab}
      onValueChange={(value) => selectTab(value as PanelTab)}
    >
      <div className={css.tabBar}>
        <Tabs.List className={css.tabList} aria-label="Review panel">
          {hasPr ? (
            <Tabs.Tab value="pr">
              <Icon name="pull-request" className={css.tabIcon} /> PR
            </Tabs.Tab>
          ) : null}
          <Tabs.Tab value="ai">
            <Icon name="sparkle" className={css.tabIcon} /> AI review
          </Tabs.Tab>
        </Tabs.List>
        <div className={css.tabActions}>
          {activeTab === "pr" ? (
            <PrRefreshButton />
          ) : (
            /* One button that changes job: the first press reviews, and once a
               review exists it becomes a follow-up — check the stored findings
               against the current code, then look for new problems. */
            <Button
              variant="primary"
              size="sm"
              onClick={() => void (stored ? runReReview() : runReview())}
              disabled={busy || !hasDiff}
              title={
                hasDiff
                  ? stored
                    ? `Ask ${ENGINE_LABELS[reviewEngine]} to check that the previous findings were addressed, then review the changed code for new issues`
                    : `Ask ${ENGINE_LABELS[reviewEngine]} to review this comparison`
                  : "Nothing to review until a comparison has changes"
              }
            >
              {/* No spinner while busy: the loader below already shows the run. */}
              {busy ? null : <Icon name="sparkle" />}
              {reviewing
                ? "Reviewing…"
                : reReviewing
                  ? "Re-reviewing…"
                  : explaining
                    ? "Explaining…"
                    : stored
                      ? "Re-review"
                      : "Review"}
            </Button>
          )}
        </div>
      </div>
      {/* Both stay mounted so drafts and open composers survive a tab switch. */}
      {hasPr ? (
        <Tabs.Panel value="pr" keepMounted className={css.tabPanel}>
          {pr ? <PrSection pr={pr} /> : <PrSkeleton />}
        </Tabs.Panel>
      ) : null}
      <Tabs.Panel value="ai" keepMounted className={css.tabPanel}>
        <div className={css.controls}>
          <Popover.Root>
            <Popover.Trigger
              render={<Button variant="ghost" size="sm" className={css.settingsTrigger} />}
              disabled={busy}
              title="Choose the review agent, model and effort"
            >
              <Icon name="sliders" />
              <span className={css.settingsSummary}>
                {[
                  ENGINE_LABELS[reviewEngine],
                  reviewModel.trim() || "default model",
                  agentModels.efforts.includes(reviewEffort) ? `${reviewEffort} effort` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <Icon name="chevron-down" />
            </Popover.Trigger>
            <Popover.Popup align="start" className={css.settingsPopup}>
              <Popover.Title className={css.settingsTitle}>Review agent</Popover.Title>
              <div className={css.settingsField}>
                <span className={css.settingsLabel}>Engine</span>
                <Select
                  size="sm"
                  aria-label="Review engine"
                  items={ENGINE_OPTIONS}
                  value={reviewEngine}
                  onValueChange={(engine) => engine && setReviewEngine(engine)}
                  disabled={busy}
                />
              </div>
              <div className={css.settingsField}>
                <span className={css.settingsLabel}>Model</span>
                {/*
                 * Keyed on the engine so switching starts the field's internal query
                 * state fresh alongside the engine's own remembered model.
                 */}
                <Combobox
                  key={reviewEngine}
                  ariaLabel="Model"
                  value={reviewModel.trim() ? reviewModel : null}
                  groups={[
                    {
                      label: agentModels.fromCatalog ? "Available models" : "Suggestions",
                      items: agentModels.models,
                    },
                  ]}
                  onChange={setReviewModel}
                  placeholder="default model"
                  className={css.modelField}
                  commitTyped
                  disabled={busy}
                />
              </div>
              <div className={css.settingsField}>
                <span className={css.settingsLabel}>Effort</span>
                <Select
                  size="sm"
                  aria-label="Reasoning effort"
                  items={[
                    { value: "", label: "default effort" },
                    ...agentModels.efforts.map((level) => ({
                      value: level,
                      label: `${level} effort`,
                    })),
                  ]}
                  value={agentModels.efforts.includes(reviewEffort) ? reviewEffort : ""}
                  onValueChange={(level) => setReviewEffort(level ?? "")}
                  disabled={busy}
                />
              </div>
              <p className={css.settingsHint}>
                Leave the model blank to use the CLI's own default.
              </p>
            </Popover.Popup>
          </Popover.Root>
          <Tooltip content="Also explain the change in plain language, listed here with the findings">
            <span className={css.explainToggle}>
              <Checkbox
                checked={explainMode}
                onCheckedChange={(checked) => setExplainMode(checked)}
                disabled={busy}
              >
                Explain
              </Checkbox>
            </span>
          </Tooltip>
        </div>

        {/* While a finished run hands over, the review it replaces fades out. */}
        <div ref={bodyRef} className={handingOver ? `${css.body} ${css.replacing}` : css.body}>
          {reviewError ? (
            <div className={css.error} role="alert">
              <p className={css.errorText}>{reviewError}</p>
              <Button variant="ghost" size="sm" onClick={dismissReviewError}>
                <Icon name="close" /> Dismiss
              </Button>
            </div>
          ) : null}

          {/* Its own box: the two agents run independently, so one can fail
              while the other returns something worth reading. */}
          {explainError ? (
            <div className={css.error} role="alert">
              <p className={css.errorText}>Could not explain the change. {explainError}</p>
              <Button variant="ghost" size="sm" onClick={dismissExplainError}>
                <Icon name="close" /> Dismiss
              </Button>
            </div>
          ) : null}

          {/* Above the review: it is orientation, and orientation comes before
              judgement. It also stands on its own — a review need not exist,
              and the explanation outlives whichever engine wrote it. */}
          <ExplanationList />

          {/* One shape per changed file, within reason: enough to keep the scene
              busy on a one-file change, few enough not to crowd it on a big one.
              The agents report no progress mid-run, so it runs open-ended. */}
          {running || handingOver ? (
            <Fold open appear className={css.notice}>
              <ReviewLoader
                key={runId}
                count={Math.min(9, Math.max(5, fileCount))}
                leaving={!running}
                onLeft={shapesLeft}
              />
              <p className={handingOver ? `${css.status} ${css.statusLeaving}` : css.status}>
                {rerun
                  ? `${ENGINE_LABELS[reviewEngine]} is checking whether the previous findings were addressed, then reviewing the changed code for new issues.`
                  : `${ENGINE_LABELS[reviewEngine]} is reading the diff and the surrounding code.`}{" "}
                This can take a few minutes on a large change.
              </p>
            </Fold>
          ) : null}

          {shown && !reviewing ? (
            <>
              <Section title="Review" reveal>
                <div className={css.itemHead}>
                  <Provenance
                    engine={shown.engine}
                    model={shown.model}
                    effort={shown.effort}
                    createdAt={shown.createdAt}
                  />
                  <CopyButton text={shown.review.summary} label="Copy summary" />
                </div>
                <GitHubMarkdown markdown={shown.review.summary} className={css.agentMarkdown} />
                <Thread
                  threadKey={REVIEW_THREAD_KEY}
                  comments={shown.threads[REVIEW_THREAD_KEY] ?? []}
                  engine={shown.engine}
                  placeholder="Discuss the review as a whole…"
                  askLabel="Discuss"
                  actions={
                    pr ? (
                      <PrCommentComposer
                        finding={null}
                        patch={patch}
                        pr={pr}
                        reviewBody={shown.review.summary}
                        postedUrl={shown.review.postedUrl}
                      />
                    ) : null
                  }
                />
              </Section>
              {shown.resolutions && shown.resolutions.length > 0 ? (
                <Section title="Previous findings" count={shown.resolutions.length} reveal>
                  <ul className={css.findings}>
                    {shown.resolutions.map((resolution) => (
                      <Resolution
                        key={resolutionThreadKey(resolution.finding)}
                        resolution={resolution}
                        engine={shown.engine}
                      />
                    ))}
                  </ul>
                </Section>
              ) : null}
              <Section
                title={shown.resolutions?.length ? "New findings" : "Findings"}
                count={ordered.length}
                reveal
              >
                {ordered.length === 0 ? (
                  <p className={css.status}>
                    {shown.resolutions?.length
                      ? "No new findings beyond the previous review."
                      : "No findings — the diff came back clean."}
                  </p>
                ) : (
                  <ul className={css.findings}>
                    {ordered.map((finding) => (
                      <Finding
                        key={findingThreadKey(finding)}
                        finding={finding}
                        engine={shown.engine}
                        patch={patch}
                        pr={pr}
                      />
                    ))}
                  </ul>
                )}
              </Section>
              {/* Keyed on the review, so a fresh one resets the draft and the
                  preselected verdict to what it recommends. */}
              <Conclusion key={shown.createdAt} review={shown.review} pr={pr} />
            </>
          ) : null}
          <Fold open={!shown && !running && !handingOver && !reviewError} className={css.notice}>
            <p className={css.status}>
              Nothing runs until you press Review. Findings land here, kept per comparison and
              engine for when you come back.
            </p>
          </Fold>
        </div>
      </Tabs.Panel>
    </Tabs.Root>
  );
}
