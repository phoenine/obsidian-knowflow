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
    "The graph shows how events move through the queue.",
    "",
    "```mermaid",
    "mindmap",
    "  root((Queue))",
    "```",
    "",
    "## 普通章节",
    "",
    "没有标记，但仍应交给 AI 判断价值。"
  ].join("\n");

  const sections = prepareQuizSections(article);
  assert.deepEqual(sections.map((section) => section.title), ["导语", "核心章节", "Knowledge Map", "普通章节"]);
  assert.ok(sections[2].content.includes("The graph shows how events move through the queue."));
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

{
  // Bold markers exist in the article, but a quote that is only markup is not a source.
  const article = "**核心概念** 很重要，缓存失效有三种常见原因。";
  const options = ["A", "B", "C", "D"].map((key) => ({ key, content: "选项 " + key }));
  for (const sourceQuote of ["**", "*", "=="]) {
    const quiz = new QuizAi({
      requestJson: async (_model, messages) => ({
        sections: [{
          sectionId: JSON.parse(messages[1].content).sections[0].id,
          value: 3,
          questions: [{ focusType: "concept", sourceQuote, question: "题干 " + sourceQuote, options, answerKey: "A" }]
        }]
      })
    });
    assert.equal((await quiz.generateQuiz({}, "Articles/Markup.md", "标记", article, 4)).length, 0, `quote ${sourceQuote} must be rejected`);
  }
}

{
  // Spaced operators are part of the claim: `count == limit` is not the same text as `count limit`.
  const article = "当 count == limit 时停止重试。";
  const options = ["A", "B", "C", "D"].map((key) => ({ key, content: "选项 " + key }));
  const quizFor = (sourceQuote) => new QuizAi({
    requestJson: async (_model, messages) => ({
      sections: [{
        sectionId: JSON.parse(messages[1].content).sections[0].id,
        value: 3,
        questions: [{ focusType: "concept", sourceQuote, question: "何时停止？", options, answerKey: "A" }]
      }]
    })
  });
  assert.equal((await quizFor("当 count limit 时停止重试").generateQuiz({}, "Articles/Op.md", "运算", article, 4)).length, 0);
  assert.equal((await quizFor("当 count == limit 时停止重试").generateQuiz({}, "Articles/Op.md", "运算", article, 4)).length, 1);
}

{
  // Two options share the letter A with different text: the answer is ambiguous, so the whole question is rejected.
  const article = "队列按照先进先出的顺序处理任务。";
  const options = ["A", "B", "C", "D"].map((key) => ({ key, content: "选项 " + key }));
  const conflicting = [{ key: "A", content: "5" }, { key: "A", content: "4" }, ...options.slice(1)];
  const quizFor = (questionOptions) => new QuizAi({
    requestJson: async (_model, messages) => ({
      sections: [{
        sectionId: JSON.parse(messages[1].content).sections[0].id,
        value: 3,
        questions: [{ focusType: "concept", sourceQuote: article, question: "几？", options: questionOptions, answerKey: "A", explanation: "正确答案是 4" }]
      }]
    })
  });
  assert.equal((await quizFor(conflicting).generateQuiz({}, "Articles/Dup.md", "重复", article, 4)).length, 0);
  // The same letter with the same text collapses to one option and the question is kept.
  const repeated = [...options, { key: "A", content: "选项 A" }];
  assert.equal((await quizFor(repeated).generateQuiz({}, "Articles/Dup.md", "重复", article, 4)).length, 1);
}

await rm(tempDir, { recursive: true, force: true });
console.log("quiz generation tests passed");
