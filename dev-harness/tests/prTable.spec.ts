import { expect, test } from "@playwright/test";

for (const reducedMotion of ["reduce", "no-preference"] as const) {
  test(`PR tabs update the same table through loading and empty results (${reducedMotion})`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await page.goto("/dev-harness/");
    const rows = page.locator("tr[data-pr]");
    const table = page.getByRole("table");
    await expect(rows).toHaveCount(4);
    const retained = await table.evaluateHandle((table) => [
      table,
      table.parentElement,
      table.querySelector("thead"),
      ...table.querySelectorAll("th"),
    ]);
    const title = table.locator('th[data-column="title"]');
    await title.getByRole("button").click();
    await expect(title).toHaveAttribute("aria-sort", "ascending");

    // Mine has no cached data yet; its first fetch must keep the table mounted.
    await page.getByRole("tab", { name: /^Mine/ }).click();
    await expect(page.getByText("Loading pull requests…", { exact: true })).toBeVisible();
    expect(await retained.evaluate((nodes) => nodes.every((node) => node?.isConnected))).toBe(true);
    await expect(rows).toHaveCount(3);
    await expect(title).toHaveAttribute("aria-sort", "ascending");

    await page.getByRole("tab", { name: /^Review requested/ }).click();
    await expect(rows).toHaveCount(4);
    const sharedRow = await page.locator('tr[data-pr="47"]').elementHandle();
    await page.getByRole("tab", { name: /^All open/ }).click();
    await expect(rows).toHaveCount(7);
    expect(await sharedRow?.evaluate((row) => row.isConnected)).toBe(true);
    await page.getByRole("tab", { name: /^Reviewed/ }).click();
    await expect(rows).toHaveCount(3);
    expect(await sharedRow?.evaluate((row) => row.isConnected)).toBe(true);

    const input = page.getByRole("combobox", {
      name: "Filter pull requests, or paste a pull request link",
    });
    await input.fill("no-such-pr");
    await expect(rows).toHaveCount(0);
    await expect(page.getByText("Nothing matches that filter.", { exact: true })).toBeVisible();
    await expect(title).toBeVisible();
    await input.fill("");
    await expect(rows).toHaveCount(3);
    expect(await retained.evaluate((nodes) => nodes.every((node) => node?.isConnected))).toBe(true);
    await expect(title).toHaveAttribute("aria-sort", "ascending");
  });
}

test("a failed tab listing keeps the table and its header", async ({ page }) => {
  await page.goto("/dev-harness/?fail=list");
  const table = page.getByRole("table");
  await expect(table).toBeVisible();
  const retained = await table.elementHandle();
  await expect(
    page.getByText("Pasting a PR link above still works.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: /^Reviewed/ }).click();
  await expect(page.locator("tr[data-pr]")).toHaveCount(3);
  await page.getByRole("tab", { name: /^Mine/ }).click();
  await expect(
    page.getByText("Pasting a PR link above still works.", { exact: true }),
  ).toBeVisible();
  expect(await retained?.evaluate((table) => table.isConnected)).toBe(true);
  await expect(table.locator("thead")).toBeVisible();
});
