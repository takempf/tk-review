import { expect, type Page, test } from "@playwright/test";

const rows = (page: Page) => page.locator("tr[data-pr]");
const tabs = (page: Page) =>
  page.getByRole("navigation", { name: "Open reviews" }).getByRole("listitem");

test("tabs stay open after they are left, until their close button closes them", async ({
  page,
}) => {
  await page.goto("/dev-harness/");
  await expect(rows(page)).toHaveCount(4);

  await rows(page).nth(0).click();
  await expect(tabs(page)).toHaveCount(1);
  await page.getByRole("button", { name: "Pull requests", exact: true }).click();
  await expect(rows(page)).toHaveCount(4);
  await expect(tabs(page)).toHaveCount(1);

  await rows(page).nth(1).click();
  await expect(tabs(page)).toHaveCount(2);
  await tabs(page).nth(0).getByRole("button").first().click();
  await expect(tabs(page)).toHaveCount(2);
  await page.getByRole("button", { name: "Pull requests", exact: true }).click();
  await expect(tabs(page)).toHaveCount(2);

  await tabs(page).nth(0).getByTitle("Close tab").click();
  await expect(tabs(page)).toHaveCount(1);
});
