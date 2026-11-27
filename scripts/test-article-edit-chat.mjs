import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const tempDir = await mkdtemp(join(tmpdir(), "knowflow-article-edit-chat-"));
await esbuild.build({
  bundle: true,
  entryPoints: { "article-edit-chat": "src/services/chat/article-edit-chat.ts" },
  format: "esm",
  outdir: tempDir,
  platform: "node"
});
const {
  isArticleEditRequest,
  articleForEdit,
  readArticleEdits,
  chatEdits,
  renderArticleEditReview
} = await import(pathToFileURL(join(tempDir, "article-edit-chat.js")).href);

assert.equal(isArticleEditRequest("把开头那段改短"), true);
assert.equal(isArticleEditRequest("请帮我把第一段改成更短的说法"), true);
assert.equal(isArticleEditRequest("修改一下标题"), true);
assert.equal(isArticleEditRequest("删掉最后一句"), true);
assert.equal(isArticleEditRequest("帮我在第二节后面加上一段说明"), true);
assert.equal(isArticleEditRequest("rewrite the opening"), true);

assert.equal(isArticleEditRequest("为什么要把开头改短？"), false);
assert.equal(isArticleEditRequest("总结一下这篇文章"), false);
assert.equal(isArticleEditRequest("检查当前文章是否过时"), false);
assert.equal(isArticleEditRequest("格式化文章中的代码块"), false);
assert.equal(isArticleEditRequest("更新"), false);
assert.equal(isArticleEditRequest("好"), false);

{
  const article = `${"甲".repeat(20000)}\n目标句子在后面。\n${"乙".repeat(8000)}`;
  const excerpt = articleForEdit(article, "把「目标句子在后面。」改短");
  assert.equal(excerpt.truncated, true);
  assert.ok(excerpt.text.includes("目标句子在后面。"));
  assert.ok(!excerpt.text.endsWith("乙".repeat(8000)));
}
assert.equal(articleForEdit("短文章", "改短").truncated, false);

assert.deepEqual(readArticleEdits({
  edits: [
    { op: "insert", anchor: "原文", at: "before", text: "新段落" },
    { before: "原文", after: "" },
    { before: "  ", after: "x" },
    { before: "同样", after: "同样" }
  ]
}), [
  { op: "insert", anchor: "原文", at: "before", text: "新段落" },
  { op: "delete", anchor: "原文" }
]);
assert.equal(readArticleEdits({ edits: [{ op: "rename", anchor: "原文" }, { op: "insert", anchor: "原文", text: "新段落" }] }).length, 0);
assert.equal(readArticleEdits({}), null);
assert.equal(readArticleEdits({ edits: "no" }), null);

const note = "开头。\n\n用队列连接生产者和消费者。\n\n结尾。\n";
{
  const prepared = chatEdits(note, [{ before: "用队列连接生产者和消费者。", after: "用队列解耦生产者和消费者。" }]);
  assert.equal(prepared.items.length, 1);
  assert.match(renderArticleEditReview(prepared.items), /要把这次修改写回文章吗/);
}
assert.equal(chatEdits(note, [{ before: "不存在的句子。", after: "新句子。" }]).rejected[0].reason, "missing");
assert.equal(chatEdits("同样。\n\n同样。\n", [{ before: "同样。", after: "不同。" }]).rejected[0].reason, "ambiguous");
assert.equal(chatEdits(note, [{ before: "用队列", after: "用队列" }]).items.length, 0);

await rm(tempDir, { recursive: true, force: true });
console.log("article edit chat tests passed");
