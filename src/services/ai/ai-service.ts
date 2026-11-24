import type { ChatMessage as StoredChatMessage, ChatUsage, GeneratedNoteSummary, KnowledgePoint, KnowledgePointGroup, KnowFlowSettings, QuizQuestion } from "../../types";
import { AiTransport } from "./ai-transport";
import { estimateChatUsage } from "../chat/chat-stream";
import { buildChatRequestMessages } from "../chat/chat-context";
import { requestFormattingDecisions } from "./formatting-ai";
import type { FormattingCandidate, FormattingDecision } from "../clipping/formatting-candidates";
import { KnowledgeAi } from "./knowledge-ai";
import type { TranslationCandidate, TranslationDecision } from "../clipping/translation-candidates";
import { generateArticleSummary, type SummaryDelta } from "./summary-ai";
import { requestNoteProperties, type NotePropertyProposal } from "./note-properties-ai";
import { RepairAi } from "./repair-ai";
import { QuizAi } from "./quiz-ai";
import type { SkillRunner } from "../core/skill-runner";
import translationFormatRules from "../../../skills/article-translation/references/inline-translation.md" with { type: "text" };

export class AiService {

  constructor(private settings: KnowFlowSettings, private skills: SkillRunner) {}

  updateSettings(settings: KnowFlowSettings): void {
    this.settings = settings;
  }

  async summarize(filePath: string, title: string, content: string): Promise<GeneratedNoteSummary> {
    return this.generateSummary(filePath, title, content);
  }

  async summarizeStream(
    filePath: string,
    title: string,
    content: string,
    onDelta: SummaryDelta
  ): Promise<GeneratedNoteSummary> {
    return this.generateSummary(filePath, title, content, onDelta);
  }

  private async generateSummary(
    filePath: string, title: string, content: string,
    onDelta?: SummaryDelta
  ): Promise<GeneratedNoteSummary> {
    const model = { ...this.settings.summaryModel };
    const summary = await this.skills.run("article-summary", (instructions) =>
      generateArticleSummary(model, title, content, instructions, onDelta)
    );
    return { filePath, title, ...summary };
  }

  async answerStream(
    contextLabel: string,
    articleContent: string,
    history: StoredChatMessage[],
    handlers: {
      onContent: (delta: string) => void;
      onReasoning: (delta: string) => void;
      onUsage: (usage: ChatUsage) => void;
      retrievedContext?: string;
    }
  ): Promise<ChatUsage> {
    const transport = new AiTransport();
    const messages = buildChatRequestMessages(contextLabel, articleContent, history, handlers.retrievedContext);
    let emitted = false;
    try {
      return await transport.requestTextStream(this.settings.chatModel, messages, {
        onContent: (delta) => {
          emitted = true;
          handlers.onContent(delta);
        },
        onReasoning: (delta) => {
          emitted = true;
          handlers.onReasoning(delta);
        },
        onUsage: handlers.onUsage
      });
    } catch (error) {
      if (emitted) throw error;
      const answer = await transport.requestText(this.settings.chatModel, messages);
      handlers.onContent(answer);
      const usage = estimateChatUsage(messages, answer);
      handlers.onUsage(usage);
      return usage;
    }
  }

  async isFreshnessRequest(question: string): Promise<boolean> {
    if (this.settings.chatModel.runtime === "disabled") return false;
    const result = await new AiTransport().requestJson<{ check?: unknown }>(this.settings.chatModel, [
      {
        role: "system",
        content: [
          "识别用户是否请求联网检查当前绑定文章里的事实或做法现在是否仍然有效。",
          "只有这样才返回 JSON {\"check\":true}。普通解释、假设、引用他人的说法、单独查询其他资料及查看既有报告都返回 false。",
          "这个判断只触发只读的时效检查。只输出 JSON。"
        ].join("\n")
      },
      { role: "user", content: question }
    ]);
    return result?.check === true;
  }

  async generateQuiz(
    filePath: string,
    title: string,
    content: string,
    readingValue: number,
    knowledgePointGroups: KnowledgePointGroup[] = []
  ): Promise<QuizQuestion[]> {
    return this.skills.run("article-quiz", (instructions) => new QuizAi(new AiTransport(instructions)).generateQuiz(
      this.settings.quizModel,
      filePath,
      title,
      content,
      readingValue,
      knowledgePointGroups
    ));
  }

  async generateKnowledgePoints(title: string, content: string): Promise<KnowledgePointGroup[]> {
    return this.skills.run("knowledge-points", (instructions) =>
      new KnowledgeAi(new AiTransport(instructions)).generateKnowledgePoints(this.settings.knowledgeMapModel, title, content)
    );
  }

  async generateKnowledgePointQuiz(filePath: string, articleTitle: string, point: KnowledgePoint): Promise<QuizQuestion> {
    return this.skills.run("article-quiz", (instructions) =>
      new QuizAi(new AiTransport(instructions)).generateKnowledgePointQuiz(this.settings.quizModel, filePath, articleTitle, point)
    );
  }

  confirmFormatting(candidates: FormattingCandidate[], instructions: string): Promise<FormattingDecision[]> {
    return requestFormattingDecisions(this.settings.pipelineModel, candidates, instructions);
  }

  proposeNoteProperties(title: string, content: string, categories: string[]): Promise<NotePropertyProposal> {
    return requestNoteProperties(this.settings.pipelineModel, title, content, categories);
  }

  async translateEnglishParagraphs(
    title: string,
    candidates: TranslationCandidate[],
    instructions?: string
  ): Promise<TranslationDecision[]> {
    const translate = (skill: string) => new RepairAi(new AiTransport([skill, translationFormatRules.trim()].join("\n\n")))
      .translateEnglishParagraphs(this.settings.pipelineModel, title, candidates);
    if (instructions?.trim()) return translate(instructions);
    return this.skills.run("article-translation", translate);
  }
}
