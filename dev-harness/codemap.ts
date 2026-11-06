import type { Codemap } from "../src/ipc/git";
import { SUMMARY } from "./fixture";

interface FixtureNode {
  p: string;
  k: string;
  l: number;
  st?: "A" | "M" | "R" | "D";
  op?: string;
  hk?: [number, number, number, number][];
}

/** The fixture's changed files, plus a few unchanged ones they import or are imported by. */
const NODES: FixtureNode[] = [
  { p: "src/main.tsx", k: "tsx", l: 24 },
  { p: "src/App.tsx", k: "tsx", l: 238 },
  { p: "src/components/FileList/FileList.tsx", k: "tsx", l: 140 },
  {
    p: "src/components/DiffViewer/DiffViewer.tsx",
    k: "tsx",
    l: 96,
    st: "M",
    hk: [[4, 24, 4, 5]],
  },
  { p: "src/ipc/git.ts", k: "ts", l: 17, st: "A" },
  {
    p: "src/lib/fileChange.ts",
    k: "ts",
    l: 40,
    st: "R",
    op: "src/lib/status.ts",
    hk: [[33, 7, 32, 0]],
  },
  { p: "src/legacy/OldViewer.tsx", k: "tsx", l: 14, st: "D" },
  { p: "migrations/0007_add_reviews_table.sql", k: "sql", l: 30, st: "M", hk: [[27, 4, 26, 0]] },
];

/** From, to, import kind, barrel passed (-1 for none), and 0 kept, 1 added, 2 removed. */
const LINKS: [string, string, number, number, number][] = [
  ["src/main.tsx", "src/App.tsx", 0, -1, 0],
  ["src/App.tsx", "src/components/FileList/FileList.tsx", 0, -1, 0],
  ["src/App.tsx", "src/components/DiffViewer/DiffViewer.tsx", 0, -1, 0],
  ["src/components/DiffViewer/DiffViewer.tsx", "src/ipc/git.ts", 1, -1, 1],
  ["src/components/DiffViewer/DiffViewer.tsx", "src/lib/fileChange.ts", 0, -1, 0],
  ["src/components/FileList/FileList.tsx", "src/lib/fileChange.ts", 0, -1, 0],
  ["src/App.tsx", "src/legacy/OldViewer.tsx", 0, -1, 2],
];

/** A row per line: some indent, then a run of identifier, in the viewer's shape encoding. */
function shapeRows(lines: number, bytes: number[]) {
  for (let line = 0; line < lines; line++) {
    const indent = 2 * ((line * 3) % 4) + 1;
    const length = ((line * 7) % 28) + 4;
    bytes.push(2, indent - 1, (1 << 5) | (length - 1));
  }
}

async function gzipBase64(bytes: number[]): Promise<string> {
  const stream = new Blob([new Uint8Array(bytes)])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  const gzipped = new Uint8Array(await new Response(stream).arrayBuffer());
  return btoa(String.fromCharCode(...gzipped));
}

export async function codemapFixture(): Promise<Codemap> {
  const index = new Map(NODES.map((node, at) => [node.p, at]));
  const bytes: number[] = [];
  const nodes = NODES.map((node) => {
    const offset = bytes.length;
    shapeRows(node.l, bytes);
    const changed = node.st
      ? {
          ad: node.st === "A" ? node.l : (node.hk ?? []).reduce((sum, hunk) => sum + hunk[1], 0),
          dl: node.st === "D" ? node.l : (node.hk ?? []).reduce((sum, hunk) => sum + hunk[3], 0),
        }
      : {};
    return { ...node, ...changed, b: node.l * 32, x: [], o: offset, r: node.l, s: 1 };
  });
  const links = LINKS.map(([from, to, kind, via, change]) => [
    index.get(from),
    index.get(to),
    kind,
    via,
    change,
  ]);
  const ref = (label: string, short: string) => ({
    ref: label,
    hash: short,
    label,
    short,
    date: "2026-11-04",
    subject: "Render review findings in the PR workflow",
  });
  return {
    graph: {
      repo: "tk-review",
      commit: ["4d81e7c", "2026-11-04", "Render review findings in the PR workflow"],
      refs: { base: ref("main", SUMMARY.mergeBase), head: ref("feature/diff-viewer", "4d81e7c") },
      diff: true,
      containers: ["apps", "libs", "packages", "services"],
      nodes,
      edges: links,
      tedges: links,
      ext: [["react", 3]],
    },
    shapes: await gzipBase64(bytes),
    svgs: {},
  };
}
