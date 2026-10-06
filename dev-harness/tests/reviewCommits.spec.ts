import { expect, type Page, test } from "@playwright/test";
import { storageRoot } from "../../src/store/account";
import type { ReviewsByEngine, StoredReview } from "../../src/store/tabStore";
import { COMMITS, PR, REPO, REVIEW, SUMMARY } from "../fixture";

function fixture<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing review fixture");
  return value;
}

const newest = fixture(COMMITS.commits[0]);
const older = fixture(COMMITS.commits[1]);

function review(engine: StoredReview["engine"], head: string | null): StoredReview {
  return {
    engine,
    head,
    model: null,
    mergeBase: SUMMARY.mergeBase,
    createdAt: engine === "codex" ? "2026-10-06T12:00:00Z" : "2026-10-05T12:00:00Z",
    threads: {},
    review: {
      ...REVIEW,
      summary: `${engine} summary`,
      conclusion: `${engine} conclusion`,
      findings: [{ ...fixture(REVIEW.findings[0]), title: `${engine} finding` }],
    },
  };
}

async function openReviews(page: Page, reviews: ReviewsByEngine) {
  await page.addInitScript(
    ({ key, reviews }) => localStorage.setItem(key, JSON.stringify(reviews)),
    {
      key: `tk-review:reviews:${storageRoot(REPO)}:${PR.baseRemote}/${PR.baseRef}...${PR.compareRef}`,
      reviews,
    },
  );
  await page.goto("/dev-harness/");
  await page
    .getByText("Render review findings in the PR workflow", { exact: true })
    .first()
    .click();
  await page
    .getByRole("button", {
      name: "Comment on file migrations/0007_add_reviews_table.sql",
      exact: true,
    })
    .waitFor();
  await page.getByRole("tab", { name: /^(AI review|Review)$/ }).click();
}

test("each reviewed commit keeps its summaries, findings, resolutions and conclusion together", async ({
  page,
}, testInfo) => {
  const codex = review("codex", newest.sha);
  codex.resolutions = [
    { finding: fixture(REVIEW.findings[1]), status: "addressed", note: "Subscription fixed" },
  ];
  await openReviews(page, { codex, claude: review("claude", older.sha) });
  const groups = page.locator("[data-review-commit]");
  await expect(groups).toHaveCount(2);
  await expect(groups.first()).toHaveAttribute("data-review-commit", newest.sha);
  const current = groups.first();
  const previous = groups.last();
  await expect(current.getByRole("heading", { name: newest.sha.slice(0, 7) })).toBeVisible();
  await expect(current.getByText(newest.subject, { exact: true })).toBeVisible();
  await expect(current.getByText("codex summary", { exact: true })).toBeVisible();
  await expect(current.getByText("codex finding", { exact: true })).toBeVisible();
  await expect(current.getByText("Subscription fixed", { exact: true })).toBeVisible();
  await expect(current.getByRole("textbox", { name: "Review conclusion" })).toHaveValue(
    "codex conclusion",
  );
  await expect(current.getByText("claude finding", { exact: true })).toHaveCount(0);
  await expect(previous.getByText(older.subject, { exact: true })).toBeVisible();
  await expect(previous.getByText("claude summary", { exact: true })).toBeVisible();
  await expect(previous.getByText("claude finding", { exact: true })).toBeVisible();
  await expect(previous.getByRole("textbox", { name: "Review conclusion" })).toHaveValue(
    "claude conclusion",
  );

  await page.screenshot({ path: testInfo.outputPath("reviews-by-commit.png") });
  const findings = previous.getByRole("button", { name: /^Findings/ });
  await findings.click();
  await page.keyboard.press("Meta+f");
  const search = page.getByRole("dialog", { name: "Find in this view" });
  const input = search.getByRole("combobox", { name: "Search text" });
  await input.fill("claude finding");
  await expect(search.getByRole("option")).toHaveCount(1);
  await input.press("Enter");
  await expect(findings).toHaveAttribute("aria-expanded", "true");
  await expect(previous.getByText("claude finding", { exact: true })).toBeInViewport();
});

test("engines reviewing the same commit share sections and use the latest conclusion", async ({
  page,
}) => {
  await openReviews(page, {
    codex: review("codex", newest.sha),
    claude: review("claude", newest.sha),
  });
  const group = page.locator("[data-review-commit]");
  await expect(group).toHaveCount(1);
  await expect(group.getByText("codex finding", { exact: true })).toBeVisible();
  await expect(group.getByText("claude finding", { exact: true })).toBeVisible();
  await expect(group.getByRole("button", { name: "Reviews 2", exact: true })).toBeVisible();
  await expect(group.getByRole("textbox", { name: "Review conclusion" })).toHaveCount(1);
  await expect(group.getByRole("textbox", { name: "Review conclusion" })).toHaveValue(
    "codex conclusion",
  );
});

test("unknown commits stay separate from recorded commits that are no longer listed", async ({
  page,
}) => {
  const removed = "deadbee0123456789abcdef0123456789abcdef012";
  const legacy = review("claude", null);
  delete legacy.head;
  await openReviews(page, { codex: review("codex", removed), claude: legacy });
  const groups = page.locator("[data-review-commit]");
  await expect(groups).toHaveCount(2);
  await expect(groups.first().getByRole("heading", { name: "deadbee" })).toBeVisible();
  await expect(groups.last().getByRole("heading", { name: "Commit not recorded" })).toBeVisible();
  await expect(groups.first().getByText("codex finding", { exact: true })).toBeVisible();
  await expect(groups.last().getByText("claude finding", { exact: true })).toBeVisible();
});
