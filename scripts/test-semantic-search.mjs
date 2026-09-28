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

const { chunkArticle, cosineSimilarity, isMarkdownInFolder, searchSemanticChunks } = await import(
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

assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
assert.equal(cosineSimilarity([1], [1, 2]), 0);

const indexed = [
  { ...chunks[0], embedding: [1, 0] },
  { ...chunks[1], id: "Articles/Other.md#0", path: "Articles/Other.md", embedding: [0.8, 0.2] },
  { ...chunks[1], id: "Articles/Far.md#0", path: "Articles/Far.md", embedding: [0.1, 0.9] }
];
const hits = searchSemanticChunks(indexed, [[1, 0]], 2, "Articles/Test.md");
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
const app = {
  vault: {
    adapter: {
      exists: async (path) => stored.has(path),
      read: async (path) => stored.get(path),
      write: async (path, value) => { stored.set(path, value); },
      remove: async (path) => { stored.delete(path); }
    },
    getMarkdownFiles: () => files,
    cachedRead: async (file) => file.path.includes("Apple") ? "## 苹果\n苹果是一种水果。" : "## 水果\n苹果和香蕉都是水果。",
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
const transport = {
  embed: async (_config, inputs) => inputs.map((input) => input.includes("苹果") ? [1, 0] : [0.8, 0.2])
};
const service = new SemanticIndexService(app, settings, "semantic-index.json", transport);
const stats = await service.rebuild();
assert.equal(stats.files, 2);
assert.equal(stats.compatible, true);
assert.ok(stored.has("semantic-index.json"));
assert.ok(!JSON.parse(stored.get("semantic-index.json")).chunks.some((chunk) => chunk.path.includes("/assets/")));
assert.ok((await service.searchContext("苹果", undefined, 2)).includes("检索来源"));
const related = await service.findRelated(files[0], 5);
assert.equal(related[0]?.path, "Articles/Fruit.md");
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
await service.migratePath("Articles/Apple.md", "Articles/Renamed.md");
assert.equal(JSON.parse(stored.get("semantic-index.json")).chunks[0].path, "Articles/Renamed.md");
await service.clear();
assert.equal(stored.has("semantic-index.json"), false);

await rm(tempDir, { recursive: true, force: true });
console.log("semantic search tests passed");
