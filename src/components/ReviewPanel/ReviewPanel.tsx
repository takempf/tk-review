import { MarkdownClient } from "@comark/react";
import emoji from "comark/plugins/emoji";
import footnotes from "comark/plugins/footnotes";
import DOMPurify from "dompurify";
import { useEffect, useMemo, useState } from "react";
import {
  type EngineModels,
  gitApi,
  type PrContext,
  type ReviewComment,
  type ReviewEngine,
  type ReviewFinding,
} from "../../ipc/git";
import { postBodyForFinding, postLocationForFinding } from "../../lib/prComment";
import {
  findingThreadKey,
  REVIEW_THREAD_KEY,
  type ResolvedFinding,
  resolutionThreadKey,
  type StoredExplanation,
  type StoredReview,
  useReviewStore,
} from "../../store/reviewStore";
import { Combobox } from "../Combobox/Combobox";
import { ResizeHandle, useStoredSize } from "../ResizeHandle/ResizeHandle";
import { Textarea } from "../Textarea/Textarea";
import css from "./ReviewPanel.module.css";

const ENGINE_LABELS: Record<ReviewEngine, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

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

/** Stable fallback: a fresh `[]` from a selector re-renders forever. */
const EMPTY_THREAD: ReviewComment[] = [];
const PR_SECTION_KEY = "tk-review:review-panel:pr-open";
const AI_SECTION_KEY = "tk-review:review-panel:ai-open";
/** Height of the PR section when open; the AI review takes whatever is left. */
const PR_SECTION_HEIGHT = {
  storageKey: "tk-review:review-panel:pr-height",
  min: 96,
  max: 1600,
  fallback: 320,
};
/** Comark enables GFM tables, strikethrough, autolinks, task lists, and alerts
 * by default. These plugins round it out with GitHub's emoji and footnotes. */
const GITHUB_MARKDOWN_PLUGINS = [emoji(), footnotes()];

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

function GitHubImage({ src, alt = "", ...props }: React.ImgHTMLAttributes<HTMLImageElement>) {
  const [resolvedSrc, setResolvedSrc] = useState(src);

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
        // Keep the original URL as a fallback; regular image failures retain
        // the browser's normal broken-image affordance.
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  return <img {...props} alt={alt} src={resolvedSrc} />;
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
      components={{ img: GitHubImage }}
    />
  );
}

function persistedOpen(key: string): boolean {
  try {
    return localStorage.getItem(key) !== "false";
  } catch {
    return true;
  }
}

function Collapsible({
  storageKey,
  title,
  actions,
  children,
  className,
  /** Applied only while open; a collapsed section is just its header. */
  openStyle,
  /** Rendered alongside the body while open, e.g. a resize handle on the section's edge. */
  openExtra,
}: {
  storageKey: string;
  title: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  openStyle?: React.CSSProperties;
  openExtra?: React.ReactNode;
}) {
  const [open, setOpen] = useState(() => persistedOpen(storageKey));
  function toggle() {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(storageKey, String(next));
    } catch {
      // Collapse state is a convenience, never a dependency.
    }
  }
  return (
    <section
      className={[css.section, className].filter(Boolean).join(" ")}
      style={open ? openStyle : undefined}
    >
      <div className={css.sectionHeader}>
        <button type="button" className={css.sectionToggle} onClick={toggle} aria-expanded={open}>
          <span className={css.sectionChevron} aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          {title}
        </button>
        {actions}
      </div>
      {open ? <div className={css.sectionBody}>{children}</div> : null}
      {open ? openExtra : null}
    </section>
  );
}

function PrSection({ pr }: { pr: PrContext }) {
  const selectFile = useReviewStore((state) => state.selectFile);
  const refreshPr = useReviewStore((state) => state.refreshPr);
  const refreshingPr = useReviewStore((state) => state.refreshingPr);
  // The header's Refresh does the same work when a PR is open; don't offer a
  // second run while either one is still going.
  const loadingDiff = useReviewStore((state) => state.loadingDiff);
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
  const state = pr.isDraft ? "draft" : pr.state;
  const height = useStoredSize(PR_SECTION_HEIGHT);

  return (
    <Collapsible
      storageKey={PR_SECTION_KEY}
      className={css.prSection}
      openStyle={{ flexBasis: height.size }}
      openExtra={
        <ResizeHandle
          axis="height"
          edge="end"
          label="Resize pull request section"
          size={height.size}
          min={PR_SECTION_HEIGHT.min}
          max={PR_SECTION_HEIGHT.max}
          onResize={height.resize}
          onResizeEnd={height.resizeAndPersist}
          onReset={height.reset}
        />
      }
      title={
        <span className={css.prTitle}>
          Pull request #{pr.number} · {state} · @{pr.author}
        </span>
      }
      actions={
        <button
          type="button"
          className={css.refreshPr}
          onClick={() => void refreshPr()}
          disabled={refreshingPr || loadingDiff}
          title="Refresh pull request details and discussion"
        >
          {refreshingPr || loadingDiff ? "Refreshing…" : "↻"}
        </button>
      }
    >
      <div className={css.prDescription}>
        <p className={css.prName}>{pr.title}</p>
        {prHeadMoved ? (
          <p className={css.prMoved}>PR has new commits; the comparison was refreshed.</p>
        ) : null}
        {pr.body ? (
          <GitHubMarkdown markdown={pr.body} className={css.prMarkdown} />
        ) : (
          <p className={css.muted}>No description.</p>
        )}
      </div>
      {topLevel.length > 0 ? (
        <div className={css.prDiscussion}>
          <p className={css.subheading}>Conversation</p>
          {topLevel.map((comment) => (
            <div className={css.prComment} key={comment.id}>
              <span className={css.prAuthor}>@{comment.author}</span>
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
                <div className={css.prComment} key={comment.id}>
                  <span className={css.prAuthor}>
                    @{comment.author}
                    {comment.line != null ? ` · line ${comment.line}` : ""}
                    {comment.outdated ? " · outdated" : ""}
                  </span>
                  <GitHubMarkdown markdown={comment.body} className={css.prCommentMarkdown} />
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </Collapsible>
  );
}

/** How an explanation was produced, for the small print above it. */
function explainedAt(stored: StoredExplanation): string {
  const when = new Date(stored.createdAt);
  const stamp = Number.isNaN(when.getTime()) ? "" : ` · ${when.toLocaleString()}`;
  const model = stored.model ? ` · ${stored.model}` : "";
  return `via ${stored.engine}${model}${stamp}`;
}

/** Sorts last, and gets no jump link: no item in the diff surface to jump to. */
const NOT_IN_DIFF = Number.MAX_SAFE_INTEGER;

/**
 * The plain-language explanation of the change, in the same column as the
 * findings it sits among.
 *
 * Findings and explanations are different kinds of thing — one is a judgement
 * to act on, the other is orientation — so every explanation carries a tag
 * where a finding carries its severity, and the two never read as one list.
 * Each per-file entry links to its file, which selects it and scrolls the diff
 * surface there, exactly as a finding's path does.
 */
function ExplanationList() {
  const explainMode = useReviewStore((state) => state.explainMode);
  const stored = useReviewStore((state) => state.explanation);
  const explaining = useReviewStore((state) => state.explaining);
  const summary = useReviewStore((state) => state.summary);
  const selectFile = useReviewStore((state) => state.selectFile);

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

  return (
    <div className={css.explanations}>
      {stored ? (
        <p className={css.reviewedWith}>
          {explainedAt(stored)}
          {stale ? " · from an older version of this diff" : ""}
        </p>
      ) : null}
      {explaining ? (
        <p className={css.status}>
          {stored ? "Explaining again…" : "Explaining the change in plain language…"}
        </p>
      ) : null}
      {stored ? (
        <ul className={css.findings}>
          <li className={css.finding}>
            <div className={css.findingMeta}>
              <span className={css.explainTag}>explanation</span>
              <span className={css.findingPathPlain}>the whole change</span>
            </div>
            <p className={css.findingBody}>{stored.explanation.overall}</p>
          </li>
          {files.map((file) => (
            <li className={css.finding} key={file.path}>
              <div className={css.findingMeta}>
                <span className={css.explainTag}>explanation</span>
                {file.index === NOT_IN_DIFF ? (
                  <span className={css.findingPathPlain}>{file.path}</span>
                ) : (
                  <button
                    type="button"
                    className={css.findingPath}
                    onClick={() => selectFile(file.path)}
                    title={`Jump to ${file.path}`}
                  >
                    {file.path}
                  </button>
                )}
              </div>
              <p className={css.findingBody}>{file.explanation}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function reviewedAt(stored: StoredReview): string {
  const when = new Date(stored.createdAt);
  const stamp = Number.isNaN(when.getTime()) ? "" : ` · ${when.toLocaleString()}`;
  const model = stored.model ? ` · ${stored.model}` : "";
  const effort = stored.effort ? ` · ${stored.effort} effort` : "";
  return `via ${stored.engine}${model}${effort}${stamp}`;
}

/**
 * One conversation: its comments, a pending marker while the agent answers,
 * and the input that asks. Only one thread can await a reply at a time.
 */
function Thread({
  threadKey,
  comments,
  engine,
  placeholder,
}: {
  threadKey: string;
  comments: ReviewComment[];
  engine: ReviewEngine;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");
  const replyingTo = useReviewStore((state) => state.replyingTo);
  const addComment = useReviewStore((state) => state.addComment);

  const pending = replyingTo === threadKey;
  const busy = replyingTo !== null;
  const canSend = !busy && draft.trim() !== "";

  function send() {
    if (!canSend) return;
    setDraft("");
    void addComment(threadKey, draft.trim());
  }

  return (
    <div className={css.thread}>
      {comments.map((comment) => (
        <div
          key={`${comment.at}:${comment.author}`}
          className={comment.author === "user" ? css.commentUser : css.commentAgent}
        >
          <span className={css.commentAuthor}>{comment.author === "user" ? "You" : engine}</span>
          <p className={css.commentText}>{comment.text}</p>
        </div>
      ))}
      {pending ? <p className={css.commentPending}>Waiting for {engine}…</p> : null}
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
          autoGrow
          placeholder={placeholder}
          disabled={busy}
        />
        <button type="submit" className={css.commentSend} disabled={!canSend}>
          Send
        </button>
      </form>
    </div>
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
      {postedUrl ? (
        <a className={css.postedLink} href={postedUrl} target="_blank" rel="noreferrer">
          Posted to PR ↗
        </a>
      ) : null}
      {!open ? (
        <button
          type="button"
          className={css.postButton}
          onClick={() => setOpen(true)}
          disabled={busy}
        >
          {postedUrl ? "Post again" : "Send to PR"}
        </button>
      ) : (
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
            <button
              type="button"
              className={css.postButton}
              onClick={post}
              disabled={busy || !body.trim()}
            >
              {pending ? "Posting…" : confirming ? "Post anyway" : "Post"}
            </button>
            <button type="button" className={css.composerCancel} onClick={close} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
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
  const selectFile = useReviewStore((state) => state.selectFile);
  const inDiff = useReviewStore(
    (state) => state.summary?.files.some((file) => file.path === finding.path) ?? false,
  );
  const threadKey = resolutionThreadKey(finding);
  const comments = useReviewStore(
    (state) => state.reviews[state.reviewEngine]?.threads[threadKey] ?? EMPTY_THREAD,
  );

  return (
    <li className={css.finding}>
      <div className={css.findingMeta}>
        <span className={`${css.severity} ${resolutionClass(status)}`}>{status}</span>
        {inDiff ? (
          <button
            type="button"
            className={css.findingPath}
            onClick={() => selectFile(finding.path)}
            title={`Jump to ${finding.path}`}
          >
            {finding.path}
            {finding.line != null ? `:${finding.line}` : ""}
          </button>
        ) : (
          <span className={css.findingPathPlain}>
            {finding.path}
            {finding.line != null ? `:${finding.line}` : ""}
          </span>
        )}
      </div>
      <p className={css.findingTitle}>{finding.title}</p>
      {note ? <p className={css.findingBody}>{note}</p> : null}
      <Thread
        threadKey={threadKey}
        comments={comments}
        engine={engine}
        placeholder="Ask about this verdict…"
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
  const selectFile = useReviewStore((state) => state.selectFile);
  const inDiff = useReviewStore(
    (state) => state.summary?.files.some((file) => file.path === finding.path) ?? false,
  );
  const threadKey = findingThreadKey(finding);
  const comments = useReviewStore(
    (state) => state.reviews[state.reviewEngine]?.threads[threadKey] ?? EMPTY_THREAD,
  );

  return (
    <li className={css.finding}>
      <div className={css.findingMeta}>
        <span className={`${css.severity} ${severityClass(finding.severity)}`}>
          {finding.severity}
        </span>
        {/* Jumping only works for paths that are actually in the diff surface. */}
        {inDiff ? (
          <button
            type="button"
            className={css.findingPath}
            onClick={() => selectFile(finding.path)}
            title={`Jump to ${finding.path}`}
          >
            {finding.path}
            {finding.line != null ? `:${finding.line}` : ""}
          </button>
        ) : (
          <span className={css.findingPathPlain}>
            {finding.path}
            {finding.line != null ? `:${finding.line}` : ""}
          </span>
        )}
      </div>
      <p className={css.findingTitle}>{finding.title}</p>
      <p className={css.findingBody}>{finding.body}</p>
      {pr ? (
        <PrCommentComposer finding={finding} patch={patch} pr={pr} postedUrl={finding.postedUrl} />
      ) : null}
      <Thread
        threadKey={threadKey}
        comments={comments}
        engine={engine}
        placeholder="Ask about this finding…"
      />
    </li>
  );
}

export function ReviewPanel() {
  const pr = useReviewStore((state) => state.pr);
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

  // Diff order, so the panel reads top-to-bottom alongside the surface.
  const ordered = useMemo(() => {
    if (!stored) return [];
    return [...stored.review.findings].sort(
      (a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0),
    );
  }, [stored]);

  return (
    <div className={css.panel}>
      {pr ? <PrSection pr={pr} /> : null}
      <Collapsible
        storageKey={AI_SECTION_KEY}
        title={<span className={css.title}>AI review</span>}
        actions={
          /* One button that changes job: the first press reviews, and once a
             review exists it becomes a follow-up — check the stored findings
             against the current code, then look for new problems. */
          <button
            type="button"
            className={css.reviewButton}
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
            {reviewing
              ? "Reviewing…"
              : reReviewing
                ? "Re-reviewing…"
                : explaining
                  ? "Explaining…"
                  : stored
                    ? "Re-review"
                    : "Review"}
          </button>
        }
      >
        <div className={css.controls}>
          {/* Same triangle as the combobox, on a native select. */}
          <span className={css.selectWrap}>
            <select
              className={css.engineSelect}
              value={reviewEngine}
              onChange={(event) => setReviewEngine(event.target.value as ReviewEngine)}
              disabled={busy}
              aria-label="Review engine"
            >
              {(Object.keys(ENGINE_LABELS) as ReviewEngine[]).map((engine) => (
                <option key={engine} value={engine}>
                  {ENGINE_LABELS[engine]}
                </option>
              ))}
            </select>
            <svg className={css.selectChevron} viewBox="0 0 10 8.6603" aria-hidden="true">
              <polygon points="0,0 10,0 5,8.6603" />
            </svg>
          </span>
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
          <span className={css.selectWrap}>
            <select
              className={css.engineSelect}
              value={agentModels.efforts.includes(reviewEffort) ? reviewEffort : ""}
              onChange={(event) => setReviewEffort(event.target.value)}
              disabled={busy}
              aria-label="Reasoning effort"
            >
              <option value="">default effort</option>
              {agentModels.efforts.map((level) => (
                <option key={level} value={level}>
                  {level} effort
                </option>
              ))}
            </select>
            <svg className={css.selectChevron} viewBox="0 0 10 8.6603" aria-hidden="true">
              <polygon points="0,0 10,0 5,8.6603" />
            </svg>
          </span>
          <label
            className={css.explainToggle}
            title="Also explain the change in plain language, listed here with the findings"
          >
            <input
              type="checkbox"
              checked={explainMode}
              onChange={(event) => setExplainMode(event.target.checked)}
              disabled={busy}
            />
            Explain
          </label>
        </div>

        <div className={css.body}>
          {reviewError ? (
            <div className={css.error} role="alert">
              <p className={css.errorText}>{reviewError}</p>
              <button type="button" className={css.errorDismiss} onClick={dismissReviewError}>
                Dismiss
              </button>
            </div>
          ) : null}

          {/* Its own box: the two agents run independently, so one can fail
              while the other returns something worth reading. */}
          {explainError ? (
            <div className={css.error} role="alert">
              <p className={css.errorText}>Could not explain the change. {explainError}</p>
              <button type="button" className={css.errorDismiss} onClick={dismissExplainError}>
                Dismiss
              </button>
            </div>
          ) : null}

          {/* Above the review: it is orientation, and orientation comes before
              judgement. It also stands on its own — a review need not exist,
              and the explanation outlives whichever engine wrote it. */}
          <ExplanationList />

          {reReviewing ? (
            <p className={css.status}>
              {ENGINE_LABELS[reviewEngine]} is checking whether the previous findings were
              addressed, then reviewing the changed code for new issues. This can take a few minutes
              on a large change.
            </p>
          ) : null}

          {reviewing ? (
            <p className={css.status}>
              {ENGINE_LABELS[reviewEngine]} is reading the diff and the surrounding code. This can
              take a few minutes on a large change.
            </p>
          ) : stored ? (
            <>
              <p className={css.reviewedWith}>{reviewedAt(stored)}</p>
              <p className={css.summary}>{stored.review.summary}</p>
              {pr ? (
                <PrCommentComposer
                  finding={null}
                  patch={patch}
                  pr={pr}
                  reviewBody={stored.review.summary}
                  postedUrl={stored.review.postedUrl}
                />
              ) : null}
              <Thread
                threadKey={REVIEW_THREAD_KEY}
                comments={stored.threads[REVIEW_THREAD_KEY] ?? []}
                engine={stored.engine}
                placeholder="Discuss the review as a whole…"
              />
              {stored.resolutions && stored.resolutions.length > 0 ? (
                <>
                  <p className={css.subheading}>Previous findings</p>
                  <ul className={css.findings}>
                    {stored.resolutions.map((resolution) => (
                      <Resolution
                        key={resolutionThreadKey(resolution.finding)}
                        resolution={resolution}
                        engine={stored.engine}
                      />
                    ))}
                  </ul>
                </>
              ) : null}
              {stored.resolutions?.length ? <p className={css.subheading}>New findings</p> : null}
              {ordered.length === 0 ? (
                <p className={css.status}>
                  {stored.resolutions?.length
                    ? "No new findings beyond the previous review."
                    : "No findings — the diff came back clean."}
                </p>
              ) : (
                <ul className={css.findings}>
                  {ordered.map((finding) => (
                    <Finding
                      key={findingThreadKey(finding)}
                      finding={finding}
                      engine={stored.engine}
                      patch={patch}
                      pr={pr}
                    />
                  ))}
                </ul>
              )}
            </>
          ) : !reviewError ? (
            <p className={css.status}>
              On demand: nothing runs until you press Review. The chosen agent reads the current
              comparison — including uncommitted changes when that box is ticked — plus the
              surrounding code, and reports findings here. Reviews and their comment threads are
              kept per comparison and per engine, so they're waiting when you come back. Leave the
              model blank to use the CLI's own default.
            </p>
          ) : null}
        </div>
      </Collapsible>
    </div>
  );
}
