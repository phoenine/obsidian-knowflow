import type { AiModelConfig, KnowledgePoint, KnowledgePointGroup, QuizQuestion } from "../../types";
import { AiTransport } from "./ai-transport";
import type { ChatRequestMessage } from "../chat/chat-context";
import { batchQuizSections, getQuizFocusTargets, getQuizQuestionLimit, prepareQuizSections } from "../learning/quiz-generation";
import type { QuizFocusType, QuizSourceSection } from "../learning/quiz-generation";

interface QuizBatchResponse {
  sections: Array<{
    sectionId: string;
    value: number;
    questions: Array<{
      focusType: QuizFocusType;
      sourceQuote: string;
      knowledgePointId?: string;
      question: string;
      options: Array<{ key: string; content: string }>;
      answerKey: string;
      explanation: string;
      difficulty: number;
    }>;
  }>;
}

interface RatedQuizQuestion {
  focusType: QuizFocusType;
  sectionId: string;
  sectionValue: number;
  markedPriority: number;
  question: QuizQuestion;
}

interface KnowledgePointQuizResponse {
  question: {
    question: string;
    options: Array<{ key: string; content: string }>;
    answerKey: string;
    explanation: string;
    difficulty: number;
  };
}

export class QuizAi {
  constructor(private transport: AiTransport) {}

  async generateQuiz(
    config: AiModelConfig,
    filePath: string,
    title: string,
    content: string,
    readingValue: number,
    knowledgePointGroups: KnowledgePointGroup[] = []
  ): Promise<QuizQuestion[]> {
    const sections = prepareQuizSections(content);
    if (sections.length === 0) return [];
    const batches = batchQuizSections(sections);
    const limit = getQuizQuestionLimit(readingValue);
    const focusTargets = getQuizFocusTargets(limit);
    const totalChars = sections.reduce((total, section) => total + section.content.length, 0) || 1;
    const rated: RatedQuizQuestion[] = [];
    const knowledgePoints = knowledgePointGroups.flatMap((group) => group.points);
    const knowledgePointIds = new Set(knowledgePoints.map((point) => point.id));

    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      const batchChars = batch.reduce((total, section) => total + section.content.length, 0);
      const batchQuestionLimit = Math.max(1, Math.ceil(limit * batchChars / totalChars) + 1);
      try {
        const payload = await this.transport.requestJson<QuizBatchResponse>(
          config,
          buildQuizBatchMessages(title, readingValue, batch, batchQuestionLimit, focusTargets, knowledgePoints)
        );
        rated.push(...normalizeQuizBatchResponse(payload, batch, filePath, knowledgePointIds));
      } catch (error) {
        throw new Error(
          `Quiz 章节批次 ${index + 1}/${batches.length} 处理失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return selectQuizQuestions(rated, limit, focusTargets);
  }

  async generateKnowledgePointQuiz(
    config: AiModelConfig,
    filePath: string,
    articleTitle: string,
    point: KnowledgePoint
  ): Promise<QuizQuestion> {
    const payload = await this.transport.requestJson<KnowledgePointQuizResponse>(config, [
      {
        role: "system",
        content: [
          "你是 KnowFlow 的针对性出题器。只根据给定知识点及其原文依据生成一道中文单选题。",
          "题目必须检验理解而不是字面记忆；提供 A/B/C/D 四个选项、唯一答案和解析。",
          "不得引入原文依据之外的事实。只输出严格 JSON。"
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          articleTitle,
          knowledgePoint: point,
          requiredJsonShape: {
            question: {
              question: "题干",
              options: [
                { key: "A", content: "选项 A" },
                { key: "B", content: "选项 B" },
                { key: "C", content: "选项 C" },
                { key: "D", content: "选项 D" }
              ],
              answerKey: "A | B | C | D",
              explanation: "答案与错误选项解析",
              difficulty: "1-5 integer"
            }
          }
        })
      }
    ]);
    return normalizeKnowledgePointQuiz(payload, filePath, point.id, point.evidence.section);
  }
}

function buildQuizBatchMessages(
  title: string,
  readingValue: number,
  sections: QuizSourceSection[],
  batchQuestionLimit: number,
  focusTargets: Record<QuizFocusType, number>,
  knowledgePoints: KnowledgePoint[]
): ChatRequestMessage[] {
  return [
    {
      role: "system",
      content: [
        "你是 KnowFlow 的学习测验出题器。逐章判断知识价值，只为有明确学习价值的章节出题；背景、宣传、重复内容和无可检验知识的章节必须返回 value=0、questions=[]。",
        "必须只根据提供的文章章节出题，不得引入文章外事实。",
        "优先从标记内容取材：bold 最高，highlight 和 underline 为高，italic 为中；标记不足时再从同章节正文补充。",
        "标记只是价值信号，不代表一定值得出题，仍需根据语义判断。",
        "focusType 只能是 concept、principle、comparison、application、pitfall。",
        "只生成单选题；每题必须有题干、A/B/C/D 四个选项、唯一答案和中文解析。",
        "sourceQuote 必须逐字引用对应章节中的原始依据，用于验证题目没有编造。",
        "错误选项要有迷惑性，但不能明显荒谬或包含文章未涉及的事实。",
        "输出严格 JSON，不要输出 Markdown。"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        articleTitle: title,
        readingValue,
        batchQuestionLimit,
        articleFocusTargets: focusTargets,
        knowledgePoints: knowledgePoints.map((point) => ({
          id: point.id,
          title: point.title,
          sourceSection: point.evidence.section
        })),
        markerPriority: {
          bold: "最高",
          highlight: "高",
          underline: "高",
          italic: "中，仅在其他标记不足时使用"
        },
        sections: sections.map((section) => ({
          id: section.id,
          title: section.title,
          marked: section.marked,
          content: section.content
        })),
        requiredJsonShape: {
          sections: [{
            sectionId: "输入中的章节 id",
            value: "0-3 integer；0 表示不出题",
            questions: [{
              focusType: "concept | principle | comparison | application | pitfall",
              sourceQuote: "对应章节中的原文",
              knowledgePointId: "关联知识点 id；没有匹配项时留空",
              question: "题干",
              options: [
                { key: "A", content: "选项 A" },
                { key: "B", content: "选项 B" },
                { key: "C", content: "选项 C" },
                { key: "D", content: "选项 D" }
              ],
              answerKey: "A | B | C | D",
              explanation: "答案与错误选项解析",
              difficulty: "1-5 integer"
            }]
          }]
        }
      })
    }
  ];
}

function normalizeQuizBatchResponse(
  value: QuizBatchResponse,
  sourceSections: QuizSourceSection[],
  filePath: string,
  knowledgePointIds: Set<string>
): RatedQuizQuestion[] {
  const now = new Date().toISOString();
  const byId = new Map(sourceSections.map((section) => [section.id, section]));
  const sections = Array.isArray(value.sections) ? value.sections : [];
  const result: RatedQuizQuestion[] = [];
  for (const sectionResult of sections) {
    const source = byId.get(sectionResult.sectionId);
    if (!source) continue;
    const sectionValue = Number.isInteger(sectionResult.value)
      ? Math.min(3, Math.max(0, sectionResult.value))
      : 0;
    if (sectionValue === 0 || !Array.isArray(sectionResult.questions)) continue;
    for (const question of sectionResult.questions) {
      if (!isQuizFocusType(question.focusType)) continue;
      const sourceQuote = typeof question.sourceQuote === "string" ? question.sourceQuote.trim() : "";
      if (!sourceQuote || !sourceContainsQuote(source.content, sourceQuote)) continue;
      const options = Array.isArray(question.options)
        ? question.options
          .filter((option) => ["A", "B", "C", "D"].includes(option.key) && typeof option.content === "string" && option.content.trim())
          .slice(0, 4)
        : [];
      const optionKeys = new Set(options.map((option) => option.key));
      if (typeof question.question !== "string" || !question.question.trim()) continue;
      if (options.length !== 4 || !optionKeys.has(question.answerKey)) continue;
      const difficulty = Number.isInteger(question.difficulty)
        ? Math.min(5, Math.max(1, question.difficulty))
        : 3;
      result.push({
        focusType: question.focusType,
        sectionId: source.id,
        sectionValue,
        markedPriority: sourceQuoteMarkerPriority(source, sourceQuote),
        question: {
          id: `${Date.now()}-${result.length}-${Math.random().toString(36).slice(2, 8)}`,
          notePath: filePath,
          ...(knowledgePointIds.has(question.knowledgePointId ?? "") ? { knowledgePointId: question.knowledgePointId } : {}),
          sourceSection: source.title,
          question: question.question.trim(),
          type: "single_choice",
          options: options.map((option) => ({ key: option.key, content: option.content.trim() })),
          answerKey: question.answerKey,
          explanation: typeof question.explanation === "string" ? question.explanation.trim() : "",
          difficulty,
          createdAt: now
        }
      });
    }
  }
  return result;
}

function normalizeKnowledgePointQuiz(
  value: KnowledgePointQuizResponse,
  filePath: string,
  knowledgePointId: string,
  sourceSection: string
): QuizQuestion {
  const question = value?.question;
  const options = Array.isArray(question?.options)
    ? question.options
      .filter((option) => ["A", "B", "C", "D"].includes(option.key) && typeof option.content === "string" && option.content.trim())
      .slice(0, 4)
    : [];
  const optionKeys = new Set(options.map((option) => option.key));
  if (!question || typeof question.question !== "string" || !question.question.trim()) {
    throw new Error("Quiz model did not return a valid question.");
  }
  if (options.length !== 4 || !optionKeys.has(question.answerKey)) {
    throw new Error("Quiz model did not return four valid options and one answer.");
  }
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    notePath: filePath,
    knowledgePointId,
    sourceSection,
    question: question.question.trim(),
    type: "single_choice",
    options: options.map((option) => ({ key: option.key, content: option.content.trim() })),
    answerKey: question.answerKey,
    explanation: typeof question.explanation === "string" ? question.explanation.trim() : "",
    difficulty: Number.isInteger(question.difficulty) ? Math.min(5, Math.max(1, question.difficulty)) : 3,
    createdAt: new Date().toISOString()
  };
}

function selectQuizQuestions(
  rated: RatedQuizQuestion[],
  limit: number,
  targets: Record<QuizFocusType, number>
): QuizQuestion[] {
  const seen = new Set<string>();
  const unique = rated
    .filter((item) => {
      const key = item.question.question.replace(/\s+/g, "").toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) =>
      b.sectionValue - a.sectionValue
      || a.markedPriority - b.markedPriority
      || a.sectionId.localeCompare(b.sectionId)
    );
  const selected: RatedQuizQuestion[] = [];
  const used = new Set<RatedQuizQuestion>();
  for (const type of Object.keys(targets) as QuizFocusType[]) {
    const matches = unique.filter((item) => item.focusType === type).slice(0, targets[type]);
    for (const item of matches) {
      selected.push(item);
      used.add(item);
    }
  }
  for (const item of unique) {
    if (selected.length >= limit) break;
    if (!used.has(item)) selected.push(item);
  }
  return selected.slice(0, limit).map((item) => item.question);
}

function isQuizFocusType(value: unknown): value is QuizFocusType {
  return ["concept", "principle", "comparison", "application", "pitfall"].includes(String(value));
}

function sourceContainsQuote(content: string, quote: string): boolean {
  if (content.includes(quote)) return true;
  return normalizeSourceText(content).includes(normalizeSourceText(quote));
}

function normalizeSourceText(value: string): string {
  return value.replace(/\*\*|==|<\/?u>|\*/gi, "").replace(/\s+/g, " ").trim();
}

function sourceQuoteMarkerPriority(section: QuizSourceSection, quote: string): number {
  const normalizedQuote = normalizeSourceText(quote);
  const priorities = section.marked
    .filter((marked) => normalizedQuote.includes(normalizeSourceText(marked.text)))
    .map((marked) => marked.kind === "bold" ? 0 : marked.kind === "italic" ? 2 : 1);
  return priorities.length > 0 ? Math.min(...priorities) : 3;
}
