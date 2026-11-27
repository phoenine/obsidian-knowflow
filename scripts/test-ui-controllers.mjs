import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const tempDir = await mkdtemp(join(tmpdir(), "knowflow-ui-controllers-"));
await esbuild.build({
  bundle: true,
  entryPoints: {
    "chat-controller": "src/ui/controllers/chat-controller.ts",
    "summary-controller": "src/ui/controllers/summary-controller.ts",
    "sidebar-view": "src/ui/sidebar-view.ts",
    "chat-note-service": "src/services/chat/chat-note-service.ts"
  },
  format: "esm",
  outdir: tempDir,
  platform: "node",
  plugins: [{
    name: "stub-obsidian",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub-obsidian" }));
      build.onLoad({ filter: /.*/, namespace: "stub-obsidian" }, () => ({
        contents: [
          "export class Notice { constructor(message) { globalThis.knowflowNotices?.push(message); } }",
          "export class TFile {}",
          "export class ItemView { constructor(leaf) { this.app = leaf.app; } }",
          "export class MarkdownView {}",
          "export const MarkdownRenderer = {};",
          "export const normalizePath = (path) => path;",
          "export const parseYaml = () => ({});",
          "export const setIcon = () => {};",
          "export const requestUrl = () => { throw new Error('Unexpected network request'); };"
        ].join("\n"),
        loader: "js"
      }));
    }
  }]
});

const { ChatController } = await import(pathToFileURL(join(tempDir, "chat-controller.js")).href);
const { SummaryController } = await import(pathToFileURL(join(tempDir, "summary-controller.js")).href);
const { KnowFlowSidebarView } = await import(pathToFileURL(join(tempDir, "sidebar-view.js")).href);
const { ChatNoteService } = await import(pathToFileURL(join(tempDir, "chat-note-service.js")).href);

function chatElement(tag = "div", props = {}, elements = []) {
  const listeners = new Map();
  const element = {
    tag, props, style: {}, ownerDocument: {}, disabled: false,
    createDiv: (options) => chatElement("div", options, elements),
    createSpan: (options) => chatElement("span", options, elements),
    createEl: (name, options) => chatElement(name, options, elements),
    querySelector: () => null, empty() {}, addClass() {}, setAttribute() {}, animate() {},
    addEventListener(event, callback) {
      listeners.set(event, [...(listeners.get(event) ?? []), callback]);
    },
    emit(event) {
      if (!this.disabled) for (const callback of listeners.get(event) ?? []) callback();
    }
  };
  elements.push(element);
  return element;
}

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
    settings: {},
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
    path: file.path, original: "", checkedOn: "2026-11-23", verdict: "局部内容需要更新",
    coreConclusion: "核心结论仍有参考价值。", incomplete: [], held: [], unverified: [],
    updates: [
      { status: "已经失效", action: "修正", section: "一", before: "版本 1", after: "版本 2", reason: "版本已更新。", source: { ...source, date: "", quote: "已更新至版本 2" } },
      { status: "已经失效", action: "修正", section: "一", before: "上限 10", after: "上限 20", reason: "上限已提高。", source: { ...source, date: "", quote: "上限提升至 20" } }
    ]
  };
  const model = { runtime: "disabled", apiBaseUrl: "", apiKey: "", model: "" };
  const writes = [];
  const app = { vault: { getAbstractFileByPath: (path) => path === file.path ? file : null } };
  const plugin = {
    settings: {
      summaryModel: model, taskModel: model, chatModel: model,
      embeddingModel: model
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
  assert.match(checked.content, /\*\*2\*\* · \*\*修正\*\* · \*已经失效\*/);
  assert.match(checked.content, /\n\n---\n\n/);
  assert.match(checked.content, /\*\*原文\*\*\n> /);
  assert.match(checked.content, /要不要按这些建议更新原文/);
  assert.deepEqual(writes, []);
  assert.deepEqual(controller.replyChoices(controller.activeThread, checked).map((choice) => choice.reply), ["更新", "不用"], "freshness offers only update and decline");
  const missing = await ask("应用第 3 条");
  assert.deepEqual(controller.replyChoices(controller.activeThread, checked), [], "buttons hide once the user has replied");
  assert.deepEqual(controller.replyChoices(controller.activeThread, missing).map((choice) => choice.reply), ["更新", "不用"]);
  assert.deepEqual(writes, []);
  assert.match((await ask("更新")).content, /请先勾选/);
  assert.deepEqual(writes, [], "an invalid number cannot authorize all updates");
  assert.match((await ask("apply: 1 · replace · outdated")).content, /不符/);
  assert.match((await ask("update")).content, /请先勾选/);
  assert.deepEqual(writes, [], "an unrecognized label cannot authorize all updates");
  const picked = await ask("应用：2 · 修正 · 已经失效");
  assert.match(picked.content, /将只写入第 2 项/);
  assert.deepEqual(controller.replyChoices(controller.activeThread, picked).map((choice) => choice.reply), ["更新", "不用"]);
  assert.deepEqual(writes, []);
  const view = new KnowFlowSidebarView({ app }, { ...plugin, router: { getContext: () => ({ mode: "article-detail", activeFile: file }) } });
  view.chatController = controller;
  let confirmation;
  view.submitChat = (question) => { confirmation = ask(question); };
  const elements = [];
  view.renderChatChoices(chatElement("div", {}, elements), controller.activeThread, picked, file);
  const [selectAll, ...boxes] = elements.filter((element) => element.tag === "input");
  const buttons = elements.filter((element) => element.tag === "button");
  assert.deepEqual(buttons.map(({ props }) => props.text), ["更新", "不用"]);
  assert.deepEqual(boxes.map(({ checked }) => checked), [false, true]);
  assert.equal(selectAll.indeterminate, true);
  selectAll.checked = true;
  selectAll.emit("change");
  assert.deepEqual(boxes.map(({ checked }) => checked), [true, true]);
  selectAll.checked = false;
  selectAll.emit("change");
  assert.deepEqual(boxes.map(({ checked }) => checked), [false, false]);
  assert.equal(buttons[0].disabled, true);
  buttons[0].emit("click");
  assert.equal(confirmation, undefined);
  boxes[1].checked = true;
  boxes[1].emit("change");
  assert.equal(buttons[0].disabled, false);
  buttons[0].emit("click");
  await confirmation;
  assert.deepEqual(writes, [[1]]);
  await ask("检查并更新这篇文章");
  assert.deepEqual(writes, [[1]], "check-and-update waits for confirmation");
  await ask("应用第 1、2 条");
  assert.deepEqual(writes, [[1]]);
  await ask("更新");
  assert.deepEqual(writes, [[1], [0, 1]]);
  controller.activeThread = null;
  assert.match((await ask("应用全部")).content, /本对话没有可应用/);
  assert.deepEqual(writes, [[1], [0, 1]], "a new thread cannot apply an earlier review");
  controller.activeThread = null;
  await ask("检查当前文章是否过时");
  const declined = await ask("不用");
  assert.match(declined.content, /原文保持不变/);
  assert.deepEqual(controller.replyChoices(controller.activeThread, declined), []);

  assert.deepEqual(writes, [[1], [0, 1]]);
  await ask("检查当前文章是否过时");
  const accepted = await ask("更新");
  assert.match(accepted.content, /已更新 2 项，写在对应章节里/);
  assert.doesNotMatch(accepted.content, /原文/);
  assert.deepEqual(writes.at(-1), [0, 1]);
  controller.activeThread = null;
  app.vault.read = async () => "正文";
  await ask("检查当前文章是否过时");
  plugin.ai = { answerStream: async () => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0, estimated: false }) };
  const casual = await ask("好");
  assert.notEqual(casual.kind, "article-freshness");
  assert.equal(writes.length, 3);
  const late = await ask("更新");
  assert.notEqual(late.kind, "article-freshness");
  assert.equal(writes.length, 3, "a later 更新 must not apply a review that ordinary chat already left behind");
  controller.activeThread = null;
  plugin.freshness.check = async () => ({
    ...review,
    updates: [],
    unverified: [{ section: "一", text: "版本 1", reason: "证据不足。" }]
  });
  const insufficient = await ask("检查当前文章是否过时");
  assert.match(insufficient.content, /证据不足，原文先不改/);
  assert.doesNotMatch(insufficient.content, /没有需要更新的内容/);
}

{
  const oldWindow = globalThis.window;
  globalThis.window = { requestAnimationFrame: () => 1, moment: () => ({ format: () => "20261127_100000" }) };
  try {
    const notes = new Map();
    const app = { vault: {
      adapter: { exists: async (path) => notes.has(path) },
      createFolder: async () => {}, create: async (path, body) => notes.set(path, body),
      getMarkdownFiles: () => [...notes.keys()].map((path) => ({ path })),
      cachedRead: async ({ path }) => notes.get(path)
    } };
    const chatNotes = new ChatNoteService(app, "Chat history");
    const context = { mode: "article-detail", activeFile: { path: "Articles/B.md" } };
    const view = new KnowFlowSidebarView({ app }, { chatNotes, router: { getContext: () => context } });
    const elements = [];
    view.containerEl = { children: [null, chatElement("div", {}, elements)] };
    view.renderArticleDetail = () => {};
    view.renderChatThread = () => {};
    view.finishAutoComposer = () => {};
    view.render();
    const time = "2026-11-27T00:00:00Z";
    view.chatController.activeThread = {
      id: "thread", filePath: context.activeFile.path, contextLabel: "B", sourceMode: "article-detail",
      createdAt: time, updatedAt: time, messages: [{ role: "user", content: "问题", createdAt: time }]
    };
    await view.chatController.saveActiveThread();
    context.activeFile = { path: "Articles/A.md" };
    view.render();
    assert.equal(view.chatController.activeThread, null);
    await view.openChatHistory();
    const saved = elements.find(({ props }) => props.cls === "kf-chat-history-item");
    saved.emit("click");
    assert.equal(view.chatController.activeThread.filePath, "Articles/B.md", "saved chats open from other articles");
    view.render();
    assert.equal(view.chatController.activeThread.filePath, "Articles/B.md", "ordinary rerenders keep the opened chat");
    context.activeFile = { path: "Articles/C.md" };
    view.render();
    assert.equal(view.chatController.activeThread, null, "navigating to another article still leaves the chat");
  } finally {
    globalThis.window = oldWindow;
  }
}

{
  const file = { path: "Articles/Article.md", basename: "Article", extension: "md" };
  const source = { title: "发布说明", url: "https://example.com/release", date: "", quote: "已更新至版本 2" };
  const review = {
    path: file.path, original: "版本 1\n\n上限 10\n", checkedOn: "2026-11-23", verdict: "局部内容需要更新",
    coreConclusion: "", incomplete: [], held: [], unverified: [],
    updates: [
      { status: "已经失效", action: "修正", section: "一", before: "版本 1", after: "版本 2", reason: "版本已更新。", source },
      { status: "已经失效", action: "修正", section: "一", before: "上限 10", after: "上限 20", reason: "上限已提高。", source: { ...source, quote: "上限提升至 20" } }
    ]
  };
  const writes = [];
  let answered = false;
  const model = { runtime: "disabled", apiBaseUrl: "", apiKey: "", model: "" };
  const app = { vault: {
    getAbstractFileByPath: (path) => path === file.path ? file : null,
    read: async () => review.original
  } };
  const plugin = {
    settings: { summaryModel: model, taskModel: model, chatModel: model, embeddingModel: model },
    ai: {
      isFreshnessRequest: async () => false,
      answerStream: async () => {
        answered = true;
        return { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimated: false };
      }
    },
    freshness: {
      check: async () => review,
      apply: async (_target, _review, selected) => {
        writes.push([...selected]);
        return { written: selected.size, skipped: [] };
      }
    }
  };
  const controller = new ChatController(app, plugin, () => {});
  const ask = async (question, replay = false) => {
    await controller.submit(question, { mode: "article-detail", activeFile: file, selectedPath: null }, file, {
      onStart() {}, onContent() {}, onReasoning() {}, replay
    });
    return controller.activeThread.messages.at(-1);
  };
  await ask("检查当前文章是否过时");
  await ask("应用第 1 个");
  const first = await ask("更新");
  assert.equal(answered, false);
  assert.deepEqual(writes, [[0]]);
  assert.match(first.content, /还有 1 项没写入/);
  assert.match(first.content, /上限 10/);
  assert.deepEqual(controller.replyChoices(controller.activeThread, first).map((choice) => choice.reply), ["更新", "不用"]);
  const second = await ask("更新");
  assert.deepEqual(writes[1], [0]);
  assert.match(second.content, /已更新 1 项/);
  assert.doesNotMatch(second.content, /还有 1 项没写入/);
  assert.equal(answered, false);
  await ask("检查当前文章是否过时");
  const ordinary = await ask("最新的是哪一个？");
  assert.equal(answered, true);
  assert.deepEqual(controller.replyChoices(controller.activeThread, ordinary), []);
  const stale = await ask("应用第 1 个");
  assert.match(stale.content, /本对话没有可应用/);
  await ask("检查当前文章是否过时");
  await ask("换个角度解释", true);
  assert.match((await ask("应用第 1 个")).content, /本对话没有可应用/);
  assert.deepEqual(writes, [[0], [0]]);
}

{
  // Code-format preview: buttons, targeted writes, and "应用全部" reaching the right handler.
  const file = { path: "Articles/Code.md", basename: "Code", extension: "md" };
  const fixture = (blocks) => [
    "# 标题", "", "### 2.4.  exp", "",
    ...blocks.flatMap((lines) => ["```python", ...lines, "```", ""]),
    "## 3.  其他", "", "```python", "keep = 1", "```", ""
  ].join("\n");
  let body = fixture([["import os", "print(1)"]]);
  const calls = [];
  const app = {
    vault: {
      getAbstractFileByPath: (path) => path === file.path ? file : null,
      read: async () => body,
      process: async (target, update) => {
        assert.equal(target, file);
        body = update(body);
      }
    }
  };
  const plugin = {
    settings: {},
    ai: {
      confirmFormatting: async (batch, _instructions, scope) => {
        calls.push({ ids: batch.map((candidate) => candidate.id), scope });
        // Only a comment request may add comments; a pure format returns the code unchanged.
        return batch.map((candidate) => ({ id: candidate.id, action: "reformat-code", language: "python", content: scope === "code-chat-comments" ? `# 说明\n${candidate.content}` : candidate.content }));
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

  // An explicit format-and-comment request writes the targeted block immediately.
  const single = await ask("格式化下2.4. exp下面的代码块，增加一些注释");
  assert.deepEqual(calls.at(-1).ids, ["fence-1"]);
  assert.equal(calls.at(-1).scope, "code-chat-comments");
  assert.match(single.content, /已写入 1 个代码块/);
  assert.deepEqual(controller.replyChoices(controller.activeThread, single), []);
  assert.match(body, /```python\n# 说明\nimport os\nprint\(1\)\n```/);
  assert.match(body, /```python\nkeep = 1\n```/, "blocks outside the named section are untouched");

  // Two blocks in one section: buttons stay 更新 / 不用, and typing "应用第 2 个" writes only the second one.
  body = fixture([["a = 1"], ["b = 2"]]);
  controller.activeThread = null;
  const two = await ask("先预览，格式化 2.4. exp 章节的代码块");
  assert.deepEqual(
    controller.replyChoices(controller.activeThread, two).map((choice) => choice.reply),
    ["更新", "不用"]
  );
  await ask("应用第 2 个");
  assert.match(body, /```python\na = 1\n```/, "first block is not written");
  assert.match(body, /```python\nb = 2\n```/);

  // "应用全部" must reach the code-format handler, not the freshness one that answers "没有可应用的审核".
  body = fixture([["c = 3"], ["d = 4"]]);
  controller.activeThread = null;
  await ask("格式化 2.4. exp 章节的代码块，先给我看看");
  const applied = await ask("应用全部");
  assert.doesNotMatch(applied.content, /没有可应用/);
  assert.match(body, /```python\nc = 3\n```/);
  assert.match(body, /```python\nd = 4\n```/);
  assert.deepEqual(controller.replyChoices(controller.activeThread, applied), [], "buttons close after a reply");

  // Structural failure: an empty reformat is not offered, and the note stays as it was.
  body = fixture([["e = 5"]]);
  controller.activeThread = null;
  plugin.ai.confirmFormatting = async (batch) => batch.map((candidate) => ({ id: candidate.id, action: "reformat-code", language: "python", content: "" }));
  const empty = await ask("格式化 2.4. exp 章节的代码块");
  assert.match(empty.content, /未通过校验/);
  assert.match(body, /```python\ne = 5\n```/);

  // Pure formatting may not change the code: a candidate that does is not offered, and the note stays.
  body = fixture([["f = 6"]]);
  controller.activeThread = null;
  plugin.ai.confirmFormatting = async (batch) => batch.map((candidate) => ({ id: candidate.id, action: "reformat-code", language: "python", content: candidate.content.replace("f = 6", "f = 7") }));
  const changed = await ask("格式化 2.4. exp 章节的代码块");
  assert.match(changed.content, /未通过校验/, "pure formatting that changes code is not offered");
  assert.match(body, /```python\nf = 6\n```/);

  // Pure formatting keeps the fence's own language even when the model proposes another one.
  body = fixture([["g = 7"]]);
  controller.activeThread = null;
  plugin.ai.confirmFormatting = async (batch) => batch.map((candidate) => ({ id: candidate.id, action: "reformat-code", language: "text", content: candidate.content }));
  await ask("格式化 2.4. exp 章节的代码块");
  assert.match(body, /```python\ng = 7\n```/, "the fence language is kept by pure formatting");

  // A comment request may not change code either.
  body = fixture([["h = 8"]]);
  controller.activeThread = null;
  plugin.ai.confirmFormatting = async (batch) => batch.map((candidate) => ({ id: candidate.id, action: "reformat-code", language: "python", content: "# 说明\nh = 9" }));
  const commentChanged = await ask("格式化下2.4. exp下面的代码块，增加一些注释");
  assert.doesNotMatch(commentChanged.content, /要写回这个代码块吗/, "a comment request that changes code is not offered");
  assert.match(body, /```python\nh = 8\n```/);
}

{
  // The same restore result as clipping: a perl object becomes javascript, a typo is not "fixed",
  // a failed batch leaves its block, and a note edited after the preview is not overwritten.
  const file = { path: "Articles/Ts.md", basename: "Ts", extension: "md" };
  const eslint = `"rules": {    "prettier/prettier": "error"  },  "overrides": [    {      // Tolerate warnings on legacy JavaScript files      "files": ["*.js"]    }  ]`;
  const eslintRestored = [
    `"rules": {`,
    `  "prettier/prettier": "error"`,
    `},`,
    `"overrides": [`,
    `  {`,
    `    // Tolerate warnings on legacy JavaScript files`,
    `    "files": ["*.js"]`,
    `  }`,
    `]`
  ].join("\n");
  const typed = "import { makeFeatures } = from './domain/features';import { userCollection } from './infrastructure/mongodb/UserCollection';import { ImageStorage } from './infrastructure/ImageStorage.js';";
  const flat = "const value = {    ready: true,    name: \"demo\"  };";
  const pretty = "const value = {\n  ready: true,\n  name: \"demo\"\n};";
  const huge = `const blob = "${"a".repeat(8000)}";`;
  let body = ["# 标题", "", "```perl", eslint, "```", "", "```typescript", typed, "```", "", "```javascript", "const ok = 1;", "```", ""].join("\n");
  const app = {
    vault: {
      getAbstractFileByPath: (path) => path === file.path ? file : null,
      read: async () => body,
      process: async (target, update) => {
        assert.equal(target, file);
        body = update(body);
      }
    }
  };
  const plugin = {
    settings: {},
    ai: {
      confirmFormatting: async (batch) => batch.map((candidate) => {
        if (candidate.fenceLanguage === "perl") return { id: candidate.id, action: "reformat-code", language: "perl", content: eslintRestored };
        if (candidate.content.includes("makeFeatures")) {
          return { id: candidate.id, action: "reformat-code", language: "typescript", content: candidate.content.replaceAll("';import", "';\nimport") };
        }
        return { id: candidate.id, action: "keep" };
      })
    }
  };
  const controller = new ChatController(app, plugin, () => {});
  const ask = async (question) => {
    await controller.submit(question, { mode: "article-detail", activeFile: file, selectedPath: null }, file, {
      onStart() {}, onContent() {}, onReasoning() {}
    });
    return controller.activeThread.messages.at(-1);
  };
  const preview = await ask("先预览，格式化文章里的代码");
  assert.match(preview.content, /```javascript\n"rules":/);
  assert.match(preview.content, /```typescript\nimport \{ makeFeatures \} = from/);
  assert.doesNotMatch(preview.content, /const ok = 1/, "an unchanged ordinary block is not offered");
  await ask("更新");
  assert.match(body, /```javascript\n"rules": \{\n {2}"prettier\/prettier": "error"/);
  assert.doesNotMatch(body, /```perl/);
  assert.match(body, /= from '\.\/domain\/features'/);
  assert.match(body, /```javascript\nconst ok = 1;/);

  body = ["# 标题", "", "```perl", "SELECT id FROM events;", "```", ""].join("\n");
  controller.activeThread = null;
  plugin.ai.confirmFormatting = async (batch) => batch.map((candidate) => ({
    id: candidate.id, action: "reformat-code", language: "sql", content: candidate.content
  }));
  const labelWrite = await ask("格式化文章里的代码");
  assert.match(labelWrite.content, /已写入 1 个代码块/);
  assert.match(body, /```sql\nSELECT id FROM events;/);

  const scriptLine = '"scripts": {    "lint": "eslint .",    "lint:types": "tsc --noEmit --skipLibCheck"  },';
  body = ["# 标题", "", "```javascript", scriptLine, "```", "", "图注。"].join("\n");
  controller.activeThread = null;
  let modelCalls = 0;
  plugin.ai.confirmFormatting = async () => { modelCalls += 1; return []; };
  const localWrite = await ask("格式化文章里的代码");
  assert.match(localWrite.content, /已写入 1 个代码块/);
  assert.equal(modelCalls, 0);
  assert.match(body, /"scripts": \{\n {2}"lint": "eslint \.",\n {2}"lint:types": "tsc --noEmit --skipLibCheck"\n\},\n```\n\n图注。/);

  body = ["# 标题", "", "```javascript", huge, "```", "", "```javascript", flat, "```", ""].join("\n");
  controller.activeThread = null;
  plugin.ai.confirmFormatting = async (batch) => {
    if (batch.some((candidate) => candidate.content.includes("blob"))) throw new Error("batch failed");
    return batch.map((candidate) => ({ id: candidate.id, action: "reformat-code", language: "javascript", content: pretty }));
  };
  const partial = await ask("格式化文章里的代码");
  assert.match(partial.content, /已写入 1 个代码块/);
  assert.match(partial.content, /1 个代码块的检查没有完成/);
  assert.doesNotMatch(partial.content, /blob/);
  assert.match(body, /const blob = "/, "the failed batch keeps its original block");
  assert.match(body, /ready: true/);

  body = ["# 标题", "", "```javascript", flat, "```", ""].join("\n");
  controller.activeThread = null;
  plugin.ai.confirmFormatting = async (batch) => batch.map((candidate) => ({ id: candidate.id, action: "reformat-code", language: "javascript", content: pretty }));
  await ask("格式化文章里的代码，先给我看看");
  body = `${body}\n旁边写了一句。\n`;
  const stale = await ask("更新");
  assert.match(stale.content, /写入前被修改/);
  assert.match(body, /旁边写了一句/);
  assert.match(body, /const value = \{ {4}ready: true/, "the old preview is not written over the edited note");

  body = ["# 标题", "", "```javascript", flat, "```", ""].join("\n");
  controller.activeThread = null;
  plugin.ai.confirmFormatting = async () => { throw new Error("batch failed"); };
  const failed = await ask("格式化文章里的代码");
  assert.match(failed.content, /没有完成/);
  assert.match(body, /const value = \{ {4}ready: true/);
}

{
  const notices = [];
  globalThis.knowflowNotices = notices;
  const saved = [];
  let rejectWrite;
  const view = new KnowFlowSidebarView({ app: {} }, {
    quizNotes: {
      recordAnswer: async (_path, _index, key) => {
        saved.push(key);
        if (saved.length === 1) await new Promise((_, reject) => { rejectWrite = reject; });
      }
    }
  });
  const session = {
    filePath: "Articles/Queue.md",
    quizPath: "Archives/Queue_Quiz.md",
    questions: [{ answerKey: "B" }],
    index: 0,
    selectedKey: "B",
    submitted: false
  };
  const renders = [];
  view.quizSession = session;
  view.render = () => renders.push({ pending: view.submittingQuizSessions.has(session), submitted: session.submitted });
  const first = view.submitQuizAnswer(session);
  await view.submitQuizAnswer(session);
  assert.deepEqual(saved, ["B"], "a pending submission cannot write the same answer twice");
  rejectWrite(new Error("Vault is read-only"));
  await first;
  assert.equal(session.selectedKey, "B");
  assert.equal(session.submitted, false);
  assert.match(notices.at(-1), /答案保存失败：Vault is read-only/);
  await view.submitQuizAnswer(session);
  assert.deepEqual(saved, ["B", "B"]);
  assert.deepEqual(renders, [
    { pending: true, submitted: false },
    { pending: false, submitted: false },
    { pending: true, submitted: false },
    { pending: false, submitted: true }
  ]);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async () => { throw new Error("Clipboard access denied"); } }
  });
  try {
    await view.copyChatText("回答");
    assert.match(notices.at(-1), /复制失败：Clipboard access denied/);
  } finally {
    delete navigator.clipboard;
  }
  delete globalThis.knowflowNotices;
}

{
  const context = { mode: "task-overview", selectedPath: "Articles", activeFile: null };
  const retries = [];
  const rendered = [];
  const fakeElement = (options) => {
    if (options?.text) rendered.push(options.text);
    return {
      style: {},
      setAttribute() {},
      createDiv: fakeElement,
      createSpan: fakeElement,
      createEl: (_tag, props) => ({
        ...fakeElement(props),
        addEventListener: (_event, handler) => { if (props?.text === "重试") retries.push(handler); }
      })
    };
  };
  let taskCalls = 0;
  let reviewCalls = 0;
  let plan = null;
  let review = null;
  const view = new KnowFlowSidebarView({ app: {} }, {
    settings: { articlesFolder: "Articles", dailyNewArticleLimit: 4, dailyReviewQuestionCap: 10 },
    router: { getContext: () => context },
    store: {
      getDailyTaskPlan: () => plan,
      getDailyReviewSession: () => null,
      saveDailyTaskPlan: async (next) => {
        taskCalls += 1;
        if (taskCalls === 1) throw new Error("任务写入失败");
        plan = next;
      }
    },
    dailyReview: {
      getSession: () => review,
      ensureSession: async () => {
        reviewCalls += 1;
        if (reviewCalls === 1) throw new Error("题库读取失败");
        review = { questions: [], answers: {} };
      }
    }
  });
  view.getArticleFiles = () => [];
  view.getDailyTaskCandidates = () => [];
  view.summarizeArticles = () => ({
    stats: { scopePath: "Articles", total: 0, learned: 0, unread: 0 },
    categoryStats: [],
    weekly: { dailyLearned: [], dailyReview: [], reviewCount: 0, reviewAccuracy: null }
  });
  view.render = () => view.renderTaskOverview(fakeElement(), context);
  view.render();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([taskCalls, reviewCalls], [1, 1], "rendering load errors must not trigger another load");
  assert.ok(rendered.some((text) => text.includes("任务写入失败")));
  assert.ok(rendered.some((text) => text.includes("题库读取失败")));
  assert.ok(retries.length >= 2, "both errors should offer an explicit retry");
  for (const retry of retries.slice(-2)) retry();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([taskCalls, reviewCalls], [2, 2]);
  assert.equal(view.dailyTaskPlanErrors.size + view.dailyReviewErrors.size, 0);
}

{
  // Explicit edits write immediately. Requested previews and suggestions require confirmation.
  const file = { path: "Articles/Edit.md", basename: "Edit", extension: "md" };
  let body = "开头保持不变。\n\n用队列连接生产者和消费者。\n\n结尾保持不变。\n";
  const app = {
    vault: {
      getAbstractFileByPath: (path) => path === file.path ? file : null,
      read: async () => body,
      process: async (target, update) => {
        assert.equal(target, file);
        body = update(body);
      }
    }
  };
  const plugin = {
    ai: {
      proposeArticleEdits: async (instruction, article) => {
        assert.match(instruction, /改成/);
        assert.match(article, /用队列连接生产者和消费者/);
        return { edits: [{ before: "用队列连接生产者和消费者。", after: "用队列解耦生产者和消费者。" }], truncated: false };
      },
      answerStream: async (_label, _content, _history, handlers) => {
        handlers.onContent("这是解释");
        return { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimated: false };
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

  const preview = await ask("先预览，把「用队列连接生产者和消费者。」改成更短的说法");
  assert.equal(preview.kind, "article-edit");
  assert.match(preview.content, /用队列连接生产者和消费者/);
  assert.match(preview.content, /要把这次修改写回文章吗/);
  assert.match(body, /用队列连接生产者和消费者/);
  assert.deepEqual(controller.replyChoices(controller.activeThread, preview).map((choice) => choice.reply), ["更新", "不用"]);
  const written = await ask("更新");
  assert.match(written.content, /已写入 1 处修改/);
  assert.match(body, /用队列解耦生产者和消费者/);
  assert.doesNotMatch(body, /用队列连接生产者和消费者/);

  // Intent comes from the model, not from a list of phrasings.
  const answerWith = (text) => {
    plugin.ai.answerStream = async (_label, _content, _history, handlers) => {
      handlers.onContent(text);
      return { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimated: false };
    };
  };
  const insertion = { op: "insert", anchor: "用队列解耦生产者和消费者。", at: "after", text: "在 AD 审计中的位置\n\n域控是 LDAP。" };
  plugin.ai.classifyArticleEdit = async (question) =>
    ({ "这篇内容有点少": "ask", "第二节好像少了背景": "ask" })[question] ?? "none";

  controller.activeThread = null;
  const sampleCode = "```c\nstruct vb2_queue { int type; };\n```";
  plugin.ai.proposeArticleEdits = async (instruction, _article, _onReasoning, previousReply) => {
    assert.equal(instruction, "在文章中补充一些代码块示例");
    assert.equal(previousReply, "", "a fresh thread has no earlier answer to insert");
    return { edits: [{ ...insertion, text: sampleCode }], truncated: false };
  };
  const inserted = await ask("在文章中补充一些代码块示例");
  assert.match(inserted.content, /已写入 1 处修改/);
  assert.ok(body.includes(sampleCode));
  assert.deepEqual(controller.replyChoices(controller.activeThread, inserted), []);

  const flat = "struct vb2_queue { int type; };";
  body += `\n${flat}\n`;
  controller.activeThread = null;
  answerWith(sampleCode);
  const explainedCode = await ask("这个应该是代码块吧？");
  assert.deepEqual(controller.replyChoices(controller.activeThread, explainedCode), []);
  assert.ok(body.endsWith(`\n${flat}\n`));
  plugin.ai.proposeArticleEdits = async (instruction, _article, _onReasoning, previousReply) => {
    assert.equal(instruction, "帮我更新代码块到文章中");
    assert.equal(previousReply, sampleCode);
    return { edits: [{ op: "replace", anchor: flat, text: sampleCode }], truncated: false };
  };
  body = body.replace(`${sampleCode}\n\n`, "");
  const replaced = await ask("帮我更新代码块到文章中");
  assert.match(replaced.content, /已写入 1 处修改/);
  assert.ok(body.endsWith(`${sampleCode}\n`));

  controller.activeThread = null;
  answerWith("可以补一句为什么需要队列。");
  const offer = await ask("这篇内容有点少");
  assert.notEqual(offer.kind, "article-edit");
  assert.match(offer.content, /可以补一句为什么需要队列。\n\n要把这些内容写进文章吗？$/);
  assert.deepEqual(controller.replyChoices(controller.activeThread, offer), [{ label: "更新", reply: "更新" }, { label: "不用", reply: "不用" }]);
  assert.doesNotMatch(body, /在 AD 审计中的位置/);
  plugin.ai.proposeArticleEdits = async (instruction, _article, _onReasoning, previousReply) => {
    assert.match(instruction, /上一轮回答/);
    assert.equal(previousReply, "可以补一句为什么需要队列。", "the offer question is not article text");
    return { edits: [insertion], truncated: false };
  };
  const accepted = await ask("更新");
  assert.equal(accepted.kind, "article-edit");
  assert.match(accepted.content, /已写入 1 处修改/);
  assert.match(body, /在 AD 审计中的位置/);
  assert.deepEqual(controller.replyChoices(controller.activeThread, accepted), []);

  controller.activeThread = null;
  answerWith("可以补一句为什么需要队列。");
  await ask("第二节好像少了背景");
  const declined = await ask("不用");
  assert.match(declined.content, /原文保持不变/);
  assert.deepEqual(controller.replyChoices(controller.activeThread, declined), []);

  controller.activeThread = null;
  await ask("第二节好像少了背景");
  const beforeAcknowledgment = body;
  plugin.ai.classifyArticleEdit = async () => { throw new Error("isolated acknowledgments are read-only"); };
  assert.equal((await ask("好")).status, "done");
  assert.equal((await ask("更新")).status, "done", "a stale offer cannot be confirmed");
  assert.equal(body, beforeAcknowledgment);

  plugin.ai.classifyArticleEdit = async () => "none";
  answerWith("这是解释");

  controller.activeThread = null;
  const explained = await ask("为什么要用队列？");
  assert.equal(explained.content, "这是解释");
  assert.notEqual(explained.kind, "article-edit");
  assert.deepEqual(controller.replyChoices(controller.activeThread, explained), [], "ordinary answers do not ask to edit");
  plugin.ai.classifyArticleEdit = async () => { throw new Error("explicit commands and replies skip intent detection"); };

  body = "同样的句子。\n\n同样的句子。\n";
  controller.activeThread = null;
  plugin.ai.proposeArticleEdits = async () => ({ edits: [{ before: "同样的句子。", after: "不同的句子。" }], truncated: false });
  const ambiguous = await ask("把「同样的句子。」改成别的");
  assert.match(ambiguous.content, /不止一次/);
  assert.equal(body, "同样的句子。\n\n同样的句子。\n");

  body = "甲句。\n\n乙句。\n";
  controller.activeThread = null;
  plugin.ai.proposeArticleEdits = async () => ({
    edits: [
      { before: "甲句。", after: "甲句改。" },
      { before: "乙句。", after: "乙句改。" }
    ],
    truncated: false
  });
  const many = await ask("把甲句和乙句改短，先给我看看");
  assert.deepEqual(
    controller.replyChoices(controller.activeThread, many).map((choice) => choice.reply),
    ["更新", "不用"]
  );
  const one = await ask("应用第 1 个");
  assert.match(one.content, /已写入 1 处修改/);
  assert.match(body, /甲句改。/);
  assert.match(body, /乙句。/);
  assert.doesNotMatch(body, /乙句改/);
  assert.deepEqual(controller.replyChoices(controller.activeThread, one).map((choice) => choice.reply), ["更新", "不用"]);
  const rest = await ask("更新");
  assert.match(rest.content, /已写入 1 处修改/);
  assert.match(body, /乙句改。/);
  assert.deepEqual(controller.replyChoices(controller.activeThread, rest), []);
}

await rm(tempDir, { recursive: true, force: true });
console.log("ui controller tests passed");
