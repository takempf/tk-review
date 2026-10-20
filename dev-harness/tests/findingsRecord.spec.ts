import { expect, type Page, test } from "@playwright/test";
import type { PriorReview } from "../../src/ipc/git";

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

async function reReview(page: Page, runs: number) {
  await page.getByRole("button", { name: "Re-review", exact: true }).click();
  await expect.poll(async () => (await requests(page)).length).toBe(runs);
  await expect(page.getByRole("button", { name: "Re-review", exact: true })).toBeEnabled();
}

const requests = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { reReviewRequests: { prior: PriorReview }[] }).reReviewRequests,
  );

const errorMapping = "Error mapping could reuse the shared kind table.";

/** The live review's card for the finding on `src/ipc/git.ts`. */
const errorMappingCard = (page: Page) =>
  page.locator('[data-search-id^="review:claude:f:src/ipc/git.ts:"]');

/** Opens the fold the review's suggestions and nits wait in. */
const openMinor = (page: Page) =>
  page
    .getByRole("button", { name: /^Suggestions and nits/ })
    .first()
    .click();

/** The live review's fold of findings set aside. */
const setAside = (page: Page) => page.getByRole("button", { name: /^Set aside/ }).first();

/** Dismisses the finding in `card` as `kind`, with why. */
async function dismiss(card: ReturnType<typeof errorMappingCard>, kind: string, why: string) {
  await card.getByRole("button", { name: "Dismiss", exact: true }).click();
  await card.getByRole("radio", { name: kind }).click();
  await card.getByRole("textbox", { name: "Why it's dismissed" }).fill(why);
  await card.getByRole("button", { name: "Dismiss finding" }).click();
}

test("a dismissed finding folds away with why, and restoring it puts it back", async ({ page }) => {
  await review(page);
  await openMinor(page);
  await dismiss(errorMappingCard(page), "Not a problem", "The copy is deliberate.");

  const title = page.getByText(errorMapping, { exact: true });
  await expect(title).toBeHidden();
  await expect(setAside(page)).toContainText("1 dismissed");
  await setAside(page).click();
  await expect(title).toBeVisible();
  await expect(page.getByText("The copy is deliberate.", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(setAside(page)).not.toContainText("dismissed");
  await expect(errorMappingCard(page)).toBeVisible();
});

test("re-reviews follow up on every open finding and are told what was set aside", async ({
  page,
}) => {
  await review(page);
  await openMinor(page);
  await dismiss(errorMappingCard(page), "Won't fix", "Kept apart on purpose.");

  await reReview(page, 1);
  const first = (await requests(page))[0]?.prior;
  // The dismissed finding is set aside, along with the one the review withdrew.
  expect(first?.findings.map((finding) => finding.title)).toEqual([
    "New non-null column has no default or backfill.",
    "Effect cleanup races the in-flight fetch.",
    "Comment describes the old return type.",
    "Stale diffs are hidden rather than prevented.",
  ]);
  expect(first?.findings.every((finding) => typeof finding.readAt === "string")).toBe(true);
  expect(first?.setAside).toEqual([
    expect.objectContaining({
      why: "withdrawn",
      finding: expect.objectContaining({ title: "Diff input is rebuilt on every render." }),
    }),
    expect.objectContaining({
      why: "wontFix",
      note: "Kept apart on purpose.",
      finding: expect.not.objectContaining({ dismissed: expect.anything() }),
    }),
  ]);

  // What was dismissed before stays listed, and can still be put back.
  await setAside(page).click();
  await expect(page.getByText("Won't fix · earlier").first()).toBeVisible();

  // The second re-review gets the first's new finding, and the earlier ones it
  // left partial or unaddressed, not only what it raised itself.
  await reReview(page, 2);
  const second = (await requests(page))[1]?.prior;
  expect(second?.findings.map((finding) => finding.title)).toEqual([
    "Backfill scans the whole table without an index.",
    "Effect cleanup races the in-flight fetch.",
    "Comment describes the old return type.",
  ]);
  expect(second?.setAside.map((item) => item.why)).toEqual(["withdrawn", "wontFix"]);
});

test("a dismissed finding drafts a rule for whoever raised it", async ({ page }) => {
  await review(page);
  // Raised by Maintainability alone, so the rule is that specialist's.
  const nit = page.locator('[data-search-id^="review:claude:f:src/lib/fileChange.ts:"]');
  await openMinor(page);
  await dismiss(nit, "Not a problem", "Docblocks here describe the old shape on purpose.");
  await setAside(page).click();
  await page.getByRole("button", { name: "Make it a rule" }).click();

  const dialog = page.getByRole("dialog", { name: "Review rules" });
  await expect(
    dialog
      .getByRole("tablist", { name: "Reviewers" })
      .getByRole("tab", { name: "Maintainability" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("textbox", { name: "Maintainability rules" })).toHaveValue(
    '- Don\'t raise "Comment describes the old return type" in `src/lib/fileChange.ts`: Docblocks here describe the old shape on purpose.',
  );
});
