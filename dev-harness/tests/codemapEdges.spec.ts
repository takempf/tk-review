import { expect, type Frame, test } from "@playwright/test";

interface Paint {
  labels: Record<string, [number, number]>;
  curves: number[][];
  pages: { x: number; y: number; w: number; h: number; matrix: number[] }[];
}

type PaintWindow = Window & { edgePaint: Paint };

/** Observe the actual drawing calls, in every frame, without adding a viewer test API. */
function observeEdges() {
  const paint: Paint = { labels: {}, curves: [], pages: [] };
  Object.assign(window, { edgePaint: paint });
  addEventListener("message", (event) => {
    if (event.data?.type !== "tk-review:codemap") return;
    const graph = event.data.graph;
    graph.diff = false;
    graph.nodes = [
      { p: "src/anchors/importer.ts", k: "ts", l: 40, r: 40, s: 1 },
      { p: "src/anchors/exporter.ts", k: "ts", l: 400, r: 400, s: 1 },
      { p: "src/anchors/sampled.ts", k: "ts", l: 1280, r: 320, s: 4 },
    ].map((node) => ({ ...node, o: 0, b: node.l * 30, x: [] }));
    graph.edges = graph.tedges = [
      [0, 1, 0, -1, 0, 8, 210],
      [0, 2, 0, -1, 0, 12, 600],
      [1, 0, 0, -1, 0, 370, 24],
    ];
  });
  const prototype = CanvasRenderingContext2D.prototype;
  const fillRect = prototype.fillRect;
  prototype.fillRect = function (x, y, w, h) {
    if (
      this.canvas.id === "cv" &&
      x === 0 &&
      y === 0 &&
      w === this.canvas.clientWidth &&
      h === this.canvas.clientHeight
    ) {
      paint.curves = [];
      paint.pages = [];
    }
    fillRect.call(this, x, y, w, h);
  };
  const fillText = prototype.fillText;
  prototype.fillText = function (text, x, y, maxWidth) {
    if (this.canvas.id === "cv" && /^(importer|exporter|sampled)\.ts$/.test(text)) {
      paint.labels[text] = [x - 27, y - 15];
    }
    if (maxWidth === undefined) fillText.call(this, text, x, y);
    else fillText.call(this, text, x, y, maxWidth);
  };
  let start: [number, number] = [0, 0];
  const moveTo = prototype.moveTo;
  prototype.moveTo = function (x, y) {
    start = [x, y];
    moveTo.call(this, x, y);
  };
  const cubic = prototype.bezierCurveTo;
  prototype.bezierCurveTo = function (...args) {
    if (this.canvas.id === "cv") paint.curves.push([...start, ...args]);
    cubic.apply(this, args);
  };
  const quadratic = prototype.quadraticCurveTo;
  prototype.quadraticCurveTo = function (...args) {
    if (this.canvas.id === "cv") paint.curves.push([...start, ...args]);
    quadratic.apply(this, args);
  };
  const strokeRect = prototype.strokeRect;
  prototype.strokeRect = function (x, y, w, h) {
    if (this.canvas.id === "cv") {
      const m = this.getTransform();
      paint.pages.push({
        x,
        y,
        w,
        h,
        matrix: [m.a, m.b, m.c, m.d, m.e, m.f].map(
          (value) => value / Math.min(2, devicePixelRatio || 1),
        ),
      });
    }
    strokeRect.call(this, x, y, w, h);
  };
}

async function paint(frame: Frame) {
  return frame.evaluate(() => (window as unknown as PaintWindow).edgePaint);
}

async function select(frame: Frame, name: string) {
  const search = frame.getByRole("searchbox", { name: "Find a file" });
  await search.fill(name);
  await search.press("Enter");
  await expect(frame.locator("#detail h2")).toHaveText(name);
}

test("connections follow import/export rows, page boundaries, unfolded pages and sampled rows", async ({
  page,
}) => {
  await page.addInitScript(observeEdges);
  await page.goto("/dev-harness/");
  await page
    .getByText("Render review findings in the PR workflow", { exact: true })
    .first()
    .click();
  await page
    .getByRole("tablist", { name: "Review views" })
    .getByRole("tab", { name: "Codemap" })
    .click();
  const element = await page.locator('iframe[title="Codemap"]').elementHandle();
  const frame = await element?.contentFrame();
  if (!frame) throw new Error("missing codemap frame");
  await frame.getByRole("button", { name: "Flat", exact: true }).click();
  await expect.poll(async () => Object.keys((await paint(frame)).labels).length).toBe(3);
  const labels = (await paint(frame)).labels;
  const importer = labels["importer.ts"];
  const exporter = labels["exporter.ts"];
  const sampled = labels["sampled.ts"];
  if (!importer || !exporter || !sampled) throw new Error("missing file labels");
  const near = (actual: number | undefined, expected: number) =>
    actual !== undefined && Math.abs(actual - expected) < 0.01;
  await select(frame, "importer.ts");

  const hasEndpoints = (p: Paint, fromY: number, toY: number) =>
    p.curves.some((curve) => near(curve[1], fromY) && near(curve.at(-1), toY));
  // A 160-line page is 300 world units tall. Line 210 is below its visible page.
  await expect
    .poll(async () =>
      hasEndpoints(await paint(frame), importer[1] + 29 + 7.5 * 1.875, exporter[1] + 29 + 300),
    )
    .toBe(true);
  // The sampled file keeps one row for every four source lines; line 600 is row 149.
  await expect
    .poll(async () =>
      hasEndpoints(
        await paint(frame),
        importer[1] + 29 + 11.5 * 1.875,
        sampled[1] + 29 + 149.5 * 1.875,
      ),
    )
    .toBe(true);
  // A hidden import also leaves from its source page's bottom edge.
  await expect
    .poll(async () =>
      hasEndpoints(await paint(frame), exporter[1] + 29 + 300, importer[1] + 29 + 23.5 * 1.875),
    )
    .toBe(true);

  await select(frame, "exporter.ts");
  // Unfolding reveals line 210 on page two, one column (164 units) to the right.
  await expect
    .poll(async () =>
      (await paint(frame)).curves.some(
        (curve) =>
          near(curve[1], importer[1] + 29 + 7.5 * 1.875) &&
          near(curve.at(-1), exporter[1] + 29 + 49.5 * 1.875) &&
          [exporter[0] + 164, exporter[0] + 164 + 150].some((x) => near(curve.at(-2), x)),
      ),
    )
    .toBe(true);
  // Its import on line 370 follows page three when the source file unfolds.
  await expect
    .poll(async () =>
      (await paint(frame)).curves.some(
        (curve) =>
          near(curve[1], exporter[1] + 29 + 49.5 * 1.875) &&
          near(curve.at(-1), importer[1] + 29 + 23.5 * 1.875) &&
          [exporter[0] + 328, exporter[0] + 328 + 150].some((x) => near(curve[0], x)),
      ),
    )
    .toBe(true);

  await select(frame, "importer.ts");
  await frame.getByRole("button", { name: "3D", exact: true }).click();
  await frame.locator("#zfit").click();
  await expect
    .poll(async () => {
      const p = await paint(frame);
      const source = p.pages.find((rect) => rect.w === 150 && rect.h === 75);
      const target = p.pages.find(
        (rect) =>
          rect.w === 150 && rect.h === 300 && rect.x === exporter[0] && rect.y === exporter[1] + 29,
      );
      if (!source || !target) return false;
      const ends = (rect: typeof source, offset: number) =>
        [0, 150].map((side): [number, number] => {
          const [a, b, c, d, e, f] = rect.matrix as [
            number,
            number,
            number,
            number,
            number,
            number,
          ];
          return [
            a * (rect.x + side) + c * (rect.y + offset) + e,
            b * (rect.x + side) + d * (rect.y + offset) + f,
          ];
        });
      return p.curves.some(
        (curve) =>
          curve.length === 6 &&
          ends(source, 7.5 * 1.875).some(([x, y]) => near(curve[0], x) && near(curve[1], y)) &&
          ends(target, 300).some(([x, y]) => near(curve[4], x) && near(curve[5], y)),
      );
    })
    .toBe(true);
});
