import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

// mermaid-service.ts imports the "obsidian" package, which only exists
// inside the Obsidian runtime — stub it out so the module can be bundled
// and exercised here like the other pure-logic services.
const obsidianStub = "export class Notice {}\nexport class TFile {}\n";

const tempDir = await mkdtemp(join(tmpdir(), "knowflow-mermaid-"));
await esbuild.build({
  bundle: true,
  entryPoints: ["src/services/learning/mermaid-service.ts"],
  format: "esm",
  outdir: tempDir,
  platform: "node",
  plugins: [
    {
      name: "stub-obsidian",
      setup(build) {
        build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub-obsidian" }));
        build.onLoad({ filter: /.*/, namespace: "stub-obsidian" }, () => ({ contents: obsidianStub, loader: "js" }));
      }
    }
  ]
});
const { MermaidService } = await import(pathToFileURL(join(tempDir, "mermaid-service.js")).href);

// When the note already has an AI summary callout, the Knowledge Map must
// be inserted immediately after it — not just appended to the end of the
// file — so it always reads "AI summary, then knowledge map" regardless
// of what other content follows the summary.
{
  const note = [
    "---",
    "分类: AI",
    "---",
    "",
    "> [!summary]- AI 摘要",
    "> 这是摘要正文。",
    ">",
    "> **推荐理由**：值得深入学习。",
    "",
    "## 正文标题",
    "",
    "这里是文章正文，摘要生成之后才会出现的内容。"
  ].join("\n");

  const result = await callUpsertKnowledgeMap(note);

  const summaryEnd = result.indexOf("## Knowledge Map");
  const bodyStart = result.indexOf("## 正文标题");
  assert.ok(summaryEnd > 0, "Knowledge Map block must be present");
  assert.ok(summaryEnd < bodyStart, "Knowledge Map must sit between the AI summary and the rest of the body");
  assert.ok(result.indexOf("**推荐理由**") < summaryEnd, "Knowledge Map must come after the summary, not before it");
}

// Without a summary callout, insert the map before the first H2 so it acts
// as an outline for the article rather than an appendix.
{
  const note = "## 正文标题\n\n这里是文章正文。";
  const result = await callUpsertKnowledgeMap(note);
  assert.ok(result.indexOf("## Knowledge Map") < result.indexOf("## 正文标题"));
}

// Re-running generateForFile on a note that already has a Knowledge Map
// must replace it in place, not duplicate it, regardless of where it sits.
{
  const note = [
    "> [!summary]- AI 摘要",
    "> 摘要正文。",
    "",
    "## 知识骨架",
    "",
    "```mermaid",
    "mindmap",
    "  root((旧的))",
    "```",
    "",
    "## 正文标题",
    "",
    "正文。"
  ].join("\n");
  const result = await callUpsertKnowledgeMap(note);
  assert.equal((result.match(/## Knowledge Map/g) ?? []).length, 1, "must not duplicate the section");
  assert.ok(!result.includes("## 知识骨架"), "legacy Chinese section title must be migrated");
  assert.ok(!result.includes("root((旧的))"), "old mermaid content must be replaced");
}

// Edits made while the AI request is running must be merged into the latest
// note instead of being overwritten by the request's original snapshot.
{
  let current = "## 正文\n\n请求开始前的内容。\n";
  let releaseAi;
  const aiGate = new Promise((resolve) => {
    releaseAi = resolve;
  });
  const app = {
    vault: {
      read: async () => current,
      modify: async (_file, next) => {
        current = next;
      }
    }
  };
  const ai = {
    generateKnowledgeMap: async () => {
      await aiGate;
      return "graph LR\n  H((\"核心主题\"))";
    }
  };
  const noteOperations = {
    runExclusive: async (_path, operation) => operation()
  };
  const svc = new MermaidService(app, ai, noteOperations);
  const generation = svc.generateForFile({ basename: "标题", path: "Articles/标题.md" });
  await Promise.resolve();
  current = `${current.trimEnd()}\n\n用户在 AI 请求期间添加的内容。\n`;
  releaseAi();
  await generation;

  assert.ok(current.includes("用户在 AI 请求期间添加的内容。"), "concurrent edits must survive map generation");
  assert.ok(current.includes("## Knowledge Map"));
}

async function callUpsertKnowledgeMap(content) {
  // Exercise the same code path generateForFile() uses, via a throwaway
  // TFile-like object and a vault stub that just records the write.
  let written = null;
  const app = {
    vault: {
      read: async () => content,
      modify: async (_file, next) => {
        written = next;
      }
    }
  };
  const ai = {
    generateKnowledgeMap: async () => [
      "graph LR",
      "  H((\"核心主题\"))",
      "  H --> A[\"阶段一\"]",
      "  A -.-> A1[\"1.发现<br/>2.影响\"]",
      "  style A fill:#fff5f5,stroke:#ff8787"
    ].join("\n")
  };
  const noteOperations = {
    runExclusive: async (_path, operation) => operation()
  };
  const svc = new MermaidService(app, ai, noteOperations);
  await svc.generateForFile({ basename: "标题", path: "Articles/标题.md" });
  return written;
}

await rm(tempDir, { recursive: true, force: true });
console.log("mermaid-service tests passed");
