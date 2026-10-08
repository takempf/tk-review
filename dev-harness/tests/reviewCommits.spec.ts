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
  const findings = previous.getByRole("button", { name: /^Claude Code/ });
  await findings.click();
  await expect(findings).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Meta+f");
  const search = page.getByRole("dialog", { name: "Find in this view" });
  const input = search.getByRole("combobox", { name: "Search text" });
  await input.fill("claude finding");
  await expect(search.getByRole("option")).toHaveCount(1);
  await input.press("Enter");
  await expect(findings).toHaveAttribute("aria-expanded", "true");
  await expect(previous.getByText("claude finding", { exact: true })).toBeInViewport();
});

test("engines reviewing the same commit each get a review of their own, the newest first", async ({
  page,
}) => {
  await openReviews(page, {
    codex: review("codex", newest.sha),
    claude: review("claude", newest.sha),
  });
  const group = page.locator("[data-review-commit]");
  await expect(group).toHaveCount(1);
  const cards = group.locator("[data-reveal-frame]");
  await expect(cards).toHaveCount(2);
  await expect(cards.first().getByText("codex finding", { exact: true })).toBeVisible();
  await expect(cards.first().getByRole("textbox", { name: "Review conclusion" })).toHaveValue(
    "codex conclusion",
  );
  await expect(cards.last().getByText("claude finding", { exact: true })).toBeVisible();
  await expect(cards.last().getByRole("textbox", { name: "Review conclusion" })).toHaveValue(
    "claude conclusion",
  );
  await expect(cards.first().getByText("claude finding", { exact: true })).toHaveCount(0);
});

test("a review a re-review replaced stays under its commit, folded and read-only", async ({
  page,
}) => {
  const earlier = review("claude", older.sha);
  earlier.createdAt = "2026-10-04T12:00:00Z";
  earlier.review.findings = [{ ...fixture(REVIEW.findings[0]), title: "earlier finding" }];
  earlier.threads = {
    review: [
      { author: "user", text: "Asked about the earlier review", at: "2026-10-04T12:05:00Z" },
    ],
  };
  const current = review("claude", newest.sha);
  current.past = [earlier];
  await openReviews(page, { claude: current });

  const groups = page.locator("[data-review-commit]");
  await expect(groups).toHaveCount(2);
  await expect(groups.first()).toHaveAttribute("data-review-commit", newest.sha);
  await expect(groups.first().getByRole("button", { name: /^Claude Code/ })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  const previous = groups.last();
  await expect(previous).toHaveAttribute("data-review-commit", older.sha);
  const toggle = previous.getByRole("button", { name: /^Claude Code/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(previous.getByText("earlier finding", { exact: true })).toBeHidden();

  await toggle.click();
  await expect(previous.getByText("earlier finding", { exact: true })).toBeVisible();
  await expect(previous.getByText("Asked about the earlier review", { exact: true })).toBeVisible();
  await expect(previous.getByRole("button", { name: /^(Ask about this|Discuss)$/ })).toHaveCount(0);
  await expect(previous.getByRole("button", { name: "Send to PR" })).toHaveCount(0);
  await expect(previous.getByRole("textbox", { name: "Review conclusion" })).toHaveCount(0);
});

test("the commit the next review reads holds its button until it has a review, which a re-review keeps", async ({
  page,
}, testInfo) => {
  await openReviews(page, {});
  const group = page.locator("[data-review-commit]");
  await expect(group).toHaveCount(1);
  await expect(group).toHaveAttribute("data-review-commit", newest.sha);
  await expect(group.getByText("No reviews", { exact: true })).toBeVisible();
  await expect(group.getByTitle(/Choose the agent/)).toBeVisible();
  await expect(page.getByTitle(/^The next review reads/)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("next-commit-controls.png") });
  await group.getByRole("button", { name: "Review", exact: true }).click();
  const cards = group.locator("[data-reveal-frame]");
  await expect(cards).toHaveCount(1);
  await expect(group).toHaveCount(1);

  // Reviewed, the commit is its review; the controls go back above the list.
  await expect(group.getByTitle(/Choose the agent/)).toHaveCount(0);
  await expect(page.getByTitle(/^The next review reads/)).toContainText(newest.sha.slice(0, 7));
  await page.getByRole("button", { name: "Re-review", exact: true }).click();
  await expect(cards).toHaveCount(2);
  await expect(cards.first().getByRole("button", { name: /re-review/ })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  const replaced = cards.last().getByRole("button", { name: /findings$/ });
  await expect(replaced).toHaveAttribute("aria-expanded", "false");
  await expect(cards.last().getByRole("textbox", { name: "Review conclusion" })).toHaveCount(0);
});

test("unknown commits stay separate from recorded commits that are no longer listed", async ({
  page,
}) => {
  const removed = "deadbee0123456789abcdef0123456789abcdef012";
  const legacy = review("claude", null);
  delete legacy.head;
  await openReviews(page, { codex: review("codex", removed), claude: legacy });
  const groups = page.locator("[data-review-commit]");
  // Below the commit the next review reads, which has none yet.
  await expect(groups).toHaveCount(3);
  await expect(groups.first()).toHaveAttribute("data-review-commit", newest.sha);
  await expect(groups.first().getByRole("button", { name: /^(Re-)?review$/i })).toBeVisible();
  await expect(groups.nth(1).getByRole("heading", { name: "deadbee" })).toBeVisible();
  await expect(groups.last().getByRole("heading", { name: "Commit not recorded" })).toBeVisible();
  await expect(groups.nth(1).getByText("codex finding", { exact: true })).toBeVisible();
  await expect(groups.last().getByText("claude finding", { exact: true })).toBeVisible();
});

test("a commit's bar stays above its reviews as they scroll, and folds them away", async ({
  page,
}, testInfo) => {
  const long = review("claude", newest.sha);
  long.review.findings = Array.from({ length: 12 }, (_, index) => ({
    ...fixture(REVIEW.findings[0]),
    title: `finding ${index + 1}`,
  }));
  await openReviews(page, { claude: long, codex: review("codex", older.sha) });
  const body = page.getByRole("region", { name: "AI reviews" });
  const groups = page.locator("[data-review-commit]");
  const bar = groups.first().locator("header");
  const heading = groups.first().locator("[data-reveal-frame] > [data-reveal]").first();
  await expect(groups.first().getByText("finding 12", { exact: true })).toBeAttached();

  await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight / 3;
  });
  const top = (await body.boundingBox())?.y ?? Number.NaN;
  await expect.poll(async () => (await bar.boundingBox())?.y).toBeCloseTo(top, 0);
  const barHeight = (await bar.boundingBox())?.height ?? Number.NaN;
  await expect.poll(async () => (await heading.boundingBox())?.y).toBeCloseTo(top + barHeight, 0);
  await page.screenshot({ path: testInfo.outputPath("sticky-commit-bar.png") });

  // The next commit's bar pushes it off, and sticks in its place.
  await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(async () => (await groups.last().locator("header").boundingBox())?.y)
    .toBeCloseTo(top, 0);
  await expect.poll(async () => (await bar.boundingBox())?.y ?? 0).toBeLessThan(top);

  await body.evaluate((element) => {
    element.scrollTop = 0;
  });
  const toggle = bar.getByRole("button", { name: new RegExp(`^${newest.sha.slice(0, 7)}`) });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(groups.first().getByText("finding 1", { exact: true })).toBeHidden();
  await expect(groups.last().getByText("codex finding", { exact: true })).toBeVisible();
  await toggle.click();
  await expect(groups.first().getByText("finding 1", { exact: true })).toBeVisible();
});
