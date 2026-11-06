import { expect, type Locator, type Page, test } from "@playwright/test";

const prTitle = "Render review findings in the PR workflow";
const views = (page: Page) => page.getByRole("tablist", { name: "Review views" });
const codemap = (page: Page) => page.frameLocator('iframe[title="Codemap"]');

async function openPr(page: Page, query = "") {
  await page.goto(`/dev-harness/${query}`);
  await page.getByText(prTitle, { exact: true }).first().click();
  await page
    .getByRole("button", { name: "Comment on file migrations/0007_add_reviews_table.sql" })
    .waitFor();
}

/** A canvas shrunk to a grid of average colours, as RGBA bytes. */
function shrunkPixels(canvas: Locator): Promise<number[]> {
  return canvas.evaluate((source: HTMLCanvasElement) => {
    const probe = document.createElement("canvas");
    probe.width = 192;
    probe.height = 128;
    const context = probe.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("no 2D context for the probe");
    context.drawImage(source, 0, 0, probe.width, probe.height);
    return Array.from(context.getImageData(0, 0, probe.width, probe.height).data);
  });
}

/** The share of grid cells whose colour moved by more than a faint step. */
function changedShare(before: number[], after: number[]) {
  let changed = 0;
  for (let at = 0; at < before.length; at += 4) {
    const step = Math.max(
      ...[0, 1, 2].map((channel) =>
        Math.abs((before[at + channel] ?? 0) - (after[at + channel] ?? 0)),
      ),
    );
    if (step > 12) changed++;
  }
  return changed / (before.length / 4);
}

/** Waits until the canvas draws the same thing twice in a row. */
async function settledPixels(canvas: Locator) {
  let previous: number[] = [];
  await expect
    .poll(async () => {
      const current = await shrunkPixels(canvas);
      const share = previous.length ? changedShare(previous, current) : 1;
      previous = current;
      return share;
    })
    .toBe(0);
  return previous;
}

test("a file picked in the file list is found on the codemap, and Show diff opens it in the diff", async ({
  page,
}) => {
  await openPr(page);
  await views(page).getByRole("tab", { name: "Codemap" }).click();

  await expect(codemap(page).getByRole("button", { name: "Everything" })).toBeVisible();

  await page.locator('[data-panel="files"]').getByText("fileChange.ts", { exact: true }).click();
  await expect(views(page).getByRole("tab", { name: "Codemap" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const details = codemap(page).getByRole("complementary", { name: "File details" });
  await expect(details).toContainText("src/lib/fileChange.ts");

  await details.getByRole("button", { name: "Show diff" }).click();
  await expect(views(page).getByRole("tab", { name: "Diff" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.getByRole("button", { name: "Comment on file src/lib/fileChange.ts", exact: true }),
  ).toBeInViewport();
});

test("Highlight affected files turns the change's marking off and back on in the map and navigator", async ({
  page,
}) => {
  await openPr(page);
  await views(page).getByRole("tab", { name: "Codemap" }).click();
  const map = codemap(page).getByLabel("Codebase map canvas");
  const overview = codemap(page).getByLabel("Overview");
  await codemap(page).getByRole("button", { name: "Flat" }).click();
  for (let step = 0; step < 3; step++) {
    await codemap(page).getByRole("button", { name: "Zoom in" }).click();
  }
  const highlightedMap = await settledPixels(map);
  const highlightedOverview = await settledPixels(overview);

  await codemap(page).getByRole("button", { name: "Everything" }).click();
  const highlight = codemap(page).getByRole("menuitemcheckbox", {
    name: "Highlight affected files",
  });
  await expect(highlight).toHaveAttribute("aria-checked", "true");
  await highlight.click();
  await expect(highlight).toHaveAttribute("aria-checked", "false");
  expect(changedShare(highlightedMap, await settledPixels(map))).toBeGreaterThan(0.008);
  expect(changedShare(highlightedOverview, await settledPixels(overview))).toBeGreaterThan(0.008);

  await highlight.click();
  await expect(highlight).toHaveAttribute("aria-checked", "true");
  expect(changedShare(highlightedMap, await settledPixels(map))).toBeLessThan(0.002);
  expect(changedShare(highlightedOverview, await settledPixels(overview))).toBeLessThan(0.002);
});

test("a codemap that can't be drawn says why and can be tried again", async ({ page }) => {
  await openPr(page, "?fail=codemap");
  await views(page).getByRole("tab", { name: "Codemap" }).click();
  await expect(page.getByText("The codemap couldn't be drawn")).toBeVisible();
  await expect(page.getByText("unknown revision: 9f2c1ab")).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("the codemap redraws its code shapes and navigator after Chromium's GPU process restarts", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Only Chromium can restart its GPU process on demand");
  await openPr(page);
  await views(page).getByRole("tab", { name: "Codemap" }).click();
  const map = codemap(page).getByLabel("Codebase map canvas");
  const overview = codemap(page).getByLabel("Overview");
  await codemap(page).getByRole("searchbox", { name: "Find a file" }).fill("DiffViewer");
  await codemap(page).getByRole("searchbox", { name: "Find a file" }).press("Enter");
  await expect(codemap(page).getByRole("complementary", { name: "File details" })).toContainText(
    "src/components/DiffViewer/DiffViewer.tsx",
  );
  const mapBefore = await settledPixels(map);
  const overviewBefore = await settledPixels(overview);

  await map.evaluate((canvas: HTMLCanvasElement) => {
    const frame = window as Window & { codemapContextLost?: Promise<boolean> };
    frame.codemapContextLost = new Promise((resolve) => {
      canvas.addEventListener("contextlost", () => resolve(true), { once: true });
      setTimeout(() => resolve(false), 5000);
    });
  });
  const browser = page.context().browser();
  if (!browser) throw new Error("the page has no browser to reach over CDP");
  await (await browser.newBrowserCDPSession()).send("Browser.crashGpuProcess");
  const lost = await map.evaluate(
    () => (window as Window & { codemapContextLost?: Promise<boolean> }).codemapContextLost,
  );
  test.skip(!lost, "This Chromium draws canvases without the GPU, so it has nothing to lose");

  await expect
    .poll(async () => changedShare(mapBefore, await shrunkPixels(map)), {
      message: "the map draws the selected file's code shape as it did before",
    })
    .toBeLessThan(0.002);
  await expect
    .poll(async () => changedShare(overviewBefore, await shrunkPixels(overview)), {
      message: "the navigator shows the folders and files as it did before",
    })
    .toBeLessThan(0.002);
});

for (const width of [2400, 1500]) {
  test(`the codemap's file, line and import counts sit alone as plain text at the bottom centre of a map in a ${width}px window`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await openPr(page);
    await views(page).getByRole("tab", { name: "Codemap" }).click();
    const counts = codemap(page).getByText(/^\d+ files · \S+ lines\d+ imports$/);
    await expect(counts).toBeVisible();
    await expectAloneAtBottomCentre(counts);
  });
}

async function expectAloneAtBottomCentre(counts: Locator) {
  const placement = await counts.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const backed: string[] = [];
    for (
      let node: Element | null = element;
      node && node !== document.body;
      node = node.parentElement
    ) {
      const style = getComputedStyle(node);
      const painted =
        style.backgroundColor !== "rgba(0, 0, 0, 0)" ||
        style.backgroundImage !== "none" ||
        style.boxShadow !== "none" ||
        ["top", "right", "bottom", "left"].some(
          (side) => style.getPropertyValue(`border-${side}-width`) !== "0px",
        );
      if (painted) backed.push(node.id || node.className || node.tagName);
    }
    const overlapping = [...document.querySelectorAll(".panel")]
      .filter((panel) => panel.checkVisibility())
      .filter((panel) => {
        const other = panel.getBoundingClientRect();
        return (
          other.left < box.right &&
          other.right > box.left &&
          other.top < box.bottom &&
          other.bottom > box.top
        );
      })
      .map((panel) => panel.id);
    return {
      centreOffset: box.left + box.width / 2 - innerWidth / 2,
      bottomGap: innerHeight - box.bottom,
      backed,
      overlapping,
    };
  });
  expect(Math.abs(placement.centreOffset)).toBeLessThan(2);
  expect(placement.bottomGap).toBeLessThan(24);
  expect(placement.backed).toEqual([]);
  expect(placement.overlapping).toEqual([]);
}
