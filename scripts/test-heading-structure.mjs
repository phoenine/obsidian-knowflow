import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const tempDir = await mkdtemp(join(tmpdir(), "knowflow-headings-"));
await esbuild.build({
  bundle: true,
  entryPoints: { "heading-structure": "src/services/clipping/heading-structure.ts" },
  format: "esm",
  outdir: tempDir,
  platform: "node"
});
const {
  applyHeadingEdits,
  buildHeadingInput,
  readHeadingEdits,
  stripHeadingNumbers
} = await import(pathToFileURL(join(tempDir, "heading-structure.js")).href);

const apply = (content, edits) => applyHeadingEdits(content, buildHeadingInput(content), edits);

{
  const content = [
    "导语。",
    "",
    "一、背景",
    "这里是背景。",
    "",
    "```js",
    "## 代码里的标题",
    "```",
    "",
    "> 引用里的 ## 标题",
    "",
    "| 列 | 值 |",
    "| --- | --- |",
    "",
    "<!-- 注释",
    "多行 -->",
    "",
    "部署配置如下：",
    "",
    "# 部署配置",
    "apiVersion: v1",
    "kind: Pod",
    "metadata:",
    "  name: nginx",
    "",
    "结尾。"
  ].join("\n");
  const input = buildHeadingInput(content);
  assert.equal(input.mode, "full");
  assert.deepEqual(input.text.split("\n"), [
    "1|导语。",
    "3|一、背景",
    "4|这里是背景。",
    "6-8|[代码]",
    "10|[引用]",
    "12-13|[表格]",
    "15-16|[注释]",
    "18|部署配置如下：",
    "20-24|[疑似代码]",
    "26|结尾。"
  ], "blank lines are left out and protected content collapses into placeholders");
  assert.ok(!input.shown.has(19), "a `# comment` glued to unfenced code must not be editable");
  assert.ok(!input.shown.has(6));
}

{
  const long = `${"很长的段落内容".repeat(30)}。`;
  const content = Array.from({ length: 200 }, (_, index) => `第 ${index} 节\n\n${long}`).join("\n\n");
  const input = buildHeadingInput(content);
  assert.equal(input.mode, "compressed");
  assert.ok(input.tokens <= 32000);
  assert.match(input.text, /…（共 \d+ 字）/);
  const truncatedLine = [...input.shown.entries()].find(([, shown]) => shown.truncated);
  const echoed = apply(content, [{ type: "format", line: truncatedLine[0] + 1, text: truncatedLine[1].text, level: 2 }]);
  assert.equal(echoed.applied, 1, "a truncated line is matched against the prefix the model saw");
  assert.deepEqual(buildHeadingInput(Array.from({ length: 3000 }, () => long).join("\n\n")), { skipped: "正文过长" });
}

{
  const content = [
    "导语。",
    "",
    "**为什么 AI 更擅长修改函数式代码？**",
    "",
    "正文一。",
    "",
    "一、背景",
    "",
    "正文二。",
    "",
    "#### 小结",
    "",
    "正文三。",
    "",
    "## 这是整个系统中最重要的一个问题。",
    "",
    "正文四。"
  ].join("\n");
  const result = apply(content, [
    { type: "format", line: 3, text: "为什么 AI 更擅长修改函数式代码？", level: 2, reason: "章节" },
    { type: "format", line: 7, text: "一、背景", level: 2 },
    { type: "level", line: 11, text: "小结", level: 3 },
    { type: "demote", line: 15, text: "## 这是整个系统中最重要的一个问题。" }
  ]);
  assert.equal(result.discarded, undefined);
  assert.equal(result.applied, 4);
  assert.equal(result.rejected, 0);
  const lines = result.content.split("\n");
  assert.equal(lines[2], "## 为什么 AI 更擅长修改函数式代码？", "whole-line bold is dropped when the line becomes a heading");
  assert.equal(lines[6], "## 一、背景");
  assert.equal(lines[10], "### 小结");
  assert.equal(lines[14], "这是整个系统中最重要的一个问题。");
  assert.equal(stripHeadingNumbers(result.content).split("\n")[6], "## 背景");
  assert.equal(apply(result.content, []).content, result.content, "no edits means no change");
}

{
  const content = ["正文。", "", "产品经理不该按人头配齐", "", "这里解释职责。"].join("\n");
  const rewritten = apply(content, [{ type: "format", line: 3, text: "产品经理的配置原则", level: 2 }]);
  assert.equal(rewritten.content, content, "the echoed text must match the source line");
  assert.equal(rewritten.rejected, 1);
  for (const level of ["2", 5, 1, 2.5, undefined]) {
    assert.equal(apply(content, [{ type: "format", line: 3, text: "产品经理不该按人头配齐", level }]).content, content, `level ${level}`);
  }
  assert.equal(apply(content, [{ type: "level", line: 3, text: "产品经理不该按人头配齐", level: 2 }]).applied, 0, "level needs an existing heading");
  assert.equal(apply(content, [{ type: "demote", line: 3, text: "产品经理不该按人头配齐" }]).applied, 0, "demote needs an existing heading");
  assert.equal(apply(content, [{ type: "format", line: 99, text: "x", level: 2 }]).applied, 0);
  assert.equal(apply(content, [{ type: "format", line: 2, text: "", level: 2 }]).applied, 0, "blank lines are not editable");
  const duplicate = apply(content, [
    { type: "format", line: 3, text: "产品经理不该按人头配齐", level: 2 },
    { type: "format", line: 3, text: "产品经理不该按人头配齐", level: 3 }
  ]);
  assert.equal(duplicate.applied, 0, "two edits for one line are both refused");
  assert.equal(duplicate.rejected, 2);
  const heading = "## 已有标题\n\n正文。";
  assert.equal(apply(heading, [{ type: "format", line: 1, text: "已有标题", level: 3 }]).applied, 0, "format is for plain lines only");
  assert.equal(apply("- 列表项\n\n正文。", [{ type: "format", line: 1, text: "- 列表项", level: 2 }]).applied, 0);
}

{
  const content = ["## 甲", "", "正文。", "", "乙", "", "正文。", "", "丙", "", "正文。", "", "丁", "", "正文。"].join("\n");
  const mostlyWrong = apply(content, [
    { type: "format", line: 5, text: "乙", level: 3 },
    { type: "format", line: 9, text: "不是这一行", level: 3 },
    { type: "format", line: 13, text: "也不是", level: 3 }
  ]);
  assert.equal(mostlyWrong.content, content, "too many mismatched echoes mean the line numbers are unreliable");
  assert.match(mostlyWrong.discarded, /对不上/);
}

{
  const content = ["## 甲", "", "正文。", "", "乙", "", "正文。", "", "丙", "", "正文。"].join("\n");
  const result = apply(content, [
    { type: "format", line: 5, text: "乙", level: 4 },
    { type: "format", line: 9, text: "丙", level: 3 }
  ]);
  assert.equal(result.applied, 1, "the edit that creates a new downward skip is dropped");
  assert.equal(result.rejected, 1);
  assert.deepEqual(result.content.split("\n").filter((line) => line.startsWith("#")), ["## 甲", "### 丙"]);

  const existingSkip = ["## 甲", "", "#### 原文就跳级", "", "正文。", "", "乙", "", "正文。"].join("\n");
  const kept = apply(existingSkip, [{ type: "format", line: 7, text: "乙", level: 2 }]);
  assert.equal(kept.applied, 1, "a skip already in the source does not block other edits");

  const backUp = ["## 甲", "", "### 乙", "", "#### 丙", "", "正文。", "", "丁", "", "正文。"].join("\n");
  assert.equal(apply(backUp, [{ type: "format", line: 9, text: "丁", level: 2 }]).applied, 1, "returning from #### to ## is legal");

  const demoteParent = ["## 甲", "", "### 乙", "", "#### 丙", "", "正文。"].join("\n");
  const orphan = apply(demoteParent, [{ type: "demote", line: 3, text: "乙" }]);
  assert.equal(orphan.applied, 0, "demoting a parent that leaves its child skipping a level is refused");
}

{
  const rows = [
    ["模块 | 职责", "--- | ---", "解析 | 读入文本"],
    ["模块 | 职责", "| --- | --- |", "| 解析 | 读入文本 |"],
    ["| 模块 | 职责 |", "--- | ---", "解析 | 读入文本"]
  ];
  for (const [header, delimiter, row] of rows) {
    const table = ["## 架构", "", header, delimiter, row, "## 下一节", "", "正文。"].join("\n");
    const input = buildHeadingInput(table);
    assert.ok(input.text.includes("3-5|[表格]"), "table rows with optional outer pipes are protected together");
    assert.ok(input.shown.has(5), "the heading immediately after the table is still visible");
    assert.equal(apply(table, [
      { type: "format", line: 3, text: header, level: 3 },
      { type: "format", line: 5, text: row, level: 3 }
    ]).content, table);
  }
  const proseWithPipe = ["## 甲", "", "命令 a | b 的写法", "", "正文。"].join("\n");
  assert.ok(buildHeadingInput(proseWithPipe).shown.has(2), "a pipe in prose without a delimiter row is not a table");
}

{
  const list = ["## 部署", "", "1. 安装依赖", "2. 修改配置", "", "正文。"].join("\n");
  assert.equal(apply(list, [{ type: "format", line: 3, text: "1. 安装依赖", level: 3 }]).applied, 0, "an item of a real list stays in the list");
  const loose = ["## 部署", "", "1. 安装依赖", "", "2. 修改配置", "", "正文。"].join("\n");
  assert.equal(apply(loose, [{ type: "format", line: 3, text: "1. 安装依赖", level: 3 }]).applied, 0, "a loose list item stays too");
  const continued = ["## 部署", "", "1. 安装依赖", "   需要 Node 22。", "", "正文。"].join("\n");
  assert.equal(apply(continued, [{ type: "format", line: 3, text: "1. 安装依赖", level: 3 }]).applied, 0, "an item with continuation stays");
  const section = ["导语。", "", "1. 引言", "", "引言正文。", "", "2. 方法", "", "方法正文。"].join("\n");
  const sections = apply(section, [
    { type: "format", line: 3, text: "1. 引言", level: 2 },
    { type: "format", line: 7, text: "2. 方法", level: 2 }
  ]);
  assert.equal(sections.applied, 2, "a numbered line standing alone between paragraphs can still be a section");
}

{
  const content = ["## 甲", "", "#### 旧跳级", "", "正文。", "", "## 乙", "", "正文。", "", "丙", "", "正文。"].join("\n");
  const swapped = apply(content, [
    { type: "level", line: 3, text: "旧跳级", level: 3 },
    { type: "format", line: 11, text: "丙", level: 4 }
  ]);
  assert.equal(swapped.applied, 1, "fixing one skip does not pay for a new skip elsewhere");
  assert.deepEqual(swapped.content.split("\n").filter((line) => line.startsWith("#")), ["## 甲", "### 旧跳级", "## 乙"]);
}

{
  assert.throws(() => readHeadingEdits({ decisions: [] }), /edits/);
  assert.deepEqual(readHeadingEdits({ edits: [] }), []);
}

assert.equal(
  stripHeadingNumbers("## 1. 简介\n\n### 二、 实现\n\n## 2026 年趋势\n\n## 3 种方法"),
  "## 简介\n\n### 实现\n\n## 2026 年趋势\n\n## 3 种方法"
);
assert.equal(
  stripHeadingNumbers("## 1.  一、业务背景：\n\n### 1.1.  提示词与 Skill 优化：从取得收益到提升放缓"),
  "## 业务背景：\n\n### 提示词与 Skill 优化：从取得收益到提升放缓",
  "numbers added by Obsidian's numbering plugin are stripped together with the source numbering"
);
assert.equal(stripHeadingNumbers("# 一级标题\n\n#### 四级"), "# 一级标题\n\n#### 四级", "levels are left to the model");
assert.equal(stripHeadingNumbers("```markdown\n## 1. 示例\n```"), "```markdown\n## 1. 示例\n```");
assert.equal(stripHeadingNumbers("## 1."), "## 1.", "a heading that is only a number keeps it");

await rm(tempDir, { recursive: true, force: true });
console.log("heading structure tests passed");
