import type { ChatMessage as StoredChatMessage, ChatUsage, KnowledgePoint, KnowledgePointGroup, KnowFlowSettings, NoteSummary, QuizQuestion } from "../../types";
import { AiTransport, parseJsonResponse } from "./ai-transport";
import { estimateChatUsage } from "../chat/chat-stream";
import { buildChatRequestMessages } from "../chat/chat-context";
import type { FormattingCandidate, FormattingDecision } from "../clipping/formatting-candidates";
import { KnowledgeAi } from "./knowledge-ai";
import type { TranslationCandidate, TranslationDecision } from "../clipping/translation-candidates";
import { buildSummaryMessages, normalizeSummaryResponse, type SummaryResponse } from "./summary-ai";
import { RepairAi } from "./repair-ai";
import { QuizAi } from "./quiz-ai";

export class AiService {
  private transport = new AiTransport();
  private repair = new RepairAi(this.transport);
  private knowledge = new KnowledgeAi(this.transport);
  private quiz = new QuizAi(this.transport);

  constructor(private settings: KnowFlowSettings) {}

  updateSettings(settings: KnowFlowSettings): void {
    this.settings = settings;
  }

  setSkill(skill: string): void {
    this.repair.setSkill(skill);
  }

  async summarize(filePath: string, title: string, content: string, fallbackCategory: string): Promise<NoteSummary> {
    const payload = await this.transport.requestJson<SummaryResponse>(
      this.settings.summaryModel,
      buildSummaryMessages(title, content, fallbackCategory)
    );
    return { filePath, title, ...normalizeSummaryResponse(payload, fallbackCategory) };
  }

  async summarizeStream(
    filePath: string,
    title: string,
    content: string,
    fallbackCategory: string,
    onDelta: (state: { content: string; reasoning: string }) => void
  ): Promise<NoteSummary> {
    let fullText = "";
    let fullReasoning = "";
    await this.transport.requestTextStream(this.settings.summaryModel, buildSummaryMessages(title, content, fallbackCategory), {
      onContent: (delta) => {
        fullText += delta;
        onDelta({ content: fullText, reasoning: fullReasoning });
      },
      onReasoning: (delta) => {
        fullReasoning += delta;
        onDelta({ content: fullText, reasoning: fullReasoning });
      },
      onUsage: () => {}
    });

    const payload = parseJsonResponse<SummaryResponse>(fullText);
    return { filePath, title, ...normalizeSummaryResponse(payload, fallbackCategory) };
  }

  async answerStream(
    contextLabel: string,
    articleContent: string,
    history: StoredChatMessage[],
    handlers: {
      onContent: (delta: string) => void;
      onReasoning: (delta: string) => void;
      onUsage: (usage: ChatUsage) => void;
    }
  ): Promise<ChatUsage> {
    const messages = buildChatRequestMessages(contextLabel, articleContent, history);
    let emitted = false;
    try {
      return await this.transport.requestTextStream(this.settings.chatModel, messages, {
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
      const answer = await this.transport.requestText(this.settings.chatModel, messages);
      handlers.onContent(answer);
      const usage = estimateChatUsage(messages, answer);
      handlers.onUsage(usage);
      return usage;
    }
  }

  async generateQuiz(
    filePath: string,
    title: string,
    content: string,
    readingValue: number,
    knowledgePointGroups: KnowledgePointGroup[] = []
  ): Promise<QuizQuestion[]> {
    return this.quiz.generateQuiz(
      this.settings.quizModel,
      filePath,
      title,
      content,
      readingValue,
      knowledgePointGroups
    );
  }

  async generateKnowledgePoints(title: string, content: string): Promise<KnowledgePointGroup[]> {
    return this.knowledge.generateKnowledgePoints(this.settings.knowledgeMapModel, title, content);
  }

  async generateKnowledgePointQuiz(filePath: string, articleTitle: string, point: KnowledgePoint): Promise<QuizQuestion> {
    return this.quiz.generateKnowledgePointQuiz(this.settings.quizModel, filePath, articleTitle, point);
  }

  async generateKnowledgeMap(title: string, content: string): Promise<string> {
    return this.knowledge.generateKnowledgeMap(this.settings.knowledgeMapModel, title, content);
  }

  async analyzeHeadingCandidates(title: string, candidates: FormattingCandidate[]): Promise<FormattingDecision[]> {
    return this.repair.analyzeHeadingCandidates(this.settings.pipelineModel, title, candidates);
  }

  async analyzePossibleCodeCandidates(title: string, candidates: FormattingCandidate[]): Promise<FormattingDecision[]> {
    return this.repair.analyzePossibleCodeCandidates(this.settings.pipelineModel, title, candidates);
  }

  async analyzeFencedCodeCandidates(title: string, candidates: FormattingCandidate[]): Promise<FormattingDecision[]> {
    return this.repair.analyzeFencedCodeCandidates(this.settings.pipelineModel, title, candidates);
  }

  async translateEnglishParagraphs(title: string, candidates: TranslationCandidate[]): Promise<TranslationDecision[]> {
    return this.repair.translateEnglishParagraphs(this.settings.pipelineModel, title, candidates);
  }

}
