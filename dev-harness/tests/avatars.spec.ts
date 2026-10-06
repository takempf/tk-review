import { expect, test } from "@playwright/test";

const picture =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><path fill="#d876e3" d="M0 0h64v64H0z"/></svg>';
const avatarRoute = /https:\/\/github\.com\/[^/]+\.png\?size=64$/;

test("decoded avatars are shared across rows, suggestions and reviews without HTTP caching", async ({
  page,
}, testInfo) => {
  const requests = new Map<string, number>();
  let release: () => void = () => {};
  const loading = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(avatarRoute, async (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.set(path, (requests.get(path) ?? 0) + 1);
    await loading;
    await route.fulfill({
      contentType: "image/svg+xml",
      headers: { "cache-control": "no-store" },
      body: picture,
    });
  });
  await page.addInitScript(() => {
    const painted = new WeakSet<HTMLCanvasElement>();
    Object.assign(window, { paintedAvatars: painted });
    CanvasRenderingContext2D.prototype.drawImage = new Proxy(
      CanvasRenderingContext2D.prototype.drawImage,
      {
        apply(target, context: CanvasRenderingContext2D, args) {
          Reflect.apply(target, context, args);
          painted.add(context.canvas);
        },
      },
    );
  });
  await page.goto("/dev-harness/");
  const rows = page.locator("tr[data-pr]");
  const octocat = page.locator('tr[data-pr="47"] td[data-column="author"]');
  await expect(rows).toHaveCount(4);
  await expect(octocat).toContainText("Ooctocat");
  await expect(rows.locator("canvas")).toHaveCount(0);
  release();
  await expect(rows.locator("canvas")).toHaveCount(4);
  expect(requests.get("/octocat.png")).toBe(1);

  const input = page.getByRole("combobox", {
    name: "Filter pull requests, or paste a pull request link",
  });
  await input.fill("author:octo");
  const suggestion = page.getByRole("option", { name: /^octocat 2$/ });
  await expect(suggestion).toBeVisible();
  expect(
    await suggestion
      .locator("canvas")
      .evaluate((canvas) =>
        (window as unknown as { paintedAvatars: WeakSet<Element> }).paintedAvatars.has(canvas),
      ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("cached-avatar-suggestion.png") });
  await input.fill("");
  await page.getByRole("tab", { name: /^Mine/ }).click();
  await expect(rows.locator("canvas")).toHaveCount(3);
  await page.getByRole("tab", { name: /^Review requested/ }).click();
  await expect(rows.locator("canvas")).toHaveCount(4);
  await octocat.locator("canvas").screenshot({ path: testInfo.outputPath("cached-avatar.png") });
  await page.getByRole("tab", { name: /^Reviewed/ }).click();
  await expect(rows.locator("canvas")).toHaveCount(3);
  await page.getByRole("tab", { name: /^Review requested/ }).click();
  await page.locator('tr[data-pr="47"] td[data-column="title"] button').click();
  await expect(page.getByRole("button", { name: "Add comment", exact: true })).toBeVisible();
  await expect.poll(() => requests.get("/vercel.png")).toBe(1);
  expect(requests.get("/vercel[bot].png")).toBeUndefined();
  expect([...requests.values()].every((count) => count === 1)).toBe(true);
});

test("unavailable avatars retain initials and do not retry for every occurrence", async ({
  page,
}) => {
  let attempts = 0;
  await page.route(avatarRoute, async (route) => {
    if (new URL(route.request().url()).pathname === "/octocat.png") {
      attempts++;
      await route.abort();
    } else {
      await route.fulfill({ contentType: "image/svg+xml", body: picture });
    }
  });
  await page.goto("/dev-harness/");
  const rows = page.locator("tr[data-pr]");
  await expect(rows).toHaveCount(4);
  await expect(rows.locator("canvas")).toHaveCount(2);
  await page.getByRole("tab", { name: /^Mine/ }).click();
  await expect(rows).toHaveCount(3);
  await page.getByRole("tab", { name: /^Review requested/ }).click();
  await expect(rows).toHaveCount(4);
  const octocat = page.locator('tr[data-pr="47"] td[data-column="author"]');
  await expect(octocat).toContainText("Ooctocat");
  await expect(octocat.locator("canvas")).toHaveCount(0);
  expect(attempts).toBe(1);
});
