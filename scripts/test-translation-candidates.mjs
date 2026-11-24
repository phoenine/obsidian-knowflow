import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const tempDir = await mkdtemp(join(tmpdir(), "knowflow-translation-"));
await esbuild.build({
  bundle: true,
  entryPoints: ["src/services/clipping/translation-candidates.ts", "src/services/ai/repair-ai.ts"],
  format: "esm",
  outdir: tempDir,
  platform: "node"
});
const {
  applyTranslationDecisions,
  batchTranslationCandidates,
  collectTranslationCandidates,
  planEnglishTranslation
} = await import(pathToFileURL(join(tempDir, "clipping", "translation-candidates.js")).href);
const { RepairAi } = await import(pathToFileURL(join(tempDir, "ai", "repair-ai.js")).href);

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
const fencedExample = ["````markdown", "```js", "An English sentence inside the example must stay unchanged.", "```", "````"].join("\n");
assert.deepEqual(collectTranslationCandidates(`${english}\n\n${fencedExample}`).map(({ content }) => content),
  candidates.map(({ content }) => content));
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
assert.equal(mixedCandidates.length, 0, "mixed-language articles must skip translation entirely");
assert.match(planEnglishTranslation(mixedLanguageArticle).skipReason, /包含中文/);

const libraryMetadata = [
  "**Radix UI** — Star 19,375｜ `@radix-ui/react-*` ｜MIT",
  "**Ant Design** — Star 99,729｜ `antd` ｜ **v6.6.5** ｜MIT",
  "**MUI** — Star 99,155｜ `@mui/material` ｜ **v9.5.0** ｜MIT",
  "**Chakra UI** — Star 40,679｜ `@chakra-ui/react` ｜ **v3.37.0** ｜MIT",
  "**Mantine** — Star 31,817｜ `@mantine/core` ｜ **v9.7.1** ｜MIT",
  "**HeroUI** — Star 30,895｜ `@heroui/react` ｜ **v3.2.6** ｜Apache-2.0",
  "**daisyUI** — Star 42,563｜ `daisyui` ｜ **v5.7.47** ｜MIT",
  "**Another Component Library** – GitHub Stars: 12.3k | `@example/components` | v1.2.3-beta.1 | BSD-3-Clause"
];
for (const line of libraryMetadata) {
  assert.equal(collectTranslationCandidates(line).length, 0, `metadata must stay unchanged: ${line}`);
  assert.equal(collectTranslationCandidates(`- ${line}`).length, 0, "metadata list items must also be skipped");
}
const libraryProse = [
  "Radix UI provides accessible components through the `@radix-ui/react-dialog` package.",
  "**Radix UI** — This library has 19,375 GitHub stars and provides accessible components.",
  "**Radix UI** — Star 19,375 | This library provides accessible components. | MIT",
  `${libraryMetadata[0]}\nThis library provides accessible components for application developers.`
];
for (const paragraph of libraryProse) {
  assert.equal(collectTranslationCandidates(paragraph).length, 1, "English prose about libraries must still be translated");
}

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
  0,
  "original Chinese prose must make the whole article ineligible"
);

const projectLink = "[esp32-iphone-agent](https://github.com/onehumanbeing/esp32-iphone-agent)";
const chineseArticle = `这篇文章介绍 ESP32 开发板如何入门，以及如何选择开源项目。\n\n- ${projectLink}`;
assert.deepEqual(planEnglishTranslation(chineseArticle), { candidates: [], skipReason: "正文包含中文" });
for (const content of [
  projectLink,
  `- ${projectLink}`,
  "`@example/very-long-component-package-name`",
  "https://github.com/onehumanbeing/esp32-iphone-agent",
  "[[Some Very Long Project Reference Name]]",
  "```python\n# 中文注释和 English code\nprint('hello')\n```",
  "$$\nE = mc^2\n$$"
]) {
  assert.deepEqual(planEnglishTranslation(content), { candidates: [], skipReason: "无可翻译正文" });
}
const decoratedEnglish = [
  "---", "简要描述: 这是一篇英文文章", "---", "",
  "> [!summary]- AI 摘要", "> 这是插件生成的中文摘要。", "",
  english, "", `- ${projectLink}`, "",
  "```ts", "// 代码中的中文不参与判定", "const x = 'value';", "```", "",
  "## 知识骨架", "插件生成的中文知识骨架。"
].join("\n");
assert.equal(collectTranslationCandidates(decoratedEnglish).length, 2, "generated Chinese and code must not block an English source");
assert.equal(collectTranslationCandidates(`${english}\n\n<!--\nThis hidden comment must never be translated by the plugin.\n-->\n\n    This indented code must also stay unchanged.`).length, 2);
assert.equal(collectTranslationCandidates(`${english}\n\n## Knowledge Map\n\nThis generated English explanation must not become a translation candidate.`).length, 2);
assert.equal(collectTranslationCandidates(`---\ndescription: This English metadata does not belong to the article.\n---\n\n${english}`).length, 2);
assert.equal(collectTranslationCandidates(`${english}\n\n> [!note] 原文备注\n> 这段中文是原作者写的正文备注。`).length, 0);
assert.equal(collectTranslationCandidates(`${english}\n\n    - 这是原文中的嵌套中文列表，不能忽略。`).length, 0);
const partiallyTranslated = applyTranslationDecisions(english, candidates, [validTranslation(candidates[0].id)]);
assert.deepEqual(collectTranslationCandidates(partiallyTranslated).map((candidate) => candidate.content), [candidates[1].content]);
assert.equal(collectTranslationCandidates(`${managedLegacyTranslation}\n\n${candidates[1].content}`).length, 1);

for (const foreign of [
  "Voici un paragraphe français qui explique comment utiliser cette bibliothèque dans une application.",
  "Este artículo explica cómo utilizar esta biblioteca para crear aplicaciones accesibles.",
  "Dieser Artikel beschreibt die Verwendung dieser Bibliothek für zuverlässige Anwendungen.",
  "これは英語ではなく日本語で書かれた説明文です。"
]) {
  assert.equal(collectTranslationCandidates(foreign).length, 0, "Latin letters do not imply English");
  assert.equal(collectTranslationCandidates(`${candidates[0].content}\n\n${foreign}`).length, 0, "one foreign paragraph must block the whole article");
}
assert.match(planEnglishTranslation("Hello world").skipReason, /无法确定/);
assert.equal(collectTranslationCandidates(`${english}\n\nBonjour tout le monde.`).length, 0, "uncertain short paragraphs must not be silently accepted");
const longMixedParagraph = `${candidates[0].content.repeat(35)} ${"Voici un paragraphe français qui explique comment utiliser cette bibliothèque dans une application. ".repeat(35)}`;
assert.equal(collectTranslationCandidates(longMixedParagraph).length, 0, "language detection must inspect past the first 2048 characters");

function validTranslation(id) {
  return { id, translation: "完整的中文译文。" };
}

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

const validResponse = {
  translations: candidates.map((candidate) => ({ id: candidate.id, translation: "完整的中文译文。" }))
};
const translateResponse = (payload) => new RepairAi({ requestJson: async () => payload })
  .translateEnglishParagraphs({}, "Test article", candidates);
assert.deepEqual(await translateResponse(validResponse), validResponse.translations);
assert.deepEqual(await translateResponse({ translations: [...validResponse.translations].reverse() }), [...validResponse.translations].reverse());
await assert.rejects(translateResponse({ translations: validResponse.translations.slice(0, 1) }), /translation-2.*未返回/);
for (const [translation, reason] of [
  ["Unchanged English prose.", /不含中文/],
  ["中文译文\n第二行", /换行/],
  ["中文译文 <!-- knowflow-translation -->", /标记/],
  ["中文译文 ```", /围栏/],
  ["中".repeat(12001), /过长/],
  [123, /字符串/]
]) {
  await assert.rejects(
    translateResponse({ translations: [validResponse.translations[0], { id: candidates[1].id, translation }] }),
    (error) => /英文翻译批次 1\/1/.test(error.message)
      && /translation-2/.test(error.message) && reason.test(error.message)
  );
}
await assert.rejects(translateResponse({ translations: [...validResponse.translations, validResponse.translations[0]] }), /translation-1.*重复/);
await assert.rejects(translateResponse({ translations: [{ id: "wrong-id", translation: "中文译文。" }] }), /未知 id.*wrong-id/);
await assert.rejects(translateResponse({ translations: [null] }), /第 1 项.*id/);
for (const payload of [null, [], {}, { translations: "中文译文" }]) {
  await assert.rejects(translateResponse(payload), /translations.*数组/);
}

await rm(tempDir, { recursive: true, force: true });
console.log("translation candidate tests passed");
