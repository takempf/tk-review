import { expect, type Page, test } from "@playwright/test";

const migration = "migrations/0007_add_reviews_table.sql";
const deleted = "src/legacy/OldViewer.tsx";
const explanationLink = (page: Page, path: string) =>
  page.getByRole("button", { name: `Show AI explanation for ${path}`, exact: true });
const fileNote = (page: Page, path: string) => page.locator(`[data-explain-path="${path}"]`);

async function openPr(page: Page) {
  await page.goto("/dev-harness/");
  await page
    .getByText("Render review findings in the PR workflow", { exact: true })
    .first()
    .click();
  await explanationLink(page, migration).waitFor();
}

for (const layout of ["Split", "Unified"]) {
  test(`${layout} explanation links open the file note and preserve comment navigation`, async ({
    page,
  }) => {
    await openPr(page);
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
    await expect(page.getByRole("tab", { name: /Explain/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
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
  await openPr(page);
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
