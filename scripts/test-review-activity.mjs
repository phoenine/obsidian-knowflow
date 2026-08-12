import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const tempDir = await mkdtemp(join(tmpdir(), "knowflow-review-activity-"));
await esbuild.build({
  bundle: true,
  entryPoints: ["src/services/learning/review-activity.ts"],
  format: "esm",
  outdir: tempDir,
  platform: "node"
});
const { summarizeWeeklyReviewActivity } = await import(pathToFileURL(join(tempDir, "review-activity.js")).href);

const questions = ["one", "two", "three"].map((key) => ({
  key,
  articlePath: "Articles/AI/source.md"
}));
const activity = summarizeWeeklyReviewActivity([{
  questions,
  answers: {
    one: { correct: true },
    two: { correct: false },
    three: { correct: true }
  },
  completedAt: "2026-08-12T08:00:00.000Z"
}], new Date(2026, 7, 10), "Articles", "Articles");

assert.equal(activity.sessionCount, 1, "three questions in one session count as one review");
assert.equal(activity.dailyQuestions.reduce((sum, count) => sum + count, 0), 3, "the chart counts reviewed questions");
assert.equal(activity.averageAccuracy, 67, "accuracy is based on reviewed answers");

const empty = summarizeWeeklyReviewActivity([], new Date(2026, 7, 10), "Articles", "Articles");
assert.equal(empty.averageAccuracy, null, "accuracy stays empty without reviewed answers");

await rm(tempDir, { recursive: true, force: true });
console.log("review activity tests passed");
