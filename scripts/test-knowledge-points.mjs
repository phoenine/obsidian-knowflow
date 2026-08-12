import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const tempDir = await mkdtemp(join(tmpdir(), "knowflow-knowledge-points-"));
await esbuild.build({
  bundle: true,
  entryPoints: ["src/services/learning/knowledge-points.ts"],
  format: "esm",
  outdir: tempDir,
  platform: "node"
});
const { buildKnowledgePointsBlock, mergeKnowledgePointGroups, normalizeKnowledgePointGroups, parseKnowledgePoints, upsertKnowledgePoints } = await import(
  pathToFileURL(join(tempDir, "knowledge-points.js")).href
);

const groups = normalizeKnowledgePointGroups({
  groups: [
    {
      title: "执行边界 · Hooks",
      points: [
        {
          slug: "hook-checkpoint",
          title: "Hook 是工具调用链路中的同步检查点",
          type: "机制",
          explanation: "Hook 在模型形成调用请求后、实际执行前触发。",
          evidence: {
            section: "4.1 Hook 的运行原理",
            excerpt: "Hook 在工具调用触发后、执行前被调用。"
          },
          question: "为什么 Hook 比 system prompt 更适合作为安全边界？",
          relations: {
            dependsOn: ["mcp-tool-call"],
            extends: ["progressive-risk"]
          }
        }
      ]
    }
  ]
});

assert.equal(groups.length, 1);
assert.equal(groups[0].points[0].id, "kf-kp-hook-checkpoint");
assert.deepEqual(groups[0].points[0].relations.dependsOn, ["kf-kp-mcp-tool-call"]);
assert.deepEqual(groups[0].points[0].relations.extends, ["kf-kp-progressive-risk"]);

const block = buildKnowledgePointsBlock(groups);
assert.ok(block.includes("<!-- knowflow:knowledge-points:start -->"));
assert.ok(block.includes("> [!note]- Hook 是工具调用链路中的同步检查点"));
assert.ok(block.includes("> ^kf-kp-hook-checkpoint"));

const parsed = parseKnowledgePoints(block);
assert.deepEqual(parsed, groups);

const generatedUpdate = [{
  title: groups[0].title,
  points: [
    { ...groups[0].points[0], explanation: "模型重新生成的说明" },
    { ...groups[0].points[0], id: "kf-kp-new", title: "新知识点" }
  ]
}];
const merged = mergeKnowledgePointGroups(groups, generatedUpdate);
assert.equal(merged[0].points[0].explanation, groups[0].points[0].explanation, "stable IDs must preserve user-edited content");
assert.equal(merged[0].points[1].id, "kf-kp-new", "newly generated points must still be added");

const quizNote = [
  "---",
  "原文: \"[[Articles/AI/示例文章]]\"",
  "---",
  "",
  "<!-- study-quiz:start -->",
  "",
  "## 1. 已有题目",
  "",
  "<!-- study-quiz:end -->",
  ""
].join("\n");
const withKnowledge = upsertKnowledgePoints(quizNote, groups);
assert.ok(withKnowledge.indexOf("<!-- knowflow:knowledge-points:start -->") < withKnowledge.indexOf("<!-- study-quiz:start -->"));
assert.ok(withKnowledge.includes("## 1. 已有题目"));

const refreshed = upsertKnowledgePoints(withKnowledge, [{
  title: "能力边界 · MCP",
  points: [{ ...groups[0].points[0], title: "更新后的知识点" }]
}]);
assert.equal((refreshed.match(/<!-- knowflow:knowledge-points:start -->/g) ?? []).length, 1);
assert.ok(refreshed.includes("更新后的知识点"));
assert.ok(!refreshed.includes("Hook 是工具调用链路中的同步检查点"));
assert.ok(refreshed.includes("## 1. 已有题目"), "refreshing knowledge points must preserve quiz questions");

assert.deepEqual(parseKnowledgePoints("# 普通笔记"), []);

await rm(tempDir, { recursive: true, force: true });
console.log("knowledge point tests passed");
