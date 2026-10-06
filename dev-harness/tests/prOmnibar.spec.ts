import { expect, type Page, test } from "@playwright/test";

const input = (page: Page) =>
  page.getByRole("combobox", { name: "Filter pull requests, or paste a pull request link" });
const rows = (page: Page) => page.locator("tr[data-pr]");
const remove = (page: Page, name: string) =>
  page.getByRole("button", { name: `Remove ${name}`, exact: true });

async function select(page: Page, query: string, option: RegExp) {
  await input(page).fill(query);
  await page.getByRole("option", { name: option }).click();
  await expect(input(page)).toHaveValue("");
  await expect(input(page)).toBeFocused();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/dev-harness/");
  await expect(rows(page)).toHaveCount(4);
});

test("the design-system combobox only opens suggestions after a character is typed", async ({
  page,
}) => {
  const field = page.locator(".tk-combobox-field");
  await expect(field).toContainText("");
  await input(page).click();
  await expect(input(page)).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("listbox")).not.toBeVisible();
  await input(page).press("ArrowDown");
  await expect(page.getByRole("option")).toHaveCount(0);
  await input(page).fill("o");
  await expect(input(page)).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("option").first()).toBeVisible();
  await input(page).fill("");
  await expect(input(page)).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("listbox")).not.toBeVisible();
  await input(page).fill(" ");
  await expect(page.getByRole("option")).toHaveCount(0);
  await select(page, "octo", /^octocat 2$/);
  await expect(page.getByRole("listbox")).not.toBeVisible();
  await input(page).click();
  await expect(page.getByRole("option")).toHaveCount(0);
  await expect(remove(page, "author @octocat")).toBeVisible();
});

test("autocomplete combines author, label, and status chips and removes them independently", async ({
  page,
}, testInfo) => {
  await select(page, "octo", /^octocat 2$/);
  await expect(remove(page, "author @octocat")).toBeVisible();
  await expect(rows(page)).toHaveCount(2);
  await select(page, "bug", /^bug 1$/);
  await expect(remove(page, "label bug")).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  await expect(page.locator('tr[data-pr="118"]')).toBeVisible();
  await select(page, "approved", /^Approved 1$/);
  await expect(remove(page, "status Approved")).toBeVisible();
  await input(page).press("Escape");
  await page.screenshot({ path: testInfo.outputPath("omnibar-chips.png") });
  await remove(page, "status Approved").click();
  await remove(page, "label bug").click();
  await expect(rows(page)).toHaveCount(2);
  await remove(page, "author @octocat").click();
  await expect(rows(page)).toHaveCount(4);
});

test("multiple values of a facet are alternatives and selected options are not suggested again", async ({
  page,
}) => {
  await select(page, "octo", /^octocat 2$/);
  await input(page).fill("author:");
  await expect(page.getByRole("option", { name: /^octocat / })).toHaveCount(0);
  await expect(rows(page)).toHaveCount(2);
  await page.getByRole("option", { name: /^mona 1$/ }).click();
  await expect(rows(page)).toHaveCount(3);
  await select(page, "label:bug", /^bug 1$/);
  await expect(rows(page)).toHaveCount(1);
  await select(page, "label:review", /^review-ui 1$/);
  await expect(rows(page)).toHaveCount(2);
  await remove(page, "label bug").click();
  await expect(rows(page)).toHaveCount(1);
  await expect(page.locator('tr[data-pr="47"]')).toBeVisible();
});

test("keyboard autocomplete selects chips, and Backspace removes the focused chip", async ({
  page,
}) => {
  await input(page).fill("author:octo");
  await expect(page.getByRole("option", { name: /^octocat 2$/ })).toHaveAttribute(
    "data-highlighted",
    "",
  );
  await input(page).press("Enter");
  await expect(remove(page, "author @octocat")).toBeVisible();
  await expect(input(page)).toHaveValue("");
  await input(page).fill("label:bug");
  await expect(page.getByRole("option", { name: /^bug 1$/ })).toHaveAttribute(
    "data-highlighted",
    "",
  );
  await input(page).press("Enter");
  await expect(remove(page, "label bug")).toBeVisible();
  await input(page).press("Escape");
  await input(page).press("ArrowLeft");
  await expect(page.locator('[aria-label="Label: bug"]')).toBeFocused();
  await page.keyboard.press("Delete");
  await expect(remove(page, "label bug")).toHaveCount(0);
  await expect(rows(page)).toHaveCount(2);
  await page.keyboard.press("Backspace");
  await expect(remove(page, "author @octocat")).toHaveCount(0);
  await expect(rows(page)).toHaveCount(4);
  await expect(input(page)).toBeFocused();
});

test("chips survive tabs with no matches and can still be removed", async ({ page }) => {
  await select(page, "octo", /^octocat 2$/);
  await input(page).press("Escape");
  await page.getByRole("tab", { name: /^Mine/ }).click();
  await expect(rows(page)).toHaveCount(0);
  await expect(remove(page, "author @octocat")).toBeVisible();
  await remove(page, "author @octocat").click();
  await expect(rows(page)).toHaveCount(3);
});

test("real names match author filters and PRs while filters keep their username identity", async ({
  page,
}) => {
  await input(page).fill("tImOtHy");
  const author = page.getByRole("option", { name: /^tkempf Timothy Kempf 1$/ });
  await expect(author).toBeVisible();
  await expect(page.getByRole("option", { name: /^Open pull request #131 / })).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  await author.click();
  await expect(input(page)).toHaveValue("");
  await expect(remove(page, "author @tkempf")).toBeVisible();
  await expect(rows(page)).toHaveCount(1);

  await page.getByRole("tab", { name: /^Mine/ }).click();
  await expect(rows(page)).toHaveCount(2);
  await remove(page, "author @tkempf").click();
  await expect(rows(page)).toHaveCount(3);
  await input(page).fill("AUTHOR:kempf");
  await expect(page.getByRole("option", { name: /^tkempf Timothy Kempf 2$/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /^Open pull request / })).toHaveCount(0);
  await input(page).press("Enter");
  await expect(remove(page, "author @tkempf")).toBeVisible();
  await expect(rows(page)).toHaveCount(2);
});

test("suggestions dismiss on Escape and Tab without losing filters or text", async ({
  page,
}, testInfo) => {
  await select(page, "octo", /^octocat 2$/);
  await input(page).fill("label:");
  await expect(page.getByRole("option", { name: /^bug 1$/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("omnibar-suggestions.png") });
  await input(page).press("Tab");
  await expect(page.getByRole("listbox")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Columns", exact: true })).toBeFocused();
  await expect(remove(page, "author @octocat")).toBeVisible();
  await input(page).fill("force push");
  await expect(rows(page)).toHaveCount(1);
  await input(page).press("Escape");
  await input(page).press("Escape");
  await expect(input(page)).toHaveValue("force push");
  await expect(remove(page, "author @octocat")).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  await input(page).fill("label:missing-filter");
  await input(page).press("Enter");
  await expect(input(page)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pull requests", exact: true })).toBeVisible();
});

test("plain text still filters and Enter opens a PR number or pasted link", async ({ page }) => {
  await input(page).fill("no-such-pr");
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByRole("option")).toHaveCount(0);
  await input(page).fill("#47");
  await expect(rows(page)).toHaveCount(1);
  await input(page).press("Enter");
  await expect(
    page.getByRole("button", {
      name: "Comment on file migrations/0007_add_reviews_table.sql",
      exact: true,
    }),
  ).toBeVisible();
  await page.goto("/dev-harness/");
  await input(page).fill("https://github.com/octocat/tk-review/pull/47");
  await input(page).press("Enter");
  await expect(
    page.getByRole("button", {
      name: "Comment on file migrations/0007_add_reviews_table.sql",
      exact: true,
    }),
  ).toBeVisible();
});

test("title matches offer multiple PRs and clicking opens the selected review tab", async ({
  page,
}) => {
  await input(page).fill("review");
  const prs = page.getByRole("option", { name: /^Open pull request / });
  await expect(prs).toHaveCount(2);
  await page.getByRole("option", { name: /^Open pull request #131 / }).click();
  await expect(
    page.getByRole("navigation", { name: "Open reviews" }).getByTitle(/^#131 Show where/),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("listbox")).not.toBeVisible();
});

for (const branch of ["feature/diff-viewer", "reviews-migration"]) {
  test(`branch match ${branch} opens its PR with the keyboard`, async ({ page }) => {
    const number = branch === "feature/diff-viewer" ? 47 : 131;
    await input(page).fill(branch);
    const pr = page.getByRole("option", { name: new RegExp(`^Open pull request #${number} `) });
    await expect(pr).toHaveAttribute("data-highlighted", "");
    await expect(pr).toContainText(branch);
    await input(page).press("Enter");
    await expect(
      page.getByRole("navigation", { name: "Open reviews" }).getByTitle(new RegExp(`^#${number} `)),
    ).toHaveAttribute("aria-current", "page");
  });
}

test("PR results coexist with filter suggestions and respect existing chips", async ({
  page,
}, testInfo) => {
  await input(page).fill("feature");
  await expect(page.getByRole("option", { name: /^feature 1$/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /^Open pull request #47 / })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("omnibar-pr-results.png") });
  await page.getByRole("option", { name: /^feature 1$/ }).click();
  await expect(remove(page, "label feature")).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  await remove(page, "label feature").click();
  await select(page, "author:octo", /^octocat 2$/);
  await input(page).fill("review");
  await expect(page.getByRole("option", { name: /^Open pull request / })).toHaveCount(1);
  await page.getByRole("option", { name: /^Open pull request #47 / }).click();
  const tabs = page.getByRole("navigation", { name: "Open reviews" });
  await expect(tabs.getByTitle(/^#47 Render review/)).toHaveAttribute("aria-current", "page");
  await tabs.getByRole("button", { name: "Pull requests", exact: true }).click();
  await expect(remove(page, "author @octocat")).toBeVisible();
  await expect(
    page.getByRole("toolbar", { name: "Pull request filters" }).getByRole("button"),
  ).toHaveCount(1);
  await expect(input(page)).toHaveValue("");
  await input(page).fill("feature/diff-viewer");
  await page.getByRole("option", { name: /^Open pull request #47 / }).click();
  await expect(tabs.getByTitle(/^#47 Render review/)).toHaveCount(1);
  await expect(tabs.getByTitle(/^#47 Render review/)).toHaveAttribute("aria-current", "page");
});

test("chips wrap inside the field and suggestions stay within a narrow viewport", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 740, height: 760 });
  await select(page, "octo", /^octocat 2$/);
  await select(page, "approved", /^Approved 1$/);
  await select(page, "bug", /^bug 1$/);
  await input(page).fill("label:");
  await expect(input(page)).toBeInViewport({ ratio: 1 });
  await expect(remove(page, "author @octocat")).toBeInViewport({ ratio: 1 });
  await expect(remove(page, "status Approved")).toBeInViewport({ ratio: 1 });
  await expect(remove(page, "label bug")).toBeInViewport({ ratio: 1 });
  const popup = page.getByRole("listbox");
  await expect(popup).toBeInViewport({ ratio: 1 });
  const bounds = await popup.boundingBox();
  expect(bounds?.width).toBeGreaterThan(200);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(740);
  await page.screenshot({ path: testInfo.outputPath("omnibar-narrow.png") });
});
