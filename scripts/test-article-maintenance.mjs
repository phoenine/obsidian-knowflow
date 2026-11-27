import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as esbuild from "esbuild";

const { outputFiles } = await esbuild.build({
  stdin: {
    contents: `
      export { TFile } from "obsidian";
      export { AiService } from "./src/services/ai/ai-service";
      export { AiTransport, InvalidAiJsonError } from "./src/services/ai/ai-transport";
      export { prepareSummarySource } from "./src/services/ai/summary-source";
      export { SummaryNoteService } from "./src/services/learning/summary-note-service";
      export { SkillRunner } from "./src/services/core/skill-runner";
      export { rankRelevantNotes } from "./src/services/search/relevant-notes";
      export { SkillStore } from "./src/services/core/skill-store";
      export { NoteOperationCoordinator } from "./src/services/core/note-operation-coordinator";
      export { readLegacyRepairSkill } from "./src/services/clipping/repair-skill";
      export { prepareArticleForAi } from "./src/services/clipping/managed-content";
      export { ArticleFreshness } from "./src/services/learning/article-freshness";
      export { renderFreshnessReview } from "./src/services/chat/freshness-chat";
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
const { TFile, SkillStore, NoteOperationCoordinator, readLegacyRepairSkill, prepareArticleForAi, ArticleFreshness, renderFreshnessReview, SkillRunner, rankRelevantNotes, AiService, AiTransport, InvalidAiJsonError, prepareSummarySource, SummaryNoteService, findPublicEvidence, resolveDeepSeekSearchKey } =
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
  if (messages[0].content.includes("依据自身知识")) {
    requests.push("knowledge");
    const payload = JSON.parse(messages[1].content);
    return toResponse({
      coreStillHolds: true,
      items: payload.claims.map((claim) => ({ quote: claim.quote, needsVerification: true }))
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
const offline = await freshness.check(file, model, "");
assert.deepEqual(requests, ["analyze", "knowledge"]);
assert.equal(offline.updates.length, 0);
assert.ok(offline.followUp.length >= 1);
requests.length = 0;
const review = await freshness.check(file, model, "fixture");
assert.deepEqual(requests, ["analyze", "knowledge", "search", "judge"]);
assert.deepEqual(review.updates.map((item) => item.after), ["默认版本是 v2", "默认限制为 75。"]);
assert.equal(review.verdict, "局部内容需要更新");
assert.equal(writes, 0, "checking must leave the note untouched");
const twoSentenceUpdate = { ...review.updates[0], after: "默认版本是 v2。 现有配置可以沿用。" };
assert.ok(renderFreshnessReview("Source", { ...review, updates: [twoSentenceUpdate] })
  .includes("**默认版本是 v2。**现有配置可以沿用。"));
contents.set(file, original + "\r\n人工补充");
await freshness.apply(file, review, new Set([0]));
assert.match(contents.get(file), /默认版本是 v2/);
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

{
  const paragraph = "使用方案甲。可选方案乙。同段结尾保留。\r\n\r\n下一段。";
  const target = await vault.create("Articles/Same paragraph.md", paragraph);
  const [sourceUpdate] = review.updates;
  const first = { ...sourceUpdate, before: "使用方案甲", after: "使用方案丙" };
  const second = { ...sourceUpdate, before: "可选方案乙", after: "可选方案丁。" };
  const grouped = { ...review, path: target.path, original: paragraph, updates: [first, second] };
  await freshness.apply(target, grouped, new Set([0, 1]));
  assert.match(contents.get(target), /^使用方案丙。可选方案丁。同段结尾保留。\r\n\r\n/);
  assert.match(contents.get(target), /\r\n\r\n下一段。$/);
  assert.equal([...contents.get(target).matchAll(/KnowFlow 知识更新/g)].length, 2);
  contents.set(target, paragraph);
  const conflicting = { ...grouped, updates: [first, { ...second, before: "方案甲。可选方案乙" }] };
  const skipped = await freshness.apply(target, conflicting, new Set([0, 1]));
  assert.equal(skipped.written, 0);
  assert.equal(skipped.skipped.length, 2);
  assert.equal(contents.get(target), paragraph);
}
assert.doesNotMatch(prepareArticleForAi(contents.get(file)), /KnowFlow 时效更新|默认版本是 v1/);

const retired = await vault.create("Articles/Retired Tool.md", "Retired Tool 提供远程公开服务。此文介绍如何连接这项服务。");
const withdrawal = "Retired Tool 的远程公开服务已永久停止，旧版和新版客户端均不能连接。";
const searchSettings = {
  summaryModel: model,
  taskModel: { ...model, runtime: "openai-compatible", apiBaseUrl: "https://api.deepseek.com/v1/", apiKey: "official-key" },
  chatModel: model, embeddingModel: model
};
const searchKey = resolveDeepSeekSearchKey(searchSettings);
assert.equal(searchKey, "official-key");
assert.equal(resolveDeepSeekSearchKey({
  ...searchSettings, taskModel: { ...searchSettings.taskModel, apiBaseUrl: "https://api.deepseek.com.example.org" }
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
      purpose: "介绍如何连接服务", coreConclusion: "这项服务可以远程使用。", coreClaimQuote: "Retired Tool 提供远程公开服务。", domains: ["Retired Tool"],
      claims: [{ quote: "Retired Tool 提供远程公开服务。", section: "导语", query: "Retired Tool 远程服务状态" }],
      discoveryQueries: []
    });
  }
  if (messages[0].content.includes("依据自身知识")) {
    const payload = JSON.parse(messages[1].content);
    return toResponse({
      coreStillHolds: true,
      items: payload.claims.map((claim) => ({ quote: claim.quote, needsVerification: true }))
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

// A source for a secondary claim does not make the core conclusion invalid: the judge's flag needs an accepted
// update that says the content is outdated or wrong.
{
  const partial = await vault.create("Articles/Partial Sources.md", "默认版本是 v1，这是核心结论。\n\n次要说明：补充工具 X 支持 Y。");
  globalThis.knowflowRequest = async ({ url, body }) => {
    if (url.endsWith("/search")) {
      const { query } = JSON.parse(body);
      if (!query.includes("补充")) return { status: 200, json: { results: [] } };
      return { status: 200, json: { results: [{ url: "https://example.com/extra", title: "补充说明", date: "2026-11-01T00:00:00Z", content: "补充工具 X 已不再支持 Y。" }] } };
    }
    const { messages } = JSON.parse(body);
    if (messages[0].content.includes("全文分析")) {
      return toResponse({
        purpose: "说明默认版本", coreConclusion: "默认版本是 v1。", coreClaimQuote: "默认版本是 v1", domains: ["版本"],
        claims: [
          { quote: "默认版本是 v1", section: "导语", query: "默认版本 v1 现状" },
          { quote: "补充工具 X 支持 Y", section: "导语", query: "补充工具 X 支持 Y" }
        ],
        discoveryQueries: []
      });
    }
    if (messages[0].content.includes("依据自身知识")) {
      const payload = JSON.parse(messages[1].content);
      return toResponse({
        coreStillHolds: true,
        items: payload.claims.map((claim) => ({ quote: claim.quote, needsVerification: true }))
      });
    }
    const { sources } = JSON.parse(messages[1].content);
    return toResponse({ coreStillHolds: false, items: [
      null,
      { quote: "补充工具 X 支持 Y", after: "补充工具 X 已不再支持 Y", section: "导语",
        status: "已经失效", action: "修正", reason: "新版本已撤回支持。", sourceId: sources[0].id,
        evidenceQuote: "补充工具 X 已不再支持 Y。" }
    ] });
  };
  const partialReview = await freshness.check(partial, model, searchKey);
  assert.equal(partialReview.verdict, "局部内容需要更新");
  assert.equal(partialReview.updates.length, 1);
}

// An empty search result is not evidence. Without sources the model must not judge the core conclusion.
{
  const unsearched = await vault.create("Articles/No Results.md", "默认版本是 v1，这是文章的核心结论。\n\n另一段说明文字。");
  const judgeRequests = [];
  globalThis.knowflowRequest = async ({ url, body }) => {
    if (url.endsWith("/search")) return { status: 200, json: { results: [] } };
    const { messages } = JSON.parse(body);
    if (messages[0].content.includes("全文分析")) {
      return toResponse({
        purpose: "说明默认版本", coreConclusion: "默认版本是 v1。", domains: ["版本"],
        claims: [{ quote: "默认版本是 v1", section: "导语", query: "默认版本 v1 现状" }],
        discoveryQueries: []
      });
    }
    if (messages[0].content.includes("依据自身知识")) {
      const payload = JSON.parse(messages[1].content);
      return toResponse({
        coreStillHolds: true,
        items: payload.claims.map((claim) => ({ quote: claim.quote, needsVerification: true }))
      });
    }
    judgeRequests.push(messages);
    return toResponse({ coreStillHolds: false, items: [] });
  };
  const empty = await freshness.check(unsearched, model, searchKey);
  assert.equal(judgeRequests.length, 0, "no sources means the judge is never asked about the core conclusion");
  assert.notEqual(empty.verdict, "核心结论需要重新审视");
  assert.equal(empty.verdict, "暂时无法判断");
  assert.deepEqual(empty.unverified.map((item) => item.reason), ["没有检索到可核对的公开资料。"]);
  assert.equal(empty.updates.length, 0);
  const emptyReport = renderFreshnessReview(unsearched.basename, empty);
  assert.match(emptyReport, /证据不足，原文先不改/);
  assert.match(emptyReport, /默认版本是 v1/);
}

{
  const batched = await vault.create("Articles/Batch Budget.md", "重复开头。\n说法甲。\n\n重复开头。\n说法乙。\n");
  const quote = "当前默认版本是 v2。";
  const big = quote + String.fromCharCode(92).repeat(2400);
  const judgeBodies = [];
  globalThis.knowflowRequest = async ({ url, body }) => {
    if (url.endsWith("/search")) {
      const { query } = JSON.parse(body);
      return { status: 200, json: { results: [1, 2, 3, 4].map((index) => ({
        url: `https://example.com/${encodeURIComponent(query)}-${index}`,
        title: query,
        content: big
      })) } };
    }
    const { messages } = JSON.parse(body);
    if (messages[0].content.includes("全文分析")) {
      return toResponse({
        purpose: "测试分批", coreConclusion: "说明默认配置。", coreClaimQuote: "", domains: ["测试"],
        claims: [
          { quote: "说法甲。", section: "甲", query: "查询甲" },
          { quote: "说法乙。", section: "乙", query: "查询乙" }
        ],
        discoveryQueries: ["发现一", "发现二"]
      });
    }
    if (messages[0].content.includes("依据自身知识")) {
      const payload = JSON.parse(messages[1].content);
      return toResponse({
        coreStillHolds: true,
        items: payload.claims.map((claim) => ({ quote: claim.quote, needsVerification: true }))
      });
    }
    const payload = JSON.parse(messages[1].content);
    judgeBodies.push(messages[1].content);
    if (payload.claims.some((claim) => claim.quote === "说法甲。")) {
      return toResponse({
        coreStillHolds: true,
        items: [{
          quote: "说法甲。", before: "说法甲。", after: "说法甲已改为 v2。", section: "甲",
          status: "已经失效", action: "修正", reason: "版本已经升级。",
          sourceId: payload.sources[0].id, evidenceQuote: quote
        }]
      });
    }
    if (payload.claims.some((claim) => claim.quote === "说法乙。")) {
      return { status: 200, json: { choices: [{ message: { content: "本批没有返回 JSON" } }] } };
    }
    const discovery = payload.discovery.find((entry) => entry.query === "发现一");
    if (discovery) {
      assert.deepEqual(payload.claims, [], "a discovery request must work without any claims in its batch");
      assert.equal(payload.coreClaimQuote, "");
      assert.ok(discovery.anchors.includes("说法乙。"));
      return toResponse({ items: [
        { before: "说法甲", after: "越出补充锚点范围。", status: "缺少重要知识", action: "补充",
          reason: "新版本增加了配置。", sourceId: discovery.sourceIds[0], evidenceQuote: quote },
        { before: "说法乙。", after: "可以补充新版本的默认配置。", status: "缺少重要知识", action: "补充",
          reason: "新版本增加了配置。", sourceId: discovery.sourceIds[0], evidenceQuote: quote }
      ] });
    }
    return toResponse({ coreStillHolds: true, items: [] });
  };
  const budgetReview = await freshness.check(batched, model, "fixture");
  assert.ok(judgeBodies.length >= 2, "oversized judgment input is split");
  for (const body of judgeBodies) {
    assert.ok(body.length <= 12000, "every serialized judgment payload fits, including oversized single tasks");
    const payload = JSON.parse(body);
    const ids = new Set(payload.sources.map((source) => source.id));
    assert.equal(ids.size, payload.sources.length);
    for (const entry of [...payload.claims, ...payload.discovery]) {
      assert.equal("sources" in entry, false);
      assert.equal(entry.sourceIds.length, 4, "compacting an oversized request keeps each source");
      assert.ok(entry.sourceIds.every((id) => ids.has(id)));
    }
  }
  assert.deepEqual(budgetReview.updates.map(({ action, before }) => [action, before]), [["修正", "说法甲。"], ["补充", "说法乙。"]]);
  assert.ok(budgetReview.unverified.some((item) => item.text === "说法乙。" && item.reason.includes("尚未完成")));
  assert.match(renderFreshnessReview(batched.basename, budgetReview), /部分内容尚未判断完/);
}

{
  const noAnchor = await vault.create("Articles/No Discovery Anchor.md", "相同的原文。\n\n相同的原文。\n");
  globalThis.knowflowRequest = async ({ url, body }) => {
    if (url.endsWith("/search")) {
      return { status: 200, json: { results: [{
        url: "https://example.com/discovery-without-anchor", content: "这是补充检索返回的证据。"
      }] } };
    }
    const { messages } = JSON.parse(body);
    assert.match(messages[0].content, /全文分析/, "discovery without an anchor must not reach the judge");
    return toResponse({ claims: [], discoveryQueries: ["发现遗漏"] });
  };
  const review = await freshness.check(noAnchor, model, "fixture");
  assert.equal(review.updates.length, 0);
  assert.match(renderFreshnessReview(noAnchor.basename, review), /没有判断完/);
}

{
  const invalid = await vault.create("Articles/Invalid Judge.md", "默认版本是 v1。");
  globalThis.knowflowRequest = async ({ url, body }) => {
    if (url.endsWith("/search")) {
      return { status: 200, json: { results: [{
        url: "https://example.com/invalid-judge", title: "版本说明", content: "当前默认版本是 v2。"
      }] } };
    }
    const { messages } = JSON.parse(body);
    if (messages[0].content.includes("全文分析")) {
      return toResponse({
        purpose: "说明默认版本", coreConclusion: "默认版本是 v1。", coreClaimQuote: "默认版本是 v1。", domains: ["版本"],
        claims: [{ quote: "默认版本是 v1。", section: "导语", query: "默认版本现状" }],
        discoveryQueries: []
      });
    }
    if (messages[0].content.includes("依据自身知识")) {
      const payload = JSON.parse(messages[1].content);
      return toResponse({
        coreStillHolds: true,
        items: payload.claims.map((claim) => ({ quote: claim.quote, needsVerification: true }))
      });
    }
    return toResponse({ coreStillHolds: true });
  };
  const invalidReview = await freshness.check(invalid, model, "fixture");
  assert.equal(invalidReview.updates.length, 0);
  assert.equal(invalidReview.verdict, "暂时无法判断");
  assert.ok(invalidReview.unverified.some((item) => item.reason.includes("尚未完成")));
  assert.match(renderFreshnessReview("Invalid Judge", invalidReview), /没有判断完/);
  assert.doesNotMatch(renderFreshnessReview("Invalid Judge", invalidReview), /没有需要更新的内容/);
}

{
  const article = await vault.create("Articles/Model Knowledge.md", "默认版本是 v1。\n\n接口仍是旧地址。\n");
  const calls = [];
  globalThis.knowflowRequest = async ({ url, body }) => {
    if (String(url).includes("api.deepseek.com")) {
      calls.push(JSON.parse(body).query);
      return { status: 200, json: { results: [{
        url: "https://example.com/api", title: "接口说明", content: "当前接口已经改为新地址。"
      }] } };
    }
    const { messages } = JSON.parse(body);
    if (messages[0].content.includes("全文分析")) {
      return toResponse({
        purpose: "说明版本和接口", coreConclusion: "默认版本是 v1。", coreClaimQuote: "默认版本是 v1。",
        claims: [
          { quote: "默认版本是 v1。", section: "导语", query: "默认版本现状" },
          { quote: "接口仍是旧地址。", section: "导语", query: "接口地址现状" }
        ],
        discoveryQueries: []
      });
    }
    if (messages[0].content.includes("依据自身知识")) {
      return toResponse({
        coreStillHolds: false,
        items: [
          {
            quote: "默认版本是 v1。", before: "默认版本是 v1。", after: "默认版本是 v2。",
            section: "导语", status: "已经失效", action: "修正", reason: "模型记得默认版本已经升级。"
          },
          { quote: "接口仍是旧地址。", needsVerification: true }
        ]
      });
    }
    const payload = JSON.parse(messages[1].content);
    assert.deepEqual(payload.claims.map((claim) => claim.quote), ["接口仍是旧地址。"]);
    return toResponse({
      coreStillHolds: true,
      items: [{
        quote: "接口仍是旧地址。", before: "接口仍是旧地址。", after: "接口已经改为新地址。",
        section: "导语", status: "已经失效", action: "修正", reason: "公告已经更换接口。",
        sourceId: payload.sources[0].id, evidenceQuote: "当前接口已经改为新地址。"
      }]
    });
  };
  const offline = await freshness.check(article, model, "");
  assert.deepEqual(calls, []);
  assert.equal(offline.updates.length, 1);
  assert.equal(offline.updates[0].after, "默认版本是 v2。");
  assert.equal(offline.updates[0].source.url, "");
  assert.equal(offline.verdict, "核心结论需要重新审视");
  assert.deepEqual(offline.followUp.map((item) => item.text), ["接口仍是旧地址。"]);
  const offlineReport = renderFreshnessReview(article.basename, offline);
  assert.match(offlineReport, /模型自身知识/);
  assert.match(offlineReport, /接口仍是旧地址/);
  assert.match(offlineReport, /要不要按这些建议更新原文/);
  await freshness.apply(article, offline, new Set([0]));
  assert.match(contents.get(article), /默认版本是 v2/);
  assert.match(contents.get(article), /模型自身知识/);
  assert.doesNotMatch(contents.get(article), /https?:/);
  contents.set(article, "默认版本是 v1。\n\n接口仍是旧地址。\n");
  const online = await freshness.check(article, model, "fixture");
  assert.deepEqual(calls, ["接口地址现状"]);
  assert.deepEqual(online.updates.map((item) => [item.before, item.source.url]), [
    ["默认版本是 v1。", ""],
    ["接口仍是旧地址。", "https://example.com/api"]
  ]);
  assert.equal(online.followUp.length, 0);
}

{
  const checked = "默认版本是 v1。";
  const unchecked = "原文还讨论了另一条规则。";
  const article = await vault.create("Articles/Knowledge Scope.md", `${checked}\n\n${unchecked}`);
  globalThis.knowflowRequest = async ({ body }) => {
    const { messages } = JSON.parse(body);
    if (messages[0].content.includes("全文分析")) {
      return toResponse({ claims: [{ quote: checked, query: "默认版本" }] });
    }
    assert.deepEqual(JSON.parse(messages[1].content).claims.map(({ quote }) => quote), [checked]);
    return toResponse({ items: [
      { quote: unchecked, status: "仍然成立" },
      { quote: unchecked, status: "原文有误", after: "另一条规则已经废除。", reason: "规则有变。" },
      { quote: checked, before: unchecked, status: "缺少重要知识", after: "额外说明。", reason: "新增内容。" },
      { quote: checked, status: "原文有误", after: "默认版本是 v2。", reason: "已升级。" }
    ] });
  };
  const review = await freshness.check(article, model, "");
  assert.deepEqual(review.held, []);
  assert.deepEqual(review.updates.map(({ before }) => before), [checked]);
  await freshness.apply(article, review, new Set(review.updates.map((_, index) => index)));
  assert.ok(contents.get(article).includes(`\n\n${unchecked}`));
  assert.match(contents.get(article), /默认版本是 v2。/);
  assert.doesNotMatch(contents.get(article), /另一条规则已经废除|额外说明/);
}

{
  const checked = "默认开启快速模式。";
  const otherClaim = "后台任务会自动重试。";
  const unchecked = "兼容模式仅在旧环境使用。";
  const article = await vault.create("Articles/Public Evidence Scope.md", [checked, otherClaim, unchecked].join("\n\n"));
  const modeEvidence = "新版本默认关闭快速模式。";
  globalThis.knowflowRequest = async ({ url, body }) => {
    const payload = JSON.parse(body);
    if (url.endsWith("/search")) {
      const mode = payload.query === "快速模式";
      return { status: 200, json: { results: [{
        url: mode ? "https://example.com/mode" : "https://example.com/retry", title: payload.query,
        content: mode ? modeEvidence : "后台任务仍会自动重试。"
      }] } };
    }
    const { messages } = payload;
    if (messages[0].content.includes("全文分析")) {
      return toResponse({ claims: [{ quote: checked, query: "快速模式" }, { quote: otherClaim, query: "后台任务" }] });
    }
    const { claims } = JSON.parse(messages[1].content);
    if (messages[0].content.includes("依据自身知识")) {
      return toResponse({ items: claims.map(({ quote }) => ({ quote, needsVerification: true })) });
    }
    assert.deepEqual(claims.map(({ quote }) => quote), [checked, otherClaim]);
    const evidence = { status: "原文有误", reason: "默认配置已变更。", sourceId: claims[0].sourceIds[0], evidenceQuote: modeEvidence };
    return toResponse({ items: [
      { ...evidence, quote: unchecked, after: "兼容模式总是启用。" },
      { ...evidence, quote: otherClaim, after: "后台任务不会重试。" },
      { ...evidence, quote: checked, after: "默认关闭快速模式。" }
    ] });
  };
  const review = await freshness.check(article, model, "fixture");
  assert.deepEqual(review.updates.map(({ before }) => before), [checked]);
  assert.ok(review.unverified.some(({ text }) => text === otherClaim));
  await freshness.apply(article, review, new Set(review.updates.map((_, index) => index)));
  assert.match(contents.get(article), /默认关闭快速模式。/);
  assert.ok(contents.get(article).endsWith(`${otherClaim}\n\n${unchecked}`));
}

{
  const quotes = Array.from({ length: 36 }, (_, index) => `配置 ${index} ${"例".repeat(420)}。`);
  const article = await vault.create("Articles/Knowledge Batch Budget.md", quotes.join("\n\n"));
  const checked = [];
  let batches = 0;
  globalThis.knowflowRequest = async ({ body }) => {
    const { messages } = JSON.parse(body);
    if (messages[0].content.includes("全文分析")) {
      return toResponse({
        coreConclusion: "配置说明。", coreClaimQuote: "未匹配".repeat(4400),
        claims: quotes.map((quote) => ({ quote, query: "配置说明" }))
      });
    }
    const content = messages[1].content;
    assert.ok(content.length <= 12_000, "model-knowledge batches honor the serialized character budget");
    const payload = JSON.parse(content);
    assert.equal(payload.coreClaimQuote, "");
    batches += 1;
    checked.push(...payload.claims.map(({ quote }) => quote));
    return toResponse({ items: payload.claims.map(({ quote }) => ({ quote, status: "仍然成立" })) });
  };
  const review = await freshness.check(article, model, "");
  assert.ok(batches > 1);
  assert.deepEqual(checked, quotes);
  assert.deepEqual(review.held.map(({ text }) => text), quotes);
  assert.deepEqual(review.followUp, []);
}

{
  const article = await vault.create("Articles/Search Failure.md", "默认版本是 v1。\n\n接口仍是旧地址。\n");
  globalThis.knowflowRequest = async ({ url, body }) => {
    if (String(url).includes("api.deepseek.com")) throw new Error("search down");
    const { messages } = JSON.parse(body);
    if (messages[0].content.includes("全文分析")) {
      return toResponse({
        purpose: "说明版本和接口", coreConclusion: "默认版本是 v1。", coreClaimQuote: "默认版本是 v1。",
        claims: [
          { quote: "默认版本是 v1。", section: "导语", query: "默认版本现状" },
          { quote: "接口仍是旧地址。", section: "导语", query: "接口地址现状" }
        ],
        discoveryQueries: ["发现遗漏"]
      });
    }
    if (messages[0].content.includes("依据自身知识")) {
      return toResponse({
        coreStillHolds: false,
        items: [
          {
            quote: "默认版本是 v1。", before: "默认版本是 v1。", after: "默认版本是 v2。",
            section: "导语", status: "已经失效", action: "修正", reason: "模型记得默认版本已经升级。"
          },
          { quote: "接口仍是旧地址。", needsVerification: true }
        ]
      });
    }
    throw new Error("evidence judge must not run when search fails");
  };
  const failedSearch = await freshness.check(article, model, "fixture");
  assert.equal(failedSearch.updates.length, 1);
  assert.equal(failedSearch.updates[0].after, "默认版本是 v2。");
  assert.ok(failedSearch.unverified.some((item) => item.text === "接口仍是旧地址。" && item.reason === "公开检索失败。"));
  assert.ok(failedSearch.unverified.some((item) => item.text === "补充检索" && item.reason === "公开检索失败。"));
  const failedReport = renderFreshnessReview(article.basename, failedSearch);
  assert.match(failedReport, /默认版本是 v2/);
  assert.match(failedReport, /接口仍是旧地址/);
  assert.match(failedReport, /要不要按这些建议更新原文/);
}

{
  const article = await vault.create("Articles/Knowledge Gap.md", "接口仍是旧地址。\n");
  const calls = [];
  globalThis.knowflowRequest = async ({ url, body }) => {
    if (String(url).includes("api.deepseek.com")) {
      calls.push(JSON.parse(body).query);
      return { status: 200, json: { results: [{
        url: "https://example.com/api", title: "接口说明", content: "当前接口已经改为新地址。"
      }] } };
    }
    const { messages } = JSON.parse(body);
    if (messages[0].content.includes("全文分析")) {
      return toResponse({
        purpose: "说明接口", coreConclusion: "接口仍是旧地址。",
        claims: [{ quote: "接口仍是旧地址。", section: "导语", query: "接口地址现状" }],
        discoveryQueries: []
      });
    }
    if (messages[0].content.includes("依据自身知识")) {
      return { status: 200, json: { choices: [{ message: { content: "不是 JSON" } }] } };
    }
    const payload = JSON.parse(messages[1].content);
    return toResponse({
      items: [{
        quote: "接口仍是旧地址。", before: "接口仍是旧地址。", after: "接口已经改为新地址。",
        section: "导语", status: "已经失效", action: "修正", reason: "公告已经更换接口。",
        sourceId: payload.sources[0].id, evidenceQuote: "当前接口已经改为新地址。"
      }]
    });
  };
  const recovered = await freshness.check(article, model, "fixture");
  assert.deepEqual(calls, ["接口地址现状"]);
  assert.equal(recovered.updates[0]?.source.url, "https://example.com/api");
  assert.equal(recovered.unverified.length, 0);
}

{
  const article = await vault.create("Articles/Offline Gap.md", "接口仍是旧地址。\n");
  let searched = false;
  globalThis.knowflowRequest = async ({ url, body }) => {
    if (String(url).includes("api.deepseek.com")) searched = true;
    const { messages } = JSON.parse(body);
    if (messages[0].content.includes("全文分析")) {
      return toResponse({
        claims: [{ quote: "接口仍是旧地址。", section: "导语", query: "接口地址现状" }],
        discoveryQueries: []
      });
    }
    return { status: 200, json: { choices: [{ message: { content: "不是 JSON" } }] } };
  };
  const offlineGap = await freshness.check(article, model, "");
  assert.equal(searched, false);
  assert.equal(offlineGap.updates.length, 0);
  assert.equal(offlineGap.followUp[0]?.reason, "这一批判断没有返回可用结果。");
  const gapReport = renderFreshnessReview(article.basename, offlineGap);
  assert.match(gapReport, /接口仍是旧地址/);
  assert.doesNotMatch(gapReport, /没有判断完，原文先不改/);
}

{
  const article = await vault.create("Articles/Rejected Evidence.md", "默认上限是 10。\n");
  globalThis.knowflowRequest = async ({ url, body }) => {
    if (String(url).includes("api.deepseek.com")) {
      return { status: 200, json: { results: [{
        url: "https://example.com/limit", title: "上限说明", content: "版本升级后默认限制为 75。"
      }] } };
    }
    const { messages } = JSON.parse(body);
    if (messages[0].content.includes("全文分析")) {
      return toResponse({
        purpose: "说明上限", coreConclusion: "默认上限是 10。",
        claims: [{ quote: "默认上限是 10。", section: "导语", query: "默认上限" }],
        discoveryQueries: []
      });
    }
    if (messages[0].content.includes("依据自身知识")) {
      const payload = JSON.parse(messages[1].content);
      return toResponse({ items: payload.claims.map((claim) => ({ quote: claim.quote, needsVerification: true })) });
    }
    const payload = JSON.parse(messages[1].content);
    return toResponse({
      items: [{
        quote: "默认上限是 10。", before: "默认上限是 10。", after: "默认上限是 12。",
        section: "导语", status: "已经失效", action: "修正", reason: "证据没有支持新上限。",
        sourceId: payload.sources[0].id, evidenceQuote: "版本升级后默认限制为 75。"
      }]
    });
  };
  const rejected = await freshness.check(article, model, "fixture");
  assert.equal(rejected.updates.length, 0);
  assert.ok(rejected.unverified.some((item) => item.text === "默认上限是 10。" && item.reason.includes("数字")));
  const rejectedReport = renderFreshnessReview(article.basename, rejected);
  assert.match(rejectedReport, /默认上限是 10/);
  assert.match(rejectedReport, /证据不足，原文先不改/);
}

{
  const article = await vault.create("Articles/Model Offline.md", "默认版本是 v1。\n");
  globalThis.knowflowRequest = async () => { throw new Error("network error"); };
  await assert.rejects(() => freshness.check(article, model, ""), /无法连接模型服务/);
}

{
  const article = await vault.create("Articles/Model Drop.md", "默认版本是 v1。\n");
  let calls = 0;
  globalThis.knowflowRequest = async ({ url, body }) => {
    if (String(url).includes("api.deepseek.com")) throw new Error("search should stay off");
    calls += 1;
    const { messages } = JSON.parse(body);
    if (messages[0].content.includes("全文分析")) {
      return toResponse({
        claims: [{ quote: "默认版本是 v1。", section: "导语", query: "版本现状" }],
        discoveryQueries: []
      });
    }
    throw new Error("network error");
  };
  const dropped = await freshness.check(article, model, "");
  assert.equal(calls, 2);
  assert.equal(dropped.updates.length, 0);
  assert.equal(dropped.followUp[0]?.text, "默认版本是 v1。");
  assert.match(dropped.followUp[0]?.reason ?? "", /连接中断/);
  const report = renderFreshnessReview(article.basename, dropped);
  assert.match(report, /默认版本是 v1/);
  assert.match(report, /没有判断完/);
}

{
  const article = await vault.create("Articles/No Stream.md", "默认版本是 v1。\n");
  const previousFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("freshness must not open a stream");
  };
  let requests = 0;
  globalThis.knowflowRequest = async ({ url, body }) => {
    if (String(url).includes("api.deepseek.com")) throw new Error("search should stay off");
    requests += 1;
    const { messages } = JSON.parse(body);
    if (messages[0].content.includes("全文分析")) {
      return toResponse({
        claims: [{ quote: "默认版本是 v1。", section: "导语", query: "版本现状" }],
        discoveryQueries: []
      });
    }
    return toResponse({
      items: [{
        quote: "默认版本是 v1。", before: "默认版本是 v1。", after: "默认版本是 v2。",
        section: "导语", status: "已经失效", action: "修正", reason: "模型记得默认版本已经升级。"
      }]
    });
  };
  try {
    const once = await freshness.check(article, model, "", () => {}, () => {});
    assert.equal(fetches, 0, "a dropped connection must not start a second generation");
    assert.equal(requests, 2, "each model step is one request");
    assert.equal(once.updates[0]?.after, "默认版本是 v2。");
  } finally {
    globalThis.fetch = previousFetch;
  }
}

{
  // Article edits stream their reasoning. The stream must still ask for JSON.
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  const previousWarn = console.warn;
  const previousRequest = globalThis.knowflowRequest;
  globalThis.window = { ...previousWindow, setTimeout, clearTimeout };
  const warnings = [];
  console.warn = (...args) => { warnings.push(args); };
  const bodies = [];
  let answer = "";
  globalThis.fetch = async (_url, request) => {
    bodies.push(JSON.parse(request.body));
    const events = `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\ndata: [DONE]\n\n`;
    return {
      ok: true,
      body: new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode(events)); stream.close(); } })
    };
  };
  const chatModel = { ...model, runtime: "openai-compatible", apiKey: "key" };
  const editing = new AiService({ chatModel });
  globalThis.knowflowRequest = async () => ({ status: 200, json: { choices: [{ message: { content: answer } }] } });
  try {
    answer = JSON.stringify({ edits: [{ op: "replace", anchor: "旧句。", text: "新句。" }] });
    const valid = await editing.proposeArticleEdits("把旧句改掉", "旧句。", () => {});
    assert.deepEqual(bodies[0].response_format, { type: "json_object" });
    assert.equal(bodies[0].stream, true);
    assert.deepEqual(valid.edits, [{ op: "replace", anchor: "旧句。", text: "新句。" }]);
    const code = "```c\nstruct vb2_queue { int type; };\n```";
    const codeEdits = [
      { op: "replace", anchor: "结构体。", text: code },
      { op: "insert", anchor: "示例。", at: "after", text: code }
    ];
    const codeJson = JSON.stringify({ edits: codeEdits });
    const codeReplies = [codeJson, "```json\n" + codeJson + "\n```"];
    for (const reply of codeReplies) {
      answer = reply;
      const proposal = await editing.proposeArticleEdits("更新代码块", "结构体。\n\n示例。", () => {});
      assert.deepEqual(proposal.edits, codeEdits);
    }
    answer = "{\"edits\":[{\"op\":\"insert\",\"text\":\"断开";
    const broken = await editing.proposeArticleEdits("补充", "旧句。", () => {});
    assert.equal(broken.edits, null, "a broken payload becomes no usable edit instead of a raw dump");

    const noteText = "模拟笔记内容";
    answer = `{ "text": ${noteText.repeat(110)} }`;
    const transport = new AiTransport();
    for (const handlers of [undefined, { onReasoning() {} }]) {
      warnings.length = 0;
      await assert.rejects(
        () => transport.requestJson(chatModel, [{ role: "user", content: "返回 JSON" }], handlers),
        (error) => error instanceof InvalidAiJsonError && !error.message.includes(noteText) && error.cause === undefined
      );
      assert.equal(warnings.length, 1);
      assert.doesNotMatch(JSON.stringify(warnings), new RegExp(noteText));
      assert.deepEqual(warnings[0][1], { responseChars: answer.length, streamRequested: Boolean(handlers) });
    }
  } finally {
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
    globalThis.knowflowRequest = previousRequest;
    console.warn = previousWarn;
  }
}

{
  // Clipping passes its own instructions, but the article-translation skill (including a vault override) still applies.
  const seen = [];
  globalThis.knowflowRequest = async ({ body }) => {
    seen.push(JSON.parse(body).messages[0].content);
    return toResponse({ translations: [{ id: "translation-1", action: "skip" }] });
  };
  const translating = new AiService({ summaryModel: model, taskModel: model }, new SkillRunner({
    read: async (name) => name === "article-translation" ? "自定义翻译规则：保留缩写。" : null
  }));
  const paragraphs = [{ id: "translation-1", type: "english-paragraph", startLine: 0, endLine: 0, content: "Distributed systems are difficult because components fail." }];
  await translating.translateEnglishParagraphs("T", paragraphs, "剪藏整理规则：只整理结构。");
  assert.ok(seen[0].includes("自定义翻译规则：保留缩写。"), "clipping translation must load the article-translation skill");
  assert.ok(seen[0].includes("剪藏整理规则：只整理结构。"), "clipping instructions must still be sent");
  assert.ok(seen[0].includes('"action": "skip"'), "the translation format must document the skip shape");
  await translating.translateEnglishParagraphs("T", paragraphs);
  assert.ok(seen[1].includes("自定义翻译规则：保留缩写。"));
}

{
  // Formatting: clipping rules include the code reference only; the chat entry is limited to reformat-code.
  const seen = [];
  globalThis.knowflowRequest = async ({ body }) => {
    seen.push(JSON.parse(body).messages[0].content);
    return toResponse({ decisions: [{ id: "code-1", action: "keep" }] });
  };
  const formatting = new AiService({ summaryModel: model, taskModel: model }, runner);
  const candidate = { id: "code-1", type: "fenced-code", content: "x = 1", before: "", after: "", needsReformat: false };
  await formatting.confirmFormatting([candidate], "剪藏整理规则");
  assert.ok(!seen[0].includes("标题结构与图注"), "headings are judged by their own request, not by code confirmation");
  assert.ok(seen[0].includes("只有确认是网页行号时才去掉行首数字"), "clipping formatting must embed the code rules");
  await formatting.confirmFormatting([candidate], "", "code-chat");
  assert.ok(seen[1].includes("只允许返回 keep 或 reformat-code"), "chat formatting must be limited to reformat-code");
  assert.ok(seen[1].includes("只有确认是网页行号时才去掉行首数字"), "chat formatting still follows the code rules");
  await formatting.confirmFormatting([candidate], "", "code-chat-comments");
  assert.match(seen[2], /允许在代码行上方或行尾新增简短的中文注释/);
  assert.match(seen[2], /保留已有注释和所有原有代码/);
  assert.doesNotMatch(seen[2], /不要改动任何字符|只修改布局所需的空白|以参考为准/);
}

{
  // Heading structure: one request with the numbered body and the heading rules, without the clipping skill bundle.
  const seen = [];
  globalThis.knowflowRequest = async ({ body }) => {
    seen.push(JSON.parse(body).messages);
    return toResponse({ edits: [{ type: "format", line: 3, text: "背景", level: 2 }] });
  };
  const headings = new AiService({ summaryModel: model, taskModel: model }, runner);
  const edits = await headings.restoreHeadingStructure("T", { mode: "full", text: "1|导语。\n3|背景\n5|正文。", tokens: 10, shown: new Map() });
  assert.deepEqual(edits, [{ type: "format", line: 3, text: "背景", level: 2 }]);
  assert.ok(seen[0][0].content.includes("标题结构与图注"), "the heading request embeds the heading rules");
  assert.ok(!seen[0][0].content.includes("整理剪藏"), "the heading request does not resend the whole clipping skill");
  assert.ok(seen[0][1].content.includes("3|背景"), "the numbered body is sent as is");
}

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
const defaultSummaryGuidance = (await readFile(new URL("../skills/article-summary/references/output-quality.md", import.meta.url), "utf8")).trim();
const prompts = [];
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
let returnPlainSummary = false;
let emptySummaryResponses = 0;
globalThis.knowflowRequest = async ({ body }) => {
  const { messages } = JSON.parse(body);
  assert.ok(messages[0].content.includes("严格 JSON"));
  const prompt = messages[0].content;
  prompts.push(prompt);
  const input = JSON.parse(messages[1].content);
  assert.equal(prompt.includes("抽样时只概括可见片段"), input.inputKind === "按章抽样的原文");
  assert.ok(!Object.hasOwn(input.requiredJsonShape, "recommendedAction"));
  summaryRequests.push(input);
  const chapters = input.sections.map((_, index) => `${index + 1}. 说明场景 ${index + 1} 的条件与限制。`);
  if (emptySummaryResponses > 0) {
    emptySummaryResponses -= 1;
    return toResponse({});
  }
  if (returnPlainSummary) return toResponse({ summary: "升级前检查客户端版本。" });
  return toResponse({
    readingValue: 3, category: "知识积累",
    summary: ["## 核心观点\n- 默认版本已经更新\n- 总量限制保持不变",
      ["## 章节梳理", ...(omitLastSection ? chapters.slice(0, -1) : chapters)].join("\n")].join("\n\n"),
    briefDescription: "介绍版本变化和兼容条件。", tags: ["runtime"],
    reason: "包含版本选择依据。"
  });
};
const summary = await ai.summarize(file.path, file.basename, contents.get(file));
assert.ok(prompts[0].includes(defaultSummaryGuidance), "the built-in request includes the summary quality reference");
assert.equal(summary.briefDescription, undefined);
assert.equal(summaryRequests[0].requiredJsonShape.reason, "推荐理由");
assert.equal(summaryRequests[0].requiredJsonShape.readingValue, undefined);
assert.match(summary.summary, /^## 核心观点\n- 默认版本已经更新/m);
assert.match(summary.summary, /^## 章节梳理\n1\. 说明场景 1 的条件与限制。/m);
assert.equal(summaryRequests[0].inputKind, "完整的清理后正文");
await vault.create("skills/article-summary/SKILL.md", '---\nname: "article-summary"\ndescription: "摘要规则"\n---\n\n为摘要突出部署前置条件。\n');
returnPlainSummary = true;
summaryRequests.length = 0;
const brief = await ai.summarize(file.path, file.basename, "升级前检查客户端版本。");
assert.match(prompts.at(-1), /为摘要突出部署前置条件/);
assert.ok(!prompts.at(-1).includes(defaultSummaryGuidance), "the Vault skill replaces built-in writing guidance");
assert.equal(brief.summary, "升级前检查客户端版本。");
assert.equal(brief.reason, "");
assert.equal(summaryRequests.length, 1, "a plain paragraph is usable on the first response");
returnPlainSummary = false;
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

  summaryRequests.length = 0;
  let streamInput;
  globalThis.fetch = async (_url, { body }) => {
    streamInput = JSON.parse(body);
    assert.equal(streamInput.stream, true);
    throw new TypeError("Failed to fetch");
  };
  const fallback = await ai.summarizeStream(file.path, file.basename, scenarios, () => {});
  assert.match(fallback.summary, /^## 核心观点\n- 默认版本已经更新/m);
  assert.deepEqual(summaryRequests, [JSON.parse(streamInput.messages[1].content)]);

  let failedStreams = 0;
  summaryRequests.length = 0;
  emptySummaryResponses = 1;
  globalThis.fetch = async () => {
    failedStreams += 1;
    throw new TypeError("Failed to fetch");
  };
  const fallbackStatus = [];
  await assert.rejects(ai.summarizeStream(file.path, file.basename, scenarios, ({ content }) => {
    fallbackStatus.push(content);
  }), /一次重试|重试后/);
  assert.equal(failedStreams, 1, "a failed streaming request must not be repeated");
  assert.equal(summaryRequests.length, 1, "an empty fallback must not trigger another request");
  assert.match(fallbackStatus[0], /改用普通请求/);

  let unusableStreams = 0;
  summaryRequests.length = 0;
  globalThis.fetch = async () => {
    unusableStreams += 1;
    const event = "data: " + JSON.stringify({ choices: [{ delta: { content: '{"reason":"只有推荐理由"}' } }] });
    return new Response(event + "\n\ndata: [DONE]\n\n");
  };
  const retryStatus = [];
  const retriedStream = await ai.summarizeStream(file.path, file.basename, scenarios, ({ content }) => retryStatus.push(content));
  assert.match(retriedStream.summary, /^## 核心观点/m);
  assert.equal(unusableStreams, 1);
  assert.equal(summaryRequests.length, 1, "an unusable streamed response is retried using one non-streaming request");
  assert.match(retryStatus[0], /重试一次/);

  summaryRequests.length = 0;
  const completeSummary = '## 核心观点\n- 结论包含"引号"。';
  globalThis.fetch = async () => {
    const content = `{"summary":${JSON.stringify(completeSummary)},"reason":"尚未写完`;
    const event = "data: " + JSON.stringify({ choices: [{ delta: { content } }] }) + "\n\n";
    let sent = false;
    return new Response(new ReadableStream({
      pull(controller) {
        if (sent) return controller.error(new Error("Stream disconnected during reason"));
        sent = true;
        controller.enqueue(new TextEncoder().encode(event));
      }
    }));
  };
  const completedBeforeDisconnect = await ai.summarizeStream(file.path, file.basename, scenarios, () => {});
  assert.equal(completedBeforeDisconnect.summary, completeSummary);
  assert.equal(completedBeforeDisconnect.reason, "");
  assert.deepEqual(summaryRequests, [], "a complete summary field survives a disconnect during the recommendation");

  summaryRequests.length = 0;
  globalThis.fetch = async () => {
    const event = "data: " + JSON.stringify({ choices: [{ delta: { content: '{"summary":"已经开始' } }] }) + "\n\n";
    let sent = false;
    return new Response(new ReadableStream({
      pull(controller) {
        if (sent) return controller.error(new Error("Stream disconnected"));
        sent = true;
        controller.enqueue(new TextEncoder().encode(event));
      }
    }));
  };
  const partial = [];
  await assert.rejects(ai.summarizeStream(file.path, file.basename, scenarios, ({ content }) => {
    partial.push(content);
  }), /Stream disconnected/);
  assert.deepEqual(partial, ["已经开始"]);
  assert.deepEqual(summaryRequests, [], "do not start a second request after a partial summary");
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
