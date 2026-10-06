import { expect, type Page, test } from "@playwright/test";
import { matchOffsets, RESULT_LIMIT, searchDocuments } from "../../src/lib/textSearch";

const migration = "migrations/0007_add_reviews_table.sql";
const dialog = (page: Page) => page.getByRole("dialog", { name: "Find in this view" });
const input = (page: Page) => dialog(page).getByRole("combobox", { name: "Search text" });
const scope = (page: Page, name: string) =>
  dialog(page).getByRole("button", { name: new RegExp(`^${name}(?: \\d+)?$`) });

async function openPr(page: Page) {
  await page.goto("/dev-harness/");
  await page
    .getByText("Render review findings in the PR workflow", { exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: `Comment on file ${migration}`, exact: true }).waitFor();
}

test("literal matching handles punctuation, Unicode, case, whole words, and bounded results", () => {
  const options = { caseSensitive: false, wholeWord: false };
  expect(matchOffsets("a.b A.B aXb", "a.b", options)).toEqual([0, 4]);
  expect(matchOffsets("[.*] [.*]", "[.*]", options)).toEqual([0, 5]);
  expect(matchOffsets("a.b A.B", "a.b", { ...options, caseSensitive: true })).toEqual([0]);
  expect(
    matchOffsets("cat cats cat_cat 猫cat cat!", "cat", { ...options, wholeWord: true }),
  ).toEqual([0, 22]);
  expect(matchOffsets("K K k", "k", options)).toEqual([0, 2, 4]);
  expect(matchOffsets("anything", "", options)).toEqual([]);
  const docs = [
    { id: "large", scope: "diff" as const, title: "large", text: "x ".repeat(1000) },
    { id: "file", scope: "files" as const, title: "x.ts", text: "x.ts" },
  ];
  const results = searchDocuments(docs, "x", "all", options);
  expect(results.total).toBe(1001);
  expect(results.matches).toHaveLength(RESULT_LIMIT);
  expect(searchDocuments(docs, "x", "files", options).matches).toHaveLength(1);
});

test("Cmd/Ctrl+F defaults to everything, scopes, and restores keyboard focus", async ({ page }) => {
  await openPr(page);
  const file = page.locator(`[data-search-id="file:${migration}"]`);
  await file.click();
  await page.locator('[data-panel="diff"]').click({ position: { x: 80, y: 18 } });
  await file.focus();
  await page.keyboard.press("Meta+f");
  await expect(input(page)).toBeFocused();
  await expect(scope(page, "Everything")).toHaveAttribute("aria-pressed", "true");
  await input(page).fill("merge_base");
  await expect(dialog(page).getByRole("option").first()).toBeVisible();
  await scope(page, "Diff").click();
  await expect(scope(page, "Diff")).toHaveAttribute("aria-pressed", "true");
  await expect(input(page)).toBeFocused();
  await input(page).press("Escape");
  await expect(dialog(page)).not.toBeVisible();
  await expect(file).toBeFocused();
  await page.keyboard.press("Control+f");
  await expect(input(page)).toBeFocused();
  await expect(input(page)).toHaveValue("merge_base");
  await expect(scope(page, "Everything")).toHaveAttribute("aria-pressed", "true");
  await input(page).fill("no-such-needle-9274");
  await expect(dialog(page).getByText("No matches found")).toBeVisible();
  await dialog(page).getByRole("button", { name: "Clear search" }).click();
  await expect(input(page)).toHaveValue("");
});

for (const layout of ["Split", "Unified"]) {
  test(`${layout} search navigates to removed code in a collapsed file`, async ({ page }) => {
    await openPr(page);
    await page.getByRole("button", { name: layout, exact: true }).click();
    const path = "src/legacy/OldViewer.tsx";
    await page.locator(`[data-search-id="file:${path}"]`).click();
    const file = page.locator("diffs-container").filter({ hasText: path });
    await file.getByRole("checkbox", { name: "Viewed", exact: true }).click();
    await page.keyboard.press("Meta+f");
    await input(page).fill("export function OldViewer");
    await scope(page, "Diff").click();
    await expect(dialog(page).getByRole("option")).toHaveCount(1);
    await input(page).press("Enter");
    await expect(dialog(page)).not.toBeVisible();
    await expect(file.getByText(/export function OldViewer/)).toBeInViewport();
  });
}

test("conversation search switches tabs, unfolds notes, and reveals a hidden panel", async ({
  page,
}) => {
  await openPr(page);
  await page.getByRole("tab", { name: /Explain/ }).click();
  const notes = page.getByRole("button", { name: /^File notes/ });
  await notes.click();
  await expect(notes).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Hide review panel", exact: true }).click();
  await page.keyboard.press("Meta+f");
  await input(page).fill("Reviews need to survive a restart");
  await scope(page, "Conversations").click();
  await expect(dialog(page).getByRole("option")).toHaveCount(1);
  await input(page).press("Enter");
  await expect(page.getByRole("button", { name: "Hide review panel", exact: true })).toBeVisible();
  await expect(notes).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(`[data-search-id="explain:${migration}"]`)).toBeInViewport();
  await page.keyboard.press("Meta+f");
  await input(page).fill("intentionally on a line");
  await input(page).press("Enter");
  await expect(page.getByRole("tab", { name: "PR", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.getByText("This file-level discussion is intentionally on a line in the diff.", {
      exact: true,
    }),
  ).toBeInViewport();
});

test("files and commits search reveal the sidebar and keyboard result navigation wraps", async ({
  page,
}) => {
  await openPr(page);
  await page.locator('[data-search-id="file:src/ipc/git.ts"]').click();
  const folder = page.getByRole("button", { name: /^ipc(?: \d+)?$/ });
  await folder.click();
  await expect(folder).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Hide file list", exact: true }).click();
  await page.keyboard.press("Meta+f");
  await input(page).fill("git.ts");
  await scope(page, "Files").click();
  await input(page).press("Enter");
  await expect(page.getByRole("button", { name: "Hide file list", exact: true })).toBeVisible();
  await expect(folder).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('[data-search-id="file:src/ipc/git.ts"]')).toBeFocused();
  await page.keyboard.press("Meta+f");
  await input(page).fill("review");
  await scope(page, "Commits").click();
  const options = dialog(page).getByRole("option");
  await expect(options).toHaveCount(2);
  await input(page).press("ArrowUp");
  await expect(options.last()).toHaveAttribute("aria-selected", "true");
  await input(page).press("ArrowDown");
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await input(page).press("Enter");
  await expect(page.locator('[data-search-id^="commit:"]:focus')).toBeInViewport();
});

test("home search opens a matching pull request", async ({ page }) => {
  await page.goto("/dev-harness/");
  await page
    .getByText("Render review findings in the PR workflow", { exact: true })
    .first()
    .waitFor();
  await page.keyboard.press("Meta+f");
  await input(page).fill("Render review findings");
  await expect(scope(page, "Pull requests")).toBeVisible();
  await expect(dialog(page).getByRole("option")).toHaveCount(1);
  await input(page).press("Enter");
  await expect(
    page.getByRole("button", { name: `Comment on file ${migration}`, exact: true }),
  ).toBeVisible();
});

test("search reveals a folded AI finding and highlights its text", async ({ page }) => {
  await openPr(page);
  await page.getByRole("tab", { name: /^(AI review|Review)$/ }).click();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page
    .getByText("Error mapping could reuse the shared kind table.", { exact: true })
    .waitFor();
  const findings = page.getByRole("button", { name: /^Findings/ });
  await findings.click();
  await expect(findings).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Meta+f");
  await input(page).fill("re-declares error strings");
  await expect(dialog(page).getByRole("option")).toHaveCount(1);
  await input(page).press("Enter");
  await expect(findings).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText(/The new wrapper re-declares error strings/)).toBeInViewport();
  await expect
    .poll(() => page.evaluate(() => CSS.highlights?.get("review-search")?.size ?? 0))
    .toBeGreaterThan(0);
});

test("search has working case controls and transitions with motion enabled", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    // Viewport resizing can defer ResizeObserver notifications to the next frame.
    if (error.message !== "ResizeObserver loop completed with undelivered notifications.") {
      errors.push(error.message);
    }
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openPr(page);
  const searchButton = page
    .locator("header")
    .getByRole("button", { name: "Search this view", exact: true });
  await searchButton.click();
  await input(page).fill("MERGE_BASE");
  await expect(dialog(page).getByRole("option").first()).toBeVisible();
  await dialog(page).getByRole("button", { name: "Match case", exact: true }).click();
  await expect(dialog(page).getByText("No matches found")).toBeVisible();
  await dialog(page).getByRole("button", { name: "Match case", exact: true }).click();
  await input(page).fill("merge_base");
  await expect(dialog(page).getByRole("option")).toHaveCount(4);
  const backdrop = page.locator(".tk-backdrop");
  await expect(backdrop).toHaveCSS("backdrop-filter", "none");
  await expect(backdrop).toHaveCSS("background-color", "rgba(0, 0, 0, 0.25)");
  await expect(backdrop).toHaveCSS("mask-image", "none");
  await page.screenshot({ path: testInfo.outputPath("search-overlay.png") });
  await dialog(page).screenshot({ path: testInfo.outputPath("search-results.png") });
  await page.setViewportSize({ width: 1000, height: 500 });
  await expect(input(page)).toBeInViewport();
  await expect(dialog(page).locator("footer")).toBeInViewport({ ratio: 1 });
  await expect(dialog(page).getByRole("option").first()).toBeInViewport({ ratio: 1 });
  await input(page).press("Enter");
  await expect(dialog(page)).not.toBeVisible();
  await expect(page.locator('[data-panel="diff"]')).toBeFocused();
  expect(errors).toEqual([]);
});
