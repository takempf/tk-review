// Stand-in git data for driving the UI in a plain browser, where the Rust
// backend is not present. The git layer itself is covered by cargo tests.
import type {
  Branch,
  CommitLog,
  DiffSummary,
  ExplainResult,
  FileVersions,
  GitError,
  PrContext,
  PrSummary,
  RepoInfo,
  ReReviewResult,
  ReviewResult,
} from "../src/ipc/git";

export const REPO: RepoInfo = {
  root: "/Users/timothy/Repos/tk-review",
  name: "tk-review",
  currentBranch: "feature/diff-viewer",
  defaultBranch: "main",
};

export const BRANCHES: Branch[] = [
  { name: "feature/diff-viewer", isRemote: false, isHead: true },
  { name: "main", isRemote: false, isHead: false },
  // Long enough to exercise the popup growing past the field's width, and long
  // enough again to hit the cap where items start to ellipsize.
  {
    name: "feature/normalize-surfaces-and-theme-the-diff-renderer",
    isRemote: false,
    isHead: false,
  },
  { name: "origin/main", isRemote: true, isHead: false },
  { name: "origin/feature/diff-viewer", isRemote: true, isHead: false },
];

/**
 * The compare side's commits, newest first: the first is `SUMMARY.compareHead`,
 * so a review run in the harness lands on it. Dated in the past, so a stored
 * review without a head places by time among them.
 */
export const COMMITS: CommitLog = {
  truncated: false,
  commits: [
    {
      sha: "4d81e7c0a3f95b2d61c8e47f0b9a2d3e5c6f7a81",
      subject: "Keep viewed files collapsed across a refresh",
      author: "Timothy Kempf",
      committedAt: "2026-09-29T17:12:00-07:00",
    },
    {
      sha: "b7f2a9e14c6d08f3a5b9e2c7d1f4a6b8c0e3d5f7",
      subject: "Address review: backfill merge_base before NOT NULL",
      author: "Timothy Kempf",
      committedAt: "2026-09-28T11:05:00-07:00",
    },
    {
      sha: "e91c3d5a7b2f4e6c8a0d1b3f5e7c9a2b4d6f8e0a",
      subject: "Add the reviews table migration",
      author: "Timothy Kempf",
      committedAt: "2026-09-27T15:48:00-07:00",
    },
    {
      sha: "3a6f8c1e5d7b9a2c4e6f8a0b2d4c6e8f0a2b4c6d",
      subject: "Flag linguist-generated files in the sidebar",
      author: "Timothy Kempf",
      committedAt: "2026-09-26T09:30:00-07:00",
    },
  ],
};

/**
 * Mirrors what the Rust backend reports for this fixture: the counts, statuses
 * and ordering below are git's own output for the generated patch (see
 * `generatePatch.ts`, which prints them). Keep them in step when the file
 * contents change, or the sidebar and the rendered diff will disagree.
 */
export const SUMMARY: DiffSummary = {
  mergeBase: "9f2c1ab",
  compareHead: "4d81e7c0a3f95b2d61c8e47f0b9a2d3e5c6f7a81",
  totalAdditions: 52,
  totalDeletions: 19,
  files: [
    {
      path: "migrations/0007_add_reviews_table.sql",
      oldPath: null,
      status: "modified",
      additions: 4,
      deletions: 0,
      isBinary: false,
      isGenerated: false,
    },
    {
      path: "src-tauri/icons/icon.png",
      oldPath: null,
      status: "modified",
      additions: 0,
      deletions: 0,
      isBinary: true,
      isGenerated: false,
    },
    {
      path: "src/components/DiffViewer/DiffViewer.tsx",
      oldPath: null,
      status: "modified",
      additions: 24,
      deletions: 5,
      isBinary: false,
      isGenerated: false,
    },
    {
      path: "src/ipc/git.ts",
      oldPath: null,
      status: "added",
      additions: 17,
      deletions: 0,
      isBinary: false,
      // Stands in for a codegen'd file so the harness exercises the generated
      // badge and the collapsed-by-default behaviour.
      isGenerated: true,
    },
    {
      path: "src/legacy/OldViewer.tsx",
      oldPath: null,
      status: "deleted",
      additions: 0,
      deletions: 14,
      isBinary: false,
      isGenerated: false,
    },
    {
      path: "src/lib/fileChange.ts",
      oldPath: "src/lib/status.ts",
      status: "renamed",
      additions: 7,
      deletions: 0,
      isBinary: false,
      isGenerated: false,
    },
  ],
};

const VIEWER_OLD = `import { useEffect, useState } from "react";
import type { FileChange } from "../../ipc/git";
import css from "./DiffViewer.module.css";

export function DiffViewer({ file }: { file: FileChange }) {
  const [contents, setContents] = useState<string | null>(null);

  useEffect(() => {
    loadFile(file.path).then(setContents);
  }, [file.path]);

  if (contents === null) {
    return <p className={css.message}>Loading…</p>;
  }

  return <pre className={css.plain}>{contents}</pre>;
}
`;

const VIEWER_NEW = `import { type DiffFileInput, MultiFileDiff } from "@pierre/diffs/react";
import { useEffect, useMemo, useState } from "react";
import type { FileChange } from "../../ipc/git";
import css from "./DiffViewer.module.css";

export function DiffViewer({ file }: { file: FileChange }) {
  const [versions, setVersions] = useState<FileVersions | null>(null);
  const layout = useReviewStore((state) => state.layout);

  useEffect(() => {
    let cancelled = false;
    getFileVersions(file).then((next) => {
      if (!cancelled) setVersions(next);
    });
    return () => {
      cancelled = true;
    };
  }, [file.path]);

  // DiffFileInput requires at least one side, so narrow before rendering.
  const input = useMemo<DiffFileInput | null>(() => {
    if (!versions) return null;
    const oldFile = versions.old !== null ? { name: file.path, contents: versions.old } : null;
    const newFile = versions.new !== null ? { name: file.path, contents: versions.new } : null;
    if (oldFile && newFile) return { oldFile, newFile };
    if (newFile) return { oldFile: null, newFile };
    if (oldFile) return { oldFile, newFile: null };
    return null;
  }, [versions, file.path]);

  if (!input) {
    return <p className={css.message}>Loading…</p>;
  }

  return <MultiFileDiff {...input} options={{ diffStyle: layout }} />;
}
`;

const GIT_TS = `import { invoke } from "@tauri-apps/api/core";

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface FileChange {
  path: string;
  oldPath: string | null;
  status: ChangeStatus;
  additions: number;
  deletions: number;
  isBinary: boolean;
}

export const gitApi = {
  selectRepo: (path: string) => invoke<RepoInfo>("select_repo", { path }),
  listBranches: (root: string) => invoke<Branch[]>("list_branches", { root }),
};
`;

// The two sides share most of their lines on purpose: below git's 50% similarity
// threshold this would be reported as an add plus a delete, and the fixture would
// stop exercising the renamed state at all.
const STATUS_OLD = `export const STATUS_META = {
  added: { letter: "A", label: "Added" },
  modified: { letter: "M", label: "Modified" },
  deleted: { letter: "D", label: "Deleted" },
  renamed: { letter: "R", label: "Renamed" },
  copied: { letter: "C", label: "Copied" },
};

export function splitPath(path: string) {
  const index = path.lastIndexOf("/");
  if (index === -1) return { dir: "", name: path };
  return { dir: path.slice(0, index + 1), name: path.slice(index + 1) };
}
`;

const STATUS_NEW = `export const STATUS_META = {
  added: { letter: "A", label: "Added" },
  modified: { letter: "M", label: "Modified" },
  deleted: { letter: "D", label: "Deleted" },
  renamed: { letter: "R", label: "Renamed" },
  copied: { letter: "C", label: "Copied" },
  typeChanged: { letter: "T", label: "Type changed" },
  unmerged: { letter: "U", label: "Unmerged" },
};

export function splitPath(path: string) {
  const index = path.lastIndexOf("/");
  if (index === -1) return { dir: "", name: path };
  return { dir: path.slice(0, index + 1), name: path.slice(index + 1) };
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return \\\`\\\${bytes} B\\\`;
  return \\\`\\\${(bytes / 1024).toFixed(1)} KB\\\`;
}
`;

const OLD_VIEWER = `import css from "./OldViewer.module.css";

// Superseded by DiffViewer, which renders through @pierre/diffs.
export function OldViewer({ patch }: { patch: string }) {
  return (
    <div className={css.wrap}>
      {patch.split("\\n").map((line, index) => (
        <div key={index} className={css.line}>
          {line}
        </div>
      ))}
    </div>
  );
}
`;

const SQL_OLD = `create table reviews (
  id uuid primary key default gen_random_uuid(),
  repo_id uuid not null references repos (id),
  base_ref text not null,
  compare_ref text not null,
  created_at timestamptz not null default now()
);

create index reviews_repo_id_idx on reviews (repo_id);
`;

const SQL_NEW = `create table reviews (
  id uuid primary key default gen_random_uuid(),
  repo_id uuid not null references repos (id),
  base_ref text not null,
  compare_ref text not null,
  merge_base text not null,
  viewed_paths text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index reviews_repo_id_idx on reviews (repo_id);

create index reviews_created_at_idx on reviews (created_at desc);
`;

const sided = (old: string | null, next: string | null): FileVersions => ({
  old,
  new: next,
});

export const VERSIONS: Record<string, FileVersions> = {
  "src/components/DiffViewer/DiffViewer.tsx": sided(VIEWER_OLD, VIEWER_NEW),
  "src/ipc/git.ts": sided(null, GIT_TS),
  "src/lib/fileChange.ts": sided(STATUS_OLD, STATUS_NEW),
  "src/legacy/OldViewer.tsx": sided(OLD_VIEWER, null),
  "migrations/0007_add_reviews_table.sql": sided(SQL_OLD, SQL_NEW),
};

/** Stand-in Claude review; exercises every severity, a line span, and a path outside the diff. */
export const REVIEW: ReviewResult = {
  summary:
    "A focused rework of the diff viewer's data flow, plus a schema migration. The riskiest part is the migration: it adds a non-null column without a backfill for existing rows.",
  verdict: "request_changes",
  conclusion:
    "One blocker before this merges:\n\n1. The migration fails on any existing database — `merge_base` needs a default or a backfill.\n\nThe effect cleanup race is worth fixing in the same pass.",
  findings: [
    {
      path: "migrations/0007_add_reviews_table.sql",
      line: 6,
      severity: "critical",
      title: "New non-null column has no default or backfill.",
      body: "merge_base is `not null` but existing rows get no value, so this migration fails on any non-empty database. Add a default, or backfill before tightening the constraint.",
    },
    {
      path: "src/components/DiffViewer/DiffViewer.tsx",
      // A span, so the harness shows one highlighted and posted as a range.
      line: 11,
      endLine: 18,
      severity: "warning",
      title: "Effect cleanup races the in-flight fetch.",
      body: "`cancelled` is checked after the promise resolves, but the store subscription set up above is never torn down when the file changes mid-fetch.",
    },
    {
      path: "src/ipc/git.ts",
      line: null,
      severity: "suggestion",
      title: "Error mapping could reuse the shared kind table.",
      body: "The new wrapper re-declares error strings that `errorMessage` already owns; importing the shared map keeps the copy from drifting.",
    },
    {
      path: "src/lib/fileChange.ts",
      line: 3,
      severity: "nit",
      title: "Comment describes the old return type.",
      body: "The docblock still says the helper returns a tuple; it now returns an object.",
    },
  ],
};

/**
 * Stand-in re-review of `REVIEW`: exercises every resolution status against
 * the four findings above, plus one new finding — the "fix that introduced
 * its own bug" case the feature exists to catch.
 */
export const RE_REVIEW: ReReviewResult = {
  summary:
    "The migration now backfills before tightening the constraint, and the stale docblock was rewritten. The effect cleanup got a guard but the store subscription still leaks, and the backfill update introduced an unindexed full-table scan.",
  verdict: "comment",
  conclusion:
    "Close — the migration blocker is fixed. Two things left:\n\n- The store subscription still leaks when the file changes mid-fetch.\n- The backfill scans the whole table before its index exists.",
  resolutions: [
    {
      index: 0,
      status: "addressed",
      note: "The migration now backfills merge_base from the diff header before adding NOT NULL; verified in the current migration file.",
    },
    {
      index: 1,
      status: "partial",
      note: "A `cancelled` guard now wraps the resolve path, but the store subscription created in the same effect is still never torn down.",
    },
    {
      index: 2,
      status: "unaddressed",
      note: "The wrapper still declares its own error strings; nothing imports the shared kind table.",
    },
    {
      index: 3,
      status: "obsolete",
      note: "The docblock was rewritten as part of the rename, so there is no stale tuple wording left to fix.",
    },
  ],
  findings: [
    {
      path: "migrations/0007_add_reviews_table.sql",
      line: 9,
      severity: "warning",
      title: "Backfill scans the whole table without an index.",
      body: "The new UPDATE added to satisfy the NOT NULL constraint runs before the index exists, so on a large reviews table the migration holds a long lock. Create the index first, or batch the update.",
    },
  ],
};

/**
 * Explain mode's output, shaped to exercise the rendering rather than to read
 * as a real explanation: a long entry, a one-line rename, a file the model
 * skipped (`src/legacy/OldViewer.tsx`), a binary it was told to skip, and a
 * path that is not in the diff at all — which must render without a jump link.
 */
export const EXPLANATION: ExplainResult = {
  overall:
    "This change moves the diff viewer from fetching its own file contents to reading them from a single parsed patch, and adds the storage that review results need.\n\nThe heart of it is DiffViewer.tsx, which loses its per-file fetch, and git.ts, which gains the typed IPC surface that replaces it. The migration is the other half: reviews need somewhere to live, so the schema grows a table keyed by merge base. Everything else is fallout — the old viewer is deleted, and the status helper is renamed to match what it now returns.",
  files: [
    {
      path: "migrations/0007_add_reviews_table.sql",
      explanation:
        "The schema migrations, applied in order at startup. This one adds the reviews table so a review survives a restart, keyed by the merge base it was anchored to. The merge_base column is what ties a stored review to a particular comparison rather than to a branch name, which can move under it.",
    },
    {
      path: "src/components/DiffViewer/DiffViewer.tsx",
      explanation:
        "The middle column — it renders the diff itself. Previously each file fetched its own before/after contents on mount, which meant one round trip per file and a flash of empty state on every selection. It now reads from the single parsed patch the store already holds, so selecting a file is pure rendering. The effect that remains only handles expanding context past what the patch carries.",
    },
    {
      path: "src/ipc/git.ts",
      explanation:
        "The typed wrapper over the Rust commands, mirroring the serde structs one for one. New here because the viewer's fetching moved behind it.",
    },
    {
      path: "src/lib/fileChange.ts",
      explanation: "Renamed from src/lib/status.ts; the helpers are unchanged.",
    },
    {
      path: "src/does/not/exist.ts",
      explanation:
        "A path with no file in the diff — this card renders last, with its path as plain text rather than a link.",
    },
  ],
};

const HOUR = 60 * 60 * 1000;

/**
 * What the home screen lists. Includes the PR the harness opens (`#47`), a
 * draft, one per review decision, and titles distinct enough to tell
 * number-matching from title-matching while searching. `#124 ← #127 ← #131` is
 * a stack whose members are split across the filters. `requested` and `mine`
 * drive the mocked `gh` filters.
 */
export const PR_LIST: (PrSummary & { requested?: boolean; mine?: boolean })[] = [
  {
    number: 47,
    title: "Render review findings in the PR workflow",
    author: "octocat",
    isDraft: false,
    url: "https://github.com/example/tk-review/pull/47",
    labels: [
      { name: "review-ui", color: "1d76db" },
      { name: "needs-tests", color: "fbca04" },
    ],
    headRef: "feature/diff-viewer",
    baseRef: "main",
    isCrossRepository: false,
    headSha: "2f6a1e4f5de7c0d0d6e0f1a4b9c8d7e6f5a4b3c2",
    createdAt: new Date(Date.now() - 30 * HOUR).toISOString(),
    updatedAt: new Date(Date.now() - 2 * HOUR).toISOString(),
    additions: 52,
    deletions: 19,
    changedFiles: 6,
    reviewDecision: "REVIEW_REQUIRED",
    requested: true,
  },
  {
    number: 52,
    title: "Explain mode: plain-language summaries beside the review",
    author: "hubot",
    isDraft: true,
    url: "https://github.com/example/tk-review/pull/52",
    labels: [
      { name: "feature", color: "a2eeef" },
      { name: "wip", color: "ededed" },
    ],
    headRef: "explain-mode",
    baseRef: "main",
    isCrossRepository: false,
    headSha: "52aa",
    createdAt: new Date(Date.now() - 80 * HOUR).toISOString(),
    updatedAt: new Date(Date.now() - 26 * HOUR).toISOString(),
    additions: 410,
    deletions: 38,
    changedFiles: 14,
    reviewDecision: null,
    mine: true,
  },
  {
    number: 118,
    title: "Fix stale diffs after a force push",
    author: "octocat",
    isDraft: false,
    url: "https://github.com/example/tk-review/pull/118",
    labels: [{ name: "bug", color: "d73a4a" }],
    headRef: "fix/force-push",
    baseRef: "main",
    isCrossRepository: false,
    headSha: "118b",
    createdAt: new Date(Date.now() - 20 * HOUR).toISOString(),
    updatedAt: new Date(Date.now() - 5 * HOUR).toISOString(),
    additions: 12,
    deletions: 40,
    changedFiles: 3,
    reviewDecision: "APPROVED",
    requested: true,
  },
  {
    number: 121,
    title: "Keyboard navigation between findings",
    author: "mona",
    isDraft: false,
    url: "https://github.com/example/tk-review/pull/121",
    labels: [
      { name: "accessibility", color: "7057ff" },
      { name: "feature", color: "a2eeef" },
    ],
    headRef: "findings-keys",
    baseRef: "main",
    isCrossRepository: false,
    headSha: "121c",
    createdAt: new Date(Date.now() - 120 * HOUR).toISOString(),
    updatedAt: new Date(Date.now() - 50 * HOUR).toISOString(),
    additions: 88,
    deletions: 7,
    changedFiles: 5,
    reviewDecision: "CHANGES_REQUESTED",
    requested: true,
  },
  {
    number: 124,
    title: "Persist reviews to the app data directory instead of localStorage",
    author: "tkempf",
    isDraft: false,
    url: "https://github.com/example/tk-review/pull/124",
    labels: [
      { name: "storage", color: "0e8a16" },
      { name: "breaking", color: "b60205" },
    ],
    headRef: "reviews-on-disk",
    baseRef: "main",
    isCrossRepository: false,
    headSha: "124d",
    createdAt: new Date(Date.now() - 72 * HOUR).toISOString(),
    updatedAt: new Date(Date.now() - 0.3 * HOUR).toISOString(),
    additions: 230,
    deletions: 115,
    changedFiles: 11,
    reviewDecision: "REVIEW_REQUIRED",
    mine: true,
  },
  {
    number: 127,
    title: "Migrate reviews saved in localStorage on first launch",
    author: "tkempf",
    isDraft: false,
    url: "https://github.com/example/tk-review/pull/127",
    labels: [{ name: "storage", color: "0e8a16" }],
    headRef: "reviews-migration",
    baseRef: "reviews-on-disk",
    isCrossRepository: false,
    headSha: "127e",
    createdAt: new Date(Date.now() - 60 * HOUR).toISOString(),
    updatedAt: new Date(Date.now() - 1 * HOUR).toISOString(),
    additions: 64,
    deletions: 3,
    changedFiles: 4,
    reviewDecision: "REVIEW_REQUIRED",
    mine: true,
  },
  {
    number: 131,
    title: "Show where each stored review lives on disk",
    author: "tkempf",
    isDraft: true,
    url: "https://github.com/example/tk-review/pull/131",
    labels: [],
    headRef: "reviews-location",
    baseRef: "reviews-migration",
    isCrossRepository: false,
    headSha: "131f",
    createdAt: new Date(Date.now() - 40 * HOUR).toISOString(),
    updatedAt: new Date(Date.now() - 30 * HOUR).toISOString(),
    additions: 21,
    deletions: 2,
    changedFiles: 2,
    reviewDecision: null,
    requested: true,
  },
];

/** A complete gh-shaped PR response for exercising the integration in-browser. */
export const PR: PrContext = {
  url: "https://github.com/example/tk-review/pull/47",
  number: 47,
  title: "Render review findings in the PR workflow",
  body: `## What changed

- Adds the review panel to the diff flow
- Keeps existing comments visible

\`\`\`ts
// Findings render beside the diff they point at.
export function findingsFor(path: string, review: Review): Finding[] {
  return review.findings.filter((finding) => finding.path === path);
}
\`\`\`

## Checklist

- [x] Migration runs on an empty database
- [ ] No secrets in the fixtures
- [x] PR is linked to the issue it closes, so the tracker moves it along the workflow

<details><summary>Testing</summary>

Run \`pnpm harness\` and open the pull request fixture.

</details>`,
  author: "octocat",
  state: "open",
  isDraft: false,
  baseRef: "main",
  baseRemote: "origin",
  headRef: "feature/diff-viewer",
  headSha: "2f6a1e4f5de7c0d0d6e0f1a4b9c8d7e6f5a4b3c2",
  compareRef: "tk-review/pr/47",
  comments: [
    {
      id: 101,
      author: "octocat",
      body: "Please keep the review results **persistent** when switching files.",
      createdAt: "2026-08-06T18:20:00Z",
      path: null,
      line: null,
      outdated: false,
    },
    // Vercel's deployment table, as its bot posts it: inline avatars and status
    // images beside links, query strings with `&`, an unknown element, and a
    // <picture> whose dark source is a 404.
    {
      id: 104,
      author: "vercel[bot]",
      body: [
        "[vc]: #example:eyJpc01vbm9yZXBvIjp0cnVlfQ==",
        "The latest updates on your projects. Learn more about [Vercel for GitHub](https://vercel.link/github-learn-more).",
        "",
        "| Project | Deployment | Actions | Updated |",
        "| :--- | :----- | :------ | :------ |",
        '| <a href="https://vercel.com/acme/web"><sup><img src="https://vercel.com/api/www/avatar?projectId=prj_example&teamId=team_example&s=32" width="16" height="16" align="middle" alt="" /></sup></a> [web](https://vercel.com/acme/web) | ![Ready](https://vercel.com/static/status/ready.svg) [Ready](https://vercel.com/acme/web/example) | [Preview](https://web-git-example-acme.vercel.app) | <relative-time datetime="2026-08-06T18:30:00.000Z">Aug 6, 2026 6:30pm UTC</relative-time> |',
        "",
        '<a href="https://vercel.com/vercel-agent/request-review?owner=acme&repo=web&pr=47" rel="noreferrer"><picture><source media="(prefers-color-scheme: dark)" srcset="https://agents-vade-review.vercel.sh/request-review-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://agents-vade-review.vercel.sh/request-review-light.svg"><img src="https://agents-vade-review.vercel.sh/request-review-light.svg" alt="Request Review"></picture></a>',
      ].join("\n"),
      createdAt: "2026-08-06T18:30:00Z",
      path: null,
      line: null,
      outdated: false,
    },
    {
      id: 102,
      author: "dependabot[bot]",
      body: "This file-level discussion is intentionally on a line in the diff.",
      createdAt: "2026-08-06T18:24:00Z",
      path: "migrations/0007_add_reviews_table.sql",
      line: 6,
      outdated: false,
    },
    {
      id: 103,
      author: "reviewer",
      body: "The earlier version of this anchor is outdated.",
      createdAt: "2026-08-06T18:25:00Z",
      path: "src/components/DiffViewer/DiffViewer.tsx",
      line: 11,
      outdated: true,
    },
  ],
};

/**
 * What the backend rejects with when a claude run hits its turn limit and the
 * wrap-up that should rescue it fails too. Trimmed from a real run.
 */
export const OUT_OF_TURNS_ERROR: GitError = {
  kind: "command",
  message:
    "Claude used all its turns before it finished, and then could not answer from what it had read. 8 of its tool calls were refused permission (Bash ×7, Write).",
  detail: `The run that ran out of turns:
${JSON.stringify(
  {
    type: "result",
    subtype: "error_max_turns",
    is_error: true,
    duration_ms: 215490,
    num_turns: 31,
    stop_reason: "tool_use",
    session_id: "d87f50d5-6f14-4858-9539-0244f050e9e4",
    total_cost_usd: 1.6814207999999997,
    permission_denials: [
      {
        tool_name: "Bash",
        tool_use_id: "toolu_01F4GKp2h9tUps5z6pjTpyNa",
        tool_input: {
          command:
            'git show tk-review/pr/7927:package.json | grep -n \'"packageManager"\\|"engines"\' -A2; git show tk-review/pr/7927:.nvmrc; pnpm --version; which pnpm',
          description: "Check pnpm and Node versions",
        },
      },
      {
        tool_name: "Bash",
        tool_use_id: "toolu_017nGy4yncomWQP5HG8B6Lmw",
        tool_input: {
          command: "gh pr checks 7927 2>&1 | grep -i 'audit\\|overrides'",
          description: "Check PR CI status for audit jobs",
        },
      },
      {
        tool_name: "Write",
        tool_use_id: "toolu_01AgDEwyVrpkJFoBFESeQupp",
        tool_input: { file_path: "/tmp/pnpm-nested-test.sh", content: "#!/bin/bash\nset -e\n…" },
      },
    ],
    terminal_reason: "max_turns",
    errors: ["Reached maximum number of turns (30)"],
  },
  null,
  2,
)}

Asked to answer from what it had read, it failed with: Claude reported an error: API Error: 529 overloaded`,
};

/** A `gh` failure as the backend reports it: GitHub's reason, and the raw exchange. */
export const GH_POST_ERROR: GitError = {
  kind: "command",
  message:
    "gh: Validation Failed (HTTP 422)\npull_request_review_thread.line must be part of the diff",
  detail: `gh api --method POST repos/example/tk-review/pulls/118/comments --input -
exit status: 1

stderr:
gh: Validation Failed (HTTP 422)

stdout:
{"message":"Validation Failed","errors":[{"resource":"PullRequestReviewComment","code":"custom","field":"pull_request_review_thread.line","message":"pull_request_review_thread.line must be part of the diff"}],"documentation_url":"https://docs.github.com/rest/pulls/comments#create-a-review-comment-for-a-pull-request","status":"422"}`,
};
