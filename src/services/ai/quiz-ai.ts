import type { AiModelConfig, KnowledgePoint, KnowledgePointGroup, QuizOption, QuizQuestion } from "../../types";
import { AiTransport } from "./ai-transport";
import type { ChatRequestMessage } from "../chat/chat-context";
import { batchQuizSections, getQuizFocusTargets, getQuizQuestionLimit, prepareQuizSections } from "../learning/quiz-generation";
import type { QuizFocusType, QuizSourceSection } from "../learning/quiz-generation";
import { sourceContainsQuote } from "../learning/source-quote";

interface RatedQuizQuestion {
  focusType: QuizFocusType;
  sectionId: string;
  sectionValue: number;
  markedPriority: number;
  question: QuizQuestion;
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
        const payload = await this.transport.requestJson<unknown>(
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
    const payload = await this.transport.requestJson<unknown>(config, [
      {
        role: "system",
        content: "按 Skill 出题。只输出严格 JSON，不要输出 Markdown。"
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
      content: "按 Skill 出题。只输出严格 JSON，不要输出 Markdown。"
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
  value: unknown,
  sourceSections: QuizSourceSection[],
  filePath: string,
  knowledgePointIds: Set<string>
): RatedQuizQuestion[] {
  const now = new Date().toISOString();
  const byId = new Map(sourceSections.map((section) => [section.id, section]));
  const sections: unknown[] = isRecord(value) && Array.isArray(value.sections) ? value.sections : [];
  const result: RatedQuizQuestion[] = [];
  for (const sectionResult of sections) {
    if (!isRecord(sectionResult) || typeof sectionResult.sectionId !== "string") continue;
    const source = byId.get(sectionResult.sectionId);
    const rating = sectionResult.value;
    if (!source || typeof rating !== "number" || !Number.isInteger(rating) || rating <= 0) continue;
    const sectionValue = Math.min(3, rating);
    const questions: unknown[] = Array.isArray(sectionResult.questions) ? sectionResult.questions : [];
    for (const question of questions) {
      if (!isRecord(question) || !isQuizFocusType(question.focusType)) continue;
      const sourceQuote = typeof question.sourceQuote === "string" ? question.sourceQuote.trim() : "";
      if (!sourceQuote || !sourceContainsQuote(source.content, sourceQuote)) continue;
      if (typeof question.question !== "string" || !question.question.trim()) continue;
      const options = normalizeQuizOptions(question.options);
      const answerKey = question.answerKey;
      if (typeof answerKey !== "string" || options.length !== 4 || !options.some((option) => option.key === answerKey)) continue;
      const pointId = typeof question.knowledgePointId === "string" ? question.knowledgePointId : "";
      result.push({
        focusType: question.focusType,
        sectionId: source.id,
        sectionValue,
        markedPriority: sourceQuoteMarkerPriority(source, sourceQuote),
        question: {
          id: `${Date.now()}-${result.length}-${Math.random().toString(36).slice(2, 8)}`,
          notePath: filePath,
          ...(knowledgePointIds.has(pointId) ? { knowledgePointId: pointId } : {}),
          sourceSection: source.title,
          question: question.question.trim(),
          type: "single_choice",
          options,
          answerKey,
          explanation: typeof question.explanation === "string" ? question.explanation.trim() : "",
          difficulty: normalizeDifficulty(question.difficulty),
          createdAt: now
        }
      });
    }
  }
  return result;
}

function normalizeKnowledgePointQuiz(
  value: unknown,
  filePath: string,
  knowledgePointId: string,
  sourceSection: string
): QuizQuestion {
  const question = isRecord(value) ? value.question : null;
  if (!isRecord(question) || typeof question.question !== "string" || !question.question.trim()) {
    throw new Error("Quiz model did not return a valid question.");
  }
  const options = normalizeQuizOptions(question.options);
  const answerKey = question.answerKey;
  if (typeof answerKey !== "string" || options.length !== 4 || !options.some((option) => option.key === answerKey)) {
    throw new Error("Quiz model did not return four valid options and one answer.");
  }
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    notePath: filePath,
    knowledgePointId,
    sourceSection,
    question: question.question.trim(),
    type: "single_choice",
    options,
    answerKey,
    explanation: typeof question.explanation === "string" ? question.explanation.trim() : "",
    difficulty: normalizeDifficulty(question.difficulty),
    createdAt: new Date().toISOString()
  };
}

function normalizeQuizOptions(value: unknown): QuizOption[] {
  const candidates: unknown[] = Array.isArray(value) ? value : [];
  const options: QuizOption[] = [];
  const contentByKey = new Map<string, string>();
  for (const option of candidates) {
    if (!isRecord(option) || typeof option.key !== "string" || !["A", "B", "C", "D"].includes(option.key)) continue;
    if (typeof option.content !== "string" || !option.content.trim()) continue;
    const content = option.content.trim();
    const existing = contentByKey.get(option.key);
    if (existing !== undefined) {
      // The same letter with different text makes the answer ambiguous: the whole question is rejected.
      if (existing !== content) return [];
      continue;
    }
    contentByKey.set(option.key, content);
    options.push({ key: option.key, content });
  }
  return options;
}

function normalizeDifficulty(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? Math.min(5, Math.max(1, value)) : 3;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
