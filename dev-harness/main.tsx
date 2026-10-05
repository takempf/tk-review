/**
 * Runs the real App in a plain browser with the Rust backend stubbed, so the UI
 * and the @pierre/diffs rendering path can be driven without the native shell.
 * Not part of the app bundle.
 */
import { emit } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { GitError, PrContext, PrThread } from "../src/ipc/git";
import { Root } from "../src/Root";
import { storageRoot } from "../src/store/account";
import "../src/styles/global.css";
import {
  BRANCHES,
  COMMITS,
  EXPLANATION,
  GH_POST_ERROR,
  OUT_OF_TURNS_ERROR,
  PR,
  PR_LIST,
  RE_REVIEW,
  REPO,
  REVIEW,
  SUMMARY,
  VERSIONS,
} from "./fixture";
import { PATCH } from "./patch";

mockWindows("main");

/**
 * Failures to act out, from `?fail=` (comma-separated), so error states can be
 * seen without breaking a real CLI:
 * - `review`: reviews and re-reviews run out of turns and can't be rescued.
 * - `turns`: they run out of turns but answer from what they had read.
 * - `explain`: the explanation fails with a plain message and no detail.
 * - `post`: sending to the PR fails the way `gh api` does.
 * - `list`: listing pull requests fails with git-style multi-line stderr.
 * - `refresh`: refreshing the PR fails, which shows in the banner under the header.
 * - `resolve`: resolving or reopening a review thread is refused, as GitHub
 *   refuses someone without write access.
 */
const failing = new Set(new URLSearchParams(location.search).get("fail")?.split(",") ?? []);

/**
 * How agent runs behave, from `?run=`, so their progress line can be seen:
 * - `slow`: they take ten minutes, writing every couple of seconds.
 * - `silent`: they take ten minutes and write nothing, so the line warns.
 */
const runMode = new URLSearchParams(location.search).get("run");

/**
 * Extra open PRs from `?prs=`, to scroll the list through several pages:
 * `?prs=200` lists 200 more after the fixtures, 100 to a page as `gh` returns
 * them. They vary the way real ones do (title lengths, logins, labels, sizes
 * that grow a digit on later pages) and one early PR is stacked on one from
 * the second page, so a page arriving reshapes the rows already shown.
 */
const PAGE_SIZE = 100;
const WORDS =
  "tighten how the review panel handles stale comments after a force push rewrites the branch".split(
    " ",
  );
const LOGINS = ["octocat", "mona", "hubot", "a-much-longer-contributor-login"];
const MANY_PRS = Array.from(
  { length: Number(new URLSearchParams(location.search).get("prs") ?? 0) },
  (_, index) => {
    const number = 1000 + index;
    const words = index % 3 === 0 ? `: ${WORDS.slice(0, 3 + (index % 13)).join(" ")}` : "";
    return {
      ...PR_LIST[2],
      number,
      title: `Generated pull request ${number}${words}`,
      author: LOGINS[index % LOGINS.length] ?? "octocat",
      url: `https://github.com/example/tk-review/pull/${number}`,
      headRef: `generated/${number}`,
      baseRef: index === 5 ? "generated/1160" : "main",
      labels:
        index % 5 === 0
          ? [
              { name: "needs-design-review", color: "d876e3" },
              { name: "backend", color: "0e8a16" },
            ]
          : [],
      additions: index < 100 ? 10 + index : 10_000 + index * 37,
      updatedAt: new Date(Date.UTC(2026, 6, 1) - index * 36e5).toISOString(),
      requested: index % 3 === 0,
      mine: false,
    } as (typeof PR_LIST)[number];
  },
);

/**
 * Who `gh` is signed in as, from `?login=`: `?login=octocat` to be the author
 * of the PR the harness opens (#47), `?login=` for nobody signed in.
 */
const loginParam = new URLSearchParams(location.search).get("login");
const repo = { ...REPO, githubLogin: loginParam === null ? REPO.githubLogin : loginParam || null };
const scope = storageRoot(repo);

/** Cancels for the agent runs in flight, by run id. */
const cancels = new Map<string, () => void>();

/**
 * An agent run: settles after `ms` like `later`, reporting output as it goes
 * unless `?run=silent`, and rejects as cancelled if `cancel_agent_run` names it.
 */
function agentRun<T>(payload: unknown, ms: number, value: T, error?: GitError): Promise<T> {
  const runId = (payload as { runId: string }).runId;
  const duration = runMode === "slow" || runMode === "silent" ? 10 * 60_000 : ms;
  return new Promise<T>((resolve, reject) => {
    const output =
      runMode === "silent"
        ? undefined
        : setInterval(() => void emit("agent-run-output", runId), runMode ? 2000 : 400);
    const end = () => {
      clearTimeout(timer);
      clearInterval(output);
      cancels.delete(runId);
    };
    const timer = setTimeout(() => {
      end();
      if (error) reject(error);
      else resolve(value);
    }, duration);
    cancels.set(runId, () => {
      end();
      reject({ kind: "cancelled", message: "the run was cancelled", detail: null });
    });
  });
}

/** Settles after `ms` like a real round-trip: rejecting with `error`, if given. */
function later<T>(ms: number, value: T, error?: GitError): Promise<T> {
  return new Promise((resolve, reject) =>
    setTimeout(() => (error ? reject(error) : resolve(value)), ms),
  );
}

let nextPostedComment = 900;

/**
 * What the harness has posted as inline or file comments, each a thread of its
 * own with the PR author's reply under it, and every thread's resolved state
 * as changed here. The PR shows them once it is next read, as on GitHub.
 */
const posted: { comments: PrContext["comments"]; threads: PrThread[] } = {
  comments: [],
  threads: PR.threads.map((thread) => ({ ...thread })),
};

/** The fixture PR's conversation, with what the harness has posted and resolved since. */
function withPosted(pr: PrContext): PrContext {
  // Copies, as IPC would hand over: the app must not see a thread change
  // before the command that changes it answers.
  return structuredClone({
    ...pr,
    comments: [...pr.comments, ...posted.comments],
    threads: posted.threads,
  });
}

/**
 * The fixture PR, retitled as whichever listed PR `url` names, so each row on
 * the list opens a tab of its own. They all share its diff and conversation.
 */
function prFor(url: string): PrContext {
  const number = Number(/(\d+)\/?$/.exec(url)?.[1] ?? /#(\d+)$/.exec(url)?.[1]);
  const listed = PR_LIST.find((pr) => pr.number === number);
  if (!listed || listed.number === PR.number) return withPosted(PR);
  return {
    ...withPosted(PR),
    url: listed.url,
    number: listed.number,
    title: listed.title,
    author: listed.author,
    isDraft: listed.isDraft,
    headRef: listed.headRef,
    baseRef: listed.baseRef,
    headSha: listed.headSha ?? PR.headSha,
    compareRef: `tk-review/pr/${listed.number}`,
  };
}

/** The backend: every command the app sends, answered from the fixtures. */
function answer(command: string, payload: unknown): unknown {
  switch (command) {
    case "select_repo":
      return repo;
    case "list_branches":
      return BRANCHES;
    // Delayed so the "Fetching…" state is visible in the harness.
    case "fetch_remotes":
      return new Promise((resolve) => setTimeout(() => resolve(null), 800));
    // Delayed like a real `gh` call, so the loading and refreshing states are
    // visible. Lists are cached across reloads (src/lib/queries.ts): remove
    // `tk-review:query-cache` from localStorage to see a cold load again.
    case "list_prs": {
      const { filter = "all", after = null } = payload as {
        filter?: string;
        after?: string | null;
      };
      const listed = [...PR_LIST, ...MANY_PRS].filter((pr) =>
        filter === "reviewRequested" ? pr.requested : filter === "mine" ? pr.mine : true,
      );
      // Paged like GitHub's: the cursor is where the page starts.
      const start = after ? Number(after) : 0;
      const end = start + PAGE_SIZE;
      return later(
        700,
        {
          prs: listed.slice(start, end),
          total: listed.length,
          next: end < listed.length ? String(end) : null,
        },
        failing.has("list")
          ? {
              kind: "command",
              message: [
                "hint: The GitHub CLI could not reach api.github.com.",
                "hint: Check your network connection, or set GH_HOST.",
                "hint: Run `gh auth status` to see which hosts you are logged in to.",
                "hint: Proxy settings are read from HTTPS_PROXY.",
                "error: connecting to api.github.com: dial tcp: lookup api.github.com: no such host",
              ].join("\n"),
            }
          : undefined,
      );
    }
    // Delayed like a real `gh` round-trip and fetch, so a tab can be seen opening.
    case "open_pr":
      return later(900, prFor((payload as { url: string }).url));
    // Delayed like a real `gh` round-trip, so both Refresh buttons can be seen
    // holding their busy state before the diff reloads behind them.
    case "refresh_pr":
      return later(
        900,
        { pr: prFor((payload as { pr: PrContext }).pr.url), headMoved: false },
        failing.has("refresh")
          ? {
              kind: "command",
              message: "gh: Could not resolve to a PullRequest with the number of 118. (HTTP 404)",
              detail: `gh pr view https://github.com/example/tk-review/pull/118 --json url,number,title,body,author,state,isDraft,baseRefName,headRefOid
exit status: 1

stderr:
gh: Could not resolve to a PullRequest with the number of 118. (HTTP 404)

stdout:
`,
            }
          : undefined,
      );
    case "post_pr_comment": {
      if (failing.has("post")) return later(600, null, GH_POST_ERROR);
      const { body, path, line, endLine, destination } = payload as {
        body: string;
        path: string | null;
        line: number | null;
        endLine: number | null;
        destination: string;
      };
      nextPostedComment += 1;
      if (destination === "topLevel") return { url: `${PR.url}#issuecomment-${nextPostedComment}` };
      const id = nextPostedComment;
      const reply = ++nextPostedComment;
      const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
      const anchor = {
        path,
        line: endLine ?? line,
        startLine: endLine != null ? line : null,
        outdated: false,
      };
      posted.comments.push(
        { id, author: repo.githubLogin ?? "you", body, createdAt: at(0), ...anchor },
        {
          id: reply,
          author: PR.author,
          body: "Fixed — moved it as suggested, and added a test that covers it.",
          createdAt: at(30),
          ...anchor,
        },
      );
      posted.threads.push({
        id: `T${id}`,
        resolved: false,
        resolvedBy: null,
        outdated: false,
        commentIds: [id, reply],
      });
      return { url: `${PR.url}#discussion_r${id}` };
    }
    // Delayed like a real `gh` round-trip, so "Resolving…" is visible.
    case "set_pr_thread_resolved": {
      const { threadId, resolved } = payload as { threadId: string; resolved: boolean };
      if (failing.has("resolve")) {
        return later(500, null, {
          kind: "command",
          message: "GraphQL: Resource not accessible by integration (resolveReviewThread)",
          detail: null,
        });
      }
      const thread = posted.threads.find((candidate) => candidate.id === threadId);
      if (!thread)
        return later(500, null, { kind: "command", message: "No such thread", detail: null });
      thread.resolved = resolved;
      thread.resolvedBy = resolved ? (repo.githubLogin ?? "you") : null;
      return later(500, { ...thread });
    }
    // Delayed like a real `gh` round-trip, so "Submitting…" is visible.
    case "submit_pr_review":
      return new Promise((resolve) =>
        setTimeout(
          () => resolve({ url: `${PR.url}#pullrequestreview-${++nextPostedComment}` }),
          700,
        ),
      );
    // The working tree is not a commit, so it has no head to report.
    case "diff_branches":
      return (payload as { compare: string | null }).compare == null
        ? { ...SUMMARY, compareHead: null }
        : SUMMARY;
    // From the merge base, the PR's changes; between two later commits (a
    // prior finding followed to the PR's head), nothing changed.
    case "get_patch":
      return (payload as { mergeBase: string }).mergeBase === SUMMARY.mergeBase ? PATCH : "";
    case "list_commits":
      return COMMITS;
    case "get_file_versions": {
      const path = (payload as { path: string }).path;
      return VERSIONS[path] ?? { old: null, new: null };
    }
    // Delayed so the "Reviewing…" state is visible in the harness.
    case "review_diff":
      return agentRun(
        payload,
        1500,
        { ...REVIEW, cutShort: failing.has("turns") },
        failing.has("review") ? OUT_OF_TURNS_ERROR : undefined,
      );
    // Delayed so the "Re-reviewing…" state is visible in the harness.
    case "re_review_diff":
      return agentRun(
        payload,
        1500,
        { ...RE_REVIEW, cutShort: failing.has("turns") },
        failing.has("review") ? OUT_OF_TURNS_ERROR : undefined,
      );
    // Slower than the review on purpose: the two run independently, and each
    // tab has to stay usable while the other's run is still going.
    case "explain_diff":
      return agentRun(
        payload,
        2600,
        EXPLANATION,
        failing.has("explain")
          ? { kind: "command", message: "There is nothing to explain: the diff is empty." }
          : undefined,
      );
    case "review_reply":
      return agentRun(
        payload,
        1200,
        "Fair question — the backfill matters because rows created before this migration " +
          "have no merge_base value, so the NOT NULL constraint fails the moment the ALTER runs. " +
          "Backfill from the diff header, or add a DEFAULT and tighten later.",
      );
    case "cancel_agent_run":
      cancels.get((payload as { runId: string }).runId)?.();
      return null;
    default:
      return null;
  }
}

// Events too, so the harness's agent runs can report output.
mockIPC(answer, { shouldMockEvents: true });

// Skips the folder picker: the store opens whatever repo it remembers.
localStorage.setItem("tk-review:last-repo", REPO.root);
localStorage.setItem(
  "tk-review:recent-repos",
  JSON.stringify([
    { root: REPO.root, name: REPO.name, openedAt: new Date().toISOString() },
    {
      root: "/Users/example/work/api",
      name: "api",
      openedAt: new Date(Date.now() - 864e5).toISOString(),
    },
  ]),
);

// Two reviewed PRs: #118 at its current head, #47 with commits pushed since, so
// the home screen shows both states. Plus a merged one only history knows about.
{
  const reviewed = (
    number: number,
    title: string,
    headSha: string,
    hoursAgo: number,
    findings: number,
  ) => ({
    root: scope,
    number,
    title,
    url: `https://github.com/example/tk-review/pull/${number}`,
    author: "octocat",
    headSha,
    engine: "claude",
    createdAt: new Date(Date.now() - hoursAgo * 36e5).toISOString(),
    findings,
  });
  localStorage.setItem(
    "tk-review:review-index",
    JSON.stringify({
      [`${scope}#118`]: reviewed(118, "Fix stale diffs after a force push", "118b", 4, 0),
      [`${scope}#47`]: reviewed(47, "Render review findings in the PR workflow", "old", 30, 3),
      [`${scope}#96`]: reviewed(96, "Split the review panel into tabs", "96z", 120, 2),
    }),
  );
}

// An explanation already on record, for PR #47 and for the same branches
// compared directly, so the walkthrough and the file notes render on load
// rather than only after a mocked agent run. Set `mergeBase` to anything else
// here to see the "older version" note.
for (const comparison of [
  `${PR.baseRemote}/${PR.baseRef}...${PR.compareRef}`,
  "main...feature/diff-viewer",
]) {
  localStorage.setItem(
    `tk-review:explanations:${scope}:${comparison}`,
    JSON.stringify({
      explanation: EXPLANATION,
      engine: "claude",
      model: null,
      effort: null,
      mergeBase: SUMMARY.mergeBase,
      createdAt: new Date().toISOString(),
    }),
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("missing #root element");

createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
