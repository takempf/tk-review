import type { Codemap } from "../src/ipc/git";
import { SUMMARY } from "./fixture";

/** A seeded generator (mulberry32), so every run builds the same map. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Random = ReturnType<typeof seeded>;

const pick = <T>(random: Random, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)] as T;

/** Kinds in about the shares of a real TypeScript monorepo. */
const KINDS: [kind: string, extension: string, share: number][] = [
  ["ts", "ts", 0.56],
  ["tsx", "tsx", 0.21],
  ["sql", "sql", 0.09],
  ["py", "py", 0.03],
  ["svg", "svg", 0.025],
  ["json", "json", 0.025],
  ["img", "png", 0.015],
  ["css", "css", 0.015],
  ["yml", "yml", 0.01],
  ["js", "mjs", 0.01],
];

/** Each project with the projects it may import from, so the graph layers the way a monorepo's does. */
const PROJECTS: [path: string, imports: number[]][] = [
  ["packages/config", []],
  ["packages/shared", [0]],
  ["packages/icons", []],
  ["packages/db", [0, 1]],
  ["packages/ui", [1, 2]],
  ["packages/sdk", [1, 3]],
  ["packages/editor", [1, 4]],
  ["services/render", [1, 3, 5]],
  ["services/billing", [1, 3, 5]],
  ["services/search", [1, 3]],
  ["apps/web", [1, 2, 4, 5, 6]],
  ["apps/admin", [1, 4, 5]],
  ["apps/api", [1, 3, 5]],
  ["apps/worker", [1, 3, 7]],
  ["apps/mobile", [1, 2, 4, 5]],
];

const FOLDERS = [
  "src/components",
  "src/features",
  "src/lib",
  "src/hooks",
  "src/routes",
  "src/store",
  "src/server",
  "src/utils",
  "src/graphql",
  "migrations",
];

/** A few per folder, so folders hold a realistic handful of files each. */
const SUBFOLDERS = ["editor", "workspace", "billing", "sharing"];

const WORDS = [
  "canvas",
  "drawing",
  "layer",
  "brush",
  "palette",
  "workspace",
  "folder",
  "member",
  "invite",
  "billing",
  "export",
  "render",
  "prompt",
  "history",
  "session",
  "upload",
  "comment",
  "share",
  "toolbar",
  "panel",
  "settings",
  "account",
  "project",
  "asset",
];

const name = (random: Random) =>
  `${pick(random, WORDS)}${pick(random, WORDS).replace(/^./, (c) => c.toUpperCase())}`;

/** Lines per file: mostly short, with a long tail past the viewer's 4000-row sampling. */
function lineCount(random: Random) {
  const lines = Math.round(Math.exp(3.55 + random() * 2.2 + (random() < 0.08 ? 1.8 : 0)));
  return Math.max(1, Math.min(12_000, lines));
}

/** Appends one row of the viewer's shape encoding: a run count, then class-and-length bytes. */
function pushRow(random: Random, bytes: number[], depth: number) {
  if (random() < 0.12) {
    bytes.push(0);
    return;
  }
  const runs: number[] = [];
  let column = 0;
  const indent = Math.min(40, depth * 2);
  if (indent > 0) {
    runs.push(indent - 1);
    column = indent;
  }
  const tokens = 1 + Math.floor(random() * 7);
  for (let token = 0; token < tokens && column < 100; token++) {
    const length = 1 + Math.floor(random() * 14);
    runs.push((Math.ceil(random() * 7) << 5) | (length - 1));
    column += length;
    if (random() < 0.5 && column < 100) {
      runs.push(0);
      column += 1;
    }
  }
  bytes.push(runs.length, ...runs);
}

const MAX_ROWS = 4000;

function pushShape(random: Random, bytes: number[], lines: number) {
  const rows = Math.min(lines, MAX_ROWS);
  let depth = 0;
  for (let row = 0; row < rows; row++) {
    depth = Math.max(0, Math.min(8, depth + Math.floor(random() * 3) - 1));
    pushRow(random, bytes, depth);
  }
  return { rows, linesPerRow: lines > MAX_ROWS ? lines / MAX_ROWS : 1 };
}

/** Base64 in chunks: spreading megabytes into `String.fromCharCode` overflows the stack. */
function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

async function gzipBase64(bytes: number[]) {
  const stream = new Blob([new Uint8Array(bytes)])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return toBase64(new Uint8Array(await new Response(stream).arrayBuffer()));
}

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg>';

interface SyntheticNode {
  p: string;
  k: string;
  b: number;
  l: number;
  x: string[];
  o: number;
  r: number;
  s: number;
  iw?: number;
  ih?: number;
  st?: "A" | "M" | "R" | "D";
  op?: string;
  hk?: [number, number, number, number][];
  ad?: number;
  dl?: number;
}

function pickKind(random: Random) {
  let roll = random();
  for (const entry of KINDS) {
    roll -= entry[2];
    if (roll < 0) return entry;
  }
  return KINDS[0] as (typeof KINDS)[number];
}

function markChanged(random: Random, node: SyntheticNode) {
  const status = pick(random, ["M", "M", "M", "M", "A", "A", "D", "R"] as const);
  node.st = status;
  if (status === "R") node.op = `${node.p}.old`;
  if (status === "M" || status === "R") {
    const start = 1 + Math.floor(random() * Math.max(1, node.l - 20));
    const added = 1 + Math.floor(random() * 20);
    const removed = Math.floor(random() * 8);
    node.hk = [[start, added, start, removed]];
    node.ad = added;
    node.dl = removed;
    return;
  }
  node.ad = status === "A" ? node.l : 0;
  node.dl = status === "D" ? node.l : 0;
}

/** A deterministic monorepo of `files` files, about 3% of them changed, for benchmarking the viewer. */
export async function syntheticCodemap(files: number): Promise<Codemap> {
  const random = seeded(files);
  const bytes: number[] = [];
  const paths = new Set<string>();
  const nodes: SyntheticNode[] = [];
  const byProject: number[][] = PROJECTS.map(() => []);

  while (nodes.length < files) {
    const project = Math.floor(random() * PROJECTS.length);
    const [kind, extension] = pickKind(random);
    const folder = kind === "sql" ? "migrations" : pick(random, FOLDERS);
    const nested = random() < 0.7 ? `/${pick(random, SUBFOLDERS)}` : "";
    const test = (kind === "ts" || kind === "tsx") && random() < 0.15 ? ".test" : "";
    const path = `${PROJECTS[project]?.[0]}/${folder}${nested}/${name(random)}${test}.${extension}`;
    if (paths.has(path)) continue;
    paths.add(path);

    const lines = kind === "img" ? 0 : kind === "svg" ? 6 : lineCount(random);
    const offset = bytes.length;
    const shape = lines > 0 ? pushShape(random, bytes, lines) : { rows: 0, linesPerRow: 1 };
    const node: SyntheticNode = {
      p: path,
      k: kind,
      b: lines * 34 + 120,
      l: lines,
      x: [],
      o: offset,
      r: shape.rows,
      s: shape.linesPerRow,
    };
    if (kind === "img") {
      node.iw = 64 + Math.floor(random() * 900);
      node.ih = 64 + Math.floor(random() * 600);
    }
    byProject[project]?.push(nodes.length);
    nodes.push(node);
  }

  // Changes cluster in an app and a package it builds on, as a real PR's do.
  for (const project of [10, 4]) {
    for (const at of byProject[project] ?? []) {
      const node = nodes[at];
      if (node && node.k !== "img" && random() < 0.04) markChanged(random, node);
    }
  }

  // Files only import files earlier in their own project, or in the projects it builds on, so imports never cycle.
  const edges: [number, number, number, number, number][] = [];
  byProject.forEach((local, project) => {
    const upstream = (PROJECTS[project]?.[1] ?? []).flatMap((other) => byProject[other] ?? []);
    local.forEach((from, rank) => {
      const node = nodes[from];
      if (!node || (node.k !== "ts" && node.k !== "tsx")) return;
      const count = Math.floor(random() * 13);
      for (let link = 0; link < count; link++) {
        const crosses = upstream.length > 0 && random() < 0.3;
        if (!crosses && rank === 0) continue;
        const to = crosses ? pick(random, upstream) : (local[Math.floor(random() * rank)] ?? from);
        if (to === from) continue;
        const change = node.st === "M" && random() < 0.08 ? 1 + Math.floor(random() * 2) : 0;
        edges.push([from, to, random() < 0.2 ? 1 : 0, -1, change]);
      }
    });
  });

  const svgs: Record<string, string> = {};
  for (const node of nodes) if (node.k === "svg") svgs[node.p] = SVG;

  const ref = (label: string, short: string) => ({
    ref: label,
    hash: short,
    label,
    short,
    date: "2026-11-05",
    subject: "Synthetic monorepo for the codemap bench",
  });
  return {
    graph: {
      repo: "monorepo",
      commit: ["4d81e7c", "2026-11-05", "Synthetic monorepo for the codemap bench"],
      refs: { base: ref("main", SUMMARY.mergeBase), head: ref("feature/bench", "4d81e7c") },
      diff: true,
      containers: ["apps", "packages", "services"],
      nodes,
      edges,
      tedges: edges,
      ext: [],
    },
    shapes: await gzipBase64(bytes),
    svgs,
  };
}
