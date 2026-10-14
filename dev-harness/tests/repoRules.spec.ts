import { expect, test } from "@playwright/test";

test("the review tab edits each reviewer's rules, and saving keeps them", async ({ page }) => {
  await page.goto("/dev-harness/");
  await page
    .getByText("Render review findings in the PR workflow", { exact: true })
    .first()
    .click();
  await page.getByRole("tab", { name: /^(AI review|Review)$/ }).click();
  // The settings bar moves into the head commit's section once that loads,
  // which remounts the button and would close a dialog opened before then.
  await expect(page.getByText("No reviews", { exact: true })).toBeVisible();

  const open = page.getByRole("button", { name: "Rules", exact: true });
  await open.click();
  const dialog = page.getByRole("dialog", { name: "Review rules" });
  await expect(dialog.getByText("github.com/acme/widgets")).toBeVisible();

  // The lead reviewer comes first, and its rules are what show.
  const reviewers = dialog.getByRole("tablist", { name: "Reviewers" });
  await expect(reviewers.getByRole("tab").first()).toHaveText("Lead");
  await expect(reviewers.getByRole("tab", { name: "Lead" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const lead = dialog.getByRole("textbox", { name: "Lead rules" });
  await expect(lead).toHaveValue("");

  // Each specialist keeps its own, one at a time.
  await reviewers.getByRole("tab", { name: "Migrations" }).click();
  await expect(dialog.getByRole("textbox", { name: "Migrations rules" })).toHaveValue(
    /Every lock on `orders`/,
  );
  await expect(lead).toBeHidden();
  await expect(dialog.getByText("files under a migrations")).toBeVisible();

  await reviewers.getByRole("tab", { name: "Security" }).click();
  await dialog
    .getByRole("textbox", { name: "Security rules" })
    .fill("The admin pool skips row-level security.");
  await reviewers.getByRole("tab", { name: "Lead" }).click();
  await lead.fill("Money is always integer cents.");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();

  // Reopened, the form starts from what was saved, for every reviewer.
  await open.click();
  const reopened = page.getByRole("dialog", { name: "Review rules" });
  await expect(reopened.getByRole("textbox", { name: "Lead rules" })).toHaveValue(
    "Money is always integer cents.",
  );
  await reopened.getByRole("tab", { name: "Security" }).click();
  await expect(reopened.getByRole("textbox", { name: "Security rules" })).toHaveValue(
    "The admin pool skips row-level security.",
  );

  // Cancel leaves the saved rules alone.
  await reopened.getByRole("textbox", { name: "Security rules" }).fill("Discarded.");
  await page.getByRole("button", { name: "Cancel" }).click();
  await open.click();
  await page
    .getByRole("dialog", { name: "Review rules" })
    .getByRole("tab", { name: "Security" })
    .click();
  await expect(
    page
      .getByRole("dialog", { name: "Review rules" })
      .getByRole("textbox", { name: "Security rules" }),
  ).toHaveValue("The admin pool skips row-level security.");
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
