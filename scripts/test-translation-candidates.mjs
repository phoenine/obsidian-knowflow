import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const tempDir = await mkdtemp(join(tmpdir(), "knowflow-translation-"));
await esbuild.build({
  bundle: true,
  entryPoints: ["src/services/clipping/translation-candidates.ts"],
  format: "esm",
  outdir: tempDir,
  platform: "node"
});
const {
  applyTranslationDecisions,
  batchTranslationCandidates,
  collectTranslationCandidates
} = await import(pathToFileURL(join(tempDir, "translation-candidates.js")).href);

const english = [
  "# Reliable distributed systems",
  "",
  "Distributed systems are difficult because independent components can fail in many different ways.",
  "",
  "A good design makes failure explicit and keeps recovery operations safe to repeat.",
  "",
  "```ts",
  "const message = 'do not translate code';",
  "```",
  "",
  "> [!note] Keep this callout unchanged",
  "> This content is managed as an Obsidian structure."
].join("\n");

const candidates = collectTranslationCandidates(english);
assert.equal(candidates.length, 2);
assert.ok(candidates.every((candidate) => !candidate.content.includes("do not translate code")));
assert.ok(candidates.every((candidate) => !candidate.content.includes("callout")));

const translated = applyTranslationDecisions(english, candidates, [
  { id: candidates[0].id, translation: "分布式系统很困难，因为独立组件可能以多种不同方式发生故障。" },
  { id: candidates[1].id, translation: "良好的设计会明确呈现故障，并确保恢复操作可以安全地重复执行。" }
]);
assert.ok(translated.includes(`${candidates[0].content}（分布式系统很困难`));
assert.ok(translated.includes("```ts\nconst message = 'do not translate code';\n```"));
assert.ok(translated.includes("> [!note] Keep this callout unchanged"));
assert.ok(translated.includes("<!-- knowflow-translation -->"));
assert.equal(
  collectTranslationCandidates(translated).length,
  0,
  "running candidate collection again must not retranslate managed paragraphs"
);

const mixedLanguageArticle = [
  "# 混合语言文章",
  "",
  "这是一段已经存在的中文内容，不需要重复处理。",
  "",
  "This untouched English paragraph should still be selected for translation.",
  "",
  "This bilingual paragraph already has a translation. 这段内容已经有中文翻译。"
].join("\n");
const mixedCandidates = collectTranslationCandidates(mixedLanguageArticle);
assert.equal(mixedCandidates.length, 1);
assert.equal(
  mixedCandidates[0].content,
  "This untouched English paragraph should still be selected for translation.",
  "mixed-language articles must translate only their remaining English paragraphs"
);

const managedLegacyTranslation = [
  "This paragraph was translated before managed markers were introduced.",
  "",
  "这段中文使用旧版本的独立段落格式。",
  "<!-- knowflow-translation -->"
].join("\n");
assert.equal(
  collectTranslationCandidates(managedLegacyTranslation).length,
  0,
  "managed translations written in the previous layout must not be duplicated"
);

const unmanagedAdjacentChinese = [
  "This English paragraph has no managed translation marker.",
  "",
  "这只是相邻的普通中文段落，不应依靠语言比例猜测它是译文。"
].join("\n");
assert.equal(
  collectTranslationCandidates(unmanagedAdjacentChinese).length,
  1,
  "adjacent Chinese prose without a marker must not suppress translation"
);

const listArticle = [
  "2. Ordered list numbering must remain exactly as written.",
  "7) Alternative ordered markers must also remain unchanged.",
  "- Unordered list markers must be preserved by the writer.",
  "  * Nested unordered list indentation must remain unchanged.",
  "- [ ] Task list checkboxes must remain part of the original line."
].join("\n");
const listCandidates = collectTranslationCandidates(listArticle);
assert.equal(listCandidates.length, 5);
assert.deepEqual(
  listCandidates.map((candidate) => candidate.content),
  [
    "Ordered list numbering must remain exactly as written.",
    "Alternative ordered markers must also remain unchanged.",
    "Unordered list markers must be preserved by the writer.",
    "Nested unordered list indentation must remain unchanged.",
    "Task list checkboxes must remain part of the original line."
  ],
  "the model must receive list text without Markdown markers"
);

const translatedList = applyTranslationDecisions(
  listArticle,
  listCandidates,
  [
    "有序列表序号必须保持原样。",
    "另一种有序列表标记也必须保持不变。",
    "无序列表标记必须由程序保留。",
    "嵌套无序列表的缩进必须保持不变。",
    "任务列表复选框必须保留在原始行中。"
  ].map((translation, index) => ({ id: listCandidates[index].id, translation }))
);
assert.ok(translatedList.includes("2. Ordered list numbering must remain exactly as written.（有序列表序号必须保持原样。）"));
assert.ok(translatedList.includes("7) Alternative ordered markers must also remain unchanged.（另一种有序列表标记也必须保持不变。）"));
assert.ok(translatedList.includes("- Unordered list markers must be preserved by the writer.（无序列表标记必须由程序保留。）"));
assert.ok(translatedList.includes("  * Nested unordered list indentation must remain unchanged.（嵌套无序列表的缩进必须保持不变。）"));
assert.ok(translatedList.includes("- [ ] Task list checkboxes must remain part of the original line.（任务列表复选框必须保留在原始行中。）"));
assert.equal(collectTranslationCandidates(translatedList).length, 0);

const invalidMultilineTranslation = applyTranslationDecisions(listArticle, listCandidates, [
  { id: listCandidates[0].id, translation: "第一行\n- 新列表项" }
]);
assert.equal(invalidMultilineTranslation, listArticle, "multiline translations must not be inserted");

assert.deepEqual(
  batchTranslationCandidates(Array.from({ length: 30 }, (_, index) => ({
    id: `translation-${index}`,
    startLine: index,
    endLine: index,
    source: "A".repeat(1000),
    content: "A".repeat(1000)
  }))).flat().map((candidate) => candidate.id),
  Array.from({ length: 30 }, (_, index) => `translation-${index}`)
);

await rm(tempDir, { recursive: true, force: true });
console.log("translation candidate tests passed");
