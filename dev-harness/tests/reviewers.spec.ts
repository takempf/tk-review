import { expect, test } from "@playwright/test";

test("each finding names the reviewers who raised it", async ({ page }) => {
  await page.goto("/dev-harness/");
  await page
    .getByText("Render review findings in the PR workflow", { exact: true })
    .first()
    .click();
  await page.getByRole("tab", { name: /^(AI review|Review)$/ }).click();
  await page.getByRole("button", { name: "Review", exact: true }).click();

  const finding = (title: string) =>
    page.getByRole("listitem").filter({ has: page.getByText(title, { exact: true }) });

  // The lead and a specialist both, lead first, read out as who raised it.
  const migration = finding("New non-null column has no default or backfill.");
  await expect(migration.getByTitle("Who raised this finding")).toHaveText(
    "Raised by Lead · Migrations",
  );
  await expect(migration.getByText("Lead · Migrations")).toBeVisible();
  // A specialist alone.
  await expect(
    finding("Effect cleanup races the in-flight fetch.").getByTitle("Who raised this finding"),
  ).toHaveText("Raised by React");
});
