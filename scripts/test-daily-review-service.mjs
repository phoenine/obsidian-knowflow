import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const tempDir = await mkdtemp(join(tmpdir(), "knowflow-daily-review-service-"));
await esbuild.build({
  bundle: true,
  entryPoints: ["src/services/learning/daily-review-service.ts"],
  format: "esm",
  outdir: tempDir,
  platform: "node",
  plugins: [{
    name: "stub-obsidian",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub-obsidian" }));
      build.onLoad({ filter: /.*/, namespace: "stub-obsidian" }, () => ({
        contents: "export class TFile { constructor(path, basename) { this.path = path; this.basename = basename; } }",
        loader: "js"
      }));
    }
  }]
});
const { DailyReviewService } = await import(pathToFileURL(join(tempDir, "daily-review-service.js")).href);

const files = [
  { path: "Articles/AI/old.md", basename: "Old" },
  { path: "Articles/Other/today.md", basename: "Today" },
  { path: "Articles/Other/unlearned.md", basename: "Unlearned" }
];
const frontmatter = {
  "Articles/AI/old.md": { "学习状态": ["已学习"], "学习日期": "2026-08-10" },
  "Articles/Other/today.md": { "学习状态": ["已学习"], "学习日期": "2026-08-12" },
  "Articles/Other/unlearned.md": { "学习状态": ["未学习"] }
};
const app = {
  vault: {
    getMarkdownFiles: () => files,
    getAbstractFileByPath: (path) => files.find((file) => file.path === path)
  },
  metadataCache: { getFileCache: (file) => ({ frontmatter: frontmatter[file.path] }) }
};
let saved = null;
const store = {
  getDailyReviewSession: () => saved,
  saveDailyReviewSession: async (session) => { saved = structuredClone(session); },
  recordDailyReviewAnswer: async (date, answer) => {
    saved.answers[answer.questionKey] = answer;
    if (Object.keys(saved.answers).length === saved.questions.length) saved.completedAt = answer.answeredAt;
    return structuredClone(saved);
  },
  isLearned: () => false
};
const quizQuestion = (path, index) => ({
  displayIndex: index,
  question: {
    id: `q${index}`,
    notePath: path,
    question: `Question ${index} from a globally eligible learned article?`,
    type: "single_choice",
    options: [{ key: "A", content: "A" }, { key: "B", content: "B" }],
    answerKey: "A",
    explanation: "Explanation",
    difficulty: 3,
    createdAt: "2026-08-01"
  },
  answerState: { selectedKey: null, correct: null, answeredAt: null }
});
const writes = [];
const quizNotes = {
  listReviewQuestions: async () => files.map((file) => ({
    articlePath: file.path,
    articleTitle: file.basename,
    quizPath: `Archives/${file.basename}.md`,
    entries: [quizQuestion(file.path, 1)]
  })),
  recordAnswer: async (...args) => {
    writes.push(args);
    return args[2] === args[3];
  }
};

const service = new DailyReviewService(app, store, quizNotes, {
  articlesFolder: "Articles"
});
const session = await service.ensureSession("2026-08-12", 10);
assert.equal(session.questions.length, 1);
assert.equal(session.questions[0].articlePath, "Articles/AI/old.md", "review must scan globally across article categories");
assert.ok(!session.questions.some((item) => item.articlePath.endsWith("today.md")), "articles learned today must wait until tomorrow");

const unchanged = await service.ensureSession("2026-08-12", 10, true);
assert.equal(unchanged.questions.length, 1, "refresh before starting may regenerate the same fixed-size session");
const updated = await service.recordAnswer("2026-08-12", unchanged.questions[0].key, "B");
assert.equal(updated.completedAt !== null, true, "answering the final question must complete the session");
assert.equal(writes[0][4], unchanged.questions[0].question.question, "write-back must verify the source question did not change");
const locked = await service.ensureSession("2026-08-12", 10, true);
assert.deepEqual(locked.answers, updated.answers, "refresh must not replace a started session");

await rm(tempDir, { recursive: true, force: true });
console.log("daily review service tests passed");
