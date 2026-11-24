import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const tempDir = await mkdtemp(join(tmpdir(), "knowflow-ui-controllers-"));
await esbuild.build({
  bundle: true,
  entryPoints: [
    "src/ui/controllers/chat-controller.ts",
    "src/ui/controllers/summary-controller.ts"
  ],
  format: "esm",
  outdir: tempDir,
  platform: "node",
  plugins: [{
    name: "stub-obsidian",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub-obsidian" }));
      build.onLoad({ filter: /.*/, namespace: "stub-obsidian" }, () => ({
        contents: "export class Notice {}\nexport class TFile {}\nexport const requestUrl = () => { throw new Error('Unexpected network request'); };\n",
        loader: "js"
      }));
    }
  }]
});

const { ChatController } = await import(pathToFileURL(join(tempDir, "chat-controller.js")).href);
const { SummaryController } = await import(pathToFileURL(join(tempDir, "summary-controller.js")).href);

{
  const file = { path: "Articles/Test.md", basename: "Test" };
  let renders = 0;
  const app = { vault: { read: async () => "文章正文" } };
  const plugin = {
    ai: {
      answerStream: async (_label, _content, _history, handlers) => {
        handlers.onContent("回答");
        handlers.onReasoning("思考");
        handlers.onUsage({ promptTokens: 10, completionTokens: 2, totalTokens: 12, estimated: false });
        return { promptTokens: 10, completionTokens: 2, totalTokens: 12, estimated: false };
      }
    },
    chatNotes: { saveThread: async () => "Chats/Test.md" }
  };
  const controller = new ChatController(app, plugin, () => { renders += 1; });
  let started = false;
  let streamed = "";
  await controller.submit("问题", { mode: "article-detail", activeFile: file, selectedPath: null }, file, {
    onStart: () => { started = true; },
    onContent: (message) => { streamed = message.content; },
    onReasoning: () => {}
  });

  assert.equal(started, true);
  assert.equal(streamed, "回答");
  assert.equal(controller.activeThread.messages.length, 2);
  assert.equal(controller.activeThread.messages[1].status, "done");
  assert.equal(controller.getUsage().totalTokens, 12);
  assert.equal(renders, 2, "chat should notify once when starting and once when finishing");

  controller.deleteTurn(controller.activeThread, controller.activeThread.messages[0].id);
  assert.equal(controller.activeThread.messages.length, 0);
}

{
  const file = { path: "Articles/Summary.md", basename: "Summary", stat: { mtime: 1 } };
  const stateChanges = [];
  let saved = null;
  const app = { vault: { read: async () => "文章正文" } };
  const plugin = {
    settings: { defaultArticleCategory: "知识积累" },
    ai: {
      summarizeStream: async (_path, _title, _content, onDelta) => {
        onDelta({ content: "核心观点\n- 内容", reasoning: "" });
        return {
          filePath: file.path,
          title: file.basename,
          briefDescription: "描述",
          summary: "核心观点\n- 内容",
          readingValue: 4,
          recommendedAction: "deep_learn",
          category: "知识积累",
          reason: "理由",
          tags: []
        };
      }
    },
    summaryNotes: {
      applySummary: async (_file, text, _meta, path) => {
        assert.equal(path, file.path);
        saved = text;
      },
      loadSummaryText: async () => null
    }
  };
  const controller = new SummaryController(app, plugin, (path) => stateChanges.push(path));
  let delta = "";
  await controller.ensureSummary(file, true, {
    onDelta: (visible) => { delta = visible; }
  });

  assert.equal(delta, "核心观点\n- 内容");
  assert.deepEqual(saved, { summary: "核心观点\n- 内容", reason: "理由" });
  assert.deepEqual(controller.getSummaryText(file), { summary: "核心观点\n- 内容", reason: "理由" });
  assert.equal(controller.isPending(file.path), false);
  assert.deepEqual(stateChanges, [file.path, file.path]);
}

{
  const file = { path: "Articles/Article.md", basename: "Article", extension: "md" };
  const source = { title: "发布说明", url: "https://example.com/release" };
  const review = {
    path: file.path, sourcesFound: 1, checkedOn: "2026-11-23", truncated: false, risks: [],
    corrections: [
      { before: "版本 1", after: "版本 2", quote: "已更新至版本 2", source },
      { before: "上限 10", after: "上限 20", quote: "上限提升至 20", source }
    ]
  };
  const model = { runtime: "disabled", apiBaseUrl: "", apiKey: "", model: "" };
  const writes = [];
  const app = { vault: { getAbstractFileByPath: (path) => path === file.path ? file : null } };
  const plugin = {
    settings: {
      summaryModel: model, knowledgeMapModel: model, pipelineModel: model, chatModel: model,
      quizModel: model, embeddingModel: model, confirmBeforeWrite: true
    },
    freshness: {
      check: async (target, model) => {
        assert.equal(target, file);
        assert.equal(model, plugin.settings.chatModel);
        return review;
      },
      apply: async (target, snapshot, selected) => {
        assert.equal(target, file);
        assert.equal(snapshot, review);
        writes.push([...selected]);
      }
    }
  };
  const controller = new ChatController(app, plugin, () => {});
  const ask = async (question) => {
    await controller.submit(question, { mode: "article-detail", activeFile: file, selectedPath: null }, file, {
      onStart() {}, onContent() {}, onReasoning() {}
    });
    return controller.activeThread.messages.at(-1);
  };
  const checked = await ask("检查当前文章是否过时");
  assert.equal(checked.kind, "article-freshness");
  assert.match(checked.content, /第 2 条/);
  assert.deepEqual(writes, []);
  await ask("应用第 3 条");
  assert.deepEqual(writes, []);
  await ask("应用第 2 条");
  assert.deepEqual(writes, [[1]]);
  await ask("检查并更新这篇文章");
  assert.deepEqual(writes, [[1]], "confirmation setting should leave edits pending");
  await ask("应用第 1、2 条");
  assert.deepEqual(writes, [[1], [0, 1]]);
  controller.activeThread = null;
  assert.match((await ask("应用全部")).content, /本对话没有可应用/);
  assert.deepEqual(writes, [[1], [0, 1]], "a new thread cannot apply an earlier review");
}

await rm(tempDir, { recursive: true, force: true });
console.log("ui controller tests passed");
