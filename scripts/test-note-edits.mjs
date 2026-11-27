import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const tempDir = await mkdtemp(join(tmpdir(), "knowflow-note-edits-"));
await esbuild.build({
  bundle: true,
  entryPoints: { "note-edits": "src/services/core/note-edits.ts" },
  format: "esm",
  outdir: tempDir,
  platform: "node"
});
const { prepareChatEdits, commitNoteEdits, paragraphOf } = await import(pathToFileURL(join(tempDir, "note-edits.js")).href);

const selected = (items) => new Set(items.map((_, index) => index));

{
  const note = "---\r\ntitle: 默认版本是 v1\r\n---\r\n\r\n正文。\r\n";
  assert.equal(paragraphOf(note, "默认版本是 v1"), null);
  const onlyInSummary = "> [!summary] AI 摘要\n> 这段只在摘要里。\n\n正文。\n";
  assert.equal(paragraphOf(onlyInSummary, "这段只在摘要里。"), null);
  const alsoInBody = "> [!summary] AI 摘要\n> 唯一说法。\n\n唯一说法。\n";
  assert.equal(paragraphOf(alsoInBody, "唯一说法。"), "唯一说法。");
}

{
  const note = "甲句。\r\n\r\n乙句。\r\n";
  const prepared = prepareChatEdits(note, [{ op: "replace", anchor: "甲句。", text: "甲改。" }]);
  const commit = commitNoteEdits(note, prepared.items, selected(prepared.items));
  assert.equal(commit.content, "甲改。\r\n\r\n乙句。\r\n");
  assert.deepEqual(commit.written, [0]);
}

{
  const note = "## 标题\n\n第一段。\n";
  const prepared = prepareChatEdits(note, [{ op: "insert", anchor: "第一段。", at: "before", text: "新段落" }]);
  const commit = commitNoteEdits(note, prepared.items, selected(prepared.items));
  assert.equal(commit.content, "## 标题\n\n新段落\n\n第一段。\n");
}

{
  const note = "说明。\n\n```\n第一行\n\n第二行\n```\n\n结尾。\n";
  assert.match(paragraphOf(note, "第一行"), /第一行\n\n第二行/);
}

{
  const note = "甲。补充。\n\n乙。\n";
  const prepared = prepareChatEdits(note, [{ op: "insert", anchor: "甲。", at: "after", text: "新段落" }]);
  const changed = "甲。另一句。\n\n乙。\n";
  const missed = commitNoteEdits(changed, prepared.items, selected(prepared.items));
  assert.equal(missed.written.length, 0);
  assert.equal(missed.skipped[0].reason, "paragraph");
  assert.equal(missed.content, changed);
  const elsewhere = "甲。补充。\n\n乙改。\n";
  const replaced = commitNoteEdits(elsewhere, prepareChatEdits(note, [{ op: "replace", anchor: "甲。", text: "甲改。" }]).items, new Set([0]));
  assert.equal(replaced.content, "甲改。补充。\n\n乙改。\n");
}

{
  const note = "段落。\n\n下一段。\n";
  const inserts = [
    { edits: [{ op: "insert", anchor: "段落。", at: "after", text: "甲注", paragraph: "段落。" }] },
    { edits: [{ op: "insert", anchor: "段落。", at: "after", text: "乙注", paragraph: "段落。" }] }
  ];
  const conflict = commitNoteEdits(note, inserts, new Set([0, 1]));
  assert.equal(conflict.content, note);
  assert.deepEqual(conflict.skipped.map((item) => item.reason), ["conflict", "conflict"]);
  const stacked = inserts.map((item) => ({ edits: [{ ...item.edits[0], stack: true }] }));
  const commit = commitNoteEdits(note, stacked, new Set([0, 1]));
  assert.equal(commit.content, "段落。\n\n甲注\n\n乙注\n\n下一段。\n");
}

{
  const note = "甲乙丙。\n\n独立句。\n";
  const items = [
    { edits: [{ op: "replace", anchor: "甲乙", text: "甲" }] },
    { edits: [{ op: "replace", anchor: "乙丙", text: "丙" }] },
    { edits: [{ op: "replace", anchor: "独立句。", text: "独立。" }] }
  ];
  const commit = commitNoteEdits(note, items, selected(items));
  assert.equal(commit.content, "甲乙丙。\n\n独立。\n");
  assert.deepEqual(commit.written, [2]);
  assert.equal(commit.skipped.length, 2);
}

{
  const note = "甲。\n\n乙。\n";
  const items = [
    { edits: [{ op: "replace", anchor: "甲。\n\n乙。", text: "合并。" }] },
    { edits: [{ op: "insert", anchor: "甲。", at: "after", text: "插入", paragraph: "甲。" }] }
  ];
  const commit = commitNoteEdits(note, items, selected(items));
  assert.equal(commit.content, note);
  assert.equal(commit.written.length, 0);
}

{
  const note = "甲。\n\n乙。\n";
  const items = [
    { edits: [{ op: "replace", anchor: "甲。", text: "新。" }] },
    { edits: [{ op: "insert", anchor: "甲。", at: "after", text: "附注", paragraph: "甲。" }] }
  ];
  const commit = commitNoteEdits(note, items, selected(items));
  assert.equal(commit.content, "新。\n\n附注\n\n乙。\n");
}

{
  const note = "甲句。\n\n乙句。\n";
  const replace = { op: "replace", anchor: "甲句。", text: "甲改。" };
  const insert = { op: "insert", anchor: "甲句。", at: "before", text: "新段落" };
  for (const edits of [[replace, insert], [insert, replace]]) {
    const prepared = prepareChatEdits(note, edits);
    const commit = commitNoteEdits(note, prepared.items, selected(prepared.items));
    assert.equal(commit.content, "新段落\n\n甲改。\n\n乙句。\n");
    assert.deepEqual(commit.written, [0, 1]);
  }
}

{
  const note = "---\ntitle: 笔记\n---\n甲句。\n";
  const prepared = prepareChatEdits(note, [{ op: "insert", anchor: "甲句。", at: "before", text: "新段落" }]);
  const commit = commitNoteEdits(note, prepared.items, selected(prepared.items));
  assert.equal(commit.content, "---\ntitle: 笔记\n---\n新段落\n\n甲句。\n");
  assert.ok(commit.content.startsWith("---\n"));
}

{
  const note = "甲。\n\n乙。更多。\n";
  const prepared = prepareChatEdits(note, [{ op: "insert", anchor: "甲。\n\n乙", at: "after", text: "插入" }]);
  assert.equal(prepared.items.length, 0);
  assert.equal(prepared.rejected[0].reason, "span");
  const changed = "甲。\n\n乙。别的。\n";
  const forced = commitNoteEdits(changed, [{
    edits: [{ op: "insert", anchor: "甲。\n\n乙", at: "after", text: "插入", paragraph: "甲。" }]
  }], new Set([0]));
  assert.equal(forced.written.length, 0);
  assert.equal(forced.skipped[0].reason, "span");
  assert.equal(forced.content, changed);
}

assert.equal(paragraphOf("历史文本包含 v100。", "v10"), null);
assert.equal(prepareChatEdits("甲。\n", Array.from({ length: 9 }, (_, index) => ({ op: "replace", anchor: "甲。", text: `乙${index}。` }))).items.length, 8);

{
  const insert = { op: "insert", anchor: "原段落。", at: "after", text: "新段落。" };
  const heading = "## 介绍\r\n原段落。\r\n";
  const headingEdit = prepareChatEdits(heading, [{ ...insert, anchor: "## 介绍" }]);
  assert.equal(
    commitNoteEdits(heading, headingEdit.items, selected(headingEdit.items)).content,
    "## 介绍\r\n\r\n新段落。\r\n\r\n原段落。\r\n"
  );
  for (const [open, close] of [["```text", "```"], ["$$", "$$"], ["%%", "%%"]]) {
    const unclosed = `${open}\n原段落。\n`;
    const closed = `${unclosed}${close}\n`;
    const preview = prepareChatEdits(closed, [insert]);
    assert.equal(commitNoteEdits(closed, preview.items, selected(preview.items)).content, `${closed}\n新段落。\n`);
    assert.deepEqual(prepareChatEdits(unclosed, [insert]).rejected, [{ index: 0, reason: "protected" }]);
    const confirmed = commitNoteEdits(unclosed, preview.items, selected(preview.items));
    assert.deepEqual(confirmed.skipped, [{ index: 0, reason: "protected" }]);
    assert.equal(confirmed.content, unclosed);
  }
}

await rm(tempDir, { recursive: true, force: true });
console.log("note edit tests passed");
