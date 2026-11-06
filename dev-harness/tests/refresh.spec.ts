import { expect, test } from "@playwright/test";

test("the title bar's one Refresh button refetches the PR list, or the review on screen", async ({
  page,
}) => {
  await page.goto("/dev-harness/");
  await expect(page.locator("tr[data-pr]")).toHaveCount(4);
  const listRefresh = page.getByRole("button", { name: "Refresh pull requests", exact: true });
  await expect(listRefresh).not.toHaveAttribute("aria-busy");
  await listRefresh.click();
  await expect(listRefresh).toHaveAttribute("aria-busy", "true");
  await expect(listRefresh).not.toHaveAttribute("aria-busy");

  await page.locator("tr[data-pr]").first().click();
  await page
    .getByRole("button", { name: "Comment on file migrations/0007_add_reviews_table.sql" })
    .waitFor();
  const reviewRefresh = page.getByRole("button", { name: "Refresh pull request", exact: true });
  await expect(reviewRefresh).not.toHaveAttribute("aria-busy");
  await reviewRefresh.click();
  await expect(reviewRefresh).toHaveAttribute("aria-busy", "true");
  await expect(reviewRefresh).not.toHaveAttribute("aria-busy");
  await expect(page.getByRole("button", { name: /Refresh/ })).toHaveCount(1);
});
