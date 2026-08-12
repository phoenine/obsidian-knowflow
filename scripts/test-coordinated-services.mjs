import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const tempDir = await mkdtemp(join(tmpdir(), "knowflow-coordinated-services-"));
await esbuild.build({
  bundle: true,
  entryPoints: [
    "src/services/clipping/clipping-pipeline.ts",
    "src/services/learning/quiz-note-service.ts"
  ],
  format: "esm",
  outdir: tempDir,
  platform: "node",
  plugins: [{
    name: "stub-obsidian",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub-obsidian" }));
      build.onLoad({ filter: /.*/, namespace: "stub-obsidian" }, () => ({
        contents: [
          "export class Notice {}",
          "export class TFile { static [Symbol.hasInstance](value) { return Boolean(value && typeof value.path === 'string' && typeof value.basename === 'string'); } }",
          "export const normalizePath = (value) => value.replace(/\\\\/g, '/');",
          "export const requestUrl = async () => ({ status: 500, text: '' });"
        ].join("\n"),
        loader: "js"
      }));
    }
  }]
});

const { ClippingPipeline } = await import(pathToFileURL(join(tempDir, "clipping", "clipping-pipeline.js")).href);
const { QuizNoteService } = await import(pathToFileURL(join(tempDir, "learning", "quiz-note-service.js")).href);

// Moving categories must validate the destination first, then rename before
// changing frontmatter so a failed rename cannot alter a note left behind.
{
  const events = [];
  const file = { path: "Clippings/Test.md", name: "Test.md" };
  const app = {
    vault: {
      adapter: { exists: async (path) => path === "Articles/AI" },
      read: async () => "---\n分类: 旧分类\n---\n\n正文。\n",
      modify: async () => events.push("modify"),
      getAbstractFileByPath: () => null
    },
    fileManager: {
      renameFile: async (target, path) => {
        events.push("rename");
        target.path = path;
      }
    }
  };
  const store = { recordCategoryMove: async () => events.push("store") };
  const coordinator = { runExclusive: async (_path, operation) => operation() };
  const pipeline = new ClippingPipeline(
    app,
    { articlesFolder: "Articles", autoCreateCategoryFolders: true },
    store,
    {},
    coordinator
  );
  await pipeline.moveToCategory(file, "AI");
  assert.deepEqual(events, ["rename", "modify", "store"]);
}

{
  let modified = false;
  const file = { path: "Clippings/Conflict.md", name: "Conflict.md" };
  const app = {
    vault: {
      adapter: { exists: async (path) => path === "Articles/AI" || path === "Articles/AI/Conflict.md" },
      modify: async () => { modified = true; }
    }
  };
  const coordinator = { runExclusive: async (_path, operation) => operation() };
  const pipeline = new ClippingPipeline(
    app,
    { articlesFolder: "Articles", autoCreateCategoryFolders: true },
    {},
    {},
    coordinator
  );
  await assert.rejects(pipeline.moveToCategory(file, "AI"), /目标文件已存在/);
  assert.equal(modified, false, "destination conflicts must not modify source frontmatter");
}

// Quiz source callouts must be based on content read inside the shared note
// operation, so edits queued before that operation are preserved.
{
  const source = { path: "Articles/Test.md", name: "Test.md", basename: "Test" };
  let current = "## 正文\n\n原始内容。\n";
  const app = {
    vault: {
      adapter: { exists: async () => false },
      createFolder: async () => {},
      read: async (file) => file === source ? current : "",
      create: async () => {},
      modify: async (file, next) => {
        if (file === source) current = next;
      },
      getAbstractFileByPath: () => null
    }
  };
  const coordinator = {
    runExclusive: async (_path, operation) => {
      current = `${current.trimEnd()}\n\n排队期间的用户编辑。\n`;
      return operation();
    }
  };
  const service = new QuizNoteService(app, { archiveFolder: "Archives" }, coordinator);
  await service.saveQuiz(source, "AI", []);
  assert.ok(current.includes("排队期间的用户编辑。"));
  assert.ok(current.includes("> [!question]- Quiz"));
}

// The global review bank must discover legacy Quiz notes whose source is stored
// as a parent-relative frontmatter wikilink.
{
  const quiz = { path: "Archives/AI/Source_Quiz.md", name: "Source_Quiz.md", basename: "Source_Quiz" };
  const source = { path: "Articles/AI/Source.md", name: "Source.md", basename: "Source" };
  const content = [
    "---",
    '原文链接: "[[../Articles/AI/Source|Source]]"',
    "---",
    "",
    "<!-- study-quiz:start -->",
    "",
    "## 1. 选择题",
    "",
    "### 1.1. 哪个选项正确？",
    "",
    "- [ ] A. 错误项",
    "- [ ] B. 正确项",
    "- [ ] C. 干扰项",
    "- [ ] D. 干扰项",
    "",
    "```Answer fold",
    "- 答案：B",
    "- 解析：来自旧版题库。",
    "```",
    "",
    "<!-- study-quiz:end -->",
    ""
  ].join("\n");
  const app = {
    vault: {
      getMarkdownFiles: () => [quiz, source],
      getAbstractFileByPath: (path) => path === source.path ? source : null,
      read: async (file) => file === quiz ? content : ""
    }
  };
  const coordinator = { runExclusive: async (_path, operation) => operation() };
  const service = new QuizNoteService(app, { archiveFolder: "Archives" }, coordinator);
  const questions = await service.listReviewQuestions();
  assert.equal(questions.length, 1);
  assert.equal(questions[0].articlePath, source.path);
  assert.equal(questions[0].entries[0].question.question, "哪个选项正确？");
}

await rm(tempDir, { recursive: true, force: true });
console.log("coordinated service tests passed");
