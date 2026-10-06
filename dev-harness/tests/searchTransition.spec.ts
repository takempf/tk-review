import { expect, type Page, test } from "@playwright/test";

async function captureFlights(page: Page) {
  await page.addInitScript(() => {
    const start = document.startViewTransition.bind(document);
    const flights: {
      ready: boolean;
      finished: boolean;
      error?: string;
      animations: Animation[];
    }[] = [];
    Object.assign(window, { searchFlights: flights });
    document.startViewTransition = (...args: Parameters<typeof start>) => {
      const flight = {
        ready: false,
        finished: false,
        error: undefined as string | undefined,
        animations: [] as Animation[],
      };
      flights.push(flight);
      const transition = start(...args);
      transition.ready.then(
        () => {
          flight.animations = document
            .getAnimations()
            .filter((animation) =>
              (animation.effect as KeyframeEffect | null)?.pseudoElement?.startsWith(
                "::view-transition",
              ),
            );
          for (const animation of flight.animations) {
            animation.pause();
            animation.currentTime = 0;
          }
          flight.ready = true;
        },
        (error) => {
          flight.error = String(error);
        },
      );
      transition.finished.then(() => {
        flight.finished = true;
      });
      return transition;
    };
  });
}

async function ready(page: Page, index: number) {
  await expect
    .poll(() =>
      page.evaluate((i) => {
        const flight = (
          window as unknown as { searchFlights: { ready: boolean; error?: string }[] }
        ).searchFlights[i];
        return flight?.error ?? flight?.ready;
      }, index),
    )
    .toBe(true);
}

async function sample(page: Page, name: string, progress: number) {
  return page.evaluate(
    ({ name, progress }) => {
      const animations = document
        .getAnimations()
        .filter((animation) =>
          (animation.effect as KeyframeEffect | null)?.pseudoElement?.startsWith(
            "::view-transition",
          ),
        );
      const travel = animations.find(
        (animation) =>
          (animation.effect as KeyframeEffect | null)?.pseudoElement ===
          `::view-transition-group(${name})`,
      );
      const time = Number(travel?.effect?.getTiming().duration) * progress;
      for (const animation of animations) animation.currentTime = time;
      const group = getComputedStyle(document.documentElement, `::view-transition-group(${name})`);
      const image = getComputedStyle(document.documentElement, `::view-transition-new(${name})`);
      const matrix = new DOMMatrixReadOnly(group.transform);
      return {
        x: matrix.m41,
        y: matrix.m42,
        width: Number.parseFloat(group.width) * matrix.m11,
        height: Number.parseFloat(group.height) * matrix.m22,
        easing: group.animationTimingFunction,
        duration: group.animationDuration,
        imageWidth: image.width,
        imageHeight: image.height,
        animations: animations.length,
      };
    },
    { name, progress },
  );
}

async function finish(page: Page, index: number) {
  await page.evaluate((i) => {
    // Short backdrop animations may leave getAnimations() after seeking past
    // their end, but a paused animation still needs to be finished explicitly.
    const flight = (window as unknown as { searchFlights: { animations: Animation[] }[] })
      .searchFlights[i];
    for (const animation of flight?.animations ?? []) animation.finish();
  }, index);
  await expect
    .poll(() =>
      page.evaluate(
        (i) =>
          (window as unknown as { searchFlights: { finished: boolean }[] }).searchFlights[i]
            ?.finished,
        index,
      ),
    )
    .toBe(true);
}

for (const zoom of [1, 0.8, 1.25]) {
  test(`search morphs its actual container and contents both ways at ${zoom} zoom`, async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await captureFlights(page);
    await page.goto("/dev-harness/");
    await page.addStyleTag({
      content: `:root { --tk-duration-shared: 1200ms; } body { zoom: ${zoom}; }`,
    });
    const trigger = page.getByRole("button", {
      name: "Search this view",
      exact: true,
      includeHidden: true,
    });
    const source = await trigger.boundingBox();
    const sourceIcon = await trigger.locator('[data-tk-shared-side="trigger"]').boundingBox();
    const name = await trigger.evaluate((node) =>
      (node as HTMLElement).style.getPropertyValue("--tk-morph-name"),
    );
    expect(name).not.toBe("");
    if (!source || !sourceIcon) throw new Error("Missing trigger boxes");
    await trigger.click();
    await ready(page, 0);
    const popup = page.getByRole("dialog", { name: "Find in this view" });
    const destination = await popup.boundingBox();
    const destinationIcon = await popup.locator('[data-tk-shared-side="popup"]').boundingBox();
    if (!destination || !destinationIcon) throw new Error("Missing popup boxes");
    await expect(popup).toHaveAttribute("data-tk-morph", "box");
    expect(
      await popup.evaluate((node) =>
        (node as HTMLElement).style.getPropertyValue("--tk-morph-name"),
      ),
    ).toBe(name);
    await expect(trigger).not.toHaveAttribute("data-tk-morph");
    await expect(popup).not.toHaveAttribute("data-tk-grow");
    await expect(popup.locator(".tk-dialog-title, .tk-dialog-description")).toHaveCount(0);
    await expect(popup.getByRole("combobox", { name: "Search text" })).toBeFocused();
    const opening = [];
    for (const progress of [0, 0.5, 1]) {
      opening.push(await sample(page, name, progress));
      const icon = await sample(page, `${name}-search`, progress);
      expect(icon.x).toBeCloseTo(sourceIcon.x + (destinationIcon.x - sourceIcon.x) * progress, 0);
      expect(icon.y).toBeCloseTo(sourceIcon.y + (destinationIcon.y - sourceIcon.y) * progress, 0);
      if (progress === 0.5 && zoom === 1)
        await testInfo.attach("opening-midpoint", {
          body: await page.screenshot({ path: testInfo.outputPath("opening-midpoint.png") }),
          contentType: "image/png",
        });
    }
    for (const [index, progress] of [0, 0.5, 1].entries()) {
      const frame = opening[index];
      if (!frame) throw new Error("Missing opening frame");
      expect(frame.animations).toBeGreaterThan(0);
      expect(frame.x).toBeCloseTo(source.x + (destination.x - source.x) * progress, 0);
      expect(frame.y).toBeCloseTo(source.y + (destination.y - source.y) * progress, 0);
      expect(frame.width).toBeCloseTo(
        source.width + (destination.width - source.width) * progress,
        0,
      );
      expect(frame.height).toBeCloseTo(
        source.height + (destination.height - source.height) * progress,
        0,
      );
      expect(frame.duration).toBe("1.2s");
      expect(frame.easing).toBe("cubic-bezier(0.4, 0, 0.6, 1)");
      expect(Number.parseFloat(frame.imageWidth)).toBeCloseTo(frame.width, 0);
      expect(Number.parseFloat(frame.imageHeight)).toBeCloseTo(frame.height, 0);
    }
    await finish(page, 0);
    await expect(trigger).toHaveCSS("opacity", "0");
    await page.setViewportSize({ width: 1100, height: 500 });
    const from = await popup.boundingBox();
    const to = await trigger.boundingBox();
    if (!from || !to) throw new Error("Missing resized boxes");
    await page.keyboard.press("Escape");
    await ready(page, 1);
    const closing = [];
    for (const progress of [0, 0.5, 1]) {
      const frame = await sample(page, name, progress);
      closing.push(frame);
      expect(frame.x).toBeCloseTo(from.x + (to.x - from.x) * progress, 0);
      // View-transition snapshots round viewport coordinates at fractional zoom.
      expect(Math.abs(frame.y - (from.y + (to.y - from.y) * progress))).toBeLessThan(
        zoom === 1 ? 0.1 : 1,
      );
      expect(frame.width).toBeCloseTo(from.width + (to.width - from.width) * progress, 0);
      expect(frame.height).toBeCloseTo(from.height + (to.height - from.height) * progress, 0);
    }
    await testInfo.attach("container-frames.json", {
      body: JSON.stringify({ opening, closing }, null, 2),
      contentType: "application/json",
    });
    await finish(page, 1);
    expect(
      await page.evaluate(() => getComputedStyle(document.documentElement).viewTransitionName),
    ).toBe("none");
    await expect(popup).not.toBeVisible();
    await expect(trigger).toHaveCSS("opacity", "1");
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Meta+f");
    await ready(page, 2);
    await finish(page, 2);
    await popup.getByRole("button", { name: "Close search", exact: true }).click();
    await ready(page, 3);
    await finish(page, 3);
    await expect(popup).not.toBeVisible();
  });
}

test("closing during the opening transition restores a usable trigger", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await captureFlights(page);
  await page.goto("/dev-harness/");
  await page.keyboard.press("Meta+f");
  await ready(page, 0);
  const popup = page.getByRole("dialog", { name: "Find in this view" });
  const name = await popup.evaluate((node) =>
    (node as HTMLElement).style.getPropertyValue("--tk-morph-name"),
  );
  await sample(page, name, 0.5);
  await page.keyboard.press("Escape");
  await ready(page, 1);
  await finish(page, 1);
  await expect(popup).not.toBeVisible();
  const trigger = page.getByRole("button", { name: "Search this view", exact: true });
  await expect(trigger).toHaveCSS("opacity", "1");
  await trigger.click();
  await ready(page, 2);
  await finish(page, 2);
  await expect(popup.getByRole("combobox", { name: "Search text" })).toBeFocused();
});

test("choosing a result waits for the container to return before navigating", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await captureFlights(page);
  await page.goto("/dev-harness/");
  await page
    .getByText("Render review findings in the PR workflow", { exact: true })
    .first()
    .waitFor();
  await page.keyboard.press("Meta+f");
  await ready(page, 0);
  await finish(page, 0);
  const popup = page.getByRole("dialog", { name: "Find in this view" });
  const input = popup.getByRole("combobox", { name: "Search text" });
  await input.fill("Render review findings");
  await expect(popup.getByRole("option")).toHaveCount(1);
  await input.press("Enter");
  await ready(page, 1);
  const file = page.getByRole("button", {
    name: "Comment on file migrations/0007_add_reviews_table.sql",
    exact: true,
  });
  await expect(file).not.toBeVisible();
  await finish(page, 1);
  // The harness pauses the following screen transition as well.
  await ready(page, 2);
  await finish(page, 2);
  await expect(file).toBeVisible();
});
