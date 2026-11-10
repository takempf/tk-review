import { expect, type Frame, test } from "@playwright/test";

/** Observe visible curves, including their dash style, without a viewer test API. */
function observeChangedLinks() {
  const paint = { strokes: [] as { dashed: boolean; curves: number }[] };
  Object.assign(window, { changedLinkPaint: paint });
  addEventListener("message", (event) => {
    if (event.data?.type !== "tk-review:codemap") return;
    const graph = event.data.graph;
    graph.nodes = ["importer", "added", "removed", "barrel"].map((name) => ({
      p: `src/${name}.ts`,
      k: "ts",
      l: 40,
      r: 0,
      s: 1,
      o: 0,
      b: 1200,
      x: [],
      st: "M",
    }));
    graph.edges = [[0, 3, 0, -1, 1]];
    graph.tedges = [
      [0, 1, 0, -1, 1],
      [0, 2, 1, -1, 2],
    ];
  });
  const prototype = CanvasRenderingContext2D.prototype;
  const fillRect = prototype.fillRect;
  prototype.fillRect = function (x, y, w, h) {
    if (this.canvas.id === "cv" && x === 0 && y === 0 && w === innerWidth && h === innerHeight) {
      paint.strokes = [];
    }
    fillRect.call(this, x, y, w, h);
  };
  let curves = 0;
  const beginPath = prototype.beginPath;
  prototype.beginPath = function () {
    if (this.canvas.id === "cv") curves = 0;
    beginPath.call(this);
  };
  const bezier = prototype.bezierCurveTo;
  prototype.bezierCurveTo = function (...args) {
    if (this.canvas.id === "cv") curves++;
    bezier.apply(this, args);
  };
  const stroke = prototype.stroke;
  prototype.stroke = function (path?: Path2D) {
    if (this.canvas.id === "cv" && curves) {
      paint.strokes.push({ dashed: this.getLineDash().length > 0, curves });
    }
    Reflect.apply(stroke, this, path ? [path] : []);
  };
}

async function curves(frame: Frame) {
  return frame.evaluate(() => {
    const paint = (
      window as Window & {
        changedLinkPaint?: { strokes: { dashed: boolean; curves: number }[] };
      }
    ).changedLinkPaint;
    return paint?.strokes.map(({ dashed, curves }) => [dashed, curves]);
  });
}

test("changed imports follow link filters, barrel resolution and highlighting in both views", async ({
  page,
}) => {
  await page.addInitScript(observeChangedLinks);
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

  for (const view of ["Flat", "3D"]) {
    await frame.getByRole("button", { name: view, exact: true }).click();
    await frame.locator("#zfit").click();
    await expect
      .poll(() => curves(frame))
      .toEqual([
        [false, 1],
        [true, 1],
      ]);

    await frame.locator("#t-links").click();
    await frame.getByRole("menuitemcheckbox", { name: "Type-only imports" }).click();
    await expect.poll(() => curves(frame)).toEqual([[false, 1]]);
    await frame.getByRole("menuitemcheckbox", { name: "Type-only imports" }).click();
    await expect
      .poll(() => curves(frame))
      .toEqual([
        [false, 1],
        [true, 1],
      ]);
    await frame.getByRole("menuitemcheckbox", { name: "See through barrels" }).click();
    await expect.poll(() => curves(frame)).toEqual([[false, 1]]);
    await frame.getByRole("menuitemcheckbox", { name: "See through barrels" }).click();
    await expect
      .poll(() => curves(frame))
      .toEqual([
        [false, 1],
        [true, 1],
      ]);
    await frame.locator("#t-links").click();

    await frame.locator("#t-show").click();
    await frame.getByRole("menuitemcheckbox", { name: "Highlight affected files" }).click();
    await expect.poll(() => curves(frame)).toEqual([]);
    await frame.getByRole("menuitemcheckbox", { name: "Highlight affected files" }).click();
    await expect
      .poll(() => curves(frame))
      .toEqual([
        [false, 1],
        [true, 1],
      ]);
    await frame.locator("#t-show").click();
  }
});
