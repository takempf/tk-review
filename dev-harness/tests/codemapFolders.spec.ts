import { expect, type Frame, test } from "@playwright/test";

interface TextPaint {
  text: string;
  font: string;
  x: number;
  y: number;
  width: number;
  ascent: number;
  descent: number;
  matrix: number[];
}

interface FolderPaint {
  outlines: { points: number[][]; matrix: number[] }[];
  labels: TextPaint[];
  pills: number[][];
}

type PaintWindow = Window & { folderPaint: FolderPaint };
const LONG_FOLDER = "a-folder-with-a-long-name-that-needs-a-wider-tab";
test.use({ viewport: { width: 2200, height: 1400 } });

/** Records the actual canvas geometry, without exposing the viewer's state to tests. */
function observeFolders(longFolder: string) {
  const paint: FolderPaint = { outlines: [], labels: [], pills: [] };
  Object.assign(window, { folderPaint: paint });
  addEventListener("message", (event) => {
    if (event.data?.type !== "tk-review:codemap") return;
    const graph = event.data.graph;
    graph.diff = false;
    graph.nodes = [
      "src/index.ts",
      "src/widgets/Button.tsx",
      "src/widgets/Card.tsx",
      `src/${longFolder}/Only.ts`,
      "packages/ui/index.ts",
      "packages/shared/index.ts",
    ].map((p) => ({ p, k: "ts", l: 80, r: 80, s: 1, o: 0, b: 2400, x: [] }));
    graph.edges = graph.tedges = [];
  });
  const prototype = CanvasRenderingContext2D.prototype;
  const matrix = (context: CanvasRenderingContext2D) => {
    const m = context.getTransform();
    return [m.a, m.b, m.c, m.d, m.e, m.f].map(
      (value) => value / Math.min(2, devicePixelRatio || 1),
    );
  };
  const fillRect = prototype.fillRect;
  prototype.fillRect = function (x, y, w, h) {
    if (this.canvas.id === "cv" && x === 0 && y === 0 && w === this.canvas.clientWidth) {
      paint.outlines = [];
      paint.labels = [];
      paint.pills = [];
    }
    fillRect.call(this, x, y, w, h);
  };
  let points: number[][] = [];
  const beginPath = prototype.beginPath;
  prototype.beginPath = function () {
    points = [];
    beginPath.call(this);
  };
  const moveTo = prototype.moveTo;
  prototype.moveTo = function (x, y) {
    points.push([x, y]);
    moveTo.call(this, x, y);
  };
  const lineTo = prototype.lineTo;
  prototype.lineTo = function (x, y) {
    points.push([x, y]);
    lineTo.call(this, x, y);
  };
  const stroke = prototype.stroke as (this: CanvasRenderingContext2D, path?: Path2D) => void;
  prototype.stroke = function (path?: Path2D) {
    if (this.canvas.id === "cv" && !path && points.length === 6) {
      paint.outlines.push({ points: points.slice(), matrix: matrix(this) });
    }
    if (path) stroke.call(this, path);
    else stroke.call(this);
  };
  const roundRect = prototype.roundRect;
  prototype.roundRect = function (x, y, w, h, radii) {
    if (this.canvas.id === "cv" && h === 20) paint.pills.push([x, y, w, h]);
    roundRect.call(this, x, y, w, h, radii);
  };
  const fillText = prototype.fillText;
  prototype.fillText = function (text, x, y, maxWidth) {
    if (this.canvas.id === "cv") {
      const metrics = this.measureText(text);
      paint.labels.push({
        text,
        font: this.font,
        x,
        y,
        width: metrics.width,
        ascent: metrics.actualBoundingBoxAscent,
        descent: metrics.actualBoundingBoxDescent,
        matrix: matrix(this),
      });
    }
    if (maxWidth === undefined) fillText.call(this, text, x, y);
    else fillText.call(this, text, x, y, maxWidth);
  };
}

function transform(matrix: number[], x: number, y: number) {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = matrix;
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

function untransform(matrix: number[], x: number, y: number) {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = matrix;
  const determinant = a * d - b * c;
  return {
    x: (d * (x - e) - c * (y - f)) / determinant,
    y: (a * (y - f) - b * (x - e)) / determinant,
  };
}

const paint = (frame: Frame) =>
  frame.evaluate(() => (window as unknown as PaintWindow).folderPaint);

async function zoom(frame: Frame, direction: "in" | "out") {
  const before = await frame.locator("#zl").innerText();
  await frame.getByRole("button", { name: `Zoom ${direction}`, exact: true }).click();
  await expect(frame.locator("#zl")).not.toHaveText(before);
}

/** Measures rendered text in the folder's ground plane, including in the tilted projection. */
function textBox(label: TextPaint, matrix: number[]) {
  const at = (x: number, y: number) => {
    const screen = transform(label.matrix, x, y);
    return untransform(matrix, screen.x, screen.y);
  };
  const left = at(label.x, label.y);
  const top = at(label.x, label.y - label.ascent);
  const right = at(label.x + label.width, label.y);
  const bottom = at(label.x, label.y + label.descent);
  return { x: left.x, y: left.y, top: top.y, right: right.x, bottom: bottom.y };
}

function largeFolder(p: FolderPaint, name: string) {
  const label = p.labels.find((label) => label.text === name && !label.font.includes("12px"));
  if (!label) throw new Error(`missing large label for ${name}`);
  for (const outline of p.outlines) {
    const [corner, end, shoulder] = outline.points;
    if (!corner || !end || !shoulder) continue;
    const box = textBox(label, outline.matrix);
    if (
      box.x >= (corner[0] ?? 0) &&
      box.x < (end[0] ?? 0) &&
      box.top >= (corner[1] ?? 0) &&
      box.bottom < (shoulder[1] ?? 0)
    ) {
      return { label, box, outline, corner, end, shoulder };
    }
  }
  throw new Error(`${name} is outside its folder tab`);
}

for (const projection of ["Flat", "3D"]) {
  test(`folder tabs contain larger stacked labels and anchor floating labels in ${projection}`, async ({
    page,
  }) => {
    await page.addInitScript(observeFolders, LONG_FOLDER);
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
    await frame.getByRole("button", { name: projection, exact: true }).click();
    // Focus this folder so it stays visible on both sides of the label transition.
    await frame.locator("#t-scope").click();
    await frame.getByRole("menuitemradio", { name: /^src\b/ }).click();
    await frame.locator("#t-scope").press("Escape");
    await frame.locator("#zfit").click();
    while (Number.parseInt(await frame.locator("#zl").innerText(), 10) < 32) {
      await zoom(frame, "in");
    }
    await expect
      .poll(async () => (await paint(frame)).labels.some((label) => label.text === LONG_FOLDER))
      .toBe(true);
    const p = await paint(frame);
    for (const name of [LONG_FOLDER, "widgets"]) {
      const { label, box, outline, end, shoulder } = largeFolder(p, name);
      expect(box.right).toBeLessThan(end[0] ?? 0);
      const fontTop = transform(label.matrix, 0, 0);
      const fontBottom = transform(
        label.matrix,
        0,
        Number.parseFloat(label.font.split(" ")[1] ?? "0"),
      );
      const worldTop = untransform(outline.matrix, fontTop.x, fontTop.y);
      const worldBottom = untransform(outline.matrix, fontBottom.x, fontBottom.y);
      const scale = Math.hypot(outline.matrix[0] ?? 0, outline.matrix[2] ?? 0);
      expect(worldBottom.y - worldTop.y).toBeGreaterThan(Math.min(26, 17 / scale));
      const stats = p.labels.find((candidate) => {
        if (!/^\d+ files · .* lines$/.test(candidate.text)) return false;
        const meta = textBox(candidate, outline.matrix);
        return (
          Math.abs(meta.x - box.x) < 0.01 &&
          meta.top > box.bottom &&
          meta.bottom < (shoulder[1] ?? 0)
        );
      });
      expect(stats, `${name}'s stats fit directly below its name`).toBeDefined();
      if (stats) expect(textBox(stats, outline.matrix).right).toBeLessThan(end[0] ?? 0);
      const file = p.labels.find(
        (candidate) => candidate.text === (name === LONG_FOLDER ? "Only.ts" : "Button.tsx"),
      );
      expect(file).toBeDefined();
      if (file && projection === "Flat")
        expect(textBox(file, outline.matrix).top).toBeGreaterThan(shoulder[1] ?? 0);
    }
    const large = largeFolder(p, "widgets");
    while (Number.parseInt(await frame.locator("#zl").innerText(), 10) >= 30) {
      await zoom(frame, "out");
    }
    await expect
      .poll(async () =>
        (await paint(frame)).labels.some(
          (label) => label.text === "widgets" && label.font.includes("12px"),
        ),
      )
      .toBe(true);
    const floating = await paint(frame);
    const outline = floating.outlines.find(
      (outline) =>
        outline.points[0]?.[0] === large.corner[0] && outline.points[0]?.[1] === large.corner[1],
    );
    expect(outline).toBeDefined();
    if (!outline) throw new Error("missing widgets tab outline");
    const anchor = transform(outline.matrix, large.corner[0] ?? 0, large.corner[1] ?? 0);
    expect(
      floating.pills.some(
        ([x = 0, y = 0]) => Math.abs(x - anchor.x) < 0.01 && Math.abs(y - anchor.y) < 0.01,
      ),
    ).toBe(true);
    if (projection === "3D") {
      const canvas = await frame.locator("#cv").boundingBox();
      if (!canvas) throw new Error("missing map canvas");
      const x = canvas.x + canvas.width / 2;
      const y = canvas.y + canvas.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down({ button: "right" });
      await page.mouse.move(x - 120, y + 40, { steps: 4 });
      await page.mouse.up({ button: "right" });
      await expect
        .poll(async () => {
          const turned = await paint(frame);
          const tab = turned.outlines.find(
            (outline) =>
              outline.points[0]?.[0] === large.corner[0] &&
              outline.points[0]?.[1] === large.corner[1],
          );
          if (!tab || tab.matrix[0] === outline.matrix[0]) return false;
          const corner = transform(tab.matrix, large.corner[0] ?? 0, large.corner[1] ?? 0);
          return turned.pills.some(
            ([x = 0, y = 0]) => Math.abs(x - corner.x) < 0.01 && Math.abs(y - corner.y) < 0.01,
          );
        })
        .toBe(true);
    }
  });
}
