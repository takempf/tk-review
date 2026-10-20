import { expect, type Page, test } from "@playwright/test";

const title = "Stale diffs are hidden rather than prevented.";

/** Opens the fixture PR and runs a review on it. */
async function review(page: Page) {
  await page.goto("/dev-harness/");
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
    () => (window as unknown as { commentRequests: Record<string, unknown>[] }).commentRequests,
  );

/** The live review's card for the finding about the change as a whole. */
const card = (page: Page) => page.locator('[data-search-id^="review:claude:f::"]');

test("a finding about the change as a whole leads the review and has nowhere to jump", async ({
  page,
}) => {
  await review(page);
  await expect(card(page).getByText("The change as a whole", { exact: true })).toBeVisible();
  await expect(card(page).getByRole("button", { name: /^Jump to/ })).toHaveCount(0);
  // Ahead of the findings on files, as a reviewer's comment on the approach is.
  const titles = page.locator('[data-search-id^="review:claude:f:"] p').filter({ hasText: /\.$/ });
  await expect(titles.first()).toHaveText(title);
});

test("a finding about the change as a whole posts to the PR conversation", async ({ page }) => {
  await review(page);
  await card(page).getByRole("button", { name: "Send to PR", exact: true }).click();
  const editor = card(page).getByRole("textbox", { name: "Pull request comment" });
  await expect(editor).toHaveValue(new RegExp(`^${title}`));
  await expect(editor).not.toHaveValue(/Originally noted/);
  await card(page).getByRole("button", { name: "Post", exact: true }).click();
  await expect(card(page).getByRole("link", { name: "Posted to PR", exact: true })).toBeVisible();
  expect((await requests(page))[0]).toMatchObject({
    destination: "topLevel",
    path: null,
    line: null,
  });
});

test("a dismissed finding about the change as a whole drafts a rule without a path", async ({
  page,
}) => {
  await review(page);
  await card(page).getByRole("button", { name: "Dismiss", exact: true }).click();
  await card(page).getByRole("radio", { name: "Not a problem" }).click();
  await card(page).getByRole("button", { name: "Dismiss finding" }).click();
  await page
    .getByRole("button", { name: /^Set aside/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Make it a rule" }).click();
  // Raised by the lead and Architecture both, so the rule is the lead's.
  const dialog = page.getByRole("dialog", { name: "Review rules" });
  await expect(dialog.getByRole("textbox", { name: "Lead rules" })).toHaveValue(
    `- Don't raise "${title.replace(/\.$/, "")}".`,
  );
});
