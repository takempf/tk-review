import type { PrSummary } from "../ipc/git";

/** Where one PR sits in a stack. Only PRs that are part of one get an entry. */
export interface StackLinks {
  /** The open PR whose head branch this one targets. */
  parent: PrSummary | null;
  /** Open PRs that target this one's head branch, oldest first. */
  children: PrSummary[];
}

/**
 * Stacks as GitHub records them: a PR is stacked on another when its base
 * branch is that PR's head branch. Graphite, `gh stack`, spr and hand-rolled
 * stacks all come down to this, so no tool-specific metadata is needed.
 *
 * Two branches never count as a parent's head:
 * - a fork's, since a fork's branch names say nothing about this repository's;
 * - the default branch, so a `main → production` release PR does not look like
 *   the base of every PR targeting `main`.
 */
export function buildStacks(
  prs: PrSummary[],
  defaultBranch: string | null,
): Map<number, StackLinks> {
  const trunk = defaultBranch?.replace(/^origin\//, "") ?? null;
  // One head branch can have PRs into several bases; the list is newest first,
  // so the most recently updated one wins.
  const byHead = new Map<string, PrSummary>();
  for (const pr of prs) {
    if (pr.isCrossRepository || pr.headRef === trunk || byHead.has(pr.headRef)) continue;
    byHead.set(pr.headRef, pr);
  }

  const stacks = new Map<number, StackLinks>();
  const links = (pr: PrSummary) => {
    let entry = stacks.get(pr.number);
    if (!entry) {
      entry = { parent: null, children: [] };
      stacks.set(pr.number, entry);
    }
    return entry;
  };
  for (const pr of prs) {
    const parent = byHead.get(pr.baseRef);
    if (!parent || parent.number === pr.number) continue;
    links(pr).parent = parent;
    links(parent).children.push(pr);
  }
  for (const entry of stacks.values()) entry.children.sort((a, b) => a.number - b.number);
  return stacks;
}

export interface StackedRow {
  pr: PrSummary;
  /** How many of the rows above it in its stack are its ancestors. */
  depth: number;
}

/**
 * Orders a list so each stack reads bottom-up as one group, placed where its
 * most recently updated member would have been. Members missing from `visible`
 * (filtered out by a tab or search) are skipped without breaking the rest of
 * their stack apart.
 */
export function groupStacks(visible: PrSummary[], stacks: Map<number, StackLinks>): StackedRow[] {
  const shown = new Set(visible.map((pr) => pr.number));
  const placed = new Set<number>();
  const rows: StackedRow[] = [];

  const place = (pr: PrSummary, depth: number) => {
    if (placed.has(pr.number)) return;
    placed.add(pr.number);
    const here = shown.has(pr.number);
    if (here) rows.push({ pr, depth });
    for (const child of stacks.get(pr.number)?.children ?? []) {
      place(child, here ? depth + 1 : depth);
    }
  };

  for (const pr of visible) {
    if (placed.has(pr.number)) continue;
    // Walk down to the bottom of the stack; the guard stops a pair of PRs that
    // target each other's branches from looping.
    let root = pr;
    const seen = new Set([root.number]);
    for (let parent = stacks.get(root.number)?.parent; parent && !seen.has(parent.number); ) {
      root = parent;
      seen.add(root.number);
      parent = stacks.get(root.number)?.parent;
    }
    place(root, 0);
  }
  return rows;
}
