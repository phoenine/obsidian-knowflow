import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const tempDir = await mkdtemp(join(tmpdir(), "knowflow-store-"));
await esbuild.build({
  bundle: true,
  entryPoints: ["src/services/core/store.ts"],
  format: "esm",
  outdir: tempDir,
  platform: "node"
});
const { KnowledgeStore } = await import(pathToFileURL(join(tempDir, "store.js")).href);

function createHost(initial) {
  let saved = initial;
  const host = {
    saveCount: 0,
    loadData: async () => saved,
    saveData: async (data) => {
      host.saveCount += 1;
      saved = data;
    }
  };
  return { host };
}

// migrateFolder should move every path-keyed status/learned record whose
// path lives under the old folder, and should not touch
// records outside of it.
{
  const { host } = createHost();
  const store = new KnowledgeStore(host);
  await store.load();

  await store.setPipelineStatus({ path: "Articles/AI/one.md", status: "processed", updatedAt: "2026-01-01T00:00:00.000Z" });
  await store.setPipelineStatus({ path: "Articles/Other/two.md", status: "processed", updatedAt: "2026-01-01T00:00:00.000Z" });
  await store.markLearned("Articles/AI/one.md");

  await store.migrateFolder("Articles/AI", "Articles/人工智能");

  assert.equal(store.getPipelineStatus("Articles/AI/one.md").status, "raw");
  assert.equal(store.getPipelineStatus("Articles/人工智能/one.md").status, "processed");
  assert.equal(store.getPipelineStatus("Articles/Other/two.md").status, "processed", "unrelated folder must stay untouched");

  assert.ok(store.isLearned("Articles/人工智能/one.md"));
  assert.ok(!store.isLearned("Articles/AI/one.md"));
}

// A folder rename should not accidentally match a sibling folder that
// merely shares a name prefix (e.g. "Articles/AI" vs "Articles/AI2").
{
  const { host } = createHost();
  const store = new KnowledgeStore(host);
  await store.load();

  await store.setPipelineStatus({ path: "Articles/AI2/three.md", status: "processed", updatedAt: "2026-01-01T00:00:00.000Z" });

  await store.migrateFolder("Articles/AI", "Articles/人工智能");

  assert.equal(store.getPipelineStatus("Articles/AI2/three.md").status, "processed", "sibling folder with shared prefix must not be migrated");
}

// recordPipelineSuccess should persist the pipeline status.
// pipelineResults (a capped history log whose title/category/readingValue
// duplicated frontmatter and whose only reader was itself dead code) was
// removed entirely.
{
  const { host } = createHost();
  const store = new KnowledgeStore(host);
  await store.load();
  const before = host.saveCount;

  await store.recordPipelineSuccess({ path: "Clippings/one.md", status: "processed", updatedAt: "2026-01-01T00:00:00.000Z" });

  assert.equal(host.saveCount - before, 1, "recordPipelineSuccess must only save once");
  assert.equal(store.getPipelineStatus("Clippings/one.md").status, "processed");
}

// A category move should retain non-pipeline state but delete pipeline
// status from both the old clipping path and the new article path.
{
  const { host } = createHost();
  const store = new KnowledgeStore(host);
  await store.load();

  await store.setPipelineStatus({ path: "Clippings/two.md", status: "processed", updatedAt: "2026-01-01T00:00:00.000Z" });
  await store.markLearned("Clippings/two.md");
  const before = host.saveCount;

  await store.recordCategoryMove({ oldPath: "Clippings/two.md", newPath: "Articles/AI/two.md" });

  assert.equal(host.saveCount - before, 1, "recordCategoryMove must only save once");
  assert.equal(store.getPipelineStatus("Clippings/two.md").status, "raw");
  assert.equal(store.getPipelineStatus("Articles/AI/two.md").status, "raw");
  assert.ok(store.isLearned("Articles/AI/two.md"));
}

// The result must be the same when Obsidian's rename event migrated state
// before recordCategoryMove runs.
{
  const { host } = createHost();
  const store = new KnowledgeStore(host);
  await store.load();
  await store.setPipelineStatus({ path: "Clippings/race.md", status: "processed", updatedAt: "2026-01-01T00:00:00.000Z" });
  await store.migratePath("Clippings/race.md", "Articles/AI/race.md");
  const before = host.saveCount;

  await store.recordCategoryMove({ oldPath: "Clippings/race.md", newPath: "Articles/AI/race.md" });

  assert.equal(host.saveCount - before, 1);
  assert.equal(store.getPipelineStatus("Clippings/race.md").status, "raw");
  assert.equal(store.getPipelineStatus("Articles/AI/race.md").status, "raw");
}

// forgetPath should remove every record for a single deleted file, and
// leave unrelated files untouched.
{
  const { host } = createHost();
  const store = new KnowledgeStore(host);
  await store.load();

  await store.markLearned("Articles/AI/one.md");
  await store.setPipelineStatus({ path: "Articles/AI/one.md", status: "processed", updatedAt: "2026-01-01T00:00:00.000Z" });
  await store.setPipelineStatus({ path: "Articles/AI/other.md", status: "processed", updatedAt: "2026-01-01T00:00:00.000Z" });

  await store.forgetPath("Articles/AI/one.md");

  assert.ok(!store.isLearned("Articles/AI/one.md"));
  assert.equal(store.getPipelineStatus("Articles/AI/one.md").status, "raw");
  assert.equal(store.getPipelineStatus("Articles/AI/other.md").status, "processed", "unrelated file must stay untouched");
}

// forgetFolder should sweep every record under a deleted folder in one
// pass, mirroring migrateFolder's single-event handling.
{
  const { host } = createHost();
  const store = new KnowledgeStore(host);
  await store.load();

  await store.setPipelineStatus({ path: "Articles/AI/one.md", status: "processed", updatedAt: "2026-01-01T00:00:00.000Z" });
  await store.setPipelineStatus({ path: "Articles/AI/two.md", status: "processed", updatedAt: "2026-01-01T00:00:00.000Z" });
  await store.setPipelineStatus({ path: "Articles/AI2/three.md", status: "processed", updatedAt: "2026-01-01T00:00:00.000Z" });

  await store.forgetFolder("Articles/AI");

  assert.equal(store.getPipelineStatus("Articles/AI/one.md").status, "raw");
  assert.equal(store.getPipelineStatus("Articles/AI/two.md").status, "raw");
  assert.equal(store.getPipelineStatus("Articles/AI2/three.md").status, "processed", "sibling folder with shared prefix must not be swept");
}

// load() should discard the obsolete summaries index without migrating it.
{
  const { host } = createHost({
    summaries: {
      "Articles/AI/legacy.md": {
        filePath: "Articles/AI/legacy.md",
        title: "legacy",
        briefDescription: "d",
        summary: "旧版本遗留的摘要全文",
        readingValue: 3,
        recommendedAction: "skim",
        category: "AI",
        reason: "旧版本遗留的理由",
        tags: [],
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    },
    // A leftover pipelineResults array from an older plugin version — load()
    // must drop it outright, the same way it already drops quizzes/
    // quizAttempts/quizStats (see load() in store.ts).
    pipelineResults: [{ sourcePath: "a.md", targetPath: "a.md", title: "a", category: "AI", readingValue: 3, updatedAt: "2026-01-01T00:00:00.000Z" }],
    pipelineStatuses: {},
    chatThreads: { "chat-1": { id: "chat-1" } },
    quizNotePaths: { "Articles/AI/legacy.md": "Archives/legacy Quiz.md" },
    learnedPaths: []
  });
  const store = new KnowledgeStore(host);
  await store.load();

  assert.equal("summaries" in store.exportData(), false, "the obsolete summaries index must be dropped entirely");
  assert.equal("quizNotePaths" in store.exportData(), false, "the obsolete quizNotePaths index must be dropped entirely");
  assert.equal("pipelineResults" in store.exportData(), false, "the legacy pipelineResults array must be dropped entirely");
  assert.equal("chatThreads" in store.exportData(), false, "chat history belongs in markdown notes, not data.json");
}

// Every removed legacy field must trigger persistence even when chatThreads
// is absent; otherwise the obsolete data remains in data.json until a later
// unrelated write.
{
  const { host } = createHost({
    pipelineResults: [{ sourcePath: "legacy.md" }],
    pipelineStatuses: {},
    learnedPaths: [],
    dailyTaskPlans: {}
  });
  const store = new KnowledgeStore(host);
  await store.load();

  assert.equal(host.saveCount, 1);
  assert.equal("pipelineResults" in await host.loadData(), false);
}

// Daily task plans persist task state and keep path references valid when
// article folders are renamed.
{
  const { host } = createHost();
  const store = new KnowledgeStore(host);
  await store.load();
  await store.saveDailyTaskPlan({
    generatorVersion: 3,
    date: "2026-08-09",
    scopePath: "Articles/AI",
    generatedAt: "2026-08-09T08:00:00.000Z",
    newArticleLimit: 1,
    tasks: [{
      id: "new_note:Articles/AI/one.md",
      type: "new_note",
      title: "One",
      targetPath: "Articles/AI/one.md",
      status: "pending",
      completedAt: null
    }]
  });

  await store.updateDailyTaskStatus("2026-08-09", "Articles/AI", "new_note:Articles/AI/one.md", "completed", "2026-08-09T09:00:00.000Z");
  assert.equal(store.getDailyTaskPlan("2026-08-09", "Articles/AI")?.tasks[0].status, "completed");
  assert.deepEqual(store.getCompletedTaskPathsSince(new Date("2026-08-09T08:30:00.000Z")), ["Articles/AI/one.md"]);
  assert.deepEqual(
    store.getCompletedTasksSince(new Date("2026-08-09T08:30:00.000Z")).map((task) => ({ path: task.targetPath, completedAt: task.completedAt })),
    [{ path: "Articles/AI/one.md", completedAt: "2026-08-09T09:00:00.000Z" }]
  );

  await store.migrateFolder("Articles/AI", "Articles/人工智能");
  assert.equal(store.getDailyTaskPlan("2026-08-09", "Articles/AI"), null);
  const migrated = store.getDailyTaskPlan("2026-08-09", "Articles/人工智能");
  assert.equal(migrated?.tasks[0].targetPath, "Articles/人工智能/one.md");
  assert.equal(migrated?.tasks[0].id, "new_note:Articles/人工智能/one.md");
}

// Daily review sessions persist cross-article question references, progress,
// completion, and source-path migrations.
{
  const { host } = createHost();
  const store = new KnowledgeStore(host);
  await store.load();
  const reviewQuestion = {
    key: "review-one",
    articlePath: "Articles/AI/one.md",
    articleTitle: "One",
    quizPath: "Archives/one Quiz.md",
    displayIndex: 1,
    priority: "wrong",
    question: {
      id: "q1",
      notePath: "Articles/AI/one.md",
      question: "Question?",
      type: "single_choice",
      options: [{ key: "A", content: "A" }, { key: "B", content: "B" }],
      answerKey: "A",
      explanation: "Explanation",
      difficulty: 3,
      createdAt: "2026-08-01"
    }
  };
  await store.saveDailyReviewSession({
    generatorVersion: 1,
    date: "2026-08-12",
    generatedAt: "2026-08-12T08:00:00.000Z",
    questionCap: 10,
    bankSize: 20,
    questions: [reviewQuestion],
    answers: {},
    completedAt: null
  });
  const updated = await store.recordDailyReviewAnswer("2026-08-12", {
    questionKey: "review-one",
    selectedKey: "B",
    correct: false,
    answeredAt: "2026-08-12T08:10:00.000Z"
  });
  assert.equal(updated?.completedAt, "2026-08-12T08:10:00.000Z");
  assert.equal(store.getCompletedReviewSessionsSince(new Date("2026-08-12T00:00:00.000Z")).length, 1);

  await store.migratePath("Articles/AI/one.md", "Articles/人工智能/one.md");
  assert.equal(store.getDailyReviewSession("2026-08-12")?.questions[0].articlePath, "Articles/人工智能/one.md");
  assert.equal(store.getDailyReviewSession("2026-08-12")?.questions[0].question.notePath, "Articles/人工智能/one.md");
}

await rm(tempDir, { recursive: true, force: true });
console.log("store tests passed");
