import { expect, test } from "@playwright/test";

test("the review tab edits the repository's rules, and saving keeps them", async ({ page }) => {
  await page.goto("/dev-harness/");
  await page
    .getByText("Render review findings in the PR workflow", { exact: true })
    .first()
    .click();
  await page.getByRole("tab", { name: /^(AI review|Review)$/ }).click();

  const open = page.getByRole("button", { name: "Rules", exact: true });
  await open.click();
  const dialog = page.getByRole("dialog", { name: "Review rules" });
  await expect(dialog.getByText("github.com/acme/widgets")).toBeVisible();
  const review = dialog.getByRole("textbox", { name: "Review rules" });
  const migrations = dialog.getByRole("textbox", { name: "Migration rules" });
  await expect(migrations).toHaveValue(/Every lock on `orders`/);
  await expect(review).toHaveValue("");

  await review.fill("Money is always integer cents.");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();

  // Reopened, the form starts from what was saved.
  await open.click();
  await expect(
    page
      .getByRole("dialog", { name: "Review rules" })
      .getByRole("textbox", { name: "Review rules" }),
  ).toHaveValue("Money is always integer cents.");

  // Cancel leaves the saved rules alone.
  await page
    .getByRole("dialog", { name: "Review rules" })
    .getByRole("textbox", { name: "Review rules" })
    .fill("Discarded.");
  await page.getByRole("button", { name: "Cancel" }).click();
  await open.click();
  await expect(
    page
      .getByRole("dialog", { name: "Review rules" })
      .getByRole("textbox", { name: "Review rules" }),
  ).toHaveValue("Money is always integer cents.");
});

test("the explain tab has no rules button, since explanations don't follow them", async ({
  page,
}) => {
  await page.goto("/dev-harness/");
  await page
    .getByText("Render review findings in the PR workflow", { exact: true })
    .first()
    .click();
  await page.getByRole("tab", { name: /^(AI explain|Explain)$/ }).click();
  // The review tab stays mounted behind it, so look only at what shows.
  await expect(page.getByTitle(/Choose the agent/).filter({ visible: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Rules", exact: true })).toBeHidden();
});
