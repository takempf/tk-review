import { expect, type Page, test } from "@playwright/test";

/** Opens the fixture PR and runs a review on it. */
async function review(page: Page, query = "") {
  await page.goto(`/dev-harness/${query}`);
  await page
    .getByText("Render review findings in the PR workflow", { exact: true })
    .first()
    .click();
  await page.getByRole("tab", { name: /^(AI review|Review)$/ }).click();
  await page.getByRole("button", { name: "Review", exact: true }).click();
}

test("findings a second look took back or couldn't confirm fold away under why", async ({
  page,
}) => {
  await review(page);

  const toggle = page.getByRole("button", { name: /^Set aside/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toContainText("2");
  await expect(toggle).toContainText("1 not confirmed · 1 withdrawn");
  const title = page.getByText("Diff input is rebuilt on every render.", { exact: true });
  await expect(title).toBeHidden();
  // The findings that held are listed as usual.
  await expect(
    page.getByText("New non-null column has no default or backfill.", { exact: true }),
  ).toBeVisible();

  await toggle.click();
  await expect(title).toBeVisible();
  await expect(page.getByText("Withdrawn · was warning")).toBeVisible();
  await expect(page.getByText(/is built in a useMemo keyed on/)).toBeVisible();
  // One it couldn't settle says why, and what it said.
  await expect(page.getByText("Not confirmed · was warning")).toBeVisible();
  await expect(page.getByText(/Couldn't find whether the backend sends/)).toBeVisible();
  await expect(page.getByText(/rejects with a `?command`? error/)).toBeVisible();
});

test("a review whose findings couldn't be double-checked says so", async ({ page }) => {
  await review(page, "?fail=check");

  await expect(page.getByText(/couldn't double-check these findings/)).toBeVisible();
  await expect(page.getByText(/still going after 60 minutes/)).toBeVisible();
});
