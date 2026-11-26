import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const tempDir = await mkdtemp(join(tmpdir(), "knowflow-semantic-search-"));
await esbuild.build({
  bundle: true,
  entryPoints: ["src/services/search/semantic-search.ts"],
  format: "esm",
  outfile: join(tempDir, "semantic-search.js"),
  platform: "node"
});
await esbuild.build({
  bundle: true,
  entryPoints: ["src/services/search/semantic-index-service.ts"],
  format: "esm",
  outfile: join(tempDir, "semantic-index-service.js"),
  platform: "node",
  plugins: [{
    name: "stub-obsidian",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub-obsidian" }));
      build.onLoad({ filter: /.*/, namespace: "stub-obsidian" }, () => ({
        contents: [
          "export const normalizePath = (value) => value;",
          "export class TFile { constructor(value = {}) { Object.assign(this, value); } }",
          "globalThis.__KnowFlowTestTFile = TFile;",
          "export const requestUrl = async () => { throw new Error('unexpected request'); };"
        ].join("\n"),
        loader: "js"
      }));
    }
  }]
});

const { chunkArticle, chunkArticleSummary, cosineSimilarity, isMarkdownInFolder, normalizeEmbedding, searchSemanticChunks, pickArticlePassage } = await import(
  pathToFileURL(join(tempDir, "semantic-search.js")).href
);

assert.equal(isMarkdownInFolder({ path: "Articles/Test.md", extension: "md" }, "Articles"), true);
assert.equal(isMarkdownInFolder({ path: "Clippings/Test.md", extension: "md" }, "Articles"), false);
assert.equal(isMarkdownInFolder({ path: "Articles/Test.canvas", extension: "canvas" }, "Articles"), false);
assert.equal(isMarkdownInFolder({ path: "Knowledge Base/Test.md", extension: "md" }, "Knowledge Base"), true);
assert.equal(isMarkdownInFolder({ path: "Articles/Test.md", extension: "md" }, "Knowledge Base"), false);
assert.equal(isMarkdownInFolder({ path: "Articles/assets/Index.md", extension: "md" }, "Articles", ["assets"]), false);
assert.equal(isMarkdownInFolder({ path: "Articles/Topic/assets/Index.md", extension: "md" }, "Articles", ["assets"]), false);
assert.equal(isMarkdownInFolder({ path: "Articles/Reference/assets/Index.md", extension: "md" }, "Articles", ["Reference/assets"]), false);
assert.equal(isMarkdownInFolder({ path: "Articles/Topic/assets/Index.md", extension: "md" }, "Articles", ["Reference/assets"]), true);

const markdown = [
  "---",
  "分类: 人工智能",
  "---",
  "",
  "> [!summary]- AI 摘要",
  "> 不应进入索引",
  "",
  "## RAG",
  "",
  "向量检索连接问题和知识。",
  "",
  "## Agent",
  "",
  "Agent 根据工具结果继续行动。"
].join("\n");
const chunks = chunkArticle("Articles/Test.md", "Test", markdown, 123);
assert.equal(chunks.length, 2);
assert.ok(chunks[0].content.includes("小节：RAG"));
assert.ok(!chunks.some((chunk) => chunk.content.includes("不应进入索引")));
assert.equal(chunks[0].id, "Articles/Test.md#0");
assert.ok(chunks.every((chunk) => chunk.content.length <= 1800));
const longHeading = chunkArticle("Articles/Long.md", "Long", `## ${"H".repeat(12000)}\n\nbody`, 1);
assert.ok(longHeading.every((chunk) => chunk.content.length <= 1800));
const summaryChunks = chunkArticleSummary("Articles/Test.md", "Test", markdown, 123);
assert.equal(summaryChunks.length, 1);
assert.match(summaryChunks[0].content, /不应进入索引/);
assert.doesNotMatch(summaryChunks[0].content, /向量检索连接问题和知识/);
assert.deepEqual(chunkArticleSummary("Articles/Legacy.md", "旧文", "一篇尚无摘要的旧文。", 1), []);
assert.equal(pickArticlePassage(chunks, "Agent").heading, "Agent");

assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
assert.equal(cosineSimilarity([1], [1, 2]), 0);

assert.deepEqual(Array.from(normalizeEmbedding([3, 4], 1)), [1]);
const indexed = [
  { ...chunks[0], embedding: normalizeEmbedding([1, 0]) },
  { ...chunks[1], id: "Articles/Other.md#0", path: "Articles/Other.md", embedding: normalizeEmbedding([0.8, 0.2]) },
  { ...chunks[1], id: "Articles/Far.md#0", path: "Articles/Far.md", embedding: normalizeEmbedding([0.1, 0.9]) }
];
const hits = searchSemanticChunks(indexed, [normalizeEmbedding([1, 0])], 2, "Articles/Test.md");
assert.deepEqual(hits.map((hit) => hit.chunk.path), ["Articles/Other.md", "Articles/Far.md"]);
assert.ok(hits[0].score > hits[1].score);

const { SemanticIndexService } = await import(
  pathToFileURL(join(tempDir, "semantic-index-service.js")).href
);
const TestTFile = globalThis.__KnowFlowTestTFile;

const files = [
  new TestTFile({ path: "Articles/Apple.md", basename: "Apple", extension: "md", stat: { mtime: 1 } }),
  new TestTFile({ path: "Articles/Fruit.md", basename: "Fruit", extension: "md", stat: { mtime: 2 } }),
  new TestTFile({ path: "Articles/Topic/assets/Hidden.md", basename: "Hidden", extension: "md", stat: { mtime: 3 } })
];
const stored = new Map();
const directories = new Set();
let failManifestWrite = false;
let appleManagedBlock = "";
let withSummaries = true;
let newSummary = "";
const app = {
  vault: {
    adapter: {
      exists: async (path) => stored.has(path) || directories.has(path),
      read: async (path) => stored.get(path),
      write: async (path, value) => {
        if (failManifestWrite && path === "semantic-index.json") throw new Error("planned manifest failure");
        stored.set(path, value);
      },
      readBinary: async (path) => stored.get(path).slice(0),
      writeBinary: async (path, value) => { stored.set(path, value.slice(0)); },
      remove: async (path) => { stored.delete(path); },
      mkdir: async (path) => { directories.add(path); },
      rmdir: async (path) => {
        directories.delete(path);
        for (const key of [...stored.keys()]) if (key.startsWith(`${path}/`)) stored.delete(key);
      }
    },
    getMarkdownFiles: () => files,
    cachedRead: async (file) => withSummaries && file.basename === "Apple"
      ? `> [!summary]- AI 摘要\n> 苹果营养概况。\n\n## 苹果\n苹果是一种水果。${appleManagedBlock}`
      : withSummaries && file.basename === "Fruit"
        ? "> [!summary]- AI 摘要\n> 包含苹果与香蕉的摘要。\n\n## 水果\n苹果和香蕉都是水果。"
      : withSummaries && file.basename === "Collision-289"
        ? "> [!summary]- AI 摘要\n> 为分片并发保存使用的独立摘要。\n\n一篇有摘要的新文章。"
        : `${file.basename === "Renamed" ? newSummary : ""}## 文章\n这篇文章的正文。`,
    getAbstractFileByPath: (path) => files.find((file) => file.path === path) ?? null
  },
  metadataCache: {
    getFileCache: () => ({ frontmatter: { 分类: "知识", tags: ["水果"] } }),
    resolvedLinks: {}
  }
};
const settings = {
  articlesFolder: "Articles",
  semanticIndexExcludeFolders: ["assets"],
  embeddingModel: {
    runtime: "openai-compatible",
    apiBaseUrl: "https://embedding.example/v1",
    apiKey: "",
    model: "test-embedding"
  }
};
let failFruit = true;
let embedCalls = 0;
const transport = { embed: async (_config, inputs) => {
  embedCalls += 1;
  assert.ok(inputs.every((input) => !input.includes("苹果是一种水果。") && !input.includes("苹果和香蕉都是水果。")));
  if (failFruit && inputs.some((input) => input.includes("香蕉"))) throw new Error("planned interruption");
  return inputs.map((input) => input.includes("苹果") ? [1, 0] : [0.8, 0.2]);
} };
const service = new SemanticIndexService(app, settings, "semantic-index.json", transport);
await assert.rejects(() => service.rebuild(), /planned interruption/);
assert.ok(stored.has("semantic-index-build.json"));
const interruptedBuild = JSON.parse(stored.get("semantic-index-build.json"));
assert.equal(interruptedBuild.version, 3);
assert.equal(interruptedBuild.shards.length, 1);
assert.equal([...stored.keys()].filter((path) => path.endsWith(".bin")).length, 1);
failFruit = false;
embedCalls = 0;
const stats = await service.rebuild();
assert.equal(embedCalls, 1, "resumed build should reuse the completed first shard");
assert.equal(stats.files, 2);
assert.equal(stats.compatible, true);
assert.equal(stats.degraded, false);
assert.ok(stored.has("semantic-index.json"));
let manifest = JSON.parse(stored.get("semantic-index.json"));
assert.equal(manifest.version, 3);
assert.equal(manifest.shards.length, 2);
assert.equal(Object.hasOwn(manifest, "chunks"), false);
assert.ok(manifest.shards.every((shard) => !Object.hasOwn(shard, "embedding")));
assert.ok(stored.get("semantic-index.json").length < 2_000, "manifest must remain small and vector-free");
assert.equal([...stored.keys()].filter((path) => path.endsWith(".bin")).length, 2);
assert.ok(!stored.has("semantic-index-build.json"));
const shardMetadata = () => [...stored.entries()]
  .filter(([path]) => path.includes("semantic-index-v3/") && path.endsWith(".json"))
  .map(([path, value]) => ({ path, value: JSON.parse(value) }));
const metadataFor = (articlePath) => shardMetadata().find((item) =>
  item.value.articles.some((article) => article.path === articlePath)
);
assert.equal(metadataFor("Articles/Topic/assets/Hidden.md"), undefined);
for (const { value } of shardMetadata()) {
  assert.equal(value.version, 3);
  for (const article of value.articles) {
    assert.equal(article.vectorOffsetBytes, article.chunkStart * value.dimension * 4);
    assert.equal(article.vectorLengthBytes, article.chunkCount * value.dimension * 4);
  }
}
const appleBeforeRace = files[0].stat.mtime;
files[0].stat.mtime = 100;
const embedBeforeRace = transport.embed;
transport.embed = async (_config, inputs) => {
  files[0].stat.mtime = 180;
  return inputs.map((input) => input.includes("苹果") ? [1, 0] : [0.8, 0.2]);
};
await service.rebuild();
const raced = metadataFor("Articles/Apple.md").value.articles.find((article) => article.path === "Articles/Apple.md");
assert.equal(raced.mtime, 100, "a rebuild must not stamp old vectors with a newer mtime");
files[0].stat.mtime = appleBeforeRace;
transport.embed = embedBeforeRace;

{
  const newFile = new TestTFile({ path: "Articles/Collision-289.md", basename: "Collision-289", extension: "md", stat: { mtime: 9 } });
  let signalStart;
  let releaseBuild;
  const started = new Promise((resolve) => { signalStart = resolve; });
  transport.embed = async (config, inputs) => {
    if (!releaseBuild) await new Promise((resolve) => { releaseBuild = resolve; signalStart(); });
    return embedBeforeRace(config, inputs);
  };
  const rebuilding = service.rebuild();
  await started;
  files.push(newFile);
  const refresh = service.refreshFile(newFile);
  releaseBuild();
  await Promise.all([rebuilding, refresh]);
  assert.ok(metadataFor(newFile.path), "refresh queued during a rebuild must run after the active manifest is published");
  await service.removePath(newFile.path);
  files.splice(files.indexOf(newFile), 1);
  transport.embed = embedBeforeRace;
}

const includedContext = await service.searchContext("苹果", undefined, 2);
assert.match(includedContext, /检索来源/);
assert.match(includedContext, /苹果是一种水果/);
assert.doesNotMatch(includedContext, /苹果营养概况|包含苹果与香蕉的摘要/);
{
  const persisted = stored.get("semantic-index.json");
  const models = [];
  const changed = { ...settings, embeddingModel: { ...settings.embeddingModel, model: "different-model" } };
  transport.embed = async (config, inputs) => {
    models.push(config.model);
    service.updateSettings(changed);
    return embedBeforeRace(config, inputs);
  };
  await assert.rejects(service.rebuild(), /索引配置在构建期间已更改/);
  assert.deepEqual(models, [settings.embeddingModel.model, settings.embeddingModel.model]);
  assert.equal(stored.get("semantic-index.json"), persisted);
  service.updateSettings(settings);
  transport.embed = embedBeforeRace;
  await service.rebuild();
}
const beforeMissingSummary = embedCalls;
assert.deepEqual(await service.findRelated(files[2]), []);
assert.equal(embedCalls, beforeMissingSummary, "a source without a summary does not embed its full article");
const related = await service.findRelated(files[0], 5);
assert.equal(related[0]?.path, "Articles/Fruit.md");
const titleMatch = new TestTFile({ path: "Articles/Apple Crisp.md", basename: "Apple Crisp", extension: "md", stat: { mtime: 9 } });
files.push(titleMatch);
files[0].stat.mtime = 7;
const embedBeforeFailure = transport.embed;
transport.embed = async () => { throw new Error("embedding unavailable"); };
const fallback = await service.findRelated(files[0], 5);
assert.ok(fallback.some((note) => note.path === titleMatch.path), "title matches remain when embedding fails");
transport.embed = embedBeforeFailure;
files.splice(files.indexOf(titleMatch), 1);

const appleBefore = metadataFor("Articles/Apple.md");
const appleBinaryBefore = appleBefore.path.replace(/\.json$/, ".bin");
appleManagedBlock = "\n\n> [!info]- KnowFlow 相关文章\n> - [[Fruit]]";
files[0].stat.mtime = 4;
const callsBeforeManagedWrite = embedCalls;
await service.refreshFile(files[0]);
assert.equal(embedCalls, callsBeforeManagedWrite, "editing a legacy related-links block must reuse unchanged embeddings");
const appleAfter = metadataFor("Articles/Apple.md");
assert.notEqual(appleAfter.path, appleBefore.path, "single-file updates must create a new immutable shard revision");
assert.equal(stored.has(appleBefore.path), false);
assert.equal(stored.has(appleBinaryBefore), false);
assert.equal(stored.has(appleAfter.path.replace(/\.json$/, ".bin")), true);
assert.equal([...stored.keys()].filter((path) => path.endsWith(".bin")).length, 2);

const collision = new TestTFile({
  path: "Articles/Collision-289.md", basename: "Collision-289", extension: "md", stat: { mtime: 5 }
});
files.push(collision);
files[0].stat.mtime = 6;
await Promise.all([service.refreshFile(files[0]), service.refreshFile(collision)]);
const sharedShard = metadataFor("Articles/Apple.md");
assert.ok(sharedShard.value.articles.some((article) => article.path === collision.path), "queued updates in one shard must not overwrite each other");
await service.removePath(collision.path);
files.splice(files.indexOf(collision), 1);

const manifestBeforeFailure = stored.get("semantic-index.json");
const appleBeforeFailure = metadataFor("Articles/Apple.md");
files[0].stat.mtime = 7;
failManifestWrite = true;
await assert.rejects(() => service.refreshFile(files[0]), /planned manifest failure/);
failManifestWrite = false;
assert.equal(stored.get("semantic-index.json"), manifestBeforeFailure, "failed manifest switch must keep the old index active");
assert.equal(stored.has(appleBeforeFailure.path), true);
assert.equal([...stored.keys()].filter((path) => path.endsWith(".bin")).length, 2, "failed revisions must be cleaned up");

const reloaded = new SemanticIndexService(app, settings, "semantic-index.json", transport);
await reloaded.load();
assert.equal(reloaded.getStats().chunks, 2);
assert.ok((await reloaded.searchContext("苹果", undefined, 2)).includes("检索来源"));

const currentManifest = stored.get("semantic-index.json");
const oldManifest = JSON.parse(currentManifest);
oldManifest.modelKey = oldManifest.modelKey.replace("|source:ai-summary-v1", "");
stored.set("semantic-index.json", JSON.stringify(oldManifest));
const oldIndex = new SemanticIndexService(app, settings, "semantic-index.json", transport);
await oldIndex.load();
assert.equal(oldIndex.isReady(), false, "full-text index requires a rebuild before summary-based queries");
stored.set("semantic-index.json", currentManifest);

const fruitMetadata = metadataFor("Articles/Fruit.md");
const fruitBinary = fruitMetadata.path.replace(/\.json$/, ".bin");
const fruitBackup = stored.get(fruitBinary).slice(0);
stored.delete(fruitBinary);
const degraded = new SemanticIndexService(app, settings, "semantic-index.json", transport);
await degraded.load();
assert.equal(degraded.getStats().degraded, true);
assert.equal(degraded.getStats().unhealthyShards, 1);
assert.equal(degraded.getStats().unavailableFiles, 1);
assert.equal(degraded.isReady(), true, "one damaged shard must not disable healthy shards");
assert.ok((await degraded.searchContext("苹果", undefined, 2)).includes("Articles/Apple.md"));
stored.set(fruitBinary, fruitBackup);

transport.embed = async () => [[1, 0, 0]];
await assert.rejects(
  () => service.searchContext("维度变化", undefined, 2),
  /dimensions no longer match/
);
transport.embed = async (_config, inputs) => inputs.map((input) => input.includes("苹果") ? [1, 0] : [0.8, 0.2]);
service.updateSettings({
  ...settings,
  embeddingModel: { ...settings.embeddingModel, model: "another-embedding" }
});
assert.equal(service.getStats().compatible, false);
service.updateSettings(settings);
service.updateSettings({ ...settings, semanticIndexExcludeFolders: [] });
assert.equal(service.getStats().compatible, false);
service.updateSettings(settings);
await service.removePath("Articles/Fruit.md");
assert.equal(service.getStats().files, 1);
files[0].path = "Articles/Renamed.md";
files[0].basename = "Renamed";
await service.migratePath("Articles/Apple.md", "Articles/Renamed.md");
assert.ok(metadataFor("Articles/Renamed.md"));
assert.equal(metadataFor("Articles/Apple.md"), undefined);
manifest = JSON.parse(stored.get("semantic-index.json"));
assert.ok(manifest.shards.length <= 1);
await service.clear();
assert.equal(stored.has("semantic-index.json"), false);
assert.equal([...stored.keys()].some((path) => path.includes("semantic-index-v3/")), false);

withSummaries = false;
assert.equal((await service.rebuild()).files, 0);
assert.equal(service.hasCompatibleIndex(), true);
assert.equal(service.isReady(), false);
newSummary = "> [!summary]- AI 摘要\n> 这篇新生成的摘要介绍索引工作流。\n\n";
files[0].stat.mtime += 1;
await service.refreshFile(files[0]);
assert.equal(service.isReady(), true);
assert.equal(service.getStats().files, 1);
assert.ok((await service.searchContext("索引", undefined, 1)).includes("这篇文章的正文"));

await rm(tempDir, { recursive: true, force: true });
console.log("semantic search tests passed");
