import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * The durations of every animation on a trigger's container while it morphs:
 * the browser's own move of the box, and the frame the design system paints
 * on it (its fill, edge and corners), which it times from the root.
 */
async function containerTimings(page: Page, trigger: Locator) {
  const name = await trigger.evaluate((node) =>
    (node as HTMLElement).style.getPropertyValue("--tk-morph-name"),
  );
  expect(name).not.toBe("");
  await trigger.click();
  const timings = await page.waitForFunction((name) => {
    const durations = document
      .getAnimations()
      .filter(
        (animation) =>
          (animation.effect as KeyframeEffect | null)?.pseudoElement ===
          `::view-transition-group(${name})`,
      )
      .map((animation) => Number(animation.effect?.getTiming().duration));
    // The move, then the frame's corners and its fill.
    return durations.length >= 3 ? durations : null;
  }, name);
  const durations = await timings.jsonValue();
  if (!durations) throw new Error("The container never moved");
  return durations;
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/dev-harness/");
  await page.addStyleTag({
    content: ":root { --popup-duration: 1500ms; --tk-duration-morph: 2500ms; }",
  });
});

test("a popup morphs on the app's popup clock, frame and all", async ({ page }) => {
  const trigger = page.getByRole("button", { name: "Columns", exact: true });
  for (const duration of await containerTimings(page, trigger)) expect(duration).toBe(1500);
});

test("a dialog keeps the theme's pace", async ({ page }) => {
  const trigger = page.getByRole("button", { name: "Search this view", exact: true });
  for (const duration of await containerTimings(page, trigger)) expect(duration).toBe(2500);
});
