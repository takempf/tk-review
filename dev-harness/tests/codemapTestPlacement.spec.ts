import { expect, type Frame, test } from "@playwright/test";

type LabelWindow = Window & { cardCorners: Record<string, [number, number]> };

const CARD_WIDTH = 170;
const CARD_GAP = 46;
const WIDGET_CODE = ["Button.tsx", "Card.tsx", "Dialog.tsx", "Form.tsx"];
const WIDGET_TESTS = ["Button.test.tsx", "Card.test.tsx", "Dialog.test.tsx"];

/** Swaps in folders with colocated tests and records where each file's card is drawn. */
function observeCards() {
  const corners: Record<string, [number, number]> = {};
  Object.assign(window, { cardCorners: corners });
  addEventListener("message", (event) => {
    if (event.data?.type !== "tk-review:codemap") return;
    const graph = event.data.graph;
    graph.diff = false;
    graph.nodes = (
      [
        ["src/widgets/Button.tsx", "tsx", 120],
        ["src/widgets/Button.test.tsx", "tsx", 80],
        ["src/widgets/Card.tsx", "tsx", 60],
        ["src/widgets/Card.test.tsx", "tsx", 60],
        ["src/widgets/Dialog.tsx", "tsx", 200],
        ["src/widgets/Dialog.test.tsx", "tsx", 40],
        ["src/widgets/Form.tsx", "tsx", 90],
        ["server/api.py", "py", 150],
        ["server/test_api.py", "py", 70],
      ] as const
    ).map(([p, k, l]) => ({ p, k, l, r: l, s: 1, o: 0, b: l * 30, x: [] }));
    graph.edges = graph.tedges = [];
  });
  const fillText = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
    // A card's name is drawn 27 right of and 15 below its corner.
    if (this.canvas.id === "cv" && /\.(tsx|py)$/.test(text)) corners[text] = [x - 27, y - 15];
    if (maxWidth === undefined) fillText.call(this, text, x, y);
    else fillText.call(this, text, x, y, maxWidth);
  };
}

async function cards(frame: Frame) {
  const corners = await frame.evaluate(() => ({
    ...(window as unknown as LabelWindow).cardCorners,
  }));
  const at = (name: string) => {
    const corner = corners[name];
    if (!corner) throw new Error(`${name} isn't drawn`);
    return { x: corner[0], y: corner[1] };
  };
  const xs = (names: string[]) => names.map((name) => at(name).x);
  return { at, xs };
}

async function placeTests(frame: Frame, placement: string) {
  await frame.locator("#t-arrange").click();
  await frame.getByRole("menuitemradio", { name: placement }).click();
  await frame.locator("#t-arrange").press("Escape");
  await frame.locator("#zfit").click();
}

// Wide enough that the fitted map draws every card's name.
test.use({ viewport: { width: 2200, height: 1200 } });

test("tests sit in their own columns by default, mixed in, or beside the file each tests", async ({
  page,
}) => {
  await page.addInitScript(observeCards);
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
  await frame.locator("#t-filter").click();
  await frame.getByRole("menuitemcheckbox", { name: "Tests" }).click();
  await frame.locator("#t-filter").press("Escape");
  await frame.locator("#zfit").click();

  // Grouped to the side: every test is right of every other file, further off than the next card.
  await expect
    .poll(async () => {
      const { xs } = await cards(frame);
      return Math.min(...xs(WIDGET_TESTS)) - (Math.max(...xs(WIDGET_CODE)) + CARD_WIDTH);
    })
    .toBeGreaterThan(CARD_GAP);

  await placeTests(frame, "Mixed in");
  await expect
    .poll(async () => {
      const { xs } = await cards(frame);
      return Math.min(...xs(WIDGET_TESTS)) < Math.max(...xs(WIDGET_CODE));
    })
    .toBe(true);

  await placeTests(frame, "Next to the file they test");
  await expect
    .poll(async () => {
      const { at } = await cards(frame);
      return [
        ["Button.tsx", "Button.test.tsx"],
        ["Card.tsx", "Card.test.tsx"],
        ["Dialog.tsx", "Dialog.test.tsx"],
        ["api.py", "test_api.py"],
      ].every(([file = "", testFile = ""]) => {
        const gap = at(testFile).x - (at(file).x + CARD_WIDTH);
        return at(testFile).y === at(file).y && gap > 0 && gap < CARD_GAP;
      });
    })
    .toBe(true);
});
