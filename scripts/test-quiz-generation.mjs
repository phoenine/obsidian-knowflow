import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const tempDir = await mkdtemp(join(tmpdir(), "knowflow-quiz-generation-"));
await esbuild.build({
  bundle: true,
  entryPoints: {
    "quiz-generation": "src/services/learning/quiz-generation.ts",
    "quiz-ai": "src/services/ai/quiz-ai.ts"
  },
  format: "esm",
  outdir: tempDir,
  platform: "node"
});
const {
  batchQuizSections,
  getQuizFocusTargets,
  getQuizQuestionLimit,
  prepareQuizSections
} = await import(pathToFileURL(join(tempDir, "quiz-generation.js")).href);
const { QuizAi } = await import(pathToFileURL(join(tempDir, "quiz-ai.js")).href);

{
  const article = [
    "---",
    "阅读价值: 5",
    "---",
    "",
    "> [!summary]- AI 摘要",
    "> **摘要加粗不应作为题源**",
    "",
    "文章导语。",
    "",
    "## 核心章节",
    "",
    "**核心概念** 与 ==关键结论==。",
    "<u>重要机制</u>，以及 *补充说明*。",
    "",
    "```markdown",
    "## 代码中的标题",
    "**代码中的加粗**",
    "```",
    "",
    "## Knowledge Map",
    "",
    "```mermaid",
    "mindmap",
    "  root((忽略))",
    "```",
    "",
    "## 普通章节",
    "",
    "没有标记，但仍应交给 AI 判断价值。"
  ].join("\n");

  const sections = prepareQuizSections(article);
  assert.deepEqual(sections.map((section) => section.title), ["导语", "核心章节", "普通章节"]);
  const core = sections.find((section) => section.title === "核心章节");
  assert.ok(core.content.includes("## 代码中的标题"), "H2 inside fenced code must not split sections");
  assert.deepEqual(
    core.marked.map((marked) => [marked.kind, marked.text]),
    [
      ["bold", "核心概念"],
      ["highlight", "关键结论"],
      ["underline", "重要机制"],
      ["italic", "补充说明"]
    ]
  );
  assert.ok(!sections.some((section) => section.content.includes("摘要加粗")));
}

{
  const longArticle = `## 超长章节\n\n${Array.from({ length: 40 }, (_, index) =>
    `第 ${index} 段：${"完整章节内容".repeat(80)}`
  ).join("\n\n")}`;
  const sections = prepareQuizSections(longArticle);
  assert.ok(sections.length > 1, "oversized H2 sections must be split without truncation");
  assert.ok(sections.at(-1).content.includes("第 39 段"));
  const batches = batchQuizSections(sections);
  assert.deepEqual(
    batches.flat().map((section) => section.id),
    sections.map((section) => section.id),
    "all section chunks must be included in batches"
  );
}

assert.deepEqual(
  [1, 2, 3, 4, 5].map(getQuizQuestionLimit),
  [4, 4, 8, 10, 12]
);
const targets = getQuizFocusTargets(10);
assert.equal(Object.values(targets).reduce((total, value) => total + value, 0), 10);
assert.equal(targets.principle, 3);
assert.ok(targets.concept >= 2 && targets.concept <= 3);

{
  const article = "队列按照先进先出的顺序处理任务。";
  const options = ["A", "B", "C", "D"].map((key) => ({ key, content: "选项 " + key + " " }));
  const valid = {
    focusType: "concept",
    sourceQuote: article,
    question: "队列按什么顺序处理任务？",
    options: [null, ...options],
    answerKey: "A"
  };
  const quiz = new QuizAi({
    requestJson: async (_model, messages) => ({
      sections: [
        null,
        {
          sectionId: JSON.parse(messages[1].content).sections[0].id,
          value: 3,
          questions: [null, { ...valid, options: [options[0], ...options.slice(0, 3)] }, valid]
        }
      ]
    })
  });
  const result = await quiz.generateQuiz({}, "Articles/Queue.md", "队列", article, 4);
  assert.equal(result.length, 1);
  assert.equal(result[0].question, valid.question);
  assert.deepEqual(result[0].options, options.map(({ key, content }) => ({ key, content: content.trim() })));

  const point = { id: "fifo", evidence: { section: "导语" } };
  const pointQuiz = new QuizAi({ requestJson: async () => ({ question: valid }) });
  assert.deepEqual(
    (await pointQuiz.generateKnowledgePointQuiz({}, "Articles/Queue.md", "队列", point)).options,
    result[0].options
  );
  const invalidPointQuiz = new QuizAi({
    requestJson: async () => ({ question: { ...valid, options: [null, options[0], options[0]] } })
  });
  await assert.rejects(
    invalidPointQuiz.generateKnowledgePointQuiz({}, "Articles/Queue.md", "队列", point),
    /did not return four valid options/
  );
}

await rm(tempDir, { recursive: true, force: true });
console.log("quiz generation tests passed");
