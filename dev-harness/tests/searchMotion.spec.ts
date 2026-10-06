import { expect, test } from "@playwright/test";

test("natural shared-container playback keeps scenery paused through both flights", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/dev-harness/");
  await page.getByRole("button", { name: "Search this view", exact: true }).waitFor();
  const samples = await page.evaluate(async () => {
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Search this view"]');
    if (!trigger) throw new Error("Missing search trigger");
    const name = trigger.style.getPropertyValue("--tk-morph-name");
    const held = () => (window as unknown as { sceneryHeld: () => boolean }).sceneryHeld();
    const run = async (close: boolean) => {
      const frames: { t: number; x: number; width: number; held: boolean }[] = [];
      const started = performance.now();
      if (close) {
        const button = document.querySelector<HTMLButtonElement>('[aria-label="Close search"]');
        if (!button) throw new Error("Missing close button");
        button.click();
      } else trigger.click();
      for (let index = 0; index < 120; index++) {
        await new Promise(requestAnimationFrame);
        const moving = document
          .getAnimations()
          .some(
            (animation) =>
              (animation.effect as KeyframeEffect | null)?.pseudoElement ===
                `::view-transition-group(${name})` && animation.playState === "running",
          );
        if (!moving) {
          if (frames.length) break;
          continue;
        }
        const style = getComputedStyle(
          document.documentElement,
          `::view-transition-group(${name})`,
        );
        const transform = new DOMMatrixReadOnly(style.transform);
        frames.push({
          t: performance.now() - started,
          x: transform.m41,
          width: Number.parseFloat(style.width) * transform.m11,
          held: held(),
        });
      }
      // Wait for the group and its old/new images before starting another flight.
      await Promise.allSettled(
        document
          .getAnimations()
          .filter((animation) =>
            (animation.effect as KeyframeEffect | null)?.pseudoElement?.startsWith(
              "::view-transition",
            ),
          )
          .map((animation) => animation.finished),
      );
      return frames;
    };
    const opening = await run(false);
    const closing = await run(true);
    return { opening, closing };
  });
  await testInfo.attach("natural-motion.json", {
    body: JSON.stringify(samples, null, 2),
    contentType: "application/json",
  });
  for (const direction of ["opening", "closing"] as const) {
    const frames = samples[direction];
    expect(frames.length).toBeGreaterThan(5);
    expect(frames.every((frame) => frame.held)).toBe(true);
    expect(Math.abs((frames.at(-1)?.x ?? 0) - (frames[0]?.x ?? 0))).toBeGreaterThan(300);
    for (let index = 1; index < frames.length; index++) {
      const before = frames[index - 1];
      const after = frames[index];
      if (!before || !after) throw new Error("Missing playback frame");
      if (direction === "opening") expect(after.x).toBeLessThanOrEqual(before.x + 0.25);
      else expect(after.x).toBeGreaterThanOrEqual(before.x - 0.25);
    }
  }
  await expect(page.getByRole("dialog", { name: "Find in this view" })).not.toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { sceneryHeld: () => boolean }).sceneryHeld()),
    )
    .toBe(false);
});

test("popup contents travel inside the container during natural playback", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/dev-harness/");
  await page.addStyleTag({ content: ":root { --tk-duration-shared: 2000ms; }" });
  const trigger = page.getByRole("button", { name: "Search this view", exact: true });
  const name = await trigger.evaluate((node) =>
    (node as HTMLElement).style.getPropertyValue("--tk-morph-name"),
  );
  await trigger.click();
  await page.evaluate(async (name) => {
    while (true) {
      await new Promise(requestAnimationFrame);
      const group = document
        .getAnimations()
        .find(
          (animation) =>
            (animation.effect as KeyframeEffect | null)?.pseudoElement ===
            `::view-transition-group(${name})`,
        );
      if (group && Number(group.currentTime) >= 900) return;
    }
  }, name);
  await page.screenshot({ path: testInfo.outputPath("natural-midpoint.png") });
  await expect(
    page
      .getByRole("dialog", { name: "Find in this view" })
      .getByRole("combobox", { name: "Search text" }),
  ).toBeFocused();
});
