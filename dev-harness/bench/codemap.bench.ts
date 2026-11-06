import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Frame, type Page, test } from "@playwright/test";

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
  nodes?: { p: string; st?: string; l: number }[];
}

type BenchWindow = Window & { codemapBench: Samples; benchRaf: typeof requestAnimationFrame };

/** Runs in every frame before its scripts: times the viewer's frames and keeps a heartbeat beside them. */
function instrument() {
  const raf = window.requestAnimationFrame.bind(window);
  const samples: Samples = { draws: [], lastBusy: 0, inputs: [], beats: [], recording: false };
  Object.assign(window, { codemapBench: samples, benchRaf: raf });
  window.requestAnimationFrame = (callback) =>
    raf((time) => {
      const start = performance.now();
      callback(time);
      const duration = performance.now() - start;
      if (duration > 0.1) samples.draws.push([start, duration]);
      if (duration > 0.3) samples.lastBusy = start;
    });
  const beat = (time: number) => {
    if (samples.recording) samples.beats.push(time);
    raf(beat);
  };
  raf(beat);
  addEventListener("message", (event) => {
    if (event.data?.type === "tk-review:codemap") samples.nodes = event.data.graph.nodes;
  });
}

type Gesture =
  | { kind: "pan"; frames: number }
  | { kind: "pinch"; frames: number }
  | { kind: "hover"; frames: number };

/** Plays a gesture into the map, one input event per frame, as a trackpad delivers them. */
function play(gesture: Gesture) {
  const bench = window as unknown as BenchWindow;
  const canvas = document.querySelector("#cv") as HTMLCanvasElement;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const send = (event: Event) => {
    const start = performance.now();
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

/** Flies to a file in the biggest folder, lets it go, and zooms to `percent` around it. */
async function zoomInto(frame: Frame, percent: number) {
  const path = await frame.evaluate(() => {
    const nodes = (window as unknown as BenchWindow).codemapBench.nodes ?? [];
    return nodes.find(
      (node) => node.p.startsWith("apps/web/src/components/") && !node.p.includes(".test."),
    )?.p;
  });
  if (!path) throw new Error("the synthetic map has no component in apps/web");
  await select(frame, path);
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
];

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
  /** Canvas 2D method calls per frame that drew. */
  callsPerFrame: number;
  /** Time from one painted frame to the next, at 60Hz: 16.7 unless a frame ran over. */
  frameP95: number;
  /** Viewer frames that drew something during the gesture. */
  drawn: number;
  seconds: number;
}

/** Time the GPU process spent rastering canvas commands in a trace, in ms; its other tasks include waiting on the display. */
const RASTER_TASKS = new Set([
  "RasterDecoderImpl::DoRasterCHROMIUM",
  "RasterDecoderImpl::DoEndRasterCHROMIUM",
]);

function gpuMainTime(trace: Buffer) {
  const events: {
    name: string;
    ph: string;
    pid: number;
    tid: number;
    dur?: number;
    args?: { name?: string };
  }[] = JSON.parse(trace.toString("utf8")).traceEvents;
  const gpuThreads = new Set(
    events
      .filter((event) => event.name === "thread_name" && event.args?.name === "CrGpuMain")
      .map((event) => `${event.pid}:${event.tid}`),
  );
  return events
    .filter((event) => event.ph === "X" && RASTER_TASKS.has(event.name))
    .filter((event) => gpuThreads.has(`${event.pid}:${event.tid}`))
    .reduce((sum, event) => sum + (event.dur ?? 0) / 1000, 0);
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
  await browser.startTracing(page, { categories: ["gpu"] });
  const since = await frame.evaluate(() => {
    const samples = (window as unknown as BenchWindow).codemapBench;
    samples.inputs.length = 0;
    samples.draws.length = 0;
    samples.beats.length = 0;
    samples.recording = true;
    return performance.now();
  });
  const elapsed = await frame.evaluate(play, gesture);
  const samples = await frame.evaluate(() => {
    const { draws, inputs, beats } = (window as unknown as BenchWindow).codemapBench;
    (window as unknown as BenchWindow).codemapBench.recording = false;
    return { draws, inputs, beats };
  });
  const gpu = gpuMainTime(await browser.stopTracing());
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
    gpuPerFrame: gpu / Math.max(1, beats.length),
    callsPerFrame: await canvasCallsPerFrame(frame, gesture),
    frameP95: quantile(intervals, 0.95),
    drawn: drawn.length,
    seconds: elapsed / 1000,
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

type Column = "drawP50" | "drawP95" | "inputP95" | "gpuPerFrame" | "callsPerFrame" | "frameP95";

const COLUMNS: [Column, string, number][] = [
  ["drawP50", "Draw p50 ms", 2],
  ["drawP95", "Draw p95 ms", 2],
  ["inputP95", "Input p95 ms", 2],
  ["gpuPerFrame", "GPU raster ms/frame", 2],
  ["callsPerFrame", "Canvas calls/frame", 0],
  ["frameP95", "Frame p95 ms", 1],
];

function table(results: Result[], baseline?: Result[]) {
  const rows = results.map((result) => {
    const before = baseline?.find((entry) => entry.name === result.name);
    const cells = COLUMNS.map(([key, , digits]) => {
      const value = result[key];
      if (!before) return fixed(value, digits);
      return `${fixed(before[key], digits)} → ${fixed(value, digits)}${change(before[key], value)}`;
    });
    return `| ${result.name} | ${cells.join(" | ")} |`;
  });
  return [
    "Draw: the viewer's script per frame that drew. Input: per event. GPU raster: the GPU process rastering the canvas, per painted frame.",
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
  for (const scenario of SCENARIOS.filter((entry) =>
    ONLY.some((part) => entry.name.includes(part)),
  )) {
    const frame = await openCodemap(page);
    await scenario.setup?.(frame);
    if (scenario.snapshot) pictures[scenario.snapshot] = await snapshot(frame, scenario.snapshot);
    results.push(await measure(page, frame, scenario.gesture, scenario.name));
  }

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${LABEL}.json`), JSON.stringify({ files: FILES, results }, null, 2));
  let baseline: Result[] | undefined;
  const lines = [`Codemap bench "${LABEL}", ${FILES} files`];
  if (BASELINE) {
    baseline = JSON.parse(readFileSync(join(OUT, `${BASELINE}.json`), "utf8")).results;
    lines[0] += `, against "${BASELINE}"`;
  }
  lines.push("", table(results, baseline));
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
