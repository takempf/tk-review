import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button, Icon, Popover, Radio, RadioGroup, Select, Tabs } from "tk-design-system";
import {
  type EngineModels,
  gitApi,
  type PrContext,
  type ReviewComment,
  type ReviewEngine,
  type ReviewFinding,
  type ReviewVerdict,
} from "../../ipc/git";
import { ENGINE_LABELS } from "../../lib/engines";
import { splitPath } from "../../lib/fileChange";
import { findingLines, formatLines, type LineSpan } from "../../lib/lineSpan";
import { postBodyForFinding, postLocationForFinding } from "../../lib/prComment";
import { absoluteTime, shortTime } from "../../lib/time";
import { knownVerdict } from "../../lib/verdict";
import { useAppStore } from "../../store/appStore";
import {
  type AgentRunKind,
  CONCLUSION_POST_KEY,
  findingThreadKey,
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
import { Combobox } from "../Combobox/Combobox";
import { CopyButton } from "../CopyButton/CopyButton";
import { ErrorNotice } from "../ErrorNotice/ErrorNotice";
import { Fold } from "../Fold/Fold";
import { GitHubMarkdown } from "../Markdown/Markdown";
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

/** Stable fallback: a fresh `[]` from a selector re-renders forever. */
const EMPTY_THREAD: ReviewComment[] = [];
const TAB_KEY = "tk-review:review-panel:tab";
type PanelTab = "pr" | "ai" | "explain";
const PANEL_TABS: PanelTab[] = ["pr", "ai", "explain"];
function persistedTab(): PanelTab {
  try {
    const stored = localStorage.getItem(TAB_KEY);
    return PANEL_TABS.find((tab) => tab === stored) ?? "ai";
  } catch {
    return "ai";
  }
}

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

function PrSection({ pr }: { pr: PrContext }) {
  const selectFile = useTab((state) => state.selectFile);
  const prHeadMoved = useTab((state) => state.prHeadMoved);
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
 * Which review an item came from: the panel shows every engine's review at
 * once, so each finding, verdict and conclusion carries its engine and model.
 * The effort and time, which the review's own heading gives in full, are in
 * the tooltip.
 */
function SourceTag({ source }: { source: StoredReview }) {
  const label = [ENGINE_LABELS[source.engine] ?? source.engine, source.model].filter(Boolean);
  const detail = [
    ...label,
    source.effort ? `${source.effort} effort` : null,
    absoluteTime(source.createdAt),
  ].filter(Boolean);
  return (
    <span className={css.sourceTag} title={detail.join(" · ")}>
      {label.join(" · ")}
    </span>
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

/** A deliberate, editable hand-off from an AI finding to a GitHub comment. */
function PrCommentComposer({
  engine,
  finding,
  patch,
  pr,
  reviewBody,
  postedUrl,
}: {
  /** Whose review the finding or summary belongs to. */
  engine: ReviewEngine;
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
  const postingTo = useTab((state) => state.postingTo);
  const postPrComment = useTab((state) => state.postPrComment);
  const targetKey = sourcedKey(engine, finding ? findingThreadKey(finding) : REVIEW_THREAD_KEY);
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
    void postPrComment(engine, finding, body, location).then((posted) => {
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

/**
 * One prior finding with the re-review's verdict on it. The card mirrors a
 * finding's, but the chip is the verdict rather than the severity — what the
 * reader needs here is "is this done?", not how bad it was the first time.
 * Its comment thread carries over from the finding it judges, under a key of
 * its own so a look-alike new finding cannot inherit it.
 */
function Resolution({ resolution, source }: { resolution: ResolvedFinding; source: StoredReview }) {
  const { finding, status, note } = resolution;
  const threadKey = resolutionThreadKey(finding);
  const comments = useTab(
    (state) => state.reviews[source.engine]?.threads[threadKey] ?? EMPTY_THREAD,
  );

  return (
    <li className={css.finding} data-reveal>
      <div className={`${css.itemHead} ${css.titleHead}`}>
        <p className={`${css.findingTitle} ${resolutionClass(status)}`}>
          <span className={css.severity}>{status}</span> {finding.title}
        </p>
        <CopyButton text={findingMarkdown(finding, status, note ?? "")} label="Copy verdict" />
      </div>
      <div className={css.findingMeta}>
        <FindingLocation path={finding.path} lines={findingLines(finding)} />
        <SourceTag source={source} />
      </div>
      {note ? <GitHubMarkdown markdown={note} className={css.agentMarkdown} /> : null}
      <Thread
        threadKey={threadKey}
        comments={comments}
        engine={source.engine}
        placeholder="Ask about this verdict…"
        askLabel="Ask about this"
      />
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
      <div className={css.findingMeta}>
        <FindingLocation path={finding.path} lines={findingLines(finding)} />
        <SourceTag source={source} />
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
 */
function Conclusion({ source, pr }: { source: StoredReview; pr: PrContext | null }) {
  const { review } = source;
  const suggested = knownVerdict(review.verdict);
  const [verdict, setVerdict] = useState<ReviewVerdict>(suggested ?? "comment");
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
              reviewModel.trim() || "default model",
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
  const [tab, setTab] = useState(persistedTab);
  // With no PR there is no PR tab, whatever was last remembered.
  const activeTab: PanelTab = tab === "pr" && !hasPr ? "ai" : tab;
  function selectTab(next: PanelTab) {
    setTab(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      // The remembered tab is a convenience, never a dependency.
    }
  }

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
