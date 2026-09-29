/**
 * Runs the real App in a plain browser with the Rust backend stubbed, so the UI
 * and the @pierre/diffs rendering path can be driven without the native shell.
 * Not part of the app bundle.
 */
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../src/App";
import "../src/styles/global.css";
import {
  BRANCHES,
  EXPLANATION,
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

let nextPostedComment = 900;

mockIPC((command, payload) => {
  switch (command) {
    case "select_repo":
      return REPO;
    case "list_branches":
      return BRANCHES;
    // Delayed so the "Fetching…" state is visible in the harness.
    case "fetch_remotes":
      return new Promise((resolve) => setTimeout(() => resolve(null), 800));
    // Delayed like a real `gh` call, so the loading and refreshing states are
    // visible. Lists are cached across reloads (src/lib/queries.ts): remove
    // `tk-review:query-cache` from localStorage to see a cold load again.
    case "list_prs": {
      const filter = (payload as { filter?: string }).filter ?? "all";
      const listed = PR_LIST.filter((pr) =>
        filter === "reviewRequested" ? pr.requested : filter === "mine" ? pr.mine : true,
      );
      return new Promise((resolve) => setTimeout(() => resolve(listed), 700));
    }
    case "open_pr":
      return PR;
    // Delayed like a real `gh` round-trip, so both Refresh buttons can be seen
    // holding their busy state before the diff reloads behind them.
    case "refresh_pr":
      return new Promise((resolve) => setTimeout(() => resolve({ pr: PR, headMoved: false }), 900));
    case "post_pr_comment": {
      nextPostedComment += 1;
      return { url: `${PR.url}#issuecomment-${nextPostedComment}` };
    }
    case "diff_branches":
      return SUMMARY;
    case "get_patch":
      return PATCH;
    case "get_file_versions": {
      const path = (payload as { path: string }).path;
      return VERSIONS[path] ?? { old: null, new: null };
    }
    // Delayed so the "Reviewing…" state is visible in the harness.
    case "review_diff":
      return new Promise((resolve) => setTimeout(() => resolve(REVIEW), 1500));
    // Delayed so the "Re-reviewing…" state is visible in the harness.
    case "re_review_diff":
      return new Promise((resolve) => setTimeout(() => resolve(RE_REVIEW), 1500));
    // Slower than the review on purpose: the two run independently, and the
    // panel has to stay usable while only one of them is still going.
    case "explain_diff":
      return new Promise((resolve) => setTimeout(() => resolve(EXPLANATION), 2600));
    case "review_reply":
      return new Promise((resolve) =>
        setTimeout(
          () =>
            resolve(
              "Fair question — the backfill matters because rows created before this migration " +
                "have no merge_base value, so the NOT NULL constraint fails the moment the ALTER runs. " +
                "Backfill from the diff header, or add a DEFAULT and tighten later.",
            ),
          1200,
        ),
      );
    default:
      return null;
  }
});

// Skips the folder picker: the store opens whatever repo it remembers.
localStorage.setItem("tk-review:last-repo", REPO.root);

// Explain mode on, with a result already on record, so the middle column's
// explanations render on load rather than only after a mocked agent run.
// Set `mergeBase` to anything else here to see the "older version" note.
localStorage.setItem("tk-review:explain-mode", "true");
localStorage.setItem(
  `tk-review:explanations:${REPO.root}:main...feature/diff-viewer`,
  JSON.stringify({
    explanation: EXPLANATION,
    engine: "claude",
    model: null,
    effort: null,
    mergeBase: SUMMARY.mergeBase,
    createdAt: new Date().toISOString(),
  }),
);

const container = document.getElementById("root");
if (!container) throw new Error("missing #root element");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
