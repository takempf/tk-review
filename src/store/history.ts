import type { PrContext, RepoInfo, ReviewEngine } from "../ipc/git";

/**
 * What the home screen remembers across launches: the repositories opened
 * recently, and which pull requests have been reviewed. Both are small indexes
 * beside the reviews themselves, so the home screen never has to parse every
 * stored review to draw a list.
 */

export interface RecentRepo {
  root: string;
  name: string;
  /** ISO timestamp of the last time it was opened. */
  openedAt: string;
}

/** The latest review of one pull request, whichever engine wrote it. */
export interface ReviewedPr {
  root: string;
  number: number;
  /** Absent for reviews stored before the index existed. */
  title: string | null;
  url: string | null;
  author: string | null;
  /** The head the review read; a different head on GitHub means new commits since. */
  headSha: string | null;
  engine: ReviewEngine;
  /** ISO timestamp of when the review finished. */
  createdAt: string;
  findings: number;
}

const RECENT_REPOS_KEY = "tk-review:recent-repos";
const REVIEW_INDEX_KEY = "tk-review:review-index";
const RECENT_REPOS_LIMIT = 8;
/** Matches the compare ref `open_pr` fetches a pull request's head to. */
const PR_COMPARE_REF = /^tk-review\/pr\/(\d+)$/;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // History is a convenience; a full localStorage must never break a review.
  }
}

export function readRecentRepos(): RecentRepo[] {
  const repos = readJson<RecentRepo[]>(RECENT_REPOS_KEY, []);
  return Array.isArray(repos) ? repos : [];
}

export function rememberRepo(repo: RepoInfo): void {
  const rest = readRecentRepos().filter((recent) => recent.root !== repo.root);
  const entry = { root: repo.root, name: repo.name, openedAt: new Date().toISOString() };
  writeJson(RECENT_REPOS_KEY, [entry, ...rest].slice(0, RECENT_REPOS_LIMIT));
}

export function forgetRepo(root: string): void {
  writeJson(
    RECENT_REPOS_KEY,
    readRecentRepos().filter((recent) => recent.root !== root),
  );
}

type ReviewIndex = Record<string, ReviewedPr>;

const indexKey = (root: string, number: number) => `${root}#${number}`;

function readIndex(): ReviewIndex {
  const index = readJson<ReviewIndex>(REVIEW_INDEX_KEY, {});
  return typeof index === "object" && index !== null ? index : {};
}

export function recordReview(
  root: string,
  pr: PrContext,
  review: { engine: ReviewEngine; createdAt: string; findings: number },
): void {
  const index = readIndex();
  index[indexKey(root, pr.number)] = {
    root,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author,
    headSha: pr.headSha,
    ...review,
  };
  writeJson(REVIEW_INDEX_KEY, index);
}

interface LegacyStoredReview {
  engine?: ReviewEngine;
  createdAt?: string;
  review?: { findings?: unknown[] };
}

/**
 * Reviews stored before the index existed, recovered from their storage keys:
 * `tk-review:reviews:<root>:<base>...tk-review/pr/<n>`. They carry no title or
 * head, so the home screen fills those in from GitHub's list where it can.
 */
function legacyReviews(root: string): ReviewedPr[] {
  const prefix = `tk-review:reviews:${root}:`;
  const found: ReviewedPr[] = [];
  let keys: string[];
  try {
    keys = Object.keys(localStorage);
  } catch {
    return found;
  }
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    const compare = key.slice(prefix.length).split("...").pop() ?? "";
    const match = PR_COMPARE_REF.exec(compare);
    if (!match) continue;
    const byEngine = readJson<Record<string, LegacyStoredReview>>(key, {});
    const latest = Object.values(byEngine)
      .filter((stored) => stored?.createdAt && stored.engine)
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0];
    if (!latest?.createdAt || !latest.engine) continue;
    found.push({
      root,
      number: Number(match[1]),
      title: null,
      url: null,
      author: null,
      headSha: null,
      engine: latest.engine,
      createdAt: latest.createdAt,
      findings: latest.review?.findings?.length ?? 0,
    });
  }
  return found;
}

/** Every reviewed pull request in one repository, most recent review first. */
export function readReviewedPrs(root: string): ReviewedPr[] {
  const byNumber = new Map<number, ReviewedPr>();
  for (const legacy of legacyReviews(root)) byNumber.set(legacy.number, legacy);
  for (const entry of Object.values(readIndex())) {
    if (entry.root === root) byNumber.set(entry.number, entry);
  }
  return [...byNumber.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
