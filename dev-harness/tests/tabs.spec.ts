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
  await expect(tabs(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Pull requests", exact: true }).click();
  await expect(rows(page)).toHaveCount(4);
  await expect(tabs(page)).toHaveCount(1);

  await rows(page).nth(1).click();
  await expect(tabs(page)).toHaveCount(1);
  await tabs(page).nth(0).getByRole("button").first().click();
  await expect(tabs(page)).toHaveCount(1);
  await page.getByRole("button", { name: "Pull requests", exact: true }).click();
  await expect(tabs(page)).toHaveCount(2);

  await tabs(page).nth(0).getByTitle("Close tab").click();
  await expect(tabs(page)).toHaveCount(1);
});

/** Each screen change's morphing parts: the names with both an old and a new element, so a group animates. */
async function recordScreenMorphs(page: Page) {
  await page.addInitScript(() => {
    const start = document.startViewTransition.bind(document);
    const changes: (string[] | string)[] = [];
    Object.assign(window, { screenMorphs: changes });
    document.startViewTransition = (...args: Parameters<typeof start>) => {
      const transition = start(...args);
      transition.ready.then(
        () =>
          changes.push(
            document
              .getAnimations()
              .flatMap(
                (animation) =>
                  /^::view-transition-group\((screen-.+)\)$/.exec(
                    (animation.effect as KeyframeEffect | null)?.pseudoElement ?? "",
                  )?.[1] ?? [],
              ),
          ),
        (error) => changes.push(String(error)),
      );
      return transition;
    };
  });
}

/** The PR numbers whose number and title glided in the screen change at `index`. */
async function glidedPrs(page: Page, index: number): Promise<number[]> {
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { screenMorphs: unknown[] }).screenMorphs.length),
    )
    .toBeGreaterThan(index);
  const change = await page.evaluate(
    (at) => (window as unknown as { screenMorphs: (string[] | string)[] }).screenMorphs[at],
    index,
  );
  if (change === undefined || typeof change === "string")
    throw new Error(`The screen change failed: ${change}`);
  const gliding = (part: "number" | "title") =>
    change
      .flatMap((name) => {
        const match = /-(\d+)-(number|title)$/.exec(name);
        return match?.[2] === part ? [Number(match[1])] : [];
      })
      .sort((a, b) => a - b);
  expect(gliding("title")).toEqual(gliding("number"));
  return gliding("number");
}

test("a PR's number and title glide between its tab and the review's header, both ways", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await recordScreenMorphs(page);
  await page.goto("/dev-harness/");
  await expect(rows(page)).toHaveCount(4);
  const back = page.getByRole("button", { name: "Pull requests", exact: true });
  const heading = (number: number) => page.getByRole("link", { name: new RegExp(`^#${number} `) });
  const firstNumber = Number(/#(\d+)/.exec((await rows(page).nth(0).textContent()) ?? "")?.[1]);
  const secondNumber = Number(/#(\d+)/.exec((await rows(page).nth(1).textContent()) ?? "")?.[1]);

  await rows(page).nth(0).click();
  await expect(heading(firstNumber)).toBeVisible();
  expect(await glidedPrs(page, 0)).toEqual([firstNumber]);

  await back.click();
  await expect(tabs(page)).toHaveCount(1);
  expect(await glidedPrs(page, 1)).toEqual([firstNumber]);

  await tabs(page).nth(0).getByRole("button").first().click();
  await expect(heading(firstNumber)).toBeVisible();
  expect(await glidedPrs(page, 2)).toEqual([firstNumber]);

  await back.click();
  await rows(page).nth(1).click();
  await expect(heading(secondNumber)).toBeVisible();
  await tabs(page).nth(0).getByRole("button").first().click();
  await expect(heading(firstNumber)).toBeVisible();
  expect(await glidedPrs(page, 5)).toEqual([firstNumber, secondNumber].sort((a, b) => a - b));
});
