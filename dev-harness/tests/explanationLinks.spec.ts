import { expect, type Page, test } from "@playwright/test";
import type { PriorReview } from "../../src/ipc/git";
import { EXPLANATION } from "../fixture";

const migration = "migrations/0007_add_reviews_table.sql";
const deleted = "src/legacy/OldViewer.tsx";
const explanationLink = (page: Page, path: string) =>
  page.getByRole("button", { name: `Show AI explanation for ${path}`, exact: true });
const fileNote = (page: Page, path: string) => page.locator(`[data-explain-path="${path}"]`);

const aiTab = (page: Page) => page.getByRole("tab", { name: /^(AI review|Review)$/ });

/** Opens the fixture PR and reviews it, which explains it too, then goes back to the PR tab. */
async function openReviewedPr(page: Page, query = "") {
  await page.goto(`/dev-harness/${query}`);
  await page
    .getByText("Render review findings in the PR workflow", { exact: true })
    .first()
    .click();
  await aiTab(page).click();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.getByRole("button", { name: "Re-review", exact: true })).toBeEnabled();
  await page.getByRole("tab", { name: "PR", exact: true }).click();
}

test("a review explains the change: its walkthrough reads on from the summary", async ({
  page,
}) => {
  await openReviewedPr(page);
  await expect(explanationLink(page, migration)).toBeVisible();
  await aiTab(page).click();
  const summary = page.locator('[data-search-id="review:claude:review"]');
  await expect(summary.getByText(/^Short version: the diff viewer stops fetching/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^File notes/ })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

test("a review whose explanation fails keeps its findings and says why", async ({ page }) => {
  await openReviewedPr(page, "?fail=explain");
  await aiTab(page).click();
  await expect(page.getByText(/couldn't write a walkthrough of the change/)).toBeVisible();
  await expect(page.getByText(/wrote nothing for 15 minutes/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^File notes/ })).toHaveCount(0);
  await expect(explanationLink(page, migration)).toHaveCount(0);
});

test("a re-review is handed the explanation on record to bring up to date", async ({ page }) => {
  await openReviewedPr(page);
  await aiTab(page).click();
  await page.getByRole("button", { name: "Re-review", exact: true }).click();
  const requests = () =>
    page.evaluate(
      () => (window as unknown as { reReviewRequests: { prior: PriorReview }[] }).reReviewRequests,
    );
  await expect.poll(async () => (await requests()).length).toBe(1);
  expect((await requests())[0]?.prior.explanation?.overall).toBe(EXPLANATION.overall);
});

for (const layout of ["Split", "Unified"]) {
  test(`${layout} explanation links open the file note and preserve comment navigation`, async ({
    page,
  }) => {
    await openReviewedPr(page);
    await page.getByRole("button", { name: layout, exact: true }).click();
    const link = explanationLink(page, migration);
    const diff = page.locator("diffs-container").first();
    await expect(diff.getByText(/Reviews need to survive a restart/)).toHaveCount(0);
    await expect(link.locator("svg")).toHaveCount(1);

    const comments = diff.getByRole("button", { name: /Show in the PR tab/ }).first();
    await expect(comments.locator("svg")).toHaveCount(1);
    const color = (element: typeof link) => element.evaluate((el) => getComputedStyle(el).color);
    expect(await color(link)).not.toBe(await color(comments));

    await link.click();
    await expect(aiTab(page)).toHaveAttribute("aria-selected", "true");
    const note = fileNote(page, migration);
    await expect(note).toHaveAttribute("data-focused", "");
    await expect(note.getByText(/Reviews need to survive a restart/)).toBeInViewport();
    expect(
      await note.evaluate((el) => el.closest('[class*="_body_"]')?.scrollTop ?? 0),
    ).toBeGreaterThan(0);

    await comments.click();
    await expect(page.getByRole("tab", { name: "PR", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator("[data-anchor][data-focused]")).toBeVisible();
    await link.click();
    await expect(note.getByText(/Reviews need to survive a restart/)).toBeInViewport();
  });
}

test("explanation links reopen folded notes and a hidden panel, including deleted files", async ({
  page,
}) => {
  await openReviewedPr(page);
  await explanationLink(page, migration).click();
  const heading = page.getByRole("button", { name: /^File notes/ });
  await heading.click();
  await expect(heading).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Hide review panel", exact: true }).click();
  await explanationLink(page, migration).click();
  await expect(page.getByRole("button", { name: "Hide review panel", exact: true })).toBeVisible();
  await expect(heading).toHaveAttribute("aria-expanded", "true");
  await expect(
    fileNote(page, migration).getByText(/Reviews need to survive a restart/),
  ).toBeInViewport();

  await page
    .getByRole("button", { name: /OldViewer.tsx/ })
    .first()
    .click();
  const link = explanationLink(page, deleted);
  await link.click();
  const note = fileNote(page, deleted);
  await expect(note).toHaveAttribute("data-focused", "");
  await expect(note.getByText(/Deleted. `?DiffViewer/)).toBeInViewport();

  await note.evaluate((el) => {
    el.removeAttribute("data-focused");
    el.closest('[class*="_body_"]')?.scrollTo({ top: 0 });
  });
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(note).toHaveAttribute("data-focused", "");
  await expect(note.getByText(/Deleted. `?DiffViewer/)).toBeInViewport();
});
