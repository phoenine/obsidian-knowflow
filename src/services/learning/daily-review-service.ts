import type { App, TFile } from "obsidian";
import type { DailyReviewSession, KnowFlowSettings } from "../../types";
import type { KnowledgeStore } from "../core/store";
import { NoteOperationCoordinator } from "../core/note-operation-coordinator";
import type { QuizNoteService } from "./quiz-note-service";
import { selectDailyReviewQuestions, toEligibleReviewQuestion } from "./daily-review";

const GENERATOR_VERSION = 1;

export class DailyReviewService {
  private readonly sessions = new NoteOperationCoordinator();

  constructor(
    private app: App,
    private store: KnowledgeStore,
    private quizNotes: QuizNoteService,
    private settings: KnowFlowSettings
  ) {}

  updateSettings(settings: KnowFlowSettings): void {
    this.settings = settings;
  }

  getSession(date: string, questionCap: number): DailyReviewSession | null {
    const existing = this.store.getDailyReviewSession(date);
    return existing?.generatorVersion === GENERATOR_VERSION
      && (existing.questionCap === questionCap || Object.keys(existing.answers).length > 0)
      ? existing
      : null;
  }

  async ensureSession(date: string, questionCap: number, force = false): Promise<DailyReviewSession> {
    const existing = this.getSession(date, questionCap);
    if (existing && !force) return existing;
    if (existing && Object.keys(existing.answers).length > 0) return existing;

    const bank = await this.loadQuestionBank(date);
    return this.sessions.runExclusive(date, async () => {
      const current = this.store.getDailyReviewSession(date);
      if (current && Object.keys(current.answers).length > 0) return current;
      if (!force && current?.generatorVersion === GENERATOR_VERSION && current.questionCap === questionCap) return current;
      const questions = selectDailyReviewQuestions(bank.eligible, bank.total, questionCap, {
        pinnedKeys: force ? current?.questions.filter((question) => question.priority === "wrong").map((question) => question.key) : []
      });
      const session: DailyReviewSession = {
        generatorVersion: GENERATOR_VERSION,
        date,
        generatedAt: new Date().toISOString(),
        questionCap,
        bankSize: bank.total,
        questions,
        answers: {},
        completedAt: null
      };
      await this.store.saveDailyReviewSession(session);
      return session;
    });
  }

  async recordAnswer(
    date: string,
    questionKey: string,
    selectedKey: string
  ): Promise<DailyReviewSession> {
    return this.sessions.runExclusive(date, async () => {
      const session = this.store.getDailyReviewSession(date);
      const selected = session?.questions.find((question) => question.key === questionKey);
      if (!selected) throw new Error("今日复习题目不存在，请刷新后重试。");
      const correct = await this.quizNotes.recordAnswer(
        selected.quizPath,
        selected.displayIndex,
        selectedKey,
        selected.question.answerKey,
        selected.question.question
      );
      const updated = await this.store.recordDailyReviewAnswer(date, {
        questionKey,
        selectedKey,
        correct,
        answeredAt: new Date().toISOString()
      });
      if (!updated) throw new Error("今日复习进度保存失败。");
      return updated;
    });
  }

  private async loadQuestionBank(reviewDate: string): Promise<{
    total: number;
    eligible: NonNullable<ReturnType<typeof toEligibleReviewQuestion>>[];
  }> {
    const loaded = await this.quizNotes.listReviewQuestions();
    const candidates = loaded
      .filter((quiz) => quiz.articlePath.startsWith(`${this.settings.articlesFolder}/`))
      .filter((quiz) => {
        const file = this.app.vault.getAbstractFileByPath(quiz.articlePath);
        return file ? this.isLearnedBefore(file as TFile, reviewDate) : false;
      })
      .flatMap((quiz) => quiz.entries.map((entry) => ({
        articlePath: quiz.articlePath,
        articleTitle: quiz.articleTitle,
        quizPath: quiz.quizPath,
        displayIndex: entry.displayIndex,
        question: entry.question,
        answerState: entry.answerState
      })));
    return {
      total: candidates.length,
      eligible: candidates.flatMap((candidate) => {
        const question = toEligibleReviewQuestion(candidate, reviewDate);
        return question ? [question] : [];
      })
    };
  }

  private isLearnedBefore(file: TFile, reviewDate: string): boolean {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const status = readLearningStatus(frontmatter?.["学习状态"]);
    const learned = status
      ? !/未学习|待学习|未读|pending/i.test(status)
      : this.store.isLearned(file.path);
    if (!learned) return false;
    const learningDate = frontmatter?.["学习日期"];
    if (typeof learningDate !== "string" && typeof learningDate !== "number") return true;
    const normalized = String(learningDate).slice(0, 10);
    return normalized < reviewDate;
  }
}

function readLearningStatus(value: unknown): string | null {
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === "string" && item.trim());
    return typeof first === "string" ? first.trim() : null;
  }
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
