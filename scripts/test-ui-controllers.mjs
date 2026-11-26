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
    "sidebar-view": "src/ui/sidebar-view.ts"
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
  assert.deepEqual(controller.replyChoices(controller.activeThread, checked).map((choice) => choice.reply), ["更新", "不用"], "buttons show while the review waits");
  await ask("应用第 3 条");
  assert.deepEqual(controller.replyChoices(controller.activeThread, checked), [], "buttons hide once the user has replied");
  assert.deepEqual(writes, []);
  await ask("应用第 2 条");
  assert.deepEqual(writes, [[1]]);
  await ask("检查并更新这篇文章");
  assert.deepEqual(writes, [[1]], "check-and-update waits for confirmation");
  await ask("应用第 1、2 条");
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
      confirmFormatting: async (batch, instructions) => {
        calls.push({ ids: batch.map((candidate) => candidate.id), instructions });
        // Only a comment request may add comments; a pure format returns the code unchanged.
        return batch.map((candidate) => ({ id: candidate.id, action: "reformat-code", language: "python", content: instructions ? `# 说明\n${candidate.content}` : candidate.content }));
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

  // One block: the comment request reaches the model, the preview offers 更新 / 不用, and 更新 writes only that block.
  const single = await ask("格式化下2.4. exp下面的代码块，增加一些注释");
  assert.deepEqual(calls.at(-1).ids, ["fence-1"]);
  assert.match(calls.at(-1).instructions, /增加注释/);
  assert.match(single.content, /要写回这个代码块吗/);
  assert.deepEqual(controller.replyChoices(controller.activeThread, single).map((choice) => choice.reply), ["更新", "不用"]);
  await ask("更新");
  assert.match(body, /```python\n# 说明\nimport os\nprint\(1\)\n```/);
  assert.match(body, /```python\nkeep = 1\n```/, "blocks outside the named section are untouched");

  // Two blocks in one section: each gets a button, and "应用第 2 个" writes only the second one.
  body = fixture([["a = 1"], ["b = 2"]]);
  controller.activeThread = null;
  const two = await ask("格式化 2.4. exp 章节的代码块");
  assert.deepEqual(
    controller.replyChoices(controller.activeThread, two).map((choice) => choice.reply),
    ["应用全部", "应用第 1 个", "应用第 2 个", "不用"]
  );
  await ask("应用第 2 个");
  assert.match(body, /```python\na = 1\n```/, "first block is not written");
  assert.match(body, /```python\nb = 2\n```/);

  // "应用全部" must reach the code-format handler, not the freshness one that answers "没有可应用的审核".
  body = fixture([["c = 3"], ["d = 4"]]);
  controller.activeThread = null;
  await ask("格式化 2.4. exp 章节的代码块");
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
  assert.match(empty.content, /格式正常/);
  assert.match(body, /```python\ne = 5\n```/);

  // Pure formatting may not change the code: a candidate that does is not offered, and the note stays.
  body = fixture([["f = 6"]]);
  controller.activeThread = null;
  plugin.ai.confirmFormatting = async (batch) => batch.map((candidate) => ({ id: candidate.id, action: "reformat-code", language: "python", content: candidate.content.replace("f = 6", "f = 7") }));
  const changed = await ask("格式化 2.4. exp 章节的代码块");
  assert.match(changed.content, /格式正常/, "pure formatting that changes code is not offered");
  assert.match(body, /```python\nf = 6\n```/);

  // Pure formatting keeps the fence's own language even when the model proposes another one.
  body = fixture([["g = 7"]]);
  controller.activeThread = null;
  plugin.ai.confirmFormatting = async (batch) => batch.map((candidate) => ({ id: candidate.id, action: "reformat-code", language: "text", content: candidate.content }));
  await ask("格式化 2.4. exp 章节的代码块");
  await ask("应用全部");
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

await rm(tempDir, { recursive: true, force: true });
console.log("ui controller tests passed");
