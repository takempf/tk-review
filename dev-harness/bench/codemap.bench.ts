import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { expect, type Frame, type Page, test } from "@playwright/test";

// `pnpm bench:codemap`: BENCH_LABEL names a run, BENCH_BASELINE compares with one, BENCH_FILES sizes the map.
// With tests hidden, as the map opens, 6,800 files show about the repo it's tuned for: 6,000 files, 1.0M lines, 24,000 imports.
const FILES = Number(process.env.BENCH_FILES ?? 6800);
const LABEL = process.env.BENCH_LABEL ?? "latest";
const BASELINE = process.env.BENCH_BASELINE;
/** Only scenarios whose names contain one of these, comma-separated, for a quick look at a few. */
const ONLY = (process.env.BENCH_ONLY ?? "").split(",");
// Outside test-results/, which Playwright empties at the start of every run.
const OUT = join(process.cwd(), "dev-harness", "bench", "results");
/** Uncapped frames keep Playwright's two-frame stability check from passing, so clicks skip it. */
const SKIP_STABILITY = { force: true };

interface Samples {
  /** [start, duration] of each viewer frame that did any work. */
  draws: [number, number][];
  /** When the viewer last spent real time on a frame. */
  lastBusy: number;
  /** Duration of each scripted input event's handlers. */
  inputs: number[];
  /** Timestamps of an independent requestAnimationFrame loop, kept while `recording`: when the frame got to paint. */
  beats: number[];
  recording: boolean;
  /** [zoom %, script ms, frame interval ms, input-to-draw ms]. */
  zoomFrames: number[][];
  pendingInput: number;
  nodes?: { p: string; st?: string; l: number }[];
  graph?: { repo: string; files: number; lines: number; imports: number };
}

type BenchWindow = Window & { codemapBench: Samples; benchRaf: typeof requestAnimationFrame };

/** Runs in every frame before its scripts: times the viewer's frames and keeps a heartbeat beside them. */
function instrument() {
  const raf = window.requestAnimationFrame.bind(window);
  const samples: Samples = {
    draws: [],
    lastBusy: 0,
    inputs: [],
    beats: [],
    recording: false,
    zoomFrames: [],
    pendingInput: 0,
  };
  let previous = 0;
  Object.assign(window, { codemapBench: samples, benchRaf: raf });
  window.requestAnimationFrame = (callback) =>
    raf((time) => {
      const start = performance.now();
      callback(time);
      const duration = performance.now() - start;
      if (samples.recording) {
        const zoom = Number.parseFloat(document.querySelector("#zl")?.textContent ?? "0");
        performance.mark(`codemap:zoom:${zoom}%`);
        samples.zoomFrames.push([
          zoom,
          duration,
          previous ? time - previous : 0,
          samples.pendingInput ? performance.now() - samples.pendingInput : 0,
        ]);
        samples.pendingInput = 0;
        previous = time;
      } else previous = 0;
      if (duration > 0.1 || samples.recording) samples.draws.push([start, duration]);
      if (duration > 0.3) samples.lastBusy = start;
    });
  const beat = (time: number) => {
    if (samples.recording) samples.beats.push(time);
    raf(beat);
  };
  raf(beat);
  addEventListener("message", (event) => {
    if (event.data?.type !== "tk-review:codemap") return;
    const graph = event.data.graph;
    samples.nodes = graph.nodes;
    samples.graph = {
      repo: graph.repo,
      files: graph.nodes.length,
      lines: graph.nodes.reduce((total: number, node: { l: number }) => total + node.l, 0),
      imports: graph.tedges.length,
    };
  });
}

type Gesture =
  | { kind: "pan"; frames: number }
  | { kind: "pinch"; frames: number }
  | { kind: "zoom in"; frames: number }
  | { kind: "hover"; frames: number };

/** Plays a gesture into the map, one input event per frame, as a trackpad delivers them. */
function play(gesture: Gesture) {
  const bench = window as unknown as BenchWindow;
  const canvas = document.querySelector("#cv") as HTMLCanvasElement;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const send = (event: Event) => {
    const start = performance.now();
    bench.codemapBench.pendingInput ||= start;
    canvas.dispatchEvent(event);
    bench.codemapBench.inputs.push(performance.now() - start);
  };
  return new Promise<number>((done) => {
    const started = performance.now();
    let frame = 0;
    const step = () => {
      if (frame >= gesture.frames) {
        done(performance.now() - started);
        return;
      }
      const t = frame / gesture.frames;
      const wheel = { clientX: width / 2, clientY: height / 2, bubbles: true, cancelable: true };
      if (gesture.kind === "pan") {
        const angle = t * Math.PI * 2;
        send(
          new WheelEvent("wheel", {
            ...wheel,
            deltaX: 14.3 * Math.cos(angle),
            deltaY: 14.3 * Math.sin(angle),
          }),
        );
      } else if (gesture.kind === "pinch") {
        // Out, in twice as far, then out again: it ends where it started.
        const deltaY = t < 0.25 || t >= 0.75 ? 4 : -4;
        send(new WheelEvent("wheel", { ...wheel, deltaY, ctrlKey: true }));
      } else if (gesture.kind === "zoom in") {
        // Each step zooms in 2.7%.
        send(new WheelEvent("wheel", { ...wheel, deltaY: -3, ctrlKey: true }));
      } else {
        const across = t < 0.5 ? t * 2 : 2 - t * 2;
        const x = width * (0.1 + 0.8 * across);
        const y = height * (0.15 + 0.7 * across);
        send(
          new PointerEvent("pointermove", {
            clientX: x,
            clientY: y,
            pointerType: "mouse",
            bubbles: true,
          }),
        );
      }
      frame++;
      bench.benchRaf(step);
    };
    bench.benchRaf(step);
  });
}

async function codemapFrame(page: Page): Promise<Frame> {
  const element = await page.waitForSelector('iframe[title="Codemap"]', { timeout: 60_000 });
  const frame = await element.contentFrame();
  if (!frame) throw new Error("the codemap frame has no document");
  await frame.waitForSelector("#cv");
  return frame;
}

/** Waits until the viewer has drawn nothing for half a second: the map, its shapes and any animation are done. */
async function settle(frame: Frame) {
  // Two frames first, so a redraw something just asked for has run and counts as busy.
  await frame.evaluate(
    () =>
      new Promise((done) => {
        const { benchRaf } = window as unknown as BenchWindow;
        benchRaf(() => benchRaf(done));
      }),
  );
  await frame.waitForFunction(
    () => performance.now() - (window as unknown as BenchWindow).codemapBench.lastBusy > 500,
    undefined,
    { timeout: 60_000, polling: 100 },
  );
}

async function openCodemap(page: Page) {
  await page.goto(`/dev-harness/?codemap=${FILES}`);
  await page
    .getByText("Render review findings in the PR workflow", { exact: true })
    .first()
    .click(SKIP_STABILITY);
  await page
    .getByRole("tablist", { name: "Review views" })
    .getByRole("tab", { name: "Codemap" })
    .click(SKIP_STABILITY);
  const frame = await codemapFrame(page);
  await frame.waitForFunction(() => (window as unknown as BenchWindow).codemapBench.nodes);
  await page.waitForTimeout(1000);
  await settle(frame);
  return frame;
}

async function flat(frame: Frame) {
  await frame.click('#seg-view button[data-v="2d"]', SKIP_STABILITY);
  await frame.waitForTimeout(1000);
  await settle(frame);
}

async function select(frame: Frame, path: string) {
  await frame.fill("#q", path);
  await frame.press("#q", "Enter");
  await frame.waitForTimeout(800);
  await settle(frame);
}

/** Presses a key on the map itself, wherever focus is: the search box would swallow it otherwise. */
async function key(frame: Frame, name: string) {
  await frame.evaluate(
    (key) => document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })),
    name,
  );
}

/** The zoom label, once the map has settled and drawn it. */
async function zoomLevel(frame: Frame) {
  await settle(frame);
  return Number.parseFloat((await frame.textContent("#zl")) ?? "0");
}

/** A component in the biggest folder. */
async function component(frame: Frame) {
  const path = await frame.evaluate(() => {
    const nodes = (window as unknown as BenchWindow).codemapBench.nodes ?? [];
    return nodes.find(
      (node) => node.p.startsWith("apps/web/src/components/") && !node.p.includes(".test."),
    )?.p;
  });
  if (!path) throw new Error("the synthetic map has no component in apps/web");
  return path;
}

/** The generated GraphQL client the change regenerates: the longest changed file, imported across the map. */
async function generatedClient(frame: Frame) {
  const path = await frame.evaluate(() => {
    const nodes = (window as unknown as BenchWindow).codemapBench.nodes ?? [];
    return nodes.filter((node) => node.st).sort((a, b) => b.l - a.l)[0]?.p;
  });
  if (!path) throw new Error("the synthetic map has no changed files");
  return path;
}

/** Flies to a file, a component unless told otherwise, lets it go, and zooms to `percent` around it. */
async function zoomInto(frame: Frame, percent: number, file = component) {
  await select(frame, await file(frame));
  await key(frame, "Escape");
  // Each key zooms by 1.4, so the steps are counted from one settled reading rather than re-read between keys.
  const steps = Math.round(Math.log((await zoomLevel(frame)) / percent) / Math.log(1.4));
  for (let step = 0; step < Math.abs(steps); step++) await key(frame, steps > 0 ? "-" : "=");
  await settle(frame);
}

/** Selects a long file, changed if one is, which spreads its pages out over the map. */
async function selectLongFile(frame: Frame) {
  const path = await frame.evaluate(() => {
    const nodes = (window as unknown as BenchWindow).codemapBench.nodes ?? [];
    const long = nodes.filter(
      (node) => node.l > 320 && node.st !== "D" && !node.p.includes(".test."),
    );
    return (long.find((node) => node.st) ?? long.find((node) => node.p.startsWith("apps/web/")))?.p;
  });
  if (!path) throw new Error("the synthetic map has no long file");
  await select(frame, path);
}

async function allImports(frame: Frame) {
  await frame.click("#t-links", SKIP_STABILITY);
  await frame.click('#m-links [data-key="edges:all"]', SKIP_STABILITY);
  await settle(frame);
}

interface Scenario {
  name: string;
  setup?: (frame: Frame) => Promise<void>;
  gesture: Gesture;
  /** A picture of the settled map before the gesture, to check a change draws the same. */
  snapshot?: string;
}

const FAR = 4;
const MID = 50;
const CLOSE = 120;
const PAN: Gesture = { kind: "pan", frames: 150 };
const then =
  (...steps: ((frame: Frame) => Promise<void>)[]) =>
  async (frame: Frame) => {
    for (const step of steps) await step(frame);
  };

const SCENARIOS: Scenario[] = [
  { name: "3D · pan, opening view", gesture: PAN, snapshot: "3d-open" },
  {
    name: "3D · pan, mid zoom",
    setup: (frame) => zoomInto(frame, MID),
    gesture: PAN,
    snapshot: "3d-mid",
  },
  {
    name: "3D · pan, close up",
    setup: (frame) => zoomInto(frame, CLOSE),
    gesture: PAN,
    snapshot: "3d-close",
  },
  {
    name: "3D · pinch zoom",
    setup: (frame) => zoomInto(frame, MID),
    gesture: { kind: "pinch", frames: 160 },
  },
  {
    name: "3D · hover",
    setup: (frame) => zoomInto(frame, MID),
    gesture: { kind: "hover", frames: 150 },
  },
  { name: "Flat · pan, opening view", setup: flat, gesture: PAN, snapshot: "flat-open" },
  {
    name: "Flat · pan, mid zoom",
    setup: then(flat, (frame) => zoomInto(frame, MID)),
    gesture: PAN,
    snapshot: "flat-mid",
  },
  {
    name: "Flat · pan, close up",
    setup: then(flat, (frame) => zoomInto(frame, CLOSE)),
    gesture: PAN,
    snapshot: "flat-close",
  },
  {
    name: "Flat · pinch zoom",
    setup: then(flat, (frame) => zoomInto(frame, MID)),
    gesture: { kind: "pinch", frames: 160 },
  },
  {
    name: "Flat · hover",
    setup: then(flat, (frame) => zoomInto(frame, MID)),
    gesture: { kind: "hover", frames: 150 },
  },
  {
    name: "Flat · pan, file selected",
    setup: then(flat, selectLongFile),
    gesture: PAN,
    snapshot: "flat-selected",
  },
  {
    name: "Flat · pan, all imports",
    setup: then(flat, (frame) => zoomInto(frame, MID), allImports),
    gesture: PAN,
    snapshot: "flat-all-imports",
  },
  {
    // From about 4% to 600%, with the pointer on a file hundreds of others import, as zooming into a schema change goes.
    name: "Flat · zoom in on the generated client",
    setup: then(flat, (frame) => zoomInto(frame, FAR, generatedClient)),
    gesture: { kind: "zoom in", frames: 190 },
  },
];

// Clamp to the viewer's real minimum, then cover the full zoom range to its maximum.
// Both configurations keep exactly the same nodes, layout, target and wheel events.
for (const view of ["3D", "Flat"]) {
  for (const highlighted of [true, false]) {
    SCENARIOS.push({
      name: `${view} · full range · highlighting ${highlighted ? "on" : "off"}`,
      snapshot: `${view.toLowerCase()}-range-${highlighted ? "on" : "off"}`,
      setup: async (frame) => {
        if (view === "Flat") await flat(frame);
        if (!highlighted) {
          await frame.click("#t-show", SKIP_STABILITY);
          await frame.click('#m-show [data-key="highlightChange"]', SKIP_STABILITY);
          await key(frame, "Escape");
        }
        await zoomInto(frame, 0.2, generatedClient);
        // Rounding the key count can stop just above the minimum.
        await key(frame, "-");
        await settle(frame);
      },
      gesture: { kind: "zoom in", frames: 330 },
    });
  }
}

const quantile = (values: number[], q: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
};

interface Result {
  name: string;
  /** Script time in the viewer's frame callback, for frames that drew. */
  drawP50: number;
  drawP95: number;
  /** Script time handling one input event. */
  inputP95: number;
  /** GPU-process time per painted frame spent rastering canvas commands. */
  gpuPerFrame: number;
  /** The same, for the slowest frames the display drew: one gesture's worst stretch shows here, not in the mean. */
  gpuP95: number;
  /** Canvas 2D method calls per frame that drew. */
  callsPerFrame: number;
  /** Time from one painted frame to the next, at 60Hz: 16.7 unless the page's own frame ran over, even while the GPU falls behind. */
  frameP95: number;
  /** Viewer frames that drew something during the gesture. */
  drawn: number;
  seconds: number;
  zoomBands: {
    range: string;
    frames: number;
    drawP95: number;
    frameP95: number;
    latencyP95: number;
  }[];
}

const RASTER_TASKS = new Set([
  "RasterDecoderImpl::DoRasterCHROMIUM",
  "RasterDecoderImpl::DoEndRasterCHROMIUM",
]);

/** Time the GPU process spent rastering canvas commands in a trace, in ms, in all and for each frame the display drew; its other tasks include waiting on the display. */
function gpuRaster(trace: Buffer) {
  const events: {
    name: string;
    ph: string;
    pid: number;
    tid: number;
    ts: number;
    dur?: number;
    args?: { name?: string };
  }[] = JSON.parse(trace.toString("utf8")).traceEvents;
  const gpuThreads = new Set(
    events
      .filter((event) => event.name === "thread_name" && event.args?.name === "CrGpuMain")
      .map((event) => `${event.pid}:${event.tid}`),
  );
  const raster = events
    .filter((event) => event.ph === "X" && RASTER_TASKS.has(event.name))
    .filter((event) => gpuThreads.has(`${event.pid}:${event.tid}`));
  const swaps = events
    .filter((event) => event.ph === "X" && event.name === "Display::DrawAndSwap")
    .map((event) => event.ts)
    .sort((a, b) => a - b);
  const byFrame = swaps.map(() => 0);
  for (const event of raster) {
    // A frame's canvas is rastered before the swap that shows it.
    const shown = swaps.findIndex((swap) => swap >= event.ts);
    if (shown >= 0) byFrame[shown] = (byFrame[shown] ?? 0) + (event.dur ?? 0) / 1000;
  }
  return { total: raster.reduce((sum, event) => sum + (event.dur ?? 0) / 1000, 0), byFrame };
}

/** Counts every canvas 2D call while a few more frames of the gesture play; installed only then, so timings stay clean. */
async function canvasCallsPerFrame(frame: Frame, gesture: Gesture) {
  const calls = await frame.evaluate(
    async (replay) => {
      const prototype = CanvasRenderingContext2D.prototype as unknown as Record<string, unknown>;
      const originals = new Map<string, (...args: unknown[]) => unknown>();
      let count = 0;
      for (const key of Object.getOwnPropertyNames(prototype)) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
        if (key === "constructor" || typeof descriptor?.value !== "function") continue;
        const original = descriptor.value as (...args: unknown[]) => unknown;
        originals.set(key, original);
        prototype[key] = function (this: unknown, ...args: unknown[]) {
          count++;
          return original.apply(this, args);
        };
      }
      const samples = (window as unknown as BenchWindow).codemapBench;
      const before = samples.draws.length;
      await new Promise<void>((done) => {
        let left = replay.frames;
        const canvas = document.querySelector("#cv") as HTMLCanvasElement;
        const step = () => {
          if (left-- <= 0) return done();
          canvas.dispatchEvent(
            new WheelEvent("wheel", { deltaX: 3.1, deltaY: 2.3, bubbles: true, cancelable: true }),
          );
          (window as unknown as BenchWindow).benchRaf(step);
        };
        (window as unknown as BenchWindow).benchRaf(step);
      });
      for (const [key, original] of originals) prototype[key] = original;
      return count / Math.max(1, samples.draws.length - before);
    },
    { frames: Math.min(30, gesture.frames) },
  );
  return calls;
}

async function measure(page: Page, frame: Frame, gesture: Gesture, name: string): Promise<Result> {
  const browser = page.context().browser();
  if (!browser) throw new Error("the bench needs a browser to trace");
  // `viz` marks each frame the display draws, to split the GPU's raster time by frame.
  await browser.startTracing(page, {
    categories: [
      "gpu",
      "viz",
      "devtools.timeline",
      "blink.user_timing",
      "disabled-by-default-v8.cpu_profiler",
    ],
  });
  const since = await frame.evaluate(() => {
    const samples = (window as unknown as BenchWindow).codemapBench;
    samples.inputs.length = 0;
    samples.draws.length = 0;
    samples.beats.length = 0;
    samples.zoomFrames.length = 0;
    samples.recording = true;
    return performance.now();
  });
  const elapsed = await frame.evaluate(play, gesture);
  const samples = await frame.evaluate(() => {
    const { draws, inputs, beats, zoomFrames } = (window as unknown as BenchWindow).codemapBench;
    (window as unknown as BenchWindow).codemapBench.recording = false;
    return { draws, inputs, beats, zoomFrames };
  });
  const trace = await browser.stopTracing();
  const traceName = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  mkdirSync(join(OUT, LABEL), { recursive: true });
  writeFileSync(join(OUT, LABEL, `${traceName}.trace.json.gz`), gzipSync(trace));
  writeFileSync(join(OUT, LABEL, `${traceName}.frames.json`), JSON.stringify(samples.zoomFrames));
  const gpu = gpuRaster(trace);
  const until = since + elapsed;
  const drawn = samples.draws
    .filter(([start]) => start >= since && start <= until)
    .map(([, duration]) => duration);
  const beats = samples.beats.filter((time) => time >= since && time <= until);
  const intervals = beats.slice(1).map((time, at) => time - (beats[at] ?? time));
  return {
    name,
    drawP50: quantile(drawn, 0.5),
    drawP95: quantile(drawn, 0.95),
    inputP95: quantile(samples.inputs, 0.95),
    gpuPerFrame: gpu.total / Math.max(1, beats.length),
    gpuP95: quantile(gpu.byFrame, 0.95),
    callsPerFrame: await canvasCallsPerFrame(frame, gesture),
    frameP95: quantile(intervals, 0.95),
    drawn: drawn.length,
    seconds: elapsed / 1000,
    zoomBands: [0.2, 4.7, 20, 37, 48, 100, 267, 520, 667, 1201]
      .slice(0, -1)
      .map((lower, index, bounds) => {
        const upper = bounds[index + 1] ?? 1201;
        const rows = samples.zoomFrames.filter(([zoom = 0]) => zoom >= lower && zoom < upper);
        return {
          range: `${lower.toFixed(1)}–${Math.min(1200, upper).toFixed(1)}%`,
          frames: rows.length,
          drawP95: quantile(
            rows.map((row) => row[1] ?? 0),
            0.95,
          ),
          frameP95: quantile(
            rows.map((row) => row[2] ?? 0).filter((ms) => ms > 0),
            0.95,
          ),
          latencyP95: quantile(
            rows.map((row) => row[3] ?? 0).filter((ms) => ms > 0),
            0.95,
          ),
        };
      }),
  };
}

async function snapshot(frame: Frame, name: string) {
  const dataUrl = await frame.evaluate(() =>
    (document.querySelector("#cv") as HTMLCanvasElement).toDataURL(),
  );
  mkdirSync(join(OUT, LABEL), { recursive: true });
  writeFileSync(
    join(OUT, LABEL, `${name}.png`),
    Buffer.from(dataUrl.split(",")[1] ?? "", "base64"),
  );
  return dataUrl;
}

/** The share of pixels that differ by more than a faint step between two pictures of the same size. */
async function pictureDifference(page: Page, before: string, after: string) {
  return page.evaluate(
    async ([a, b]) => {
      const load = async (url: string) => {
        const image = new Image();
        image.src = url;
        await image.decode();
        const canvas = new OffscreenCanvas(image.width, image.height);
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("no 2D context to compare pictures");
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.width, image.height).data;
      };
      const [x, y] = await Promise.all([load(a), load(b)]);
      if (x.length !== y.length) return 1;
      let changed = 0;
      for (let at = 0; at < x.length; at += 4) {
        const step = Math.max(
          Math.abs((x[at] ?? 0) - (y[at] ?? 0)),
          Math.abs((x[at + 1] ?? 0) - (y[at + 1] ?? 0)),
          Math.abs((x[at + 2] ?? 0) - (y[at + 2] ?? 0)),
        );
        if (step > 24) changed++;
      }
      return changed / (x.length / 4);
    },
    [before, after] as const,
  );
}

const fixed = (value: number, digits = 1) => value.toFixed(digits);
const change = (before: number, after: number) =>
  before === 0
    ? ""
    : ` (${after <= before ? "−" : "+"}${Math.abs(Math.round((1 - after / before) * 100))}%)`;

type Column =
  | "drawP50"
  | "drawP95"
  | "inputP95"
  | "gpuPerFrame"
  | "gpuP95"
  | "callsPerFrame"
  | "frameP95";

const COLUMNS: [Column, string, number][] = [
  ["drawP50", "Draw p50 ms", 2],
  ["drawP95", "Draw p95 ms", 2],
  ["inputP95", "Input p95 ms", 2],
  ["gpuPerFrame", "GPU raster ms/frame", 2],
  ["gpuP95", "GPU raster p95 ms", 2],
  ["callsPerFrame", "Canvas calls/frame", 0],
  ["frameP95", "Frame p95 ms", 1],
];

function table(results: Result[], baseline?: Partial<Result>[]) {
  const rows = results.map((result) => {
    const before = baseline?.find((entry) => entry.name === result.name);
    const cells = COLUMNS.map(([key, , digits]) => {
      const value = result[key];
      const was = before?.[key];
      // A baseline saved before a column existed has no value for it.
      if (was === undefined) return fixed(value, digits);
      return `${fixed(was, digits)} → ${fixed(value, digits)}${change(was, value)}`;
    });
    return `| ${result.name} | ${cells.join(" | ")} |`;
  });
  return [
    "Draw: the viewer's script per frame that drew. Input: per event. GPU raster: the GPU process rastering the canvas, per painted frame, and its p95 per displayed frame.",
    "Frame p95 times the page's frames, which headless Chromium keeps at 16.7 even while the GPU falls behind: GPU raster p95 over 16.7 means the app drops frames.",
    "",
    `| Scenario | ${COLUMNS.map(([, title]) => title).join(" | ")} |`,
    `| --- | ${COLUMNS.map(() => "---").join(" | ")} |`,
    ...rows,
  ].join("\n");
}

test(`codemap frame times, ${FILES} files`, async ({ page }) => {
  await page.addInitScript(instrument);
  const results: Result[] = [];
  const pictures: Record<string, string> = {};
  let environment: Record<string, unknown> | undefined;
  for (const scenario of SCENARIOS.filter((entry) =>
    ONLY.some((part) => entry.name.includes(part)),
  )) {
    const frame = await openCodemap(page);
    environment ??= {
      cpu: cpus()[0]?.model,
      memoryGiB: totalmem() / 1024 ** 3,
      os: `${platform()} ${release()}`,
      browser: page.context().browser()?.version(),
      ...(await frame.evaluate(() => {
        const gl = document.createElement("canvas").getContext("webgl");
        const debug = gl?.getExtension("WEBGL_debug_renderer_info");
        return {
          graph: (window as unknown as BenchWindow).codemapBench.graph,
          visible: document.querySelector("#stat")?.textContent,
          userAgent: navigator.userAgent,
          viewport: [innerWidth, innerHeight],
          dpr: devicePixelRatio,
          gpu: debug ? gl?.getParameter(debug.UNMASKED_RENDERER_WEBGL) : "unavailable",
        };
      })),
    };
    await scenario.setup?.(frame);
    if (scenario.name.includes("full range")) await expect(frame.locator("#zl")).toHaveText("0.2%");
    if (scenario.snapshot) pictures[scenario.snapshot] = await snapshot(frame, scenario.snapshot);
    results.push(await measure(page, frame, scenario.gesture, scenario.name));
    if (scenario.name.includes("full range"))
      await expect(frame.locator("#zl")).toHaveText("1200%");
  }

  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    join(OUT, `${LABEL}.json`),
    JSON.stringify({ files: FILES, environment, results }, null, 2),
  );
  let baseline: Partial<Result>[] | undefined;
  const lines = [`Codemap bench "${LABEL}", ${FILES} files`];
  if (BASELINE) {
    baseline = JSON.parse(readFileSync(join(OUT, `${BASELINE}.json`), "utf8")).results;
    lines[0] += `, against "${BASELINE}"`;
  }
  lines.push("", table(results, baseline));
  lines.push("", `Environment: ${JSON.stringify(environment)}`);
  for (const result of results.filter((entry) => entry.name.includes("full range"))) {
    lines.push(
      "",
      result.name,
      "",
      "| Zoom | Frames | Draw p95 ms | Frame p95 ms | Input-to-draw p95 ms |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const band of result.zoomBands) {
      lines.push(
        `| ${band.range} | ${band.frames} | ${fixed(band.drawP95, 2)} | ${fixed(band.frameP95, 1)} | ${fixed(band.latencyP95, 2)} |`,
      );
    }
  }
  if (BASELINE) {
    lines.push("", "| Picture | Pixels changed |", "| --- | --- |");
    for (const [name, after] of Object.entries(pictures)) {
      const before = `data:image/png;base64,${readFileSync(join(OUT, BASELINE, `${name}.png`)).toString("base64")}`;
      lines.push(
        `| ${name} | ${fixed((await pictureDifference(page, before, after)) * 100, 2)}% |`,
      );
    }
  }
  const report = lines.join("\n");
  writeFileSync(join(OUT, `${LABEL}.md`), report);
  console.log(`\n${report}\n`);
});
