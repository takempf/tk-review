import { parsePatchFiles } from "@pierre/diffs";
import { useMemo } from "react";
import { ENGINE_LABELS } from "../../lib/engines";
import { useScreenSettled } from "../../lib/screenTransition";
import type { SearchDocument } from "../../lib/textSearch";
import {
  findingThreadKey,
  REVIEW_THREAD_KEY,
  resolutionThreadKey,
  reviewHistory,
  useTab,
  useTabStore,
} from "../../store/tabStore";
import { useSearchDocuments } from "./Search";

/** Index source data so folded files and virtualized lines remain searchable. */
export function ReviewSearchIndex() {
  const store = useTabStore();
  const summary = useTab((state) => state.summary);
  const patch = useTab((state) => state.patch);
  const pr = useTab((state) => state.pr);
  const commits = useTab((state) => state.commits);
  const reviews = useTab((state) => state.reviews);
  const explanation = useTab((state) => state.explanation);

  const settled = useScreenSettled();
  const code = useMemo<SearchDocument[]>(() => {
    if (!settled || !patch) return [];
    const documents: SearchDocument[] = [];
    for (const file of parsePatchFiles(patch).flatMap((entry) => entry.files)) {
      for (const hunk of file.hunks) {
        let addition = hunk.additionStart;
        let deletion = hunk.deletionStart;
        const add = (
          side: "additions" | "deletions",
          offset: number,
          count: number,
          start: number,
          detail: string,
        ) => {
          const lines = side === "additions" ? file.additionLines : file.deletionLines;
          for (let index = 0; index < count; index++) {
            const line = start + index;
            documents.push({
              id: `diff:${file.name}:${side}:${line}`,
              scope: "diff",
              title: file.name,
              text: (lines[offset + index] ?? "").replace(/\r?\n$/, ""),
              detail: `${detail} · line ${line}`,
              activate: () =>
                store.getState().selectFile(file.name, { start: line, end: line, side }),
            });
          }
        };
        for (const segment of hunk.hunkContent) {
          if (segment.type === "context") {
            add("additions", segment.additionLineIndex, segment.lines, addition, "Context");
            addition += segment.lines;
            deletion += segment.lines;
          } else {
            add("deletions", segment.deletionLineIndex, segment.deletions, deletion, "Removed");
            add("additions", segment.additionLineIndex, segment.additions, addition, "Added");
            deletion += segment.deletions;
            addition += segment.additions;
          }
        }
      }
    }
    return documents;
  }, [settled, patch, store]);

  const documents = useMemo<SearchDocument[]>(() => {
    const docs: SearchDocument[] = (summary?.files ?? []).map((file) => ({
      id: `file:${file.path}`,
      scope: "files",
      title: file.path,
      text: file.oldPath ? `${file.path}\n${file.oldPath}` : file.path,
      detail: file.status,
      target: `file:${file.path}`,
      activate: () => store.getState().selectFile(file.path),
    }));
    docs.push(...code);
    for (const commit of commits?.commits ?? []) {
      docs.push({
        id: `commit:${commit.sha}`,
        scope: "commits",
        title: commit.subject,
        text: `${commit.subject}\n${commit.author}\n${commit.sha}`,
        detail: commit.sha.slice(0, 7),
        target: `commit:${commit.sha}`,
      });
    }
    if (pr) {
      docs.push({
        id: "pr:description",
        scope: "conversations",
        title: pr.title,
        text: `${pr.title}\n${pr.body}`,
        detail: "PR description",
        tab: "pr",
        target: "pr:description",
      });
      for (const comment of pr.comments) {
        docs.push({
          id: `pr:comment:${comment.id}`,
          scope: "conversations",
          title: comment.path ?? `@${comment.author}`,
          text: comment.body,
          detail: `@${comment.author}${comment.outdated ? " · outdated" : ""}`,
          tab: "pr",
          target: `pr:comment:${comment.id}`,
        });
      }
    }
    for (const { source, live, key: review } of reviewHistory(reviews)) {
      const agent = ENGINE_LABELS[source.engine];
      const kind = live ? "Review" : "Earlier review";
      docs.push({
        id: `review:${review}:${REVIEW_THREAD_KEY}`,
        scope: "conversations",
        title: `${agent} review`,
        text: source.review.summary,
        detail: `${kind} summary`,
        tab: "ai",
        target: `review:${review}:${REVIEW_THREAD_KEY}`,
      });
      if (live) {
        docs.push({
          id: `conclusion:${source.engine}`,
          scope: "conversations",
          title: `${agent} conclusion`,
          text: source.review.conclusion ?? "",
          detail: "Review conclusion",
          tab: "ai",
          target: `conclusion:${source.engine}`,
        });
      }
      for (const finding of source.review.findings) {
        const target = `review:${review}:${findingThreadKey(finding)}`;
        docs.push({
          id: target,
          scope: "conversations",
          title: finding.title,
          text: `${finding.title}\n${finding.body}`,
          detail: `${agent} · ${finding.path}`,
          tab: "ai",
          target,
        });
      }
      for (const resolution of source.resolutions ?? []) {
        const target = `review:${review}:${resolutionThreadKey(resolution.finding)}`;
        docs.push({
          id: target,
          scope: "conversations",
          title: resolution.finding.title,
          text: `${resolution.finding.title}\n${resolution.finding.body}\n${resolution.note}`,
          detail: `${agent} · earlier finding`,
          tab: "ai",
          target,
        });
      }
      for (const [key, comments] of Object.entries(source.threads)) {
        comments.forEach((comment, index) => {
          const target = `thread:${review}:${key}:${index}`;
          docs.push({
            id: target,
            scope: "conversations",
            title: comment.author === "user" ? "You" : agent,
            text: comment.text,
            detail: `${kind} conversation`,
            tab: "ai",
            target,
          });
        });
      }
    }
    if (explanation) {
      docs.push({
        id: "explain:overall",
        scope: "conversations",
        title: "Walkthrough",
        text: explanation.explanation.overall,
        detail: "AI explanation",
        tab: "explain",
        target: "explain:overall",
      });
      for (const file of explanation.explanation.files) {
        docs.push({
          id: `explain:${file.path}`,
          scope: "conversations",
          title: file.path,
          text: file.explanation,
          detail: "File explanation",
          tab: "explain",
          target: `explain:${file.path}`,
        });
      }
    }
    return docs;
  }, [summary, code, pr, commits, reviews, explanation, store]);

  useSearchDocuments(documents);
  return null;
}
