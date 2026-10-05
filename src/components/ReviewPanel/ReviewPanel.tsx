import {
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
  Icon,
  type IconName,
  Popover,
  Radio,
  RadioGroup,
  Select,
  Tabs,
} from "tk-design-system";
import {
  gitApi,
  type PrComment,
  type PrContext,
  type PrThread,
  type ReviewComment,
  type ReviewEngine,
  type ReviewFinding,
  type ReviewVerdict,
} from "../../ipc/git";
import { ENGINE_LABELS } from "../../lib/engines";
import { splitPath } from "../../lib/fileChange";
import { describeLines, findingLines, formatLines, type LineSpan } from "../../lib/lineSpan";
import { useModelCatalogs, useModelLabel } from "../../lib/models";
import {
  findingAfter,
  postBodyForFinding,
  postLocationForFinding,
  postLocationForPriorFinding,
} from "../../lib/prComment";
import {
  type CommentAnchor,
  type FileDiscussion,
  inlineDiscussion,
  repliesAfter,
  threadFor,
} from "../../lib/prThreads";
import { absoluteTime, shortTime } from "../../lib/time";
import { knownVerdict } from "../../lib/verdict";
import { isSignedInAs } from "../../store/account";
import { useAppStore } from "../../store/appStore";
import {
  type AgentRunKind,
  CONCLUSION_POST_KEY,
  findingThreadKey,
  postTargetKey,
  REVIEW_THREAD_KEY,
  type ResolvedFinding,
  resolutionThreadKey,
  reviewsNewestFirst,
  type StoredExplanation,
  type StoredReview,
  sourcedKey,
  type TabState,
  useTab,
} from "../../store/tabStore";
import { Author, githubHost } from "../Author/Author";
import { Combobox } from "../Combobox/Combobox";
import { CopyButton } from "../CopyButton/CopyButton";
import { ErrorNotice } from "../ErrorNotice/ErrorNotice";
import { Fold } from "../Fold/Fold";
import { GitHubMarkdown } from "../Markdown/Markdown";
import { Model } from "../Model/Model";
import { ReviewLoader } from "../ReviewLoader/ReviewLoader";
import { RunProgress } from "../RunProgress/RunProgress";
import { Skeleton, SkeletonGroup } from "../Skeleton/Skeleton";
import { Spinner } from "../Spinner/Spinner";
import { Textarea } from "../Textarea/Textarea";
import css from "./ReviewPanel.module.css";

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

/**
 * Model and effort choices for the engine: its CLI's cached catalog (see
 * `useModelCatalogs`). Until the read lands, or when there is no cache, the
 * built-in fallback lists apply.
 */
function useAgentModels(engine: ReviewEngine) {
  const catalogs = useModelCatalogs();
  const catalog = catalogs[engine];
  return {
    fromCatalog: catalog !== undefined,
    models: catalog?.models.map((model) => model.id) ?? MODEL_SUGGESTIONS[engine],
    efforts: catalog?.efforts ?? EFFORT_LEVELS[engine],
  };
}

/**
 * Severities the model is asked to use, each with the icon its finding is
 * marked with; anything else is neutral. Marked as the verdicts are: a cross
 * for what has to change.
 */
const SEVERITY_ICONS: Record<string, IconName | undefined> = {
  critical: "close",
  warning: "warning",
  suggestion: "info",
  nit: "dot",
  neutral: "circle",
};

const severityKey = (severity: string) =>
  SEVERITY_ICONS[severity.toLowerCase()] ? severity.toLowerCase() : "neutral";

function severityClass(severity: string): string {
  return css[`severity_${severityKey(severity)}`] ?? "";
}

const severityIcon = (severity: string): IconName =>
  SEVERITY_ICONS[severityKey(severity)] ?? "circle";

/**
 * Statuses the re-review is asked to use, each with its finding's icon;
 * anything else is neutral. A check where the finding was dealt with, a cross
 * where it wasn't, a dash for part of the way.
 */
const RESOLUTION_ICONS: Record<string, IconName | undefined> = {
  addressed: "check",
  unaddressed: "close",
  partial: "minus",
  obsolete: "dot",
  neutral: "circle",
};

const resolutionKey = (status: string) =>
  RESOLUTION_ICONS[status.toLowerCase()] ? status.toLowerCase() : "neutral";

function resolutionClass(status: string): string {
  return css[`status_${resolutionKey(status)}`] ?? "";
}

const resolutionIcon = (status: string): IconName =>
  RESOLUTION_ICONS[resolutionKey(status)] ?? "circle";

/** A finding's severity or verdict as an icon in its tone, the word itself on hover. */
function FindingMark({ icon, label }: { icon: IconName; label: string }) {
  const name = label.charAt(0).toUpperCase() + label.slice(1);
  return (
    <span className={css.mark} title={name}>
      <Icon name={icon} label={name} />
    </span>
  );
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

/** Stable fallback: a fresh `[]` from a selector re-renders forever. */
const EMPTY_THREAD: ReviewComment[] = [];
type PanelTab = "pr" | "ai" | "explain";

/** The engine doing the tab's run of `kind`, if one is in flight. */
function runningEngine(state: TabState, kind: AgentRunKind): ReviewEngine | undefined {
  return Object.values(state.agentRuns).find((run) => run.kind === kind)?.engine;
}

function PrRefreshButton() {
  const refreshPr = useTab((state) => state.refreshPr);
  const refreshingPr = useTab((state) => state.refreshingPr);
  // The header's Refresh does the same work when a PR is open; don't offer a
  // second run while either one is still going.
  const loadingDiff = useTab((state) => state.loadingDiff);
  const openingPr = useTab((state) => state.openingPr);
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

/**
 * One comment from GitHub: who wrote it and when, then what they said. `meta`
 * is small print for the byline, such as a thread's state.
 */
function GitHubPost({
  comment,
  host,
  meta,
}: {
  comment: PrComment;
  host: string;
  meta?: ReactNode;
}) {
  return (
    <div className={css.prComment}>
      <div className={css.itemHead}>
        <span className={css.prByline}>
          <Author login={comment.author} host={host} className={css.prAuthor} />
          <time dateTime={comment.createdAt} title={absoluteTime(comment.createdAt)}>
            {shortTime(comment.createdAt)}
          </time>
          {meta}
        </span>
        <CopyButton text={comment.body} label="Copy comment" />
      </div>
      <GitHubMarkdown markdown={comment.body} className={css.prCommentMarkdown} />
    </div>
  );
}

/**
 * Where on its file a set of comments was made, as a mark on the file's rail
 * and the lines beside it. Current lines jump to the diff; outdated ones
 * belong to an older commit, so they only say so.
 */
function AnchorLabel({ path, anchor }: { path: string; anchor: CommentAnchor }) {
  const selectFile = useTab((state) => state.selectFile);
  const inDiff = useTab(
    (state) => state.summary?.files.some((file) => file.path === path) ?? false,
  );
  const { lines, outdated } = anchor;
  const words = lines ? describeLines(lines) : "whole file";
  const text = words.charAt(0).toUpperCase() + words.slice(1);
  return (
    <div className={css.anchorLabel}>
      <span className={css.anchorMark} aria-hidden="true" />
      {inDiff && !outdated ? (
        <button
          type="button"
          className={css.anchorLines}
          onClick={() => selectFile(path, lines)}
          title={`Jump to ${path}${lines ? `, ${describeLines(lines)}` : ""}`}
        >
          {text}
        </button>
      ) : (
        <span className={css.anchorLines}>{text}</span>
      )}
      {outdated ? <span className={css.anchorNote}>outdated</span> : null}
    </div>
  );
}

/** A thread's state, for the byline of the comment that started it. */
function threadMeta(thread: PrThread | null): ReactNode {
  if (!thread?.resolved) return null;
  return (
    <span title={thread.resolvedBy ? `Resolved by ${thread.resolvedBy}` : undefined}>resolved</span>
  );
}

/**
 * A file's inline comments as GitHub's conversation reads them, laid down the
 * file: a rail on the left with a mark at each line or span comments were
 * made on, and inset beside it every conversation there, each comment in turn.
 */
function InlineFile({ file, host }: { file: FileDiscussion; host: string }) {
  const selectFile = useTab((state) => state.selectFile);
  return (
    <section className={css.inlineFile} data-path={file.path}>
      <button type="button" className={css.inlinePath} onClick={() => selectFile(file.path)}>
        {file.path}
      </button>
      <ol className={css.anchors}>
        {file.anchors.map((anchor) => (
          <li
            key={anchor.key}
            className={css.anchor}
            data-anchor={anchor.key}
            data-span={(anchor.lines && anchor.lines.end > anchor.lines.start) || undefined}
            data-outdated={anchor.outdated || undefined}
          >
            <AnchorLabel path={file.path} anchor={anchor} />
            {anchor.threads.map(({ thread, comments }) => (
              <div key={thread?.id ?? comments[0]?.id} className={css.inlineThread}>
                {comments.map((comment, index) => (
                  <GitHubPost
                    key={comment.id}
                    comment={comment}
                    host={host}
                    meta={index === 0 ? threadMeta(thread) : null}
                  />
                ))}
              </div>
            ))}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Room left above comments brought into view, so their file reads as theirs. */
const FOCUS_MARGIN = 24;

/**
 * Scrolls `ref` to the comments the diff asked for (`commentFocus`), then
 * tints them a moment so the eye lands on the right ones. Only requests made
 * since it mounted count: a PR read in again doesn't go back to the last.
 */
function useCommentFocus(ref: RefObject<HTMLElement | null>) {
  const focus = useTab((state) => state.commentFocus);
  const handled = useRef(focus?.tick ?? 0);

  useEffect(() => {
    const body = ref.current;
    if (!focus || !body || focus.tick === handled.current) return;
    handled.current = focus.tick;
    // Matched by value, so a path needs no escaping into a selector.
    const file = [...body.querySelectorAll<HTMLElement>("[data-path]")].find(
      (element) => element.dataset.path === focus.path,
    );
    const anchor = [...(file?.querySelectorAll<HTMLElement>("[data-anchor]") ?? [])].find(
      (element) => element.dataset.anchor === focus.key,
    );
    if (!anchor) return;
    const top = anchor.getBoundingClientRect().top - body.getBoundingClientRect().top;
    body.scrollTo({
      top: body.scrollTop + top - FOCUS_MARGIN,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
    // Off and on again, laid out between, so a second ask tints it afresh.
    anchor.removeAttribute("data-focused");
    void anchor.offsetWidth;
    anchor.setAttribute("data-focused", "");
  }, [ref, focus]);
}

function PrSection({ pr }: { pr: PrContext }) {
  const prHeadMoved = useTab((state) => state.prHeadMoved);
  const host = githubHost(pr.url);
  const topLevel = pr.comments.filter((comment) => !comment.path);
  const files = useMemo(() => inlineDiscussion(pr), [pr]);
  const bodyRef = useRef<HTMLDivElement>(null);
  useCommentFocus(bodyRef);

  return (
    <div ref={bodyRef} className={css.prBody}>
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
          <div className={css.prPosts}>
            {topLevel.map((comment) => (
              <GitHubPost key={comment.id} comment={comment} host={host} />
            ))}
          </div>
        </div>
      ) : null}
      {files.length > 0 ? (
        <div className={css.prDiscussion}>
          <p className={css.subheading}>Inline comments</p>
          {files.map((file) => (
            <InlineFile key={file.path} file={file} host={host} />
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
    useModelLabel(engine, model),
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
 * Which review an item came from: the panel shows every engine's review at
 * once, so each finding, verdict and conclusion carries its engine and model.
 * The effort and time, which the review's own heading gives in full, are in
 * the tooltip.
 */
function SourceTag({ source }: { source: StoredReview }) {
  const detail = [
    ENGINE_LABELS[source.engine] ?? source.engine,
    useModelLabel(source.engine, source.model),
    source.effort ? `${source.effort} effort` : null,
    absoluteTime(source.createdAt),
  ].filter(Boolean);
  return (
    <Model
      engine={source.engine}
      model={source.model}
      title={detail.join(" · ")}
      className={css.sourceTag}
    />
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
  tag,
  reveal = false,
  defaultOpen = true,
  children,
}: {
  title: string;
  count?: number;
  /** Set after the title, like the count. */
  tag?: ReactNode;
  /** Part of a run's result, so it takes part in `useRevealInOrder`. */
  reveal?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
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
        {tag}
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
 * An explanation of the change: the walkthrough, then an index of the notes it
 * left on files. The notes are read at the top of each file in the diff, so
 * here they start folded away, as a list to jump from or copy.
 */
function Explanation({ stored }: { stored: StoredExplanation }) {
  const summary = useTab((state) => state.summary);
  const { overall, cutShort } = stored.explanation;

  // Diff order, so the notes read in the order the files are scrolled
  // through. A path the model invented, or one that has since left the diff,
  // sorts last and is shown without a link rather than being dropped — the
  // text is still worth reading, it just has nowhere to jump.
  const files = useMemo(() => {
    const order = new Map((summary?.files ?? []).map((file, index) => [file.path, index]));
    return stored.explanation.files
      .filter((file) => file.explanation.trim())
      .map((file) => ({ ...file, index: order.get(file.path) ?? NOT_IN_DIFF }))
      .sort((a, b) => a.index - b.index);
  }, [stored, summary]);

  const stale = stored.mergeBase !== (summary?.mergeBase ?? null);
  const fileMarkdown = (file: { path: string; explanation: string }) =>
    `\`${file.path}\`\n\n${file.explanation.trim()}`;

  return (
    <>
      <Section title="Walkthrough" reveal>
        <div className={css.itemHead}>
          <Provenance
            engine={stored.engine}
            model={stored.model}
            effort={stored.effort}
            createdAt={stored.createdAt}
            note={stale ? "from an older version of this diff" : undefined}
          />
          <CopyButton text={overall} label="Copy walkthrough" />
        </div>
        {cutShort ? (
          <p className={css.cutShort}>
            <Icon name="warning" />
            <span>
              {ENGINE_LABELS[stored.engine]} hit its turn limit partway through, so it explained
              from what it had read by then. Some files may be covered thinly, or not at all.
            </span>
          </p>
        ) : null}
        <GitHubMarkdown markdown={overall} className={css.agentMarkdown} />
      </Section>
      {files.length > 0 ? (
        <Section title="File notes" count={files.length} defaultOpen={false} reveal>
          <div className={css.itemActions}>
            <span className={css.provenance}>Also shown at the top of each file in the diff.</span>
            <CopyButton
              className={css.actionsEnd}
              text={files.map(fileMarkdown).join("\n\n")}
              label="Copy file notes"
            />
          </div>
          {files.map((file) => (
            <div className={css.explainFile} key={file.path}>
              <div className={css.itemHead}>
                <FindingLocation path={file.path} lines={null} />
                <CopyButton text={fileMarkdown(file)} label="Copy file note" />
              </div>
              <GitHubMarkdown markdown={file.explanation} className={css.agentMarkdown} />
            </div>
          ))}
        </Section>
      ) : null}
    </>
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
  const replyingTo = useTab((state) => state.replyingTo);
  const addComment = useTab((state) => state.addComment);

  const pending = replyingTo === sourcedKey(engine, threadKey);
  const busy = replyingTo !== null;
  const canSend = !busy && draft.trim() !== "";
  const open = asking || comments.length > 0 || pending;
  const agent = ENGINE_LABELS[engine] ?? engine;

  function send() {
    if (!canSend) return;
    setDraft("");
    void addComment(engine, threadKey, draft.trim());
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
            <>
              <p className={css.commentPending}>
                <Spinner /> Waiting for {agent}…
              </p>
              <RunProgress kind="reply" />
            </>
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

/**
 * What became of a posted finding on GitHub: whether its thread is resolved,
 * a button to resolve or reopen it, and the replies since. As of when the PR
 * was last read, so a thread just started shows once the PR is refreshed.
 * `settled` says the re-review found the finding dealt with, which makes
 * resolving it the obvious next step.
 */
function PostedThread({
  pr,
  thread,
  postedUrl,
  settled,
}: {
  pr: PrContext;
  thread: PrThread;
  postedUrl: string;
  settled: boolean;
}) {
  const settingThread = useTab((state) => state.settingThread);
  const setThreadResolved = useTab((state) => state.setThreadResolved);
  const byMe = useTab(
    (state) => thread.resolvedBy != null && isSignedInAs(state.repo, thread.resolvedBy),
  );
  const replies = useMemo(() => repliesAfter(pr, thread, postedUrl), [pr, thread, postedUrl]);
  const host = githubHost(pr.url);
  const pending = settingThread === thread.id;
  const by = thread.resolvedBy ? ` by ${byMe ? "you" : thread.resolvedBy}` : "";

  return (
    <>
      <span className={css.threadControls}>
        <span className={css.threadState} data-resolved={thread.resolved || undefined}>
          {thread.resolved ? (
            <>
              <Icon name="check" /> Resolved{by}
            </>
          ) : (
            "Unresolved"
          )}
          {thread.outdated ? " · outdated" : null}
        </span>
        <Button
          size="sm"
          variant={settled && !thread.resolved ? undefined : "ghost"}
          onClick={() => void setThreadResolved(thread.id, !thread.resolved)}
          disabled={settingThread !== null}
        >
          {pending ? (
            <>
              <Spinner /> {thread.resolved ? "Reopening…" : "Resolving…"}
            </>
          ) : thread.resolved ? (
            "Reopen"
          ) : (
            <>
              <Icon name="check" /> Resolve
            </>
          )}
        </Button>
      </span>
      {replies.length > 0 ? (
        <div className={css.githubReplies}>
          <p className={css.subheading}>
            {replies.length === 1 ? "Reply" : `${replies.length} replies`} on GitHub
          </p>
          <div className={css.prPosts}>
            {replies.map((reply) => (
              <GitHubPost key={reply.id} comment={reply} host={host} />
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}

/** A deliberate, editable hand-off from an AI finding to a GitHub comment. */
function PrCommentComposer({
  engine,
  finding,
  patch,
  pr,
  reviewBody,
  postedUrl,
  prior,
  settled = false,
}: {
  /** Whose review the finding or summary belongs to. */
  engine: ReviewEngine;
  finding: ReviewFinding | null;
  patch: string | null;
  pr: PrContext;
  /** The summary body for the review-level thread. */
  reviewBody?: string;
  postedUrl?: string;
  /** For a finding an earlier review raised: where it sits on the PR's head now. */
  prior?: PriorPlacement | "pending";
  /** The re-review found it dealt with. */
  settled?: boolean;
}) {
  const placed = prior === "pending" ? undefined : prior;
  const location = useMemo(
    () =>
      finding && placed
        ? postLocationForPriorFinding(finding, placed.now, patch)
        : postLocationForFinding(finding, patch),
    [finding, placed, patch],
  );
  const draft = useMemo(
    () =>
      reviewBody ??
      (placed
        ? postBodyForFinding(placed.now ?? finding, location, placed.now ? null : placed.asOf)
        : postBodyForFinding(finding, location)),
    [reviewBody, placed, finding, location],
  );
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // The draft until it's edited; edits survive closing the editor.
  const [edited, setBody] = useState<string | null>(null);
  const body = edited ?? draft;
  const postingTo = useTab((state) => state.postingTo);
  const postPrComment = useTab((state) => state.postPrComment);
  const targetKey = postTargetKey(engine, finding, prior != null);
  const busy = postingTo !== null;
  const pending = postingTo === targetKey;
  const requiresConfirmation = pr.state !== "open" && !pr.isDraft;
  const thread = threadFor(pr, postedUrl);

  function close() {
    setOpen(false);
    setConfirming(false);
  }

  function post() {
    if (requiresConfirmation && !confirming) {
      setConfirming(true);
      return;
    }
    void postPrComment(engine, finding, body, location, prior != null).then((posted) => {
      // Failures stay visible in the review panel and leave the editable draft
      // intact; a successful response leaves behind the GitHub permalink.
      if (posted) close();
    });
  }

  return (
    <div className={css.prComposer}>
      {!open ? (
        <Button size="sm" onClick={() => setOpen(true)} disabled={busy || prior === "pending"}>
          <Icon name="send" /> {postedUrl ? "Post again" : "Send to PR"}
        </Button>
      ) : null}
      {postedUrl ? (
        <a className={css.postedLink} href={postedUrl} target="_blank" rel="noreferrer">
          Posted to PR <Icon name="external" />
        </a>
      ) : null}
      {postedUrl && thread ? (
        <PostedThread pr={pr} thread={thread} postedUrl={postedUrl} settled={settled} />
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
  const selectFile = useTab((state) => state.selectFile);
  const inDiff = useTab(
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

/** Where a prior finding sits on the PR's head: `now` is `null` when its lines can't be followed. */
interface PriorPlacement {
  now: ReviewFinding | null;
  /** The commit the finding's lines belong to, when that isn't the head. */
  asOf: string | null;
}

/** Patches between two commits, kept for the session, to follow prior findings through. */
const PATCHES_BETWEEN = new Map<string, Promise<string>>();

function patchBetween(root: string, from: string, to: string): Promise<string> {
  const key = `${root}\n${from}\n${to}`;
  let patch = PATCHES_BETWEEN.get(key);
  if (!patch) {
    patch = gitApi.getPatch(root, from, to);
    PATCHES_BETWEEN.set(key, patch);
    // A failure is tried again next time rather than remembered.
    patch.catch(() => PATCHES_BETWEEN.delete(key));
  }
  return patch;
}

/**
 * Where a finding raised on commit `readAt` sits on the PR's head, its lines
 * followed through the commits since; `null` until that's worked out. One read
 * on a commit nobody recorded, or one git no longer has, can't be followed.
 */
function usePriorPlacement(
  finding: ReviewFinding,
  readAt: string | null,
  pr: PrContext | null,
): PriorPlacement | null {
  const root = useTab((state) => state.repo.root);
  const head = pr?.headSha ?? null;
  const same = readAt != null && readAt === head;
  const key = [root, readAt, head, findingThreadKey(finding)].join("\n");
  const [placed, setPlaced] = useState<{ key: string; placement: PriorPlacement } | null>(null);
  const unmoved = useMemo(() => ({ now: finding, asOf: null }), [finding]);

  useEffect(() => {
    if (!head || same) return;
    let cancelled = false;
    const settle = (now: ReviewFinding | null) => {
      if (!cancelled) setPlaced({ key, placement: { now, asOf: readAt } });
    };
    if (!readAt) settle(null);
    else {
      patchBetween(root, readAt, head).then(
        (patch) => settle(findingAfter(finding, patch)),
        () => settle(null),
      );
    }
    return () => {
      cancelled = true;
    };
  }, [key, root, readAt, head, same, finding]);

  if (same) return unmoved;
  return placed?.key === key ? placed.placement : null;
}

/** Verdicts that close a finding: nothing left of it to send to the PR. */
const SETTLED = new Set(["addressed", "obsolete"]);

/**
 * One prior finding with the re-review's verdict on it. The card mirrors a
 * finding's, but the band is the verdict rather than the severity — what the
 * reader needs here is "is this done?", not how bad it was the first time.
 * Its comment thread carries over from the finding it judges, under a key of
 * its own so a look-alike new finding cannot inherit it. One still open can
 * go to the PR, as a new finding can.
 */
function Resolution({
  resolution,
  source,
  patch,
  pr,
}: {
  resolution: ResolvedFinding;
  source: StoredReview;
  patch: string | null;
  pr: PrContext | null;
}) {
  const { finding, status, note } = resolution;
  const threadKey = resolutionThreadKey(finding);
  const comments = useTab(
    (state) => state.reviews[source.engine]?.threads[threadKey] ?? EMPTY_THREAD,
  );
  const postable = pr != null && (!SETTLED.has(status.toLowerCase()) || finding.postedUrl != null);
  // The review it came from is the last of the earlier ones.
  const readAt = source.earlier?.at(-1)?.head ?? null;
  const placement = usePriorPlacement(finding, readAt, postable ? pr : null);

  return (
    <li className={`${css.finding} ${resolutionClass(status)}`} data-reveal>
      <FindingMark icon={resolutionIcon(status)} label={status} />
      <div className={css.findingBody}>
        <div className={css.findingTop}>
          <FindingLocation path={finding.path} lines={findingLines(finding)} />
          <SourceTag source={source} />
        </div>
        <div className={`${css.itemHead} ${css.titleHead}`}>
          <p className={css.findingTitle}>{finding.title}</p>
          <CopyButton text={findingMarkdown(finding, status, note ?? "")} label="Copy verdict" />
        </div>
        {note ? <GitHubMarkdown markdown={note} className={css.agentMarkdown} /> : null}
        <Thread
          threadKey={threadKey}
          comments={comments}
          engine={source.engine}
          placeholder="Ask about this verdict…"
          askLabel="Ask about this"
          actions={
            pr && postable ? (
              <PrCommentComposer
                engine={source.engine}
                finding={finding}
                patch={patch}
                pr={pr}
                postedUrl={finding.postedUrl}
                prior={placement ?? "pending"}
                settled={SETTLED.has(status.toLowerCase())}
              />
            ) : null
          }
        />
      </div>
    </li>
  );
}

function Finding({
  finding,
  source,
  patch,
  pr,
}: {
  finding: ReviewFinding;
  /** The review that raised it. */
  source: StoredReview;
  patch: string | null;
  pr: PrContext | null;
}) {
  const threadKey = findingThreadKey(finding);
  const comments = useTab(
    (state) => state.reviews[source.engine]?.threads[threadKey] ?? EMPTY_THREAD,
  );

  return (
    <li className={`${css.finding} ${severityClass(finding.severity)}`} data-reveal>
      <FindingMark icon={severityIcon(finding.severity)} label={finding.severity} />
      <div className={css.findingBody}>
        <div className={css.findingTop}>
          <FindingLocation path={finding.path} lines={findingLines(finding)} />
          <SourceTag source={source} />
        </div>
        <div className={`${css.itemHead} ${css.titleHead}`}>
          <p className={css.findingTitle}>{finding.title}</p>
          <CopyButton
            text={findingMarkdown(finding, finding.severity, finding.body)}
            label="Copy finding"
          />
        </div>
        <GitHubMarkdown markdown={finding.body} className={css.agentMarkdown} />
        <Thread
          threadKey={threadKey}
          comments={comments}
          engine={source.engine}
          placeholder="Ask about this finding…"
          askLabel="Ask about this"
          actions={
            pr ? (
              <PrCommentComposer
                engine={source.engine}
                finding={finding}
                patch={patch}
                pr={pr}
                postedUrl={finding.postedUrl}
              />
            ) : null
          }
        />
      </div>
    </li>
  );
}

/** One engine's review as a whole: who wrote it and when, what it said, and its discussion. */
function ReviewSummary({
  source,
  patch,
  pr,
}: {
  source: StoredReview;
  patch: string | null;
  pr: PrContext | null;
}) {
  return (
    <li className={css.summary} data-reveal>
      <div className={css.itemHead}>
        <Provenance
          engine={source.engine}
          model={source.model}
          effort={source.effort}
          createdAt={source.createdAt}
        />
        <CopyButton text={source.review.summary} label="Copy summary" />
      </div>
      {source.review.cutShort ? (
        <p className={css.cutShort}>
          <Icon name="warning" />
          <span>
            {ENGINE_LABELS[source.engine]} hit its turn limit partway through, so it answered from
            what it had read by then. Some changes may not have been checked.
          </span>
        </p>
      ) : null}
      <GitHubMarkdown markdown={source.review.summary} className={css.agentMarkdown} />
      <Thread
        threadKey={REVIEW_THREAD_KEY}
        comments={source.threads[REVIEW_THREAD_KEY] ?? []}
        engine={source.engine}
        placeholder="Discuss the review as a whole…"
        askLabel="Discuss"
        actions={
          pr ? (
            <PrCommentComposer
              engine={source.engine}
              finding={null}
              patch={patch}
              pr={pr}
              reviewBody={source.review.summary}
              postedUrl={source.review.postedUrl}
            />
          ) : null
        }
      />
    </li>
  );
}

/**
 * Diff order, so the panel reads top-to-bottom alongside the surface. Every
 * engine's items interleave; the sort is stable, so where two land on the same
 * line the newer review's comes first.
 */
function inDiffOrder<T>(items: T[], findingOf: (item: T) => ReviewFinding): T[] {
  return [...items].sort((a, b) => {
    const x = findingOf(a);
    const y = findingOf(b);
    return x.path.localeCompare(y.path) || (x.line ?? 0) - (y.line ?? 0);
  });
}

/**
 * How the review ends: the verdict the agent recommends, already selected, over
 * its draft of the review body. Both are the reader's to change before
 * submitting, and the agent's pick keeps a "suggested" mark so an override
 * stays visible. Without a PR there is nowhere to submit, but the verdict still
 * says where the change stands. With several engines' reviews on record, the
 * most recent one's conclusion is the one offered.
 *
 * GitHub won't take an approval or a request for changes on your own pull
 * request, so on one of those the review can only go in as a comment, and the
 * choice gives way to a note saying why.
 */
function Conclusion({ source, pr }: { source: StoredReview; pr: PrContext | null }) {
  const { review } = source;
  const own = useTab((state) => pr != null && isSignedInAs(state.repo, pr.author));
  const suggested = knownVerdict(review.verdict);
  const [chosen, setVerdict] = useState<ReviewVerdict>(suggested ?? "comment");
  const verdict = own ? "comment" : chosen;
  const [body, setBody] = useState(review.conclusion ?? "");
  const [confirming, setConfirming] = useState(false);
  const postingTo = useTab((state) => state.postingTo);
  const submitPrReview = useTab((state) => state.submitPrReview);

  const busy = postingTo !== null;
  const pending = postingTo === sourcedKey(source.engine, CONCLUSION_POST_KEY);
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
    void submitPrReview(source.engine, verdict, body).then((posted) => {
      if (posted) setConfirming(false);
    });
  }

  return (
    <Section title="Conclusion" tag={<SourceTag source={source} />} reveal>
      {own ? null : (
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
      )}
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
        {own
          ? " It's your own pull request, which GitHub won't let you approve or request changes on."
          : null}
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
 * Meanwhile the results on screen (`shown`) fade out — the run's previous one,
 * and on the review tab every other engine's — and the new set takes their
 * place unseen, while the shapes are still leaving: Markdown renders
 * asynchronously, and this way it has settled before anything comes in, rather
 * than landing in the middle of it. `revealed` counts results let through,
 * which is what sets off `useRevealInOrder`.
 *
 * `label` is whatever the loader says about the run; it is kept as it was when
 * the run started, so the status text doesn't change as it ends.
 */
function useRunHandover<T, L>(running: boolean, label: L, stored: T) {
  const [wasRunning, setWasRunning] = useState(running);
  const [handingOver, setHandingOver] = useState(false);
  const [held, setHeld] = useState(false);
  const [heldLabel, setHeldLabel] = useState(label);
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
      setHeldLabel(label);
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
    label: heldLabel,
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

/**
 * The loader for an agent run, from its start until its shapes have left: the
 * scene, a caption, and the run's progress line.
 *
 * One shape per changed file, within reason: enough to keep the scene busy on
 * a one-file change, few enough not to crowd it on a big one. The agents can't
 * say how far along they are, so it runs open-ended; the line under it says
 * whether the run is still writing anything.
 */
function RunLoader({
  kind,
  running,
  handingOver,
  runId,
  caption,
  onLeft,
}: {
  kind: AgentRunKind;
  running: boolean;
  handingOver: boolean;
  runId: number;
  caption: string;
  onLeft: () => void;
}) {
  const fileCount = useTab((state) => state.summary?.files.length ?? 0);
  return (
    <Fold open appear className={css.notice}>
      <ReviewLoader
        key={runId}
        count={Math.min(9, Math.max(5, fileCount))}
        leaving={!running}
        onLeft={onLeft}
      />
      <p
        className={
          handingOver
            ? `${css.status} ${css.loaderStatus} ${css.statusLeaving}`
            : `${css.status} ${css.loaderStatus}`
        }
      >
        {caption} This can take a few minutes on a large change.
      </p>
      <RunProgress kind={kind} className={css.loaderProgress} />
    </Fold>
  );
}

/**
 * The agent, model and effort the next review or explanation runs with. Both
 * tabs share them, and a run in flight keeps whatever it started with, so they
 * can change at any time.
 */
function AgentSettings() {
  const reviewEngine = useAppStore((state) => state.reviewEngine);
  const reviewModel = useAppStore((state) => state.reviewModel);
  const reviewEffort = useAppStore((state) => state.reviewEffort);
  const setReviewEngine = useAppStore((state) => state.setReviewEngine);
  const setReviewModel = useAppStore((state) => state.setReviewModel);
  const setReviewEffort = useAppStore((state) => state.setReviewEffort);
  const agentModels = useAgentModels(reviewEngine);
  const modelName = useModelLabel(reviewEngine, reviewModel);

  return (
    <div className={css.controls}>
      <Popover.Root>
        <Popover.Trigger
          render={<Button variant="ghost" size="sm" className={css.settingsTrigger} />}
          title="Choose the agent, model and effort for reviews and explanations"
        >
          <Icon name="sliders" />
          <span className={css.settingsSummary}>
            {[
              ENGINE_LABELS[reviewEngine],
              modelName ?? "default model",
              agentModels.efforts.includes(reviewEffort) ? `${reviewEffort} effort` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <Icon name="chevron-down" />
        </Popover.Trigger>
        <Popover.Popup align="start" className={css.settingsPopup}>
          <Popover.Title className={css.settingsTitle}>Agent</Popover.Title>
          <div className={css.settingsField}>
            <span className={css.settingsLabel}>Engine</span>
            <Select
              size="sm"
              aria-label="Agent engine"
              items={ENGINE_OPTIONS}
              value={reviewEngine}
              onValueChange={(engine) => engine && setReviewEngine(engine)}
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
            />
          </div>
          <p className={css.settingsHint}>
            Leave the model blank to use the CLI's own default. Reviews and explanations share
            these.
          </p>
        </Popover.Popup>
      </Popover.Root>
    </div>
  );
}

/**
 * One button that changes job: the first press reviews, and once a review
 * exists it becomes a follow-up — check the stored findings against the
 * current code, then look for new problems.
 */
function ReviewButton() {
  const reviewEngine = useAppStore((state) => state.reviewEngine);
  const hasReview = useTab((state) => state.reviews[reviewEngine] != null);
  const reviewing = useTab((state) => state.reviewing);
  const reReviewing = useTab((state) => state.reReviewing);
  const hasDiff = useTab((state) => (state.summary?.files.length ?? 0) > 0 && !state.loadingDiff);
  const runReview = useTab((state) => state.runReview);
  const runReReview = useTab((state) => state.runReReview);
  const busy = reviewing || reReviewing;
  const agent = ENGINE_LABELS[reviewEngine];

  return (
    <Button
      variant="primary"
      size="sm"
      onClick={() => void (hasReview ? runReReview() : runReview())}
      disabled={busy || !hasDiff}
      title={
        hasDiff
          ? hasReview
            ? `Ask ${agent} to check that its previous findings were addressed, then review the changed code for new issues`
            : `Ask ${agent} to review this comparison`
          : "Nothing to review until a comparison has changes"
      }
    >
      {/* No spinner while busy: the loader below already shows the run. */}
      {busy ? null : <Icon name="sparkle" className={css.actionIcon} />}
      {reviewing
        ? "Reviewing…"
        : reReviewing
          ? "Re-reviewing…"
          : hasReview
            ? "Re-review"
            : "Review"}
    </Button>
  );
}

function ExplainButton() {
  const reviewEngine = useAppStore((state) => state.reviewEngine);
  const hasExplanation = useTab((state) => state.explanation != null);
  const explaining = useTab((state) => state.explaining);
  const hasDiff = useTab((state) => (state.summary?.files.length ?? 0) > 0 && !state.loadingDiff);
  const runExplain = useTab((state) => state.runExplain);

  return (
    <Button
      variant="primary"
      size="sm"
      onClick={() => void runExplain()}
      disabled={explaining || !hasDiff}
      title={
        hasDiff
          ? `Ask ${ENGINE_LABELS[reviewEngine]} to walk through this comparison, and leave a note on each file that needs one`
          : "Nothing to explain until a comparison has changes"
      }
    >
      {explaining ? null : <Icon name="sparkle" className={css.actionIcon} />}
      {explaining ? "Explaining…" : hasExplanation ? "Re-explain" : "Explain"}
    </Button>
  );
}

/** The review: every engine's findings, the previous ones' verdicts, and the conclusion. */
function ReviewTab() {
  const pr = useTab((state) => state.pr);
  const reviews = useTab((state) => state.reviews);
  const reviewing = useTab((state) => state.reviewing);
  const reReviewing = useTab((state) => state.reReviewing);
  const reviewError = useTab((state) => state.reviewError);
  const patch = useTab((state) => state.patch);
  const dismissReviewError = useTab((state) => state.dismissReviewError);
  const reviewEngine = useAppStore((state) => state.reviewEngine);
  const agent = ENGINE_LABELS[useTab((state) => runningEngine(state, "review")) ?? reviewEngine];

  const running = reviewing || reReviewing;
  const { handingOver, label, runId, shown, revealed, shapesLeft } = useRunHandover(
    running,
    reReviewing
      ? `${agent} is checking whether its previous findings were addressed, then reviewing the changed code for new issues.`
      : `${agent} is reading the diff and the surrounding code.`,
    reviews,
  );
  const bodyRef = useRef<HTMLDivElement>(null);
  useRevealInOrder(bodyRef, revealed);

  const sources = useMemo(() => reviewsNewestFirst(shown), [shown]);
  const findings = useMemo(
    () =>
      inDiffOrder(
        sources.flatMap((source) => source.review.findings.map((finding) => ({ finding, source }))),
        (item) => item.finding,
      ),
    [sources],
  );
  const resolutions = useMemo(
    () =>
      inDiffOrder(
        sources.flatMap((source) =>
          (source.resolutions ?? []).map((resolution) => ({ resolution, source })),
        ),
        (item) => item.resolution.finding,
      ),
    [sources],
  );
  const latest = sources[0];
  // "New" only reads right when every review listed is a follow-up.
  const followUps = sources.length > 0 && sources.every((source) => source.resolutions?.length);

  return (
    <>
      <AgentSettings />
      {/* While a finished run hands over, the review it replaces fades out. */}
      <div ref={bodyRef} className={handingOver ? `${css.body} ${css.replacing}` : css.body}>
        {reviewError ? (
          <ErrorNotice error={reviewError} onDismiss={dismissReviewError} className={css.error} />
        ) : null}

        {running || handingOver ? (
          <RunLoader
            kind="review"
            running={running}
            handingOver={handingOver}
            runId={runId}
            caption={label}
            onLeft={shapesLeft}
          />
        ) : null}

        {latest ? (
          <>
            <Section
              title={sources.length > 1 ? "Reviews" : "Review"}
              count={sources.length > 1 ? sources.length : undefined}
              reveal
            >
              <ul className={css.findings}>
                {sources.map((source) => (
                  <ReviewSummary key={source.engine} source={source} patch={patch} pr={pr} />
                ))}
              </ul>
            </Section>
            {resolutions.length > 0 ? (
              <Section title="Previous findings" count={resolutions.length} reveal>
                <ul className={css.findings}>
                  {resolutions.map(({ resolution, source }) => (
                    <Resolution
                      key={sourcedKey(source.engine, resolutionThreadKey(resolution.finding))}
                      resolution={resolution}
                      source={source}
                      patch={patch}
                      pr={pr}
                    />
                  ))}
                </ul>
              </Section>
            ) : null}
            <Section title={followUps ? "New findings" : "Findings"} count={findings.length} reveal>
              {findings.length === 0 ? (
                <p className={css.status}>
                  {followUps
                    ? "No new findings beyond the previous review."
                    : "No findings — the diff came back clean."}
                </p>
              ) : (
                <ul className={css.findings}>
                  {findings.map(({ finding, source }) => (
                    <Finding
                      key={sourcedKey(source.engine, findingThreadKey(finding))}
                      finding={finding}
                      source={source}
                      patch={patch}
                      pr={pr}
                    />
                  ))}
                </ul>
              )}
            </Section>
            {/* Keyed on the review, so a fresh one resets the draft and the
                preselected verdict to what it recommends. */}
            <Conclusion key={`${latest.engine}:${latest.createdAt}`} source={latest} pr={pr} />
          </>
        ) : null}
        <Fold
          open={sources.length === 0 && !running && !handingOver && !reviewError}
          className={css.notice}
        >
          <p className={css.status}>
            Nothing runs until you press Review. Every engine's findings land here, kept per
            comparison for when you come back.
          </p>
        </Fold>
      </div>
    </>
  );
}

/**
 * The explanation: a walkthrough of the change for a reader who hasn't seen
 * it, written to be skimmed. Its notes on individual files go to the diff.
 */
function ExplainTab() {
  const stored = useTab((state) => state.explanation);
  const explaining = useTab((state) => state.explaining);
  const explainError = useTab((state) => state.explainError);
  const dismissExplainError = useTab((state) => state.dismissExplainError);
  const reviewEngine = useAppStore((state) => state.reviewEngine);
  const agent = ENGINE_LABELS[useTab((state) => runningEngine(state, "explain")) ?? reviewEngine];

  const { handingOver, label, runId, shown, revealed, shapesLeft } = useRunHandover(
    explaining,
    `${agent} is reading the change and the code around it.`,
    stored,
  );
  const bodyRef = useRef<HTMLDivElement>(null);
  useRevealInOrder(bodyRef, revealed);

  return (
    <>
      <AgentSettings />
      <div ref={bodyRef} className={handingOver ? `${css.body} ${css.replacing}` : css.body}>
        {explainError ? (
          <ErrorNotice error={explainError} onDismiss={dismissExplainError} className={css.error} />
        ) : null}
        {explaining || handingOver ? (
          <RunLoader
            kind="explain"
            running={explaining}
            handingOver={handingOver}
            runId={runId}
            caption={label}
            onLeft={shapesLeft}
          />
        ) : null}
        {/* Keyed so a fresh explanation starts with its sections as they open. */}
        {shown ? <Explanation key={shown.createdAt} stored={shown} /> : null}
        <Fold open={!shown && !explaining && !handingOver && !explainError} className={css.notice}>
          <p className={css.status}>
            Nothing runs until you press Explain. You get a walkthrough of the change here, and a
            short note at the top of each file in the diff that needs one.
          </p>
        </Fold>
      </div>
    </>
  );
}

/**
 * A tab's icon, or a spinner while its run is going, so a run shows from the
 * other tabs too. The icon gives way when the panel is narrow; the spinner
 * stays, being the part that says something.
 */
function TabIcon({ name, running }: { name: "sparkle" | "info"; running: boolean }) {
  return running ? <Spinner /> : <Icon name={name} className={css.tabIcon} />;
}

export function ReviewPanel() {
  const pr = useTab((state) => state.pr);
  // A PR opening from the list gets its tab straight away, loading, so the
  // panel doesn't switch tabs under the reader when the PR arrives.
  const hasPr = useTab((state) => state.pr != null || state.pendingPr != null);
  const reviewing = useTab((state) => state.reviewing || state.reReviewing);
  const explaining = useTab((state) => state.explaining);
  // Every open tab has a panel of its own, so a PR opens on its PR tab and
  // keeps whichever tab the reader picks after that.
  const [tab, setTab] = useState<PanelTab>("pr");
  // The diff's comment markers lead to the PR tab, where the comments are read.
  const focusTick = useTab((state) => state.commentFocus?.tick ?? 0);
  const [focusedTick, setFocusedTick] = useState(focusTick);
  if (focusTick !== focusedTick) {
    setFocusedTick(focusTick);
    setTab("pr");
  }
  // With no PR there is no PR tab.
  const activeTab: PanelTab = tab === "pr" && !hasPr ? "ai" : tab;

  return (
    <Tabs.Root
      className={css.panel}
      value={activeTab}
      onValueChange={(value) => setTab(value as PanelTab)}
    >
      <div className={css.tabBar}>
        <Tabs.List className={css.tabList} aria-label="Review panel">
          {hasPr ? (
            <Tabs.Tab value="pr">
              <Icon name="pull-request" className={css.tabIcon} /> PR
            </Tabs.Tab>
          ) : null}
          {/* The short labels take over when the panel is too narrow for the long ones. */}
          <Tabs.Tab value="ai">
            <TabIcon name="sparkle" running={reviewing} />{" "}
            <span className={css.tabLong}>AI review</span>
            <span className={css.tabShort}>Review</span>
          </Tabs.Tab>
          <Tabs.Tab value="explain">
            <TabIcon name="info" running={explaining} />{" "}
            <span className={css.tabLong}>AI explain</span>
            <span className={css.tabShort}>Explain</span>
          </Tabs.Tab>
        </Tabs.List>
        <div className={css.tabActions}>
          {activeTab === "pr" ? (
            <PrRefreshButton />
          ) : activeTab === "ai" ? (
            <ReviewButton />
          ) : (
            <ExplainButton />
          )}
        </div>
      </div>
      {/* All stay mounted so drafts, open composers and runs' loaders survive a tab switch. */}
      {hasPr ? (
        <Tabs.Panel value="pr" keepMounted className={css.tabPanel}>
          {pr ? <PrSection pr={pr} /> : <PrSkeleton />}
        </Tabs.Panel>
      ) : null}
      <Tabs.Panel value="ai" keepMounted className={css.tabPanel}>
        <ReviewTab />
      </Tabs.Panel>
      <Tabs.Panel value="explain" keepMounted className={css.tabPanel}>
        <ExplainTab />
      </Tabs.Panel>
    </Tabs.Root>
  );
}
