import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const tempDir = await mkdtemp(join(tmpdir(), "knowflow-daily-review-"));
await esbuild.build({
  bundle: true,
  entryPoints: ["src/services/learning/daily-review.ts"],
  format: "esm",
  outdir: tempDir,
  platform: "node"
});
const {
  createReviewQuestionKey,
  getDailyReviewQuestionCount,
  selectDailyReviewQuestions,
  toEligibleReviewQuestion
} = await import(pathToFileURL(join(tempDir, "daily-review.js")).href);

const question = (articlePath, index, answerState) => toEligibleReviewQuestion({
  articlePath,
  articleTitle: articlePath.split("/").pop(),
  quizPath: `Archives/${index}.md`,
  displayIndex: index,
  question: {
    id: `q${index}`,
    notePath: articlePath,
    question: `Question number ${index} asks about an important concept?`,
    type: "single_choice",
    options: [
      { key: "A", content: "A" },
      { key: "B", content: "B" }
    ],
    answerKey: "A",
    explanation: "Explanation",
    difficulty: 3,
    createdAt: "2026-08-01"
  },
  answerState
}, "2026-08-12");

assert.equal(getDailyReviewQuestionCount(3, 3, 10), 3);
assert.equal(getDailyReviewQuestionCount(25, 25, 10), 5);
assert.equal(getDailyReviewQuestionCount(64, 64, 10), 8);
assert.equal(getDailyReviewQuestionCount(87, 87, 10), 9);
assert.equal(getDailyReviewQuestionCount(200, 200, 10), 10);

const unseen = question("Articles/A.md", 1, { selectedKey: null, correct: null, answeredAt: null });
const wrong = question("Articles/B.md", 2, { selectedKey: "B", correct: false, answeredAt: "2026-08-11" });
const due = question("Articles/C.md", 3, { selectedKey: "A", correct: true, answeredAt: "2026-08-05" });
const recentCorrect = question("Articles/D.md", 4, { selectedKey: "A", correct: true, answeredAt: "2026-08-06" });
assert.equal(unseen.priority, "unseen");
assert.equal(wrong.priority, "wrong");
assert.equal(due.priority, "due");
assert.equal(recentCorrect, null, "correct answers need a full seven-day cooldown");

const ordered = selectDailyReviewQuestions([due, unseen, wrong], 9, 3, { random: () => 0 });
assert.deepEqual(
  ordered.map((candidate) => candidate.priority),
  ["wrong", "unseen", "due"],
  "selection tiers must be strict"
);

const many = [
  wrong,
  unseen,
  due,
  ...Array.from({ length: 8 }, (_, index) =>
    question(`Articles/Article-${index}.md`, index + 10, {
      selectedKey: null,
      correct: null,
      answeredAt: null
    })
  )
].filter(Boolean);
const selected = selectDailyReviewQuestions(many, 64, 8, { random: () => 0 });
assert.equal(selected.length, 8);
assert.equal(selected[0].priority, "wrong", "wrong answers must be selected before all other tiers");

const pinned = selectDailyReviewQuestions(many, 25, 5, {
  pinnedKeys: [wrong.key],
  random: () => 0.99
});
assert.equal(pinned[0].key, wrong.key, "refresh must keep previously selected wrong questions");

assert.equal(
  createReviewQuestionKey("Articles/A.md", unseen.question),
  createReviewQuestionKey("Articles/A.md", { ...unseen.question, id: "different-id" }),
  "question keys must not depend on display ids"
);

await rm(tempDir, { recursive: true, force: true });
console.log("daily review tests passed");
