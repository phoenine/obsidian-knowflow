import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const tempDir = await mkdtemp(join(tmpdir(), "knowflow-daily-tasks-"));
await esbuild.build({
  bundle: true,
  entryPoints: ["src/services/learning/daily-tasks.ts"],
  format: "esm",
  outdir: tempDir,
  platform: "node"
});
const { createDailyTaskPlan } = await import(pathToFileURL(join(tempDir, "daily-tasks.js")).href);

const randomValues = [0.99, 0, 0.5, 0];
const plan = createDailyTaskPlan({
  date: "2026-08-09",
  scopePath: "Articles/AI",
  generatedAt: "2026-08-09T08:00:00.000Z",
  newArticleLimit: 2,
  random: () => randomValues.shift() ?? 0,
  candidates: [
    { path: "Articles/AI/new-1.md", title: "New 1", learned: false, reviewable: false },
    { path: "Articles/AI/new-2.md", title: "New 2", learned: false, reviewable: false },
    { path: "Articles/AI/new-3.md", title: "New 3", learned: false, reviewable: false },
    { path: "Articles/AI/review-1.md", title: "Review 1", learned: true, reviewable: true },
    { path: "Articles/AI/review-2.md", title: "Review 2", learned: true, reviewable: true },
    { path: "Articles/AI/no-quiz.md", title: "No Quiz", learned: true, reviewable: false },
    { path: "Articles/AI/review-3.md", title: "Review 3", learned: true, reviewable: true }
  ]
});

assert.equal(plan.date, "2026-08-09");
assert.equal(plan.generatorVersion, 3);
assert.equal(plan.scopePath, "Articles/AI");
assert.equal(plan.newArticleLimit, 2);
assert.deepEqual(plan.tasks.map((task) => task.targetPath), [
  "Articles/AI/new-3.md",
  "Articles/AI/new-1.md"
]);
assert.deepEqual(plan.tasks.map((task) => task.type), ["new_note", "new_note"]);
assert.ok(plan.tasks.every((task) => task.status === "pending"));
assert.ok(!plan.tasks.some((task) => task.targetPath === "Articles/AI/no-quiz.md"));

const preserved = createDailyTaskPlan({
  date: "2026-08-09",
  scopePath: "Articles/AI",
  generatedAt: "2026-08-09T09:00:00.000Z",
  newArticleLimit: 1,
  candidates: [
    { path: "Articles/AI/completed-new.md", title: "Completed New", learned: true, reviewable: false },
    { path: "Articles/AI/review-1.md", title: "Review 1", learned: true, reviewable: true }
  ],
  existingTasks: [
    { id: "new_note:Articles/AI/completed-new.md", type: "new_note", title: "Completed New", targetPath: "Articles/AI/completed-new.md", status: "completed", completedAt: "2026-08-09T08:00:00.000Z" }
  ],
  random: () => 0
});
assert.deepEqual(preserved.tasks.map((task) => task.targetPath), [
  "Articles/AI/completed-new.md"
]);
assert.equal(preserved.tasks[0].status, "completed", "eligible tasks must keep their same-day status");

const refreshed = createDailyTaskPlan({
  date: "2026-08-09",
  scopePath: "Articles/AI",
  generatedAt: "2026-08-09T10:00:00.000Z",
  newArticleLimit: 2,
  candidates: [
    { path: "Articles/AI/new-1.md", title: "New 1", learned: false, reviewable: false },
    { path: "Articles/AI/new-3.md", title: "New 3", learned: false, reviewable: false }
  ],
  existingTasks: [
    { id: "new_note:Articles/AI/new-1.md", type: "new_note", title: "New 1", targetPath: "Articles/AI/new-1.md", status: "pending", completedAt: null }
  ],
  random: () => 0
});
assert.deepEqual(refreshed.tasks.map((task) => task.targetPath), [
  "Articles/AI/new-1.md",
  "Articles/AI/new-3.md"
]);

const empty = createDailyTaskPlan({
  date: "2026-08-09",
  scopePath: "Articles",
  generatedAt: "2026-08-09T08:00:00.000Z",
  newArticleLimit: 0,
  candidates: [{ path: "Articles/one.md", title: "One", learned: false, reviewable: false }]
});
assert.deepEqual(empty.tasks, []);

await rm(tempDir, { recursive: true, force: true });
console.log("daily task tests passed");
