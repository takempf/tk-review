import { parsePatchFiles } from "@pierre/diffs";
import { expect, test } from "@playwright/test";
import { diffCommentLocation } from "../../src/lib/diffComment";

test("anchors ranges to one original hunk and rejects expanded or mixed-side lines", () => {
  const [file] = parsePatchFiles(`diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -3,3 +3,3 @@
 context
-old
+new
 context
@@ -20,1 +20,1 @@
-old
+new
`).flatMap((patch) => patch.files);
  if (!file) throw new Error("Missing patch fixture");
  expect(diffCommentLocation(file, { start: 5, end: 3, side: "additions" }, "head")).toMatchObject({
    path: "file.ts",
    line: 3,
    endLine: 5,
    oldSide: false,
    headSha: "head",
  });
  expect(diffCommentLocation(file, { start: 4, end: 4, side: "deletions" }, "head")).toMatchObject({
    line: 4,
    endLine: null,
    oldSide: true,
  });
  for (const range of [
    { start: 3, end: 20 }, // Across two hunks.
    { start: 2, end: 3 }, // Expanded context outside the patch.
    { start: 0, end: 0 },
    { start: 3, end: 4, side: "deletions" as const, endSide: "additions" as const },
  ]) {
    expect(diffCommentLocation(file, range, "head")).toBeNull();
  }
});
