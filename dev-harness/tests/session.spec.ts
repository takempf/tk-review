import { expect, type Page, test } from "@playwright/test";

const prTitle = "Render review findings in the PR workflow";
const openReviews = (page: Page) => page.getByRole("navigation", { name: "Open reviews" });
const closeButtons = (page: Page) => openReviews(page).getByRole("button", { name: /^Close / });
const prHeading = (page: Page) => page.getByRole("link", { name: `#47 ${prTitle}` });
const prDiffLoaded = (page: Page) =>
  page.getByRole("button", {
    name: "Comment on file migrations/0007_add_reviews_table.sql",
    exact: true,
  });

test("a reload reopens every tab, the one on screen loaded, until a tab is closed", async ({
  page,
}) => {
  await page.goto("/dev-harness/");
  await page.getByText(prTitle, { exact: true }).first().click();
  await prDiffLoaded(page).waitFor();
  await page.getByTitle("Back to pull requests").click();
  await page.getByRole("button", { name: "Compare branches" }).click();
  await expect(closeButtons(page)).toHaveCount(1);
  await openReviews(page)
    .getByRole("button", { name: new RegExp(prTitle) })
    .first()
    .click();
  await expect(prHeading(page)).toBeVisible();

  await page.reload();
  await expect(prHeading(page)).toBeVisible();
  await expect(prDiffLoaded(page)).toBeVisible();
  await expect(closeButtons(page)).toHaveCount(1);
  await expect(closeButtons(page).nth(0)).toHaveAccessibleName("Close main … feature/diff-viewer");
  await page.getByTitle("Back to pull requests").click();
  await expect(closeButtons(page)).toHaveCount(2);
  await expect(closeButtons(page).nth(0)).toHaveAccessibleName(`Close #47 ${prTitle}`);

  await closeButtons(page).nth(1).click();
  await expect(closeButtons(page)).toHaveCount(1);
  await page.reload();
  await expect(closeButtons(page)).toHaveCount(1);
  await expect(closeButtons(page).nth(0)).toHaveAccessibleName(`Close #47 ${prTitle}`);
});
