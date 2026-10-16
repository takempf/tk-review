import { expect, type Page, test } from "@playwright/test";
import type { PriorReview } from "../../src/ipc/git";
import { SUMMARY } from "../fixture";

/** Opens the fixture PR and runs a review on it. */
async function review(page: Page, query = "") {
  await page.goto(`/dev-harness/${query}`);
  await page
    .getByText("Render review findings in the PR workflow", { exact: true })
    .first()
    .click();
  await page.getByRole("tab", { name: /^(AI review|Review)$/ }).click();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.getByRole("button", { name: "Re-review", exact: true })).toBeEnabled();
}

const requests = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { reReviewRequests: { prior: PriorReview; whole: boolean }[] })
        .reReviewRequests,
  );

const outsideTitle = "Import order mixes local and package imports.";

test("a re-review looks at what changed since the last review, and folds away the rest", async ({
  page,
}) => {
  await review(page);
  await page.getByRole("button", { name: "Re-review", exact: true }).click();
  await expect.poll(async () => (await requests(page)).length).toBe(1);
  const [request] = await requests(page);
  expect(request?.whole).toBe(false);
  // It's told the commit the review read, to look for changes since.
  expect(request?.prior.head).toBe(SUMMARY.compareHead);

  const toggle = page.getByRole("button", { name: /^Set aside/ }).first();
  await expect(toggle).toContainText("1 outside what changed");
  const title = page.getByText(outsideTitle, { exact: true });
  await expect(title).toBeHidden();
  await toggle.click();
  await expect(title).toBeVisible();
  await expect(page.getByText("Outside what changed · suggestion")).toBeVisible();
  await expect(page.getByText(/group them so the next import/)).toBeVisible();
});

test("Whole diff re-reviews everything again", async ({ page }) => {
  await review(page);
  await page.getByRole("button", { name: "Whole diff", exact: true }).click();
  await expect.poll(async () => (await requests(page)).length).toBe(1);
  expect((await requests(page))[0]?.whole).toBe(true);

  await expect(page.getByRole("button", { name: /full re-review/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /outside what changed/ })).toHaveCount(0);
});

test("a re-review that had to read the whole diff says why", async ({ page }) => {
  await review(page, "?fail=scope");
  await page.getByRole("button", { name: "Re-review", exact: true }).click();
  await expect(page.getByText(/is gone from the repository, so this re-review read/)).toBeVisible();
});
