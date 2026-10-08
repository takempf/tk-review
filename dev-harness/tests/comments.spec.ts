import { expect, type Page, test } from "@playwright/test";

const migration = "migrations/0007_add_reviews_table.sql";
const editor = (page: Page) =>
  page.getByRole("textbox", { name: "Pull request comment", exact: true });
const requests = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { commentRequests: Record<string, unknown>[] }).commentRequests,
  );

async function openPr(page: Page, query = "") {
  await page.goto(`/dev-harness/${query}`);
  await page
    .getByText("Render review findings in the PR workflow", { exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: `Comment on file ${migration}`, exact: true }).waitFor();
}

test("conversation comment previews Markdown, preserves the draft, and posts once", async ({
  page,
}) => {
  await openPr(page);
  await page.getByRole("button", { name: "Add comment", exact: true }).click();
  await expect(page.getByRole("button", { name: "Comment", exact: true })).toBeDisabled();
  await editor(page).fill("**A useful comment**\n\nSecond paragraph.");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.locator("strong").filter({ hasText: "A useful comment" })).toBeVisible();
  await page.getByRole("button", { name: "Write", exact: true }).click();
  await editor(page).press("Enter");
  await expect.poll(() => requests(page)).toHaveLength(0);
  await page.getByRole("tab", { name: /Explain/ }).click();
  await page.getByRole("tab", { name: "PR", exact: true }).click();
  await expect(editor(page)).toHaveValue(/A useful comment/);
  await editor(page).press("ControlOrMeta+Enter");
  await expect(page.getByRole("link", { name: "Posted to PR", exact: true })).toBeVisible();
  await expect.poll(() => requests(page)).toHaveLength(1);
  expect((await requests(page))[0]).toMatchObject({
    destination: "topLevel",
    path: null,
    line: null,
  });
  await expect(page.getByText("Second paragraph.", { exact: true })).toBeVisible();
});

test("replies to conversation comments quote the original", async ({ page }) => {
  await openPr(page);
  // The first Reply in the PR conversation belongs to octocat's comment.
  await page.getByRole("button", { name: "Reply", exact: true }).first().click();
  await expect(editor(page)).toHaveValue(/@octocat wrote:\n> Please keep/);
  await editor(page).fill(`${await editor(page).inputValue()}Yes, this survives switching files.`);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect.poll(() => requests(page)).toHaveLength(1);
  expect((await requests(page))[0]).toMatchObject({ destination: "topLevel" });
  await expect(
    page.getByText("Yes, this survives switching files.", { exact: true }),
  ).toBeVisible();
});

test("a reply to a reply joins the root review thread", async ({ page }) => {
  await openPr(page);
  const reply = page.getByText(
    "Fixed — it subscribes once, in the effect, and unsubscribes in its cleanup.",
    { exact: true },
  );
  await reply.locator("xpath=../..").getByRole("button", { name: "Reply", exact: true }).click();
  await editor(page).fill("Thanks for updating the cleanup.");
  await editor(page)
    .locator("xpath=../../..")
    .getByRole("button", { name: "Reply", exact: true })
    .click();
  await expect.poll(() => requests(page)).toHaveLength(1);
  expect((await requests(page))[0]).toMatchObject({ destination: "inline", replyTo: 106 });
  await expect(page.getByText("Thanks for updating the cleanup.", { exact: true })).toBeVisible();
});

test("reply expands in its own post, toggles closed and restores its draft", async ({ page }) => {
  await openPr(page);
  const text = page.getByText(
    "Fixed — it subscribes once, in the effect, and unsubscribes in its cleanup.",
    { exact: true },
  );
  const post = text.locator("xpath=../..");
  const trigger = post.getByRole("button", { name: "Reply", exact: true }).first();
  await trigger.click();
  await expect(post.getByRole("textbox", { name: "Pull request comment" })).toBeFocused();
  await expect(post.getByRole("button", { name: "Cancel", exact: true })).toBeInViewport();
  await expect(page.getByRole("button", { name: "Add comment", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await editor(page).fill("Reply draft stays here.");
  await post.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();
  await expect(editor(page)).toHaveCount(0);
  await trigger.click();
  await expect(editor(page)).toHaveValue("Reply draft stays here.");
  // The trigger itself is also a toggle.
  await trigger.click();
  await expect(editor(page)).toHaveCount(0);
  await trigger.click();
  await editor(page).press("ControlOrMeta+Enter");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(post.getByRole("link", { name: "Posted to PR", exact: true })).toBeVisible();
});

test("failed reply leaves its local editor open", async ({ page }) => {
  await openPr(page, "?fail=post");
  const trigger = page.getByRole("button", { name: "Reply", exact: true }).first();
  await trigger.click();
  await editor(page).fill("Keep my reply after a failure.");
  await editor(page).press("ControlOrMeta+Enter");
  await expect(page.getByRole("alert")).toContainText("Could not post comment");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(editor(page)).toHaveValue("Keep my reply after a failure.");
});

test("scenery pauses through resizing, resumes and releases interrupted transitions", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openPr(page);
  const held = () =>
    page.evaluate(() => (window as unknown as { sceneryHeld: () => boolean }).sceneryHeld());
  await expect.poll(held).toBe(false);
  const trigger = page.getByRole("button", { name: "Add comment", exact: true });
  const samples = await trigger.evaluate(async (button) => {
    const panel = button.closest(".tk-panel");
    if (!panel) throw new Error("Missing shared trigger/editor container");
    const state = window as unknown as { sceneryHeld: () => boolean };
    const frames = [
      {
        width: panel.getBoundingClientRect().width,
        height: panel.getBoundingClientRect().height,
        held: false,
        sceneryWidth: 0,
        sceneryHeight: 0,
      },
    ];
    (button as HTMLButtonElement).click();
    for (let i = 0; i < 18; i++) {
      await new Promise(requestAnimationFrame);
      const rect = panel.getBoundingClientRect();
      const scenery = panel.querySelector(".tk-scenery")?.getBoundingClientRect();
      frames.push({
        width: rect.width,
        height: rect.height,
        held: state.sceneryHeld(),
        sceneryWidth: scenery?.width ?? 0,
        sceneryHeight: scenery?.height ?? 0,
      });
    }
    return frames;
  });
  const start = samples[0];
  const end = samples.at(-1);
  if (!start || !end) throw new Error("Missing animation samples");
  expect(end.width).toBeGreaterThan(start.width * 2);
  expect(end.height).toBeGreaterThan(start.height * 3);
  const moving = samples.filter((s) => s.held);
  expect(moving.length).toBeGreaterThan(1);
  expect(moving.some((s) => s.width > start.width + 1 && s.width < end.width - 1)).toBe(true);
  expect(new Set(moving.map((s) => s.sceneryWidth)).size).toBe(1);
  expect(new Set(moving.map((s) => s.sceneryHeight)).size).toBe(1);
  await expect.poll(held).toBe(false);
  await expect(trigger.locator("xpath=../..").locator(".tk-scenery canvas")).toHaveCount(1);

  // Preview can resize the same frame, and must pause scenery as well.
  await editor(page).fill(Array.from({ length: 20 }, (_, i) => `Paragraph ${i}.`).join("\n\n"));
  await page
    .getByRole("button", { name: "Preview", exact: true })
    .evaluate((toggle) => (toggle as HTMLElement).click());
  await expect.poll(held, { intervals: [10] }).toBe(true);
  await expect.poll(held).toBe(false);

  // Close, reopen before completion, then hide the panel while opening.
  await trigger.evaluate(async (button) => {
    (button as HTMLButtonElement).click();
    await new Promise(requestAnimationFrame);
    (button as HTMLButtonElement).click();
  });
  await expect.poll(held).toBe(false);
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(held).toBe(false);
  await expect(trigger.locator("xpath=../..").locator(".tk-scenery")).toHaveCount(0);
  await trigger.evaluate((button) => (button as HTMLButtonElement).click());
  await page.getByRole("tab", { name: /Explain/ }).click();
  await expect.poll(held).toBe(false);
});

test("the scenery fades in under the pointer, fully once open, and out once closed", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openPr(page);
  const trigger = page.getByRole("button", { name: "Add comment", exact: true });
  const scenery = trigger.locator("xpath=../..").locator(".tk-scenery");
  const opacity = () => scenery.evaluate((element) => Number(getComputedStyle(element).opacity));
  await expect(scenery).toHaveCount(0);
  // Slowed, so the fade is still under way when it is first sampled.
  await trigger
    .locator("xpath=../..")
    .evaluate((frame) => (frame as HTMLElement).style.setProperty("--tk-duration-3", "1.5s"));

  await trigger.hover();
  await expect(scenery).toHaveCount(1);
  expect(await opacity()).toBeLessThan(0.5);
  await expect.poll(opacity).toBe(0.5);

  await trigger.click();
  await expect.poll(opacity).toBe(1);
  await expect(editor(page).locator("xpath=../..")).toHaveAttribute("data-variant", "scenery");

  // Cancel leaves the pointer off the trigger, so the scenery goes with the panel.
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(scenery).toHaveCount(0);
});

test("file comments open the PR panel from another tab and keep separate drafts", async ({
  page,
}) => {
  await openPr(page);
  await page.getByRole("button", { name: "Add comment", exact: true }).click();
  await editor(page).fill("Conversation draft");
  await page.getByRole("tab", { name: /Explain/ }).click();
  await page.getByRole("button", { name: `Comment on file ${migration}`, exact: true }).click();
  await expect(page.getByRole("tab", { name: "PR", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(editor(page)).toBeFocused();
  await expect(
    page.getByText(`Comment on ${migration} (whole file).`, { exact: true }),
  ).toBeVisible();
  await editor(page).fill("This migration needs a backfill.");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.getByRole("link", { name: "Posted to PR", exact: true })).toBeVisible();
  expect((await requests(page))[0]).toMatchObject({
    destination: "file",
    path: migration,
    line: null,
    endLine: null,
  });
  await expect(page.getByText("This migration needs a backfill.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add comment", exact: true }).click();
  await expect(editor(page)).toHaveValue("Conversation draft");
});

for (const layout of ["Split", "Unified"]) {
  test(`${layout} diff gutter comments on a line and a range`, async ({ page }) => {
    await openPr(page);
    await page.getByRole("button", { name: layout, exact: true }).click();
    const diff = page.locator("diffs-container").first();
    // CodeView applies a layout switch after the toolbar updates. Hover the
    // new gutter rather than a split-layout button that is about to unmount.
    await expect(diff.locator("pre[data-diff-type]")).toHaveAttribute(
      "data-diff-type",
      layout === "Split" ? "split" : "single",
    );
    const number = diff.locator('[data-column-number="6"]').last();
    await number.hover();
    await diff.locator("[data-gutter-utility-slot] button").click();
    await expect(editor(page)).toBeVisible();
    await editor(page).fill(`${layout} single-line comment`);
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(page.getByRole("link", { name: "Posted to PR", exact: true })).toBeVisible();
    expect((await requests(page))[0]).toMatchObject({
      destination: "inline",
      path: migration,
      line: 6,
      endLine: null,
      oldSide: false,
    });
    await diff.locator('[data-column-number="5"]').last().click();
    await diff
      .locator('[data-column-number="8"]')
      .last()
      .click({ modifiers: ["Shift"] });
    await page.getByRole("button", { name: "Comment on selection", exact: true }).click();
    await editor(page).fill(`${layout} range comment`);
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await expect.poll(() => requests(page)).toHaveLength(2);
    expect((await requests(page))[1]).toMatchObject({ line: 5, endLine: 8, oldSide: false });
  });
}

test("old-side diff comment carries old-file line numbers", async ({ page }) => {
  await openPr(page);
  const diff = page.locator("diffs-container").first();
  await diff.locator('[data-deletions] [data-column-number="6"]').hover();
  await diff.locator("[data-gutter-utility-slot] button").click();
  await expect(
    page.getByText(`Comment on ${migration}:6 (old side).`, { exact: true }),
  ).toBeVisible();
  await editor(page).fill("Keep this default on the old side.");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect.poll(() => requests(page)).toHaveLength(1);
  expect((await requests(page))[0]).toMatchObject({ oldSide: true, line: 6 });
});

test("dragging the gutter plus selects a range and opens the PR editor", async ({ page }) => {
  await openPr(page);
  const diff = page.locator("diffs-container").first();
  await diff.locator('[data-additions] [data-column-number="6"]').hover();
  const plus = await diff.locator("[data-gutter-utility-slot] button").boundingBox();
  const end = await diff.locator('[data-additions] [data-column-number="8"]').boundingBox();
  if (!plus || !end) throw new Error("Diff gutter is missing");
  await page.mouse.move(plus.x + plus.width / 2, plus.y + plus.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByText(`Comment on ${migration}:6–8.`, { exact: true })).toBeVisible();
  await editor(page).fill("Comment on the dragged range.");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect.poll(() => requests(page)).toHaveLength(1);
  expect((await requests(page))[0]).toMatchObject({ line: 6, endLine: 8 });
});

test("a removed file accepts a comment on its deleted lines", async ({ page }) => {
  await openPr(page);
  await page.getByRole("button", { name: /OldViewer.tsx \+0/ }).click();
  const diff = page.locator("diffs-container").filter({
    has: page.getByRole("button", {
      name: "Comment on file src/legacy/OldViewer.tsx",
      exact: true,
    }),
  });
  await diff.locator('[data-deletions] [data-column-number="4"]').click();
  await page.getByRole("button", { name: "Comment on selection", exact: true }).click();
  await editor(page).fill("Why remove this helper?");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect.poll(() => requests(page)).toHaveLength(1);
  expect((await requests(page))[0]).toMatchObject({
    path: "src/legacy/OldViewer.tsx",
    oldSide: true,
    line: 4,
  });
});

test("AI replies, finding posts and review conclusions share Write and Preview", async ({
  page,
}) => {
  await openPr(page);
  await page.getByRole("tab", { name: /^(AI review|Review)$/ }).click();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  const conclusion = page.getByRole("textbox", {
    name: "Review conclusion",
    exact: true,
    includeHidden: true,
  });
  await expect(conclusion).toBeVisible();
  const conclusionEditor = conclusion.locator("xpath=../..");
  await conclusion.fill("**Shared conclusion editor**");
  await conclusionEditor.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(conclusionEditor.locator("strong")).toHaveText("Shared conclusion editor");
  await page.getByRole("button", { name: "Send to PR", exact: true }).first().click();
  const findingEditor = page
    .getByRole("textbox", { name: "Pull request comment", exact: true, includeHidden: true })
    .locator("xpath=../..");
  await editor(page).fill("**Shared finding editor**");
  await findingEditor.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(findingEditor.locator("strong")).toHaveText("Shared finding editor");
  await page.getByRole("button", { name: "Discuss", exact: true }).click();
  const aiReply = page.getByRole("textbox", { name: "AI reply", exact: true, includeHidden: true });
  const replyEditor = aiReply.locator("xpath=../..");
  await aiReply.fill("**Shared AI reply editor**");
  await replyEditor.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(replyEditor.locator("strong")).toHaveText("Shared AI reply editor");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: "Discuss", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(page.locator("strong").filter({ hasText: "Shared AI reply editor" })).toBeVisible();
});

test("a GitHub reply beside an AI finding expands at that trigger", async ({ page }) => {
  await openPr(page);
  const aiTab = page.getByRole("tab", { name: /^(AI review|Review)$/ });
  await aiTab.click();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.getByRole("button", { name: "Send to PR", exact: true }).nth(1).click();
  await page.getByRole("button", { name: "Post", exact: true }).click();
  await expect(page.getByRole("link", { name: "Posted to PR", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "PR", exact: true }).click();
  await page.getByRole("button", { name: "Refresh", exact: true }).last().click();
  await aiTab.click();
  const reply = page.getByText("Fixed — moved it as suggested, and added a test that covers it.", {
    exact: true,
  });
  const post = reply.locator("xpath=../..");
  await post.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(aiTab).toHaveAttribute("aria-selected", "true");
  await expect(post.getByRole("textbox", { name: "Pull request comment" })).toBeFocused();
  await expect(editor(page)).toHaveCount(1);
  await editor(page).fill("Reply to the posted finding.");
  await editor(page).press("ControlOrMeta+Enter");
  await expect(post.getByRole("link", { name: "Posted to PR", exact: true })).toBeVisible();
  expect((await requests(page))[1]).toMatchObject({ destination: "inline", replyTo: 901 });
});

test("a failed post leaves the draft and an actionable error", async ({ page }) => {
  await openPr(page, "?fail=post");
  await page.getByRole("button", { name: "Add comment", exact: true }).click();
  await editor(page).fill("Preserve this failed draft.");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not post comment");
  await expect(editor(page)).toHaveValue("Preserve this failed draft.");
  await expect(page.getByRole("button", { name: "Comment", exact: true })).toBeEnabled();
});

test("a successful post with a failed refresh does not invite a duplicate", async ({ page }) => {
  await openPr(page, "?fail=discussion");
  await page.getByRole("button", { name: "Add comment", exact: true }).click();
  await editor(page).fill("Already sent.");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Comment posted, but the conversation could not refresh",
  );
  await expect(page.getByRole("link", { name: "Posted to PR", exact: true })).toBeVisible();
  await expect(editor(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Add comment", exact: true }).click();
  await expect(editor(page)).toHaveValue("");
  expect(await requests(page)).toHaveLength(1);
});
