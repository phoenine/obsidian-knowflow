import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const tempDir = await mkdtemp(join(tmpdir(), "knowflow-code-format-chat-"));
await esbuild.build({
  bundle: true,
  entryPoints: { "code-format-chat": "src/services/chat/code-format-chat.ts" },
  format: "esm",
  outdir: tempDir,
  platform: "node"
});
const {
  parseCodeFormatRequest,
  parseCodeFormatApply,
  locateCodeBlocks,
  renderCodeFormatReview
} = await import(pathToFileURL(join(tempDir, "code-format-chat.js")).href);

// Requests: whole-article and named-section forms.
assert.deepEqual(parseCodeFormatRequest("格式化代码块"), {});
assert.deepEqual(parseCodeFormatRequest("格式化文章中的代码块"), {});
assert.deepEqual(parseCodeFormatRequest("请帮我格式化文章里所有的代码块。"), {});
assert.deepEqual(parseCodeFormatRequest("格式化 2.4 exp 章节的代码块"), { section: "2.4 exp" });
assert.deepEqual(parseCodeFormatRequest("格式化 构建资产和体系 里的代码块"), { section: "构建资产和体系" });
assert.deepEqual(parseCodeFormatRequest("格式化第二个代码块"), { index: 2 });
assert.deepEqual(parseCodeFormatRequest("格式化 2.4 exp 里的第 3 个代码块"), { section: "2.4 exp", index: 3 });

// The exact wording used in the chat, with a comment request and filler words.
assert.deepEqual(parseCodeFormatRequest("格式化下2.4. exp下面的代码块，增加一些注释"), { section: "2.4. exp", comments: true });
assert.deepEqual(parseCodeFormatRequest("给 2.4. exp 代码块加注释"), { section: "2.4. exp", comments: true });

// Questions about code formatting are not requests to change the note.
assert.equal(parseCodeFormatRequest("为什么这段代码格式不对？"), null);
assert.equal(parseCodeFormatRequest("这段代码怎么格式化"), null);
assert.equal(parseCodeFormatRequest("代码格式对吗"), null);
assert.equal(parseCodeFormatRequest("总结一下这篇文章"), null);

// Replies while a preview is waiting.
assert.deepEqual(parseCodeFormatApply("应用第 1 个"), [1]);
assert.deepEqual(parseCodeFormatApply("应用第二个"), [2]);
assert.deepEqual(parseCodeFormatApply("应用全部"), "all");
assert.deepEqual(parseCodeFormatApply("apply 2"), [2]);
assert.equal(parseCodeFormatApply("更新"), null);

const note = [
  "# 标题",
  "",
  "### 2.4.  **exp",
  "",
  "```python",
  "import os",
  "```",
  "",
  "正文一句。",
  "",
  "```python",
  "print(1)",
  "```",
  "",
  "## 5.  构建资产和体系",
  "",
  "```text",
  "观测 → 轨迹",
  "```",
  "",
  "```shell",
  "ls -la",
  "```",
  ""
].join("\n");

{
  const all = locateCodeBlocks(note, {});
  assert.equal(all.blocks.length, 4, "all fenced blocks are located in order");
  assert.deepEqual(all.blocks.map((block) => block.section), ["2.4.  exp", "2.4.  exp", "5.  构建资产和体系", "5.  构建资产和体系"]);
  assert.equal(all.blocks[0].candidate.id, "fence-1");
  assert.equal(all.blocks[0].candidate.fenceLanguage, "python");
}
{
  const exp = locateCodeBlocks(note, { section: "exp" });
  assert.equal(exp.blocks.length, 2, "section keyword picks both blocks under that heading");
  const second = locateCodeBlocks(note, { section: "2.4 exp", index: 2 });
  assert.equal(second.blocks.length, 1);
  assert.equal(second.blocks[0].candidate.content, "print(1)");
  const shell = locateCodeBlocks(note, { section: "构建资产和体系", index: 2 });
  assert.equal(shell.blocks[0].candidate.fenceLanguage, "shell");
  assert.equal(locateCodeBlocks(note, { section: "不存在的章节" }).error, "section");
  const duplicate = `${note}\n## 6. exp\n\n\`\`\`python\nprint(2)\n\`\`\`\n`;
  assert.equal(locateCodeBlocks(duplicate, { section: "exp" }).error, "ambiguous");
  assert.equal(locateCodeBlocks(duplicate, { section: "6. exp" }).blocks.length, 1);
  assert.equal(locateCodeBlocks(note, { section: "exp", index: 3 }).error, "index");
  assert.equal(locateCodeBlocks(note, { index: 9 }).error, "index");
  assert.equal(locateCodeBlocks(note, parseCodeFormatRequest("格式化第 0 个代码块")).error, "index");
  assert.equal(locateCodeBlocks(note, parseCodeFormatRequest("格式化第 100 个代码块")).error, "index");
}
{
  // Filler words like "下面" and the comment request must not leak into the section name.
  const located = locateCodeBlocks(note, parseCodeFormatRequest("格式化下2.4. exp下面的代码块，增加一些注释"));
  assert.equal(located.error, undefined);
  assert.ok(located.blocks.length > 0 && located.blocks.every((block) => block.section.includes("exp")));
  assert.ok(located.blocks.every((block) => !block.section.includes("注释")));
}

const preview = renderCodeFormatReview([{ section: "2.4. exp", language: "python", content: "import os" }]);
assert.ok(preview.includes("**1**"));
assert.ok(preview.includes("```python\nimport os\n```"));
assert.ok(preview.includes("要写回这个代码块吗"), "a single block is not described as 全部");
assert.ok(!preview.includes("写入全部"));
const twoPreview = renderCodeFormatReview([
  { section: "a", language: "python", content: "x = 1" },
  { section: "a", language: "python", content: "y = 2" }
]);
assert.ok(twoPreview.includes("写入全部"));

await rm(tempDir, { recursive: true, force: true });
console.log("code format chat tests passed");
