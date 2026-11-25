import assert from "node:assert/strict";
import * as esbuild from "esbuild";

const { outputFiles } = await esbuild.build({
  stdin: {
    contents: `
      export { TFile } from "obsidian";
      export { AiService } from "./src/services/ai/ai-service";
      export { prepareSummarySource } from "./src/services/ai/summary-source";
      export { SummaryNoteService } from "./src/services/learning/summary-note-service";
      export { SkillRunner } from "./src/services/core/skill-runner";
      export { rankRelevantNotes } from "./src/services/search/relevant-notes";
      export { SkillStore } from "./src/services/core/skill-store";
      export { NoteOperationCoordinator } from "./src/services/core/note-operation-coordinator";
      export { readLegacyRepairSkill } from "./src/services/clipping/repair-skill";
      export { prepareArticleForAi } from "./src/services/clipping/managed-content";
      export { ArticleFreshness } from "./src/services/learning/article-freshness";
      export { findPublicEvidence, resolveDeepSeekSearchKey } from "./src/services/search/public-evidence";
    `,
    resolveDir: process.cwd()
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  plugins: [{
    name: "stub-obsidian",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
      build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        contents: `
          export class TFile {
            constructor(path) {
              this.path = path;
              this.basename = path.split("/").at(-1).slice(0, -3);
              this.extension = "md";
              this.stat = { mtime: 1 };
            }
          }
          export class Notice {}
          export const normalizePath = (path) => path;
          export const parseYaml = (yaml) => {
            const [name, description] = yaml.split("\\n");
            return { name: JSON.parse(name.slice(6)), description: JSON.parse(description.slice(13)) };
          };
          export const requestUrl = (options) => globalThis.knowflowRequest(options);
        `,
        loader: "js"
      }));
    }
  }]
});
const { TFile, SkillStore, NoteOperationCoordinator, readLegacyRepairSkill, prepareArticleForAi, ArticleFreshness, SkillRunner, rankRelevantNotes, AiService, prepareSummarySource, SummaryNoteService, findPublicEvidence, resolveDeepSeekSearchKey } =
  await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`);

const files = new Map();
const contents = new Map();
let writes = 0;
const vault = {
  getMarkdownFiles: () => [...files.values()].filter((file) => file instanceof TFile),
  getAbstractFileByPath: (path) => files.get(path) ?? null,
  create: async (path, body) => {
    assert.ok(!files.has(path));
    const file = new TFile(path);
    files.set(path, file);
    contents.set(file, body);
    return file;
  },
  read: async (file) => contents.get(file),
  cachedRead: async (file) => contents.get(file),
  process: async (file, transform) => {
    assert.equal(files.get(file.path), file);
    const value = transform(contents.get(file));
    contents.set(file, value);
    file.stat.mtime += 1;
    writes += 1;
    return value;
  }
};
const skills = new SkillStore(vault);
const ops = new NoteOperationCoordinator();
const runner = new SkillRunner(skills);
assert.equal(await skills.read("article-freshness"), null);
await assert.rejects(() => skills.read("../note"), /Skill 名称/);
await vault.create("skills/article-freshness/SKILL.md", '---\nname: "article-freshness"\ndescription: "Check facts"\n---\n\n优先检查版本限制。\n');
assert.equal(await skills.read("article-freshness"), "优先检查版本限制。");
await vault.create("skills/clipping-repair.md", "允许:\r\n- 修复列表\r\n- 调整标题\r\n禁止:\r\n- 改写代码");
assert.equal(await readLegacyRepairSkill(vault), "允许：\n- 修复列表\n- 调整标题\n\n禁止：\n- 改写代码");
const clippingRunner = new SkillRunner(skills, vault);
const legacyClipping = await clippingRunner.run("clipping-update", (instructions) => instructions);
assert.match(legacyClipping, /笔记属性/);
assert.match(legacyClipping, /Obsidian Markdown/);
assert.match(legacyClipping, /渲染完整性/);
assert.match(legacyClipping, /禁止：\n- 改写代码/);
await vault.create("skills/clipping-update/SKILL.md", '---\nname: "clipping-update"\ndescription: "剪藏规则"\n---\n\n保留图注。\n');
const currentClipping = await clippingRunner.run("clipping-update", (instructions) => instructions);
assert.match(currentClipping, /笔记属性/);
assert.match(currentClipping, /保留图注。/);
assert.doesNotMatch(currentClipping, /禁止：\n- 改写代码/);

const original = [
  "---", "rating: 3", "---", "", "默认版本是 v1。", "", "默认限制为 50。", "",
  "默认上限是 10。", "", "历史文本包含 v100。", "", "~~~text", "代码专用事实", "~~~", "",
  "已经手动链接到 [[Manual]]。"
].join("\r\n");
const file = await vault.create("Articles/Source.md", original);
const source = "当前默认版本是 v2，版本升级后默认限制为 75，上限仍为 10。";
const correction = { before: "默认版本是 v1", after: "默认版本是 v2", sourceId: 1, quote: "当前默认版本是 v2" };
const toResponse = (value) => ({ status: 200, json: { choices: [{ message: { content: JSON.stringify(value) } }] } });
const model = { runtime: "ollama", apiBaseUrl: "http://localhost/v1", apiKey: "", model: "fixture" };
const requests = [];
globalThis.window = { moment: () => ({ format: () => "2026-11-23" }) };
globalThis.knowflowRequest = async ({ url, body, headers }) => {
  if (url === "https://api.deepseek.com/v1/tools/search") {
    assert.equal(headers.Authorization, "Bearer fixture");
    assert.deepEqual(JSON.parse(body), {
      query: "Source 默认版本", count: 4, need_content: true
    });
    requests.push("search");
    return { status: 200, json: { results: [{
      url: "https://example.com/versions", title: "版本说明", content: source
    }] } };
  }
  const { messages } = JSON.parse(body);
  assert.ok(messages[0].content.includes("优先检查版本限制"));
  if (messages[0].content.includes("全文分析")) {
    requests.push("analyze");
    return toResponse({
      purpose: "说明默认配置", coreConclusion: "默认配置可以沿用。", domains: ["Source"],
      claims: [
        { quote: "默认版本是 v1。", section: "导语", query: "Source 默认版本" },
        { quote: "默认限制为 50。", section: "导语", query: "Source 默认版本" },
        { quote: "并不存在的说法。", section: "导语", query: "无效" }
      ],
      discoveryQueries: []
    });
  }
  requests.push("judge");
  return toResponse({
    coreStillHolds: true,
    items: [
      { ...correction, quote: correction.before, section: "导语", status: "已经失效", action: "修正", reason: "版本已经升级。", evidenceQuote: correction.quote },
      { quote: "默认限制为 50。", before: "默认限制为 50。", after: "默认限制为 75。", section: "导语", status: "已经失效", action: "修正", reason: "限制已经提高。", sourceId: 1, evidenceQuote: "版本升级后默认限制为 75" },
      { quote: "默认上限是 10。", before: "默认上限是 10。", after: "默认上限是 12。", section: "导语", status: "已经失效", action: "修正", reason: "证据没有支持新上限。", sourceId: 1, evidenceQuote: "版本升级后默认限制为 75" },
      { quote: "代码专用事实", before: "代码专用事实", after: "无关", section: "导语", status: "原文有误", action: "修正", reason: "代码不改。", sourceId: 1, evidenceQuote: "当前默认版本是 v2" },
      { quote: "v10", before: "v10", after: "v19", section: "导语", status: "原文有误", action: "修正", reason: "不是独立说法。", sourceId: 3, evidenceQuote: "当前默认版本是 v2" }
    ]
  });
};
const freshness = new ArticleFreshness(vault, runner, ops);
await assert.rejects(() => freshness.check(file, model, ""), /DeepSeek Search/);
const review = await freshness.check(file, model, "fixture");
assert.deepEqual(requests, ["analyze", "search", "judge"]);
assert.deepEqual(review.updates.map((item) => item.after), ["默认版本是 v2", "默认限制为 75。"]);
assert.equal(review.verdict, "局部内容需要更新");
assert.equal(writes, 0, "checking must leave the note untouched");
contents.set(file, original + "\r\n人工补充");
await assert.rejects(() => freshness.apply(file, review, new Set([0])), /重新检查/);
assert.match(contents.get(file), /人工补充$/);
contents.set(file, original);
await freshness.apply(file, review, new Set([0]));
assert.ok(contents.get(file).startsWith("---\r\nrating: 3\r\n---\r\n"));
assert.ok(contents.get(file).endsWith("已经手动链接到 [[Manual]]。"));
assert.match(contents.get(file), /默认版本是 v2。\r\n\r\n> \[!note\] KnowFlow 知识更新 · 2026-11-23/);
assert.doesNotMatch(contents.get(file), /---\r\n\r\n> \[!note\]/);
assert.match(contents.get(file), /<https:\/\/example.com\/versions>/);
assert.match(prepareArticleForAi(contents.get(file)), /默认版本是 v2/);
assert.match(contents.get(file), /默认限制为 50/);
assert.doesNotMatch(prepareArticleForAi(contents.get(file)), /KnowFlow 时效更新|默认版本是 v1/);

const retired = await vault.create("Articles/Retired Tool.md", "Retired Tool 提供远程公开服务。此文介绍如何连接这项服务。");
const withdrawal = "Retired Tool 的远程公开服务已永久停止，旧版和新版客户端均不能连接。";
const searchSettings = {
  summaryModel: model,
  pipelineModel: { ...model, runtime: "openai-compatible", apiBaseUrl: "https://api.deepseek.com/v1/", apiKey: "official-key" },
  chatModel: model, quizModel: model, knowledgePointsModel: model, embeddingModel: model
};
const searchKey = resolveDeepSeekSearchKey(searchSettings);
assert.equal(searchKey, "official-key");
assert.equal(resolveDeepSeekSearchKey({
  ...searchSettings, pipelineModel: { ...searchSettings.pipelineModel, apiBaseUrl: "https://api.deepseek.com.example.org" }
}), "", "proxy credentials must not be forwarded to official DeepSeek");
assert.equal(resolveDeepSeekSearchKey(searchSettings, {
  getSecret: (name) => name === "knowflow-deepseek-search" ? "dedicated-search-key" : null
}), "dedicated-search-key");
const deepSeekCalls = [];
globalThis.knowflowRequest = async ({ url, body, headers, method }) => {
  if (url.startsWith("https://api.deepseek.com/")) {
    assert.equal(headers.Authorization, "Bearer official-key");
    assert.equal(method, "POST");
    deepSeekCalls.push(new URL(url).pathname);
    if (url.endsWith("/search")) {
      assert.deepEqual(JSON.parse(body), {
        query: "Retired Tool 远程服务状态", count: 4, need_content: true
      });
      return { status: 200, json: { results: [{
        url: "https://example.com/sunset", title: "停止服务公告", date: "2026-11-20T12:00:00Z",
        summary: "搜索引擎生成的概括不能作为逐字证据。", content: ""
      }] } };
    }
    assert.equal(url, "https://api.deepseek.com/v1/tools/fetch");
    assert.deepEqual(JSON.parse(body), { url: "https://example.com/sunset" });
    return { status: 200, json: { title: "更新公告", content: withdrawal } };
  }
  const { messages } = JSON.parse(body);
  if (messages[0].content.includes("全文分析")) {
    return toResponse({
      purpose: "介绍如何连接服务", coreConclusion: "这项服务可以远程使用。", domains: ["Retired Tool"],
      claims: [{ quote: "Retired Tool 提供远程公开服务。", section: "导语", query: "Retired Tool 远程服务状态" }],
      discoveryQueries: []
    });
  }
  const payload = JSON.parse(messages[1].content);
  assert.deepEqual(payload.sources[0].excerpts, [withdrawal]);
  return toResponse({
    coreStillHolds: false,
    items: [{
      quote: "Retired Tool 提供远程公开服务。", before: "Retired Tool 提供远程公开服务。", after: "",
      section: "导语", status: "已经失效", action: "删除", reason: "教程依赖已永久停止的服务。",
      sourceId: 1, evidenceQuote: withdrawal
    }]
  });
};
const previousWrites = writes;
const outdated = await freshness.check(retired, model, searchKey);
assert.equal(outdated.updates[0]?.source.url, "https://example.com/sunset");
assert.equal(outdated.updates[0]?.source.date, "2026-11-20");
assert.equal(outdated.verdict, "核心结论需要重新审视");
assert.deepEqual(deepSeekCalls, ["/v1/tools/search", "/v1/tools/fetch"]);
assert.equal(writes, previousWrites, "obsolete-article advice never deletes or modifies the note");
await freshness.apply(retired, outdated, new Set([0]));
const retiredText = contents.get(retired);
assert.match(retiredText, /此文介绍如何连接这项服务。/);
assert.doesNotMatch(retiredText, /提供远程公开服务。此文/);
assert.match(retiredText, /KnowFlow 知识更新/);
assert.match(retiredText, /\*\*已删除\*\*/);

globalThis.knowflowRequest = async ({ url }) => {
  assert.equal(url, "https://api.deepseek.com/v1/tools/search", "Search page content needs no Fetch request");
  return { status: 200, json: { results: [
    { url: "https://example.com/doc", title: "原始资料", content: "原始证据内容。", snippet: "搜索摘要。" },
    { url: "https://example.com/empty", title: "空摘要", content: "", snippet: "无原文。" }
  ] } };
};
assert.deepEqual((await findPublicEvidence(["Example release notes"], searchKey)).map(({ excerpts }) => excerpts), [["原始证据内容。"]]);

const esp = await vault.create("Articles/ESP32 Agent.md", "");
const titleMatch = await vault.create("Articles/ESP32 入门.md", "");
const semanticMatch = await vault.create("Articles/把 Muse 装进 ESP-Mosaico.md", "");
const weak = await vault.create("Articles/Agent Engineering.md", "");
const sameTag = await vault.create("Articles/GitHub Skills.md", "");
const app = {
  vault,
  metadataCache: {
    getFileCache: (target) => ({
      frontmatter: { tags: target === esp || target === sameTag ? ["runtime"] : [] }
    })
  }
};
const noteSearchSettings = { articlesFolder: "Articles", semanticIndexExcludeFolders: [] };
assert.deepEqual(rankRelevantNotes(app, esp, [], noteSearchSettings, 5).map(({ path }) => path), [titleMatch.path],
  "without an index, topic terms qualify while broad title words and shared tags do not");
const semanticHits = [
  { path: semanticMatch.path, similarity: 0.86 },
  { path: titleMatch.path, similarity: 0.81 },
  { path: titleMatch.path, similarity: 0.8 },
  { path: weak.path, similarity: 0.65 },
  { path: sameTag.path, similarity: 0.53 }
];
assert.deepEqual(rankRelevantNotes(app, esp, semanticHits, noteSearchSettings, 5).map(({ path }) => path),
  [titleMatch.path, semanticMatch.path], "weak matches do not pad the list and each path appears once");
assert.deepEqual(rankRelevantNotes(app, esp, [semanticHits[4]], noteSearchSettings, 5).map(({ path }) => path),
  [titleMatch.path], "the best semantic hit still has to clear the minimum");
const mixedSource = await vault.create("Articles/DeepSeek V4 Runtime.md", "");
const matchingVersion = await vault.create("Articles/Deploy DeepSeek V4.md", "");
const differentVersion = await vault.create("Articles/Archive DeepSeek V3.md", "");
assert.deepEqual(rankRelevantNotes(app, mixedSource, [], noteSearchSettings, 5).map(({ path }) => path),
  [matchingVersion.path, differentVersion.path], "matching the topic and version ranks before matching the topic alone");

const ai = new AiService({ summaryModel: model }, runner);
await vault.create("skills/article-summary/SKILL.md", '---\nname: "article-summary"\ndescription: "摘要规则"\n---\n\n为摘要突出部署前置条件。\n');
const scenarios = Array.from({ length: 10 }, (_, index) =>
  [`## 场景 ${index + 1}`, "结论与测试条件。".repeat(150), `![${"图像说明".repeat(60)}](assets/figure-${index}.png)`].join("\n\n")
).join("\n\n");
const sampled = prepareSummarySource(scenarios);
assert.equal(sampled.sampled, true);
assert.deepEqual(sampled.sections.map(({ title }) => title),
  Array.from({ length: 10 }, (_, index) => `场景 ${index + 1}`));
assert.ok(sampled.sections.every(({ content }) => !content.includes("assets/figure")));
const longParagraph = "安装时记录每个组件的兼容性与版本。\n\n";
const veryLong = "开头条件。\n\n" + longParagraph.repeat(1100) + "中间条件。\n\n" + longParagraph.repeat(1100) + "结尾条件。";
const longSample = prepareSummarySource(veryLong);
assert.equal(longSample.sampled, true);
assert.match(longSample.sections[0].content, /开头条件。[\s\S]*中间条件。[\s\S]*结尾条件。/);

const summaryRequests = [];
let omitLastSection = false;
let emptySummaryResponses = 0;
globalThis.knowflowRequest = async ({ body }) => {
  const { messages } = JSON.parse(body);
  assert.ok(messages[0].content.includes("为摘要突出部署前置条件"));
  assert.ok(messages[0].content.includes("严格 JSON"));
  assert.ok(messages[0].content.includes("## 核心观点\n- 第一个要点。\n- 第二个要点。"));
  const input = JSON.parse(messages[1].content);
  assert.ok(!Object.hasOwn(input.requiredJsonShape, "recommendedAction"));
  summaryRequests.push(input);
  const chapters = input.sections.map((_, index) => `${index + 1}. 说明场景 ${index + 1} 的条件与限制。`);
  if (emptySummaryResponses > 0) {
    emptySummaryResponses -= 1;
    return toResponse({});
  }
  return toResponse({
    readingValue: 3, category: "知识积累",
    summary: ["## 核心观点\n- 默认版本已经更新\n- 总量限制保持不变",
      ["## 章节梳理", ...(omitLastSection ? chapters.slice(0, -1) : chapters)].join("\n")].join("\n\n"),
    briefDescription: "介绍版本变化和兼容条件。", tags: ["runtime"],
    reason: "包含版本选择依据。"
  });
};
const summary = await ai.summarize(file.path, file.basename, contents.get(file));
assert.equal(summary.briefDescription, undefined);
assert.equal(summaryRequests[0].requiredJsonShape.reason, "推荐理由");
assert.equal(summaryRequests[0].requiredJsonShape.readingValue, undefined);
assert.match(summary.summary, /^## 核心观点\n- 默认版本已经更新/m);
assert.match(summary.summary, /^## 章节梳理\n1\. 说明场景 1 的条件与限制。/m);
assert.equal(summaryRequests[0].inputKind, "完整的清理后正文");
summaryRequests.length = 0;
await ai.summarize(file.path, file.basename, veryLong);
assert.equal(summaryRequests.length, 1);
assert.equal(summaryRequests[0].inputKind, "按章抽样的原文");
assert.ok(summaryRequests[0].sections[0].content.includes("中间条件。"));
omitLastSection = true;
summaryRequests.length = 0;
const partialSummary = await ai.summarize(file.path, file.basename, scenarios);
assert.match(partialSummary.summary, /^9\. 说明场景 9 的条件与限制。/m);
assert.doesNotMatch(partialSummary.summary, /场景 10/);
assert.equal(summaryRequests.length, 1, "usable text is kept immediately despite an omitted chapter");

omitLastSection = false;
summaryRequests.length = 0;
emptySummaryResponses = 1;
const retriedSummary = await ai.summarize(file.path, file.basename, scenarios);
assert.match(retriedSummary.summary, /^10\. 说明场景 10 的条件与限制。/m);
assert.equal(summaryRequests.length, 2, "an empty summary retries once with the same prepared input");
assert.deepEqual(summaryRequests[0], summaryRequests[1]);

const fetchBeforeSummary = globalThis.fetch;
Object.assign(globalThis.window, { setTimeout, clearTimeout });
const chunks = ['{"sum', 'mary":"核心观点\\', 'n\\n- 一条\\', '"观点\\"。","briefDescription":"属性内容"}'];
globalThis.fetch = async (_url, { body }) => {
  assert.equal(JSON.parse(body).stream, true);
  const events = chunks.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
  return new Response(events.join("") + "data: [DONE]\n\n");
};
const previews = [];
try {
  const streamed = await ai.summarizeStream(file.path, file.basename, scenarios, ({ content }) => {
    previews.push(content);
  });
  assert.deepEqual(previews, ["核心观点", "核心观点\n\n- 一条", '核心观点\n\n- 一条"观点"。']);
  assert.equal(streamed.summary, previews.at(-1));
  assert.equal(streamed.briefDescription, undefined);
} finally {
  globalThis.fetch = fetchBeforeSummary;
}

const writer = new SummaryNoteService({ vault }, ops);
contents.set(file, contents.get(file) + "\n用户在摘要生成期间添加的正文。");
const beforeSummaryWrite = writes;
await writer.applySummary(file, summary, undefined, file.path);
assert.equal(writes, beforeSummaryWrite + 1);
assert.equal((await writer.loadSummaryText(file)).summary, summary.summary);
assert.ok(contents.get(file).endsWith("用户在摘要生成期间添加的正文。"));
console.log("article maintenance tests passed");
