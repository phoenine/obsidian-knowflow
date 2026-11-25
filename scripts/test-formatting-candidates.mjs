import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const tempDir = await mkdtemp(join(tmpdir(), "knowflow-formatting-"));
await esbuild.build({
  bundle: true,
  entryPoints: {
    "formatting-candidates": "src/services/clipping/formatting-candidates.ts",
    "prompt-blocks": "src/services/clipping/prompt-blocks.ts",
    "clipped-code": "src/services/clipping/clipped-code.ts",
    "reading-structure": "src/services/clipping/reading-structure.ts",
    "detached-lists": "src/services/clipping/detached-lists.ts",
    "literal-html": "src/services/clipping/literal-html.ts"
  },
  format: "esm",
  outdir: tempDir,
  platform: "node"
});
const {
  applyFormattingDecisions,
  batchFormattingCandidates,
  collectHeadingCandidates,
  collectCodeCandidates,
  collectClippedCodeCandidates,
  hasSameNonWhitespaceContent,
  needsCodeReformat,
  normalizeBodyHeadingLevels,
  preferTextLanguage,
  restoreClippedShellContinuations,
  stripSequentialLineNumbers,
  trimCodeFenceBody
} = await import(pathToFileURL(join(tempDir, "formatting-candidates.js")).href);
const { formatPromptBlocks } = await import(pathToFileURL(join(tempDir, "prompt-blocks.js")).href);
const { prettyJsonBlock, removeClipperFenceSpacing, removePythonClipperSpacing, repairClippedYaml } = await import(pathToFileURL(join(tempDir, "clipped-code.js")).href);
const { repairTableDividers } = await import(pathToFileURL(join(tempDir, "reading-structure.js")).href);
const { restoreDetachedLists } = await import(pathToFileURL(join(tempDir, "detached-lists.js")).href);
const { escapeLiteralHtmlTags } = await import(pathToFileURL(join(tempDir, "literal-html.js")).href);

{
  const lines = ["# config.yaml", "memory:", "  root:./agent_memory", "  inject:", "    max_lines: 200", "    max_bytes: 25600", "    index_only: true"];
  const parseConfig = (source) => {
    if (!source.includes("  root: ./agent_memory")) throw new Error("Malformed YAML path");
    return { memory: { root: "./agent_memory", inject: { max_lines: 200, max_bytes: 25600, index_only: true } } };
  };
  assert.equal(repairClippedYaml(lines.join("\n\n"), parseConfig), lines.join("\n").replace("root:./", "root: ./"));

  const multiline = ["description: |", "  第一行", "  第二行", "options:", "  first: true", "  second: true"].join("\n\n");
  assert.equal(repairClippedYaml(multiline, (source) => ({ description: source.includes("第一行\n\n  第二行") ? "第一行\n\n第二行" : "第一行\n第二行" })), multiline);
}

{
  const header = "| 模型 | 无记忆 | 有记忆 | 增益 |";
  const row = "| 模型 A | 0.644 | 0.833 | +0.189 |";
  const divider = "| --- | --- | --- |";
  assert.equal(repairTableDividers([header, divider, row].join("\n")), [header, "| --- | --- | --- | --- |", row].join("\n"));
  const incomplete = [header, divider, "| 模型 A | 0.644 |"].join("\n");
  assert.equal(repairTableDividers(incomplete), incomplete);
}

{
  const source = ["import os", "import sys", "class Tool:", "    def run(self):", '        text = """第一段', "第二段", '"""', "        print(text)", "        return True"].join("\n\n");
  const expected = ["import os", "import sys", "", "class Tool:", "    def run(self):", '        text = """第一段', "", "第二段", "", '"""', "        print(text)", "        return True"].join("\n");
  assert.equal(removePythonClipperSpacing(source), expected);
  assert.equal(removePythonClipperSpacing(expected), expected);
}

{
  const yaml = ["# config.yaml", "memory:", "  root:./agent_memory", "  inject:", "    max_lines: 200", "    max_bytes: 25600"].join("\n\n");
  assert.equal(removeClipperFenceSpacing(yaml, "yaml"), yaml.replace(/\n\n/g, "\n"));
  const tree = ["agent_memory/", "├─ transcripts/", "│ └─ 2026-11-23/", "│ └─ s_8f3a.jsonl", "├─ notes/", "└─ config.yaml"].join("\n\n");
  assert.equal(removeClipperFenceSpacing(tree, "bash"), tree.replace(/\n\n/g, "\n"));
  const python = [
    "# memory/notes.py",
    "import re, time",
    "NOTE_TEMPLATE = \"\"\"---",
    "",
    "id: {id}",
    "",
    "claim: {claim}",
    "",
    "evidence: {evidence}",
    "",
    "status: {status}",
    "",
    "---",
    "",
    "\"\"\"",
    "def write_note():",
    "    return NOTE_TEMPLATE"
  ].join("\n");
  const compactTemplate = [
    "# memory/notes.py",
    "import re, time",
    "NOTE_TEMPLATE = \"\"\"---",
    "id: {id}",
    "claim: {claim}",
    "evidence: {evidence}",
    "status: {status}",
    "---",
    "\"\"\"",
    "def write_note():",
    "    return NOTE_TEMPLATE"
  ].join("\n");
  assert.equal(removeClipperFenceSpacing(python, "python"), compactTemplate);
  const prompt = ["把经验写进记忆。", "", "下次还会用到的结论才值得记。", "", "每条记忆必须给出依据。", "", "一条记忆只讲一件事。", "", "没有依据就不要写入。"].join("\n");
  assert.equal(removeClipperFenceSpacing(prompt, "text"), prompt);
  assert.equal(removeClipperFenceSpacing(["def run():", "", "    return 1"].join("\n"), "python"), ["def run():", "", "    return 1"].join("\n"));
}

{
  const source = ["...python", "", "def build\\_injection(root):", "", "　　return root", "", "下一段正文。"].join("\n");
  const candidates = collectClippedCodeCandidates(source);
  assert.equal(candidates.length, 1);
  assert.equal(applyFormattingDecisions(source, candidates, [{ id: candidates[0].id, action: "wrap-code", throughLine: 5 }]),
    ["```python", "def build_injection(root):", "", "    return root", "```", "", "下一段正文。"].join("\n"));
}

assert.equal(
  normalizeBodyHeadingLevels("## 1. 简介\n\n### 二、 实现\n\n## 2026 年趋势\n\n## 3 种方法"),
  "## 简介\n\n### 实现\n\n## 2026 年趋势\n\n## 3 种方法"
);
assert.equal(
  normalizeBodyHeadingLevels("## 1.  一、业务背景：\n\n### 1.1.  提示词与 Skill 优化：从取得收益到提升放缓\n\n## 2.  二、认识 Jev："),
  "## 业务背景：\n\n### 提示词与 Skill 优化：从取得收益到提升放缓\n\n## 认识 Jev："
);
assert.equal(
  normalizeBodyHeadingLevels("# 一级标题\n\n## 二级标题"),
  "## 一级标题\n\n### 二级标题",
  "body H1 must be demoted so the article title remains the only H1"
);
assert.equal(
  normalizeBodyHeadingLevels([
    "```markdown",
    "## Code example heading",
    "```",
    "",
    "### Actual body heading",
    "",
    "#### Actual child heading"
  ].join("\n")),
  [
    "```markdown",
    "## Code example heading",
    "```",
    "",
    "## Actual body heading",
    "",
    "### Actual child heading"
  ].join("\n"),
  "heading levels inside fenced code must not block promotion of body H3 headings"
);
assert.equal(
  normalizeBodyHeadingLevels("### 开头缺少父标题\n\n## 后续顶层标题"),
  "## 开头缺少父标题\n\n## 后续顶层标题",
  "the first real body heading must be H2 even when a later H2 exists"
);
assert.equal(
  normalizeBodyHeadingLevels("## 顶层标题\n\n#### 跳级子标题\n\n##### 下一级标题"),
  "## 顶层标题\n\n### 跳级子标题\n\n#### 下一级标题",
  "heading depth must not jump by more than one level"
);

{
  const article = [
    "正文介绍。",
    "",
    "产品经理不该按人头配齐",
    "",
    "这里解释产品经理的职责。"
  ].join("\n");
  const candidates = collectHeadingCandidates(article);
  const heading = candidates.find((candidate) => candidate.type === "possible-heading");
  assert.ok(heading);
  const formatted = applyFormattingDecisions(article, candidates, [
    { id: heading.id, action: "heading", level: 2 }
  ]);
  assert.ok(formatted.includes("## 产品经理不该按人头配齐"));
}

{
  const article = [
    "上一段正文。",
    "",
    "**人可以懒到什么地步**",
    "",
    "这里解释全自动工作流。"
  ].join("\n");
  const candidates = collectHeadingCandidates(article);
  const heading = candidates.find((candidate) => candidate.type === "possible-heading");
  assert.ok(heading);
  assert.equal(heading.content, "**人可以懒到什么地步**");
  assert.equal(heading.analysisContent, "人可以懒到什么地步");

  const formatted = applyFormattingDecisions(article, candidates, [
    { id: heading.id, action: "heading", level: 2 }
  ]);
  assert.ok(formatted.includes("## 人可以懒到什么地步"));

  const changedArticle = article.replace("**人可以懒到什么地步**", "**已被用户修改**");
  assert.equal(
    applyFormattingDecisions(changedArticle, candidates, [{ id: heading.id, action: "heading", level: 2 }]),
    changedArticle,
    "stale heading candidates must not modify changed source"
  );
}

{
  const article = [
    "## 1. 产品经理不该按人头配齐",
    "",
    "正文保持不变。"
  ].join("\n");
  const candidates = collectHeadingCandidates(article);
  assert.equal(applyFormattingDecisions(article, candidates, []), article);
  assert.ok(article.startsWith("## 1. "));
}

{
  const article = [
    "配置如下：",
    "",
    "apiVersion: v1",
    "kind: Pod",
    "metadata:",
    "  name: nginx",
    "",
    "配置结束。"
  ].join("\n");
  const { possibleCode: candidates } = collectCodeCandidates(article);
  const code = candidates.find((candidate) => candidate.type === "possible-code");
  assert.ok(code);
  const formatted = applyFormattingDecisions(article, candidates, [
    { id: code.id, action: "wrap-code", language: "yaml" }
  ]);
  assert.ok(formatted.includes("```yaml\napiVersion: v1\nkind: Pod\nmetadata:\n  name: nginx\n```"));
}

{
  const article = [
    "> [!summary]- AI 摘要",
    "> 核心观点",
    "> - 保留摘要内容",
    "",
    "> [!question]- Quiz",
    "> [[Quiz/测试题]]"
  ].join("\n");
  const candidates = collectHeadingCandidates(article);
  assert.equal(applyFormattingDecisions(article, candidates, []), article);
}

assert.equal(
  stripSequentialLineNumbers("1type: Metric\n2title: Revenue\n3description: 收入"),
  "type: Metric\ntitle: Revenue\ndescription: 收入"
);
{
  const numberedData = "```text\n1 apple\n2 banana\n3 carrot\n```";
  const dataCandidates = collectCodeCandidates(numberedData).fencedCode;
  assert.equal(dataCandidates.length, 1);
  assert.equal(applyFormattingDecisions(numberedData, dataCandidates, [{ id: dataCandidates[0].id, action: "keep" }]), numberedData);

  const numberedClip = "```yaml\n1type: Metric\n2title: Revenue\n3description: 收入\n```";
  const clipCandidates = collectCodeCandidates(numberedClip).fencedCode;
  assert.equal(clipCandidates.length, 1);
  assert.equal(applyFormattingDecisions(numberedClip, clipCandidates, [{ id: clipCandidates[0].id, action: "strip-line-numbers" }]),
    "```yaml\ntype: Metric\ntitle: Revenue\ndescription: 收入\n```");
}
assert.equal(
  stripSequentialLineNumbers("1company-knowledge/\n2├── index.md\n3└── log.md"),
  "company-knowledge/\n├── index.md\n└── log.md"
);
assert.equal(
  stripSequentialLineNumbers("2024\n2025\n2026"),
  "2024\n2025\n2026",
  "non-sequential numeric content must be preserved"
);

assert.equal(
  preferTextLanguage("观测 → 轨迹 → 挖掘 → 经验 → 召回 → 运行 → 再观测"),
  true,
  "arrow-chain prose must prefer text language"
);
assert.equal(
  preferTextLanguage("const value = 1;\nexport function run() {}"),
  false,
  "real code must not prefer text language"
);
assert.equal(
  preferTextLanguage("# 中文标题\n正文内容"),
  false,
  "Chinese Markdown must remain eligible for language classification"
);
assert.equal(
  preferTextLanguage("标题: 中文\n描述: 内容"),
  false,
  "Chinese YAML must remain eligible for language classification"
);
assert.equal(
  hasSameNonWhitespaceContent("const value=1;", "const value = 1;"),
  true,
  "whitespace-only formatting must be accepted"
);
assert.equal(
  hasSameNonWhitespaceContent("const value=1;", "const value = 2;"),
  false,
  "token changes must be rejected"
);
assert.equal(
  needsCodeReformat('node scripts/search.js search \\  --query "foo" \\  --confirm'),
  true,
  "mashed backslash continuations need AI reformat"
);
assert.equal(
  needsCodeReformat("const ok = 1;\nconst also = 2;"),
  false,
  "normal indented code should not need reformat"
);
assert.equal(
  trimCodeFenceBody("\n    line1\n    line2\n"),
  "    line1\n    line2",
  "trim must preserve relative indentation"
);

{
  const article = [
    "流程如下：",
    "",
    "```js",
    "观测 → 轨迹 → 挖掘 → 经验 → 召回 → 运行 → 再观测",
    "```",
    "",
    "命令：",
    "",
    "```shell",
    'node .skills/demo/scripts/search.js search \\  --query "排查超时" \\  --confirm-outbound',
    "```"
  ].join("\n");
  const { fencedCode } = collectCodeCandidates(article);
  assert.equal(
    fencedCode.some((candidate) => candidate.content.includes("观测 →")),
    false,
    "plain-text fence must skip LLM language classification"
  );
  const mangled = fencedCode.find((candidate) => candidate.needsReformat);
  assert.ok(mangled, "mashed shell fence must be collected for AI reformat");
  assert.equal(mangled.fenceLanguage, "shell");

  const reformatted = applyFormattingDecisions(article, fencedCode, [{
    id: mangled.id,
    action: "reformat-code",
    language: "shell",
    content: [
      "node .skills/demo/scripts/search.js search \\",
      '  --query "排查超时" \\',
      "  --confirm-outbound"
    ].join("\n")
  }]);
  assert.ok(reformatted.includes("```shell\nnode .skills/demo/scripts/search.js search \\\n  --query \"排查超时\" \\\n  --confirm-outbound\n```"));

  const changedLogic = applyFormattingDecisions(article, fencedCode, [{
    id: mangled.id,
    action: "reformat-code",
    language: "shell",
    content: [
      "node .skills/demo/scripts/search.js search \\",
      '  --query "其他内容" \\',
      "  --confirm-outbound"
    ].join("\n")
  }]);
  assert.equal(changedLogic, article, "AI output that changes code content must be rejected");
}

{
  const article = [
    "```text",
    "# 中文标题",
    "正文内容",
    "```",
    "",
    "```text",
    "标题: 中文",
    "描述: 内容",
    "```"
  ].join("\n");
  const { fencedCode } = collectCodeCandidates(article);
  assert.equal(fencedCode.length, 2, "Chinese Markdown and YAML must be sent for AI classification");
}

{
  const longArticle = Array.from({ length: 80 }, (_, index) => [
    "```",
    `const value${index} = ${index};`,
    "```",
    "",
    `正文段落 ${index}，用于构成长文章。`
  ].join("\n")).join("\n\n");
  const { fencedCode: candidates } = collectCodeCandidates(longArticle);
  assert.equal(candidates.length, 80);
  assert.ok(candidates.some((candidate) => candidate.content.includes("value79")), "late candidates must not be truncated");
}

{
  const candidates = Array.from({ length: 40 }, (_, index) => ({
    id: `long-${index}`,
    type: "possible-heading",
    startLine: index,
    endLine: index,
    content: `${index}-${"候选内容".repeat(180)}`,
    before: "",
    after: ""
  }));
  const batches = batchFormattingCandidates(candidates);
  assert.ok(batches.length > 1, "long candidate sets must be split into multiple requests");
  assert.deepEqual(
    batches.flat().map((candidate) => candidate.id),
    candidates.map((candidate) => candidate.id),
    "batching must preserve every candidate in order"
  );
}

{
  const article = "English paragraph.\n\n中文译文。\n<!-- knowflow-translation -->";
  const { possibleCode, fencedCode } = collectCodeCandidates(article);
  assert.ok(
    [...collectHeadingCandidates(article), ...possibleCode, ...fencedCode]
      .every((candidate) => !candidate.content.includes("knowflow-translation")),
    "managed translation markers must never become formatting candidates"
  );
}

{
  const instructions = ["保持房间的光线不变。", "", "【下一轮】", "只把参考图中的猫改成白色。"].join("\n");
  const article = [
    "### 2.1.  提示词节选", "", instructions, "", "第一行左边是模型 A", "![[效果图.png]]", "",
    "**提示词**", "", "画一张手冲咖啡步骤图。", "", "## 生成结果", "",
    "提示词", "", "![[只有结果图.png]]", "", "这段正文只是讨论提示词。"
  ].join("\n");
  const result = formatPromptBlocks(article);
  assert.equal(result.wrapped, 2);
  assert.equal(result.skipped, 1);
  assert.ok(result.content.includes("```text\n" + instructions + "\n```\n\n第一行左边是模型 A\n![[效果图.png]]"));
  assert.ok(result.content.includes("```text\n画一张手冲咖啡步骤图。\n```\n\n## 生成结果"));
  assert.ok(result.content.includes("提示词\n\n![[只有结果图.png]]"));
  assert.equal(collectCodeCandidates(result.content).fencedCode.length, 0, "prompt fences stay out of programming-code repair");
  const again = formatPromptBlocks(result.content);
  assert.equal(again.wrapped, 0);
  assert.equal(again.existing, 2);
  assert.equal(again.content, result.content, "the same prompts are already covered on the next run");
}

{
  const prompt = "输出包含 &#x20; 的字面示例。";
  const oldNote = ["### 提示词", "&#x20;", "```text", "~~~text", prompt, "~~~", "```", "", "## 生成结果"].join("\n");
  const result = formatPromptBlocks(oldNote);
  assert.equal(result.content, ["### 提示词", "", "```text", prompt, "```", "", "## 生成结果"].join("\n"));
  assert.deepEqual(result.bodies, [prompt]);
  assert.equal(formatPromptBlocks(result.content).content, result.content);

  const inner = ["保留下面的示例", "```js", "const x = 1;", "```"].join("\n");
  const oldTilde = ["提示词", "", "~~~text", inner, "~~~"].join("\n");
  const migrated = formatPromptBlocks(oldTilde);
  assert.equal(migrated.content, ["提示词", "", "````text", inner, "````"].join("\n"));
  assert.equal(collectCodeCandidates(migrated.content).fencedCode.length, 0);
}

{
  const article = [
    "编码和解决数学问题的提示词示例：",
    "",
    "> Begin by enclosing all thoughts within <thinking> tags.",
    ">",
    "> Use <count> tags after each step.",
    "",
    "## 3.  提示词范式解释",
    "",
    "[![](https://example.com/a.png)](https://example.com/a.png)"
  ].join("\n");
  const fenced = [
    "编码和解决数学问题的提示词示例：",
    "",
    "```text",
    "Begin by enclosing all thoughts within <thinking> tags.",
    "",
    "Use <count> tags after each step.",
    "```",
    "",
    "## 3.  提示词范式解释",
    "",
    "[![](https://example.com/a.png)](https://example.com/a.png)"
  ].join("\n");
  const result = formatPromptBlocks(article);
  assert.equal(result.wrapped, 1);
  assert.equal(result.content, fenced);
  assert.equal(formatPromptBlocks(result.content).content, result.content);
  assert.equal(collectCodeCandidates(result.content).fencedCode.length, 0);
}

{
  const article = [
    "下面这段说明里有标签。",
    "",
    "先写 <step> 再 </step> 继续。",
    "",
    "> Begin by enclosing all thoughts within <thinking> tags.",
    ">",
    "> Use <count> tags after each step.",
    "",
    "## 后文",
    "",
    "[![](https://example.com/a.png)](https://example.com/a.png)",
    "",
    "换行用 <br>，图片用 <img src=\"a.png\">。",
    "",
    "<video src=\"https://mpvideo.qpic.cn/a.mp4\" controls=\"\">您的浏览器不支持 video 标签</video>",
    "",
    "链接是 <https://example.com>。",
    "",
    "行内 `<thinking>` 保持原样。已转义 \\<thinking> 不再变化。",
    "",
    "上次转义的 \\<video src=\"https://example.com/a.mp4\" controls=\"\">播放\\</video> 应恢复。",
    "",
    "<!-- <note> 注释里的标签保持原样 -->",
    "",
    "```text",
    "这里的 <thinking> 已经在围栏里。",
    "```"
  ].join("\n");
  const expected = [
    "下面这段说明里有标签。",
    "",
    "先写 \\<step> 再 \\</step> 继续。",
    "",
    "> Begin by enclosing all thoughts within \\<thinking> tags.",
    ">",
    "> Use \\<count> tags after each step.",
    "",
    "## 后文",
    "",
    "[![](https://example.com/a.png)](https://example.com/a.png)",
    "",
    "换行用 <br>，图片用 <img src=\"a.png\">。",
    "",
    "<video src=\"https://mpvideo.qpic.cn/a.mp4\" controls=\"\">您的浏览器不支持 video 标签</video>",
    "",
    "链接是 <https://example.com>。",
    "",
    "行内 `<thinking>` 保持原样。已转义 \\<thinking> 不再变化。",
    "",
    "上次转义的 <video src=\"https://example.com/a.mp4\" controls=\"\">播放</video> 应恢复。",
    "",
    "<!-- <note> 注释里的标签保持原样 -->",
    "",
    "```text",
    "这里的 <thinking> 已经在围栏里。",
    "```"
  ].join("\n");
  const result = escapeLiteralHtmlTags(article);
  assert.equal(result.escaped, 6);
  assert.equal(result.content, expected);
  assert.equal(escapeLiteralHtmlTags(result.content).escaped, 0);
  assert.equal(escapeLiteralHtmlTags(result.content).content, result.content);
}

{
  const article = [
    "编码和解决数学问题的提示词示例：",
    "",
    "> Begin by enclosing all thoughts within <thinking> tags.",
    ">",
    "> Use <count> tags after each step.",
    "",
    "后面还有一个 <step>。"
  ].join("\n");
  const fenced = escapeLiteralHtmlTags(formatPromptBlocks(article).content);
  assert.ok(fenced.content.includes("```text\nBegin by enclosing all thoughts within <thinking> tags.\n\nUse <count> tags after each step.\n```"));
  assert.ok(fenced.content.includes("后面还有一个 \\<step>。"));
  assert.equal(fenced.escaped, 1);
}

{
  const nested = [
    "~~~markdown", "```", "", "内层示例", "", "# 示例标题", "```", "~~~", "",
    "%%", "", "私有批注", "", "%%", "", "这是正文标题", ""
  ].join("\n");
  assert.deepEqual(collectHeadingCandidates(nested).map(({ content }) => content), ["这是正文标题"]);
  assert.equal(collectCodeCandidates(nested).fencedCode.length, 0);
  assert.equal(normalizeBodyHeadingLevels(nested), nested);

  const quoted = String.raw`run "literal \\  --flag" --next`;
  const comment = String.raw`run --flag # example \  --safe`;
  assert.equal(restoreClippedShellContinuations(quoted, "sh"), quoted);
  assert.equal(restoreClippedShellContinuations(comment, "sh"), comment);
}

{
  const source = [
    "### 12.9.  五条可以搬去别处的设计思想",
    "",
    "这套东西虽然是给 Agent 记忆写的，但有五条能直接搬到别的系统里。",
    "",
    "1",
    "",
    "**只追加的真相源。** 任何派生数据都可能错，只有原始事件不会骗人。",
    "",
    "2",
    "",
    "**派生层可重建。** wiki、索引、摘要都能从日志重跑一遍。",
    "",
    "```",
    "1",
    "",
    "**代码里的序号保留。**",
    "",
    "2",
    "",
    "**不要收成列表。**",
    "```"
  ].join("\n");
  assert.equal(restoreDetachedLists(source), [
    "### 12.9.  五条可以搬去别处的设计思想",
    "",
    "这套东西虽然是给 Agent 记忆写的，但有五条能直接搬到别的系统里。",
    "",
    "1. **只追加的真相源。** 任何派生数据都可能错，只有原始事件不会骗人。",
    "",
    "2. **派生层可重建。** wiki、索引、摘要都能从日志重跑一遍。",
    "",
    "```",
    "1",
    "",
    "**代码里的序号保留。**",
    "",
    "2",
    "",
    "**不要收成列表。**",
    "```"
  ].join("\n"));
  assert.equal(restoreDetachedLists("1\n\n单独一项不收。"), "1\n\n单独一项不收。");
}

{
  const raw = '{  "state": {"query": "活动支持哪些配置，有什么门槛？"},  "questions": { "business_route": { "type": "choice", "活动咨询": "解释规则" } } }';
  const pretty = prettyJsonBlock(raw, "json");
  assert.equal(pretty, JSON.stringify(JSON.parse(raw), null, 2));
  assert.ok(pretty.includes("\n"));
  assert.equal(prettyJsonBlock(pretty, "json"), pretty);
  assert.equal(prettyJsonBlock("{bad", "json"), "{bad");
  assert.equal(prettyJsonBlock(raw, "text"), raw);
}

await rm(tempDir, { recursive: true, force: true });
console.log("formatting candidate tests passed");
