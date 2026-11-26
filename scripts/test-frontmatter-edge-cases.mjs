import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

// This suite documents the known boundaries of the hand-rolled, line-based
// frontmatter parser in frontmatter-rules.ts. It is not a real YAML parser:
// it deliberately preserves raw formatting (field order, comments, Templater
// tags like <% tp.date.now(...) %>) instead of re-serializing through a YAML
// library, which would normalize/lose that formatting. These tests lock in
// what currently works and make the remaining sharp edges explicit so future
// changes don't regress them silently.

const tempDir = await mkdtemp(join(tmpdir(), "knowflow-frontmatter-"));
await esbuild.build({
  bundle: true,
  entryPoints: ["src/services/clipping/frontmatter-rules.ts"],
  format: "esm",
  outdir: tempDir,
  platform: "node"
});
const { applyArticleFrontmatter, applyLearningCompletionFrontmatter, applySummaryFrontmatter, fillEmptyNoteProperties, updateFrontmatterCategory } = await import(
  pathToFileURL(join(tempDir, "frontmatter-rules.js")).href
);

{
  const initial = '---\n创建日期: 2026-11-24\n学习日期: <% tp.date.now("YYYY-MM-DD") %>\n阅读价值: 0\n分类: LLM\n---\n正文';
  const result = applyArticleFrontmatter("正文", initial, "", { title: "正文", today: "2026-11-25" });
  assert.match(result, /创建日期: 2026-11-24\n学习日期:\n阅读价值:\n分类: LLM/);
}

const baseData = { title: "标题", today: "2026-08-04" };

// Completing a Task Overview item must update both learning fields while
// preserving unrelated frontmatter and body content.
{
  const original = "---\n分类: AI\n学习日期:\n学习状态:\n  - 未学习\n---\n正文";
  const result = applyLearningCompletionFrontmatter(original, "2026-08-09");
  assert.ok(result.includes("分类: AI"));
  assert.ok(result.includes("学习日期: 2026-08-09"));
  assert.ok(result.includes("学习状态:\n  - 已学习"));
  assert.ok(result.endsWith("正文"));
}

// Genuinely empty frontmatter ("---\n---\n") must still be recognized as
// frontmatter (not folded into the body) and get KnowFlow's fields filled in.
{
  const original = "---\n---\n正文内容";
  const result = applyArticleFrontmatter("正文内容", original, "", baseData);
  assert.ok(result.startsWith("---\n"), "must still detect the empty frontmatter block");
  assert.ok(result.includes("分类:\n"), "分类 must get a blank placeholder when there's no template and no AI summary yet");
  assert.ok(result.includes("正文内容"));
  assert.ok(!result.includes("---\n正文内容---"), "body must not get swallowed into the frontmatter");
}

// A note with no frontmatter at all must be left as plain content passed
// through updateFrontmatterCategory (nothing to update, no crash).
{
  const noFrontmatter = "# 标题\n\n正文";
  assert.equal(updateFrontmatterCategory(noFrontmatter, "AI"), noFrontmatter);
}

{
  const original = "\uFEFF---\n简要描述: \"包含---的属性\"\n分类: 旧分类\n---\n\n正文";
  const updated = updateFrontmatterCategory(original, "AI");
  assert.ok(updated.includes('简要描述: "包含---的属性"'));
  assert.ok(updated.includes("分类:\n  - AI"), "plugin-written 分类 stays a list");
  assert.ok(updated.endsWith("\n\n正文"));
}

// CRLF line endings in the original file must not break field detection or
// produce mixed line-ending output.
{
  const crlfOriginal = ["---", "分类: 旧分类", "状态: false", "---", "正文"].join("\r\n");
  const result = applyArticleFrontmatter("正文", crlfOriginal, "", baseData);
  assert.ok(result.includes("分类: 旧分类"), "applyArticleFrontmatter no longer touches 分类 — it must be preserved as-is");
  assert.ok(!result.includes("\r"), "output should be normalized to \\n only");
}

// Author wikilinks are display aliases, not part of the author name.
{
  const original = [
    "---",
    "文章作者: \"[[Mars任鑫]]\"",
    "状态: false",
    "---",
    "正文"
  ].join("\n");
  const result = applyArticleFrontmatter("正文", original, "", baseData);
  assert.ok(result.includes("文章作者: Mars任鑫"));
  assert.ok(!result.includes("[["));
  const aliased = applyArticleFrontmatter("正文", "---\n文章作者: \"[[uid|懿航]]\"\n---\n正文", "", baseData);
  assert.ok(aliased.includes("文章作者: 懿航"));
}

// Ordinary author values are already valid YAML.
{
  const original = "---\n文章作者: Mars任鑫\n---\n正文";
  const result = applyArticleFrontmatter("正文", original, "", baseData);
  assert.ok(result.includes('文章作者: Mars任鑫'));
}

// YAML reserves @ at the start of a plain scalar. Author handles must remain
// intact but be quoted so Obsidian can parse and render the whole frontmatter.
{
  const original = "---\n文章作者: @undefinedKi\n---\n正文";
  const result = applyArticleFrontmatter("正文", original, "", baseData);
  assert.ok(result.includes('文章作者: "@undefinedKi"'));
  assert.ok(!result.includes("文章作者: @undefinedKi"));
}

// Tab-indented continuation lines under a block field must still be treated
// as part of that field's value, not mistaken for a new top-level key.
{
  const tabIndented = [
    "---",
    "学习状态:",
    "\t- 学习中",
    "分类: 旧分类",
    "---",
    "正文"
  ].join("\n");
  const result = applyArticleFrontmatter("正文", tabIndented, "", baseData);
  assert.ok(result.includes("分类: 旧分类"), "分类 must still be found intact after a tab-indented block");
  assert.ok(result.includes("学习中"), "tab-indented continuation content must be preserved, not dropped");
}

// applySummaryFrontmatter writes the supplied property fields. Inline flow-style tags
// (e.g. `tags: [a, b, c]`) must still be detected as the `tags` key and
// fully replaced with the AI's tags — KnowFlow intentionally overwrites
// the old tags when a summary supplies updated tags so Obsidian can
// use them in tag search and graph view.
{
  const inlineArray = [
    "---",
    "tags: [foo, bar, baz]",
    "分类: 旧分类",
    "---",
    "正文"
  ].join("\n");
  const result = applySummaryFrontmatter(inlineArray, { description: "描述", readingValue: 3, category: "AI", tags: ["AI", "效率"] });
  assert.ok(!result.includes("[foo, bar, baz]"), "old inline tags must be replaced, not preserved");
  assert.ok(result.includes("  - AI") && result.includes("  - 效率"), "AI tags must be written as a YAML list");
  assert.ok(result.includes("分类:\n  - AI"), "applySummaryFrontmatter overwrites 分类 with the AI's suggestion, as a list");
}

{
  const original = "---\n简要描述: 旧描述\n阅读价值: 4\n分类: 知识积累\ntags: [Obsidian]\n---\n正文";
  const result = applySummaryFrontmatter(original, { description: "新描述" });
  assert.ok(result.includes("新描述"));
  assert.ok(result.includes("阅读价值: 4\n分类: 知识积累\ntags: [Obsidian]"));
}

// When the AI returns no tags, fall back to the "clippings" placeholder
// instead of leaving an empty tags field behind.
{
  const original = "---\n---\n正文";
  const result = applySummaryFrontmatter(original, { description: "描述", readingValue: 3, category: "AI", tags: [] });
  assert.ok(result.includes("  - clippings"), "must fall back to the clippings placeholder when there are no AI tags");
}

// applySummaryFrontmatter must never touch the body, even when there's no
// frontmatter block yet to begin with.
{
  const noFrontmatter = "# 标题\n\n正文内容保持不变";
  const result = applySummaryFrontmatter(noFrontmatter, { description: "描述", readingValue: 3, category: "AI", tags: [] });
  assert.ok(result.includes("# 标题\n\n正文内容保持不变"), "body must be untouched even when frontmatter had to be created");
}

// updateFrontmatterCategory (used by moveToCategory) must be a pure,
// single-field patch that leaves every other line untouched, including
// Templater expressions that are not valid standalone YAML scalars.
{
  const withTemplater = [
    "---",
    "创建日期: <% tp.date.now(\"YYYY-MM-DD\") %>",
    "分类: 旧分类",
    "---",
    "正文"
  ].join("\n");
  const result = updateFrontmatterCategory(withTemplater, "新分类");
  assert.ok(result.includes("创建日期: <% tp.date.now(\"YYYY-MM-DD\") %>"), "Templater tag must be untouched");
  assert.ok(result.includes("分类:\n  - 新分类"));
}

{
  const note = "---\n阅读价值: 0\n分类:\ntags:\n  - clippings\n简要描述:\n---\n正文";
  const filled = fillEmptyNoteProperties(note, {
    description: "说明事件日志。",
    readingValue: 4,
    category: "人工智能",
    tags: ["agent-memory"]
  });
  assert.deepEqual(filled.filled, ["简要描述", "阅读价值", "分类", "标签"]);
  assert.match(filled.content, /简要描述: "说明事件日志。"/);
  assert.match(filled.content, /阅读价值: 4/);
  assert.match(filled.content, /分类:\n  - 人工智能/);
  assert.match(filled.content, /  - agent-memory/);
  assert.doesNotMatch(filled.content, /clippings/);

  const kept = fillEmptyNoteProperties("---\n简要描述: \"已有描述\"\n阅读价值: 2\n分类: 知识积累\ntags:\n  - kept\n---\n正文", {
    description: "新描述",
    readingValue: 5,
    category: "人工智能",
    tags: ["agent-memory"]
  });
  assert.deepEqual(kept.filled, []);
  assert.match(kept.content, /已有描述/);
  assert.match(kept.content, /阅读价值: 2/);
  assert.match(kept.content, /分类: 知识积累/);
  assert.match(kept.content, /  - kept/);

  const replaced = fillEmptyNoteProperties(kept.content, {
    description: "新描述",
    readingValue: 5,
    category: "人工智能",
    tags: ["agent-memory"]
  }, { replaceExisting: true });
  assert.deepEqual(replaced.filled, ["简要描述", "阅读价值", "分类", "标签"]);
  assert.match(replaced.content, /简要描述: "新描述"/);
  assert.match(replaced.content, /阅读价值: 5/);
  assert.match(replaced.content, /分类:\n  - 人工智能/);
  assert.match(replaced.content, /  - agent-memory/);
  assert.doesNotMatch(replaced.content, /kept/);
}

await esbuild.build({
  bundle: true,
  entryPoints: ["src/services/ai/note-properties-ai.ts"],
  format: "esm",
  outfile: join(tempDir, "note-properties-ai.js"),
  platform: "node",
  plugins: [{
    name: "stub-obsidian",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
      build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export const requestUrl = async () => ({});", loader: "js" }));
    }
  }]
});
const { readNoteProperties } = await import(pathToFileURL(join(tempDir, "note-properties-ai.js")).href);
const categories = ["人工智能", "知识积累"];
const accepted = readNoteProperties({
  briefDescription: "用事件日志保存原始记录，再用派生索引提供查询。",
  readingValue: 4,
  category: "人工智能",
  tags: ["agent-memory"]
}, categories);
assert.equal(accepted.description, "用事件日志保存原始记录，再用派生索引提供查询。");
assert.equal(readNoteProperties({ briefDescription: "Agent就能做视频哎嘿。" }, categories).description, undefined);
assert.equal(readNoteProperties({ briefDescription: "这篇文章太香了！" }, categories).description, undefined);
// The model sometimes echoes the option list as an array; the one matching option must still be used.
// Several candidates are ambiguous: the answer is invalid, not "the first match".
assert.equal(readNoteProperties({ briefDescription: "用事件日志保存原始记录，再用派生索引提供查询。", category: ["人工智能", "知识积累"] }, categories).category, undefined);
assert.equal(readNoteProperties({ category: ["不存在的分类"] }, categories).category, undefined);
assert.equal(readNoteProperties({ category: ["知识积累"] }, categories).category, "知识积累");
// A number is a wrong type, not an empty description, so the existing one is kept.
const numeric = readNoteProperties({ briefDescription: 12345678901234567890, category: "技术" }, categories);
assert.equal(numeric.descriptionRejected, true);
assert.equal(fillEmptyNoteProperties("---\n简要描述: \"旧的有效描述\"\n---\n正文", numeric, { replaceExisting: true, keepExistingDescription: numeric.descriptionRejected }).clearedDescription, false);
assert.equal(readNoteProperties({ briefDescription: "" }, categories).descriptionRejected, undefined, "an empty description is simply missing");
assert.equal(readNoteProperties({ category: ["知识积累"] }, categories).category, "知识积累");
assert.equal(readNoteProperties({ category: "知识积累" }, categories).category, "知识积累");
// A rejected description is not an empty one: the existing 简要描述 must survive the rewrite.
const rejected = readNoteProperties({ briefDescription: "这篇文章太香了！" }, categories);
assert.equal(rejected.descriptionRejected, true);
const existing = "---\n简要描述: \"旧的有效描述\"\n阅读价值: 3\n---\n正文";
const keptByRejection = fillEmptyNoteProperties(existing, rejected, { replaceExisting: true, keepExistingDescription: rejected.descriptionRejected });
assert.match(keptByRejection.content, /旧的有效描述/);
assert.equal(keptByRejection.clearedDescription, false);
// Nothing usable at all still clears the field, as the clipping rules say.
const cleared = fillEmptyNoteProperties(existing, readNoteProperties({}, categories), { replaceExisting: true });
assert.equal(cleared.clearedDescription, true);
assert.doesNotMatch(cleared.content, /旧的有效描述/);

await rm(tempDir, { recursive: true, force: true });
console.log("frontmatter edge case tests passed");
