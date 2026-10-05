import type { PrComment, PrContext, PrThread } from "../ipc/git";
import type { LineSpan } from "./lineSpan";

/**
 * The id a review comment's permalink ends in: `…/pull/7#discussion_r<id>`.
 * A top-level comment's ends `#issuecomment-<id>` instead, and GitHub keeps
 * no thread for it.
 */
export function reviewCommentId(url: string): number | null {
  const match = /#discussion_r(\d+)$/.exec(url);
  return match ? Number(match[1]) : null;
}

/**
 * The review thread a comment posted at `url` started or joined, as GitHub
 * last reported it: `null` for a top-level comment, or one posted since the PR
 * was last read.
 */
export function threadFor(pr: PrContext, url: string | undefined): PrThread | null {
  const id = url ? reviewCommentId(url) : null;
  if (id == null) return null;
  return pr.threads.find((thread) => thread.commentIds.includes(id)) ?? null;
}

/** What was said in `thread` after the comment posted at `url`, oldest first. */
export function repliesAfter(pr: PrContext, thread: PrThread, url: string): PrComment[] {
  const posted = reviewCommentId(url);
  const at = thread.commentIds.indexOf(posted ?? -1);
  return thread.commentIds
    .slice(at + 1)
    .flatMap((id) => pr.comments.find((comment) => comment.id === id) ?? []);
}

/** One conversation at a place in a file: GitHub's thread, when it was read. */
export interface AnchoredThread {
  /** `null` for a comment no thread was read for. */
  thread: PrThread | null;
  /** Oldest first: the first started it. */
  comments: PrComment[];
}

/** A place in a file that comments were made on, and every conversation there. */
export interface CommentAnchor {
  key: string;
  /** `null` for comments on the file as a whole. */
  lines: LineSpan | null;
  /** The lines are where the comments were made, on a commit since replaced. */
  outdated: boolean;
  /** In the order they started. */
  threads: AnchoredThread[];
}

export interface FileDiscussion {
  path: string;
  /** The file as a whole first, then down the file. */
  anchors: CommentAnchor[];
}

function linesOf(comment: PrComment): LineSpan | null {
  if (comment.line == null) return null;
  return { start: Math.min(comment.startLine ?? comment.line, comment.line), end: comment.line };
}

/**
 * The PR's inline comments, file by file, each gathered at the line or span it
 * was made on with the replies that followed it. Outdated lines belong to an
 * older commit, so they gather apart from the same numbers on the head.
 */
export function inlineDiscussion(pr: PrContext): FileDiscussion[] {
  const inline = pr.comments.filter((comment) => comment.path != null);
  const byId = new Map(inline.map((comment) => [comment.id, comment]));
  const threaded = new Set<number>();
  const conversations: AnchoredThread[] = [];
  for (const thread of pr.threads) {
    const comments = thread.commentIds.flatMap((id) => byId.get(id) ?? []);
    if (comments.length === 0) continue;
    for (const comment of comments) threaded.add(comment.id);
    conversations.push({ thread, comments });
  }
  for (const comment of inline) {
    if (!threaded.has(comment.id)) conversations.push({ thread: null, comments: [comment] });
  }

  const files = new Map<string, Map<string, CommentAnchor>>();
  for (const conversation of conversations) {
    const [first] = conversation.comments;
    if (!first?.path) continue;
    const lines = linesOf(first);
    const outdated = conversation.thread?.outdated ?? first.outdated;
    const key = lines ? `${outdated ? "was" : "at"}:${lines.start}-${lines.end}` : "file";
    let anchors = files.get(first.path);
    if (!anchors) {
      anchors = new Map();
      files.set(first.path, anchors);
    }
    let anchor = anchors.get(key);
    if (!anchor) {
      anchor = { key, lines, outdated: lines != null && outdated, threads: [] };
      anchors.set(key, anchor);
    }
    anchor.threads.push(conversation);
  }

  const started = (conversation: AnchoredThread) => conversation.comments[0]?.createdAt ?? "";
  return [...files.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, anchors]) => ({
      path,
      anchors: [...anchors.values()]
        .map((anchor) => ({
          ...anchor,
          threads: [...anchor.threads].sort((a, b) => started(a).localeCompare(started(b))),
        }))
        .sort(
          (a, b) =>
            (a.lines?.start ?? 0) - (b.lines?.start ?? 0) ||
            (a.lines?.end ?? 0) - (b.lines?.end ?? 0) ||
            Number(a.outdated) - Number(b.outdated),
        ),
    }));
}
