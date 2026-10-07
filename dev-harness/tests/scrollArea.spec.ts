import { expect, type Locator, type Page, test } from "@playwright/test";

const area = (page: Page, label: string) => page.locator(`[data-scroll-area="${label}"]`);
const viewport = (root: Locator) => root.locator("[data-scroll-viewport]");
const track = (root: Locator) => root.locator(':scope > [data-orientation="vertical"]');

async function expectNoGutter(root: Locator) {
  await expect(viewport(root)).toHaveCSS("scrollbar-width", "none");
  expect(
    await viewport(root).evaluate(
      (element: HTMLElement) => element.offsetWidth - element.clientWidth,
    ),
  ).toBe(0);
  await expect(viewport(root)).toHaveAttribute("tabindex", "0");
}

async function dragDown(page: Page, root: Locator) {
  await viewport(root).hover();
  await expect(track(root)).toHaveCSS("opacity", "1");
  const bounds = await track(root).boundingBox();
  const thumb = await track(root).locator('[data-orientation="vertical"]').boundingBox();
  if (!bounds || !thumb) throw new Error("Missing overlay scrollbar geometry");
  const before = await viewport(root).evaluate((element) => element.scrollTop);
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
  await page.mouse.down();
  await page.mouse.move(thumb.x + thumb.width / 2, bounds.y + bounds.height * 0.7, { steps: 12 });
  await page.mouse.up();
  await expect
    .poll(() => viewport(root).evaluate((element) => element.scrollTop))
    .toBeGreaterThan(before);
}

test("PR overlay scrollbar scrolls, drags, and updates as more pages arrive", async ({
  page,
}, testInfo) => {
  await page.goto("/dev-harness/?prs=250");
  await page.getByRole("tab", { name: /^All open/ }).click();
  const root = area(page, "Pull requests");
  await expect(page.locator("tr[data-pr]")).toHaveCount(100);
  await expectNoGutter(root);
  await dragDown(page, root);
  await page.screenshot({ path: testInfo.outputPath("pr-overlay-scrollbar.png") });
  const thumb = track(root).locator('[data-orientation="vertical"]');
  const initialHeight = await thumb.evaluate((element) => element.getBoundingClientRect().height);
  await viewport(root).evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => page.locator("tr[data-pr]").count()).toBeGreaterThan(100);
  await expect
    .poll(() => thumb.evaluate((element) => element.getBoundingClientRect().height))
    .toBeLessThan(initialHeight);
  await page.mouse.move(0, 0);
  await expect(track(root)).toHaveCSS("opacity", "0");
});

test("diff and review overlays keep the renderer, file navigation and keyboard scrolling working", async ({
  page,
}, testInfo) => {
  await page.goto("/dev-harness/");
  await page.locator('tr[data-pr="47"] td[data-column="title"] button').click();
  await expect(
    page.getByRole("button", {
      name: "Comment on file migrations/0007_add_reviews_table.sql",
      exact: true,
    }),
  ).toBeVisible();
  const diff = area(page, "Diff");
  const discussion = area(page, "Pull request conversation");
  await expectNoGutter(diff);
  await expectNoGutter(discussion);
  expect(
    await viewport(discussion).evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBe(0);
  await dragDown(page, diff);
  await dragDown(page, discussion);
  await viewport(diff).focus();
  const before = await viewport(diff).evaluate((element) => element.scrollTop);
  await page.keyboard.press("PageUp");
  await expect
    .poll(() => viewport(diff).evaluate((element) => element.scrollTop))
    .toBeLessThan(before);
  await page.locator('[data-search-id="file:migrations/0007_add_reviews_table.sql"]').click();
  await expect(
    page.getByRole("button", {
      name: "Comment on file migrations/0007_add_reviews_table.sql",
      exact: true,
    }),
  ).toBeInViewport();
  await viewport(diff).hover();
  await page.screenshot({ path: testInfo.outputPath("review-overlay-scrollbars.png") });
  for (const label of ["Files", "Commits"]) {
    await expect(viewport(area(page, label))).toHaveCSS("scrollbar-width", "none");
  }
});
