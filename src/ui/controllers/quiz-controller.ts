import { Notice, TFile } from "obsidian";
import type { App } from "obsidian";
import type KnowFlowPlugin from "../../main";
import type { KnowledgePoint, KnowledgePointGroup, KnowledgePointStatus, QuizSession, QuizStats } from "../../types";

export interface CachedKnowledgePoints {
  groups: KnowledgePointGroup[];
  statuses: Record<string, KnowledgePointStatus>;
}

export class QuizController {
  private pendingKnowledgeMaps = new Set<string>();
  private pendingKnowledgePoints = new Set<string>();
  private pendingKnowledgePointQuizzes = new Set<string>();
  private pendingQuizzes = new Set<string>();
  private knowledgePointCache = new Map<string, CachedKnowledgePoints>();
  private quizStatsCache = new Map<string, QuizStats>();
  private quizStatsPending = new Set<string>();

  constructor(
    private app: App,
    private plugin: KnowFlowPlugin,
    private getCategory: (file: TFile) => string,
    private onStateChange: (filePath: string) => void
  ) {}

  isKnowledgeMapPending(filePath: string): boolean {
    return this.pendingKnowledgeMaps.has(filePath);
  }

  isQuizPending(filePath: string): boolean {
    return this.pendingQuizzes.has(filePath);
  }

  isKnowledgePointsPending(filePath: string): boolean {
    return this.pendingKnowledgePoints.has(filePath);
  }

  getKnowledgePointData(filePath: string): CachedKnowledgePoints | null {
    const cached = this.knowledgePointCache.get(filePath);
    if (cached) return cached;
    void this.refreshKnowledgePointData(filePath);
    return null;
  }

  getQuizStats(path: string): QuizStats {
    const cached = this.quizStatsCache.get(path);
    if (cached) return cached;
    void this.refreshQuizStats(path);
    return { total: 0, answered: 0, accuracy: null, wrong: 0 };
  }

  async generateKnowledgeMap(file: TFile): Promise<void> {
    if (this.pendingKnowledgeMaps.has(file.path)) return;
    this.pendingKnowledgeMaps.add(file.path);
    this.onStateChange(file.path);
    try {
      await this.plugin.mermaid.generateForFile(file);
    } catch (error) {
      new Notice(`KnowFlow Mermaid failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.pendingKnowledgeMaps.delete(file.path);
      this.onStateChange(file.path);
    }
  }

  async generateQuiz(file: TFile): Promise<void> {
    if (this.pendingQuizzes.has(file.path)) return;
    this.pendingQuizzes.add(file.path);
    this.onStateChange(file.path);
    try {
      const content = await this.app.vault.read(file);
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      const value = frontmatter?.["阅读价值"];
      const readingValue = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10) || 3;
      const knowledgePoints = await this.plugin.quizNotes.loadKnowledgePoints(file.path);
      const questions = await this.plugin.ai.generateQuiz(
        file.path,
        file.basename,
        content,
        readingValue,
        knowledgePoints?.groups ?? []
      );
      if (questions.length === 0) throw new Error("Quiz model did not return valid questions.");
      await this.plugin.quizNotes.saveQuiz(file, this.getCategory(file), questions);
      this.invalidate(file.path);
      new Notice(`KnowFlow: generated ${questions.length} quiz questions`);
    } catch (error) {
      new Notice(`KnowFlow quiz failed: ${error instanceof Error ? error.message : String(error)}`, 8000);
    } finally {
      this.pendingQuizzes.delete(file.path);
      this.onStateChange(file.path);
    }
  }

  async refreshKnowledgePointData(filePath: string): Promise<void> {
    if (this.pendingKnowledgePoints.has(filePath)) return;
    this.pendingKnowledgePoints.add(filePath);
    try {
      const loaded = await this.plugin.quizNotes.loadKnowledgePoints(filePath);
      this.knowledgePointCache.set(filePath, {
        groups: loaded?.groups ?? [],
        statuses: loaded?.statuses ?? {}
      });
    } catch (error) {
      this.knowledgePointCache.set(filePath, { groups: [], statuses: {} });
      new Notice(`KnowFlow: 读取知识点失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.pendingKnowledgePoints.delete(filePath);
      this.onStateChange(filePath);
    }
  }

  async generateKnowledgePoints(file: TFile): Promise<void> {
    if (this.pendingKnowledgePoints.has(file.path)) return;
    this.pendingKnowledgePoints.add(file.path);
    this.onStateChange(file.path);
    try {
      const article = await this.app.vault.read(file);
      const groups = await this.plugin.ai.generateKnowledgePoints(file.basename, article);
      const saved = await this.plugin.quizNotes.saveKnowledgePoints(file, this.getCategory(file), groups);
      const loaded = await this.plugin.quizNotes.loadKnowledgePoints(file.path);
      this.knowledgePointCache.set(file.path, {
        groups: saved.groups,
        statuses: loaded?.statuses ?? {}
      });
      new Notice(`KnowFlow: generated ${saved.groups.flatMap((group) => group.points).length} knowledge points`);
    } catch (error) {
      new Notice(`KnowFlow knowledge points failed: ${error instanceof Error ? error.message : String(error)}`, 8000);
    } finally {
      this.pendingKnowledgePoints.delete(file.path);
      this.onStateChange(file.path);
    }
  }

  async generateKnowledgePointQuiz(file: TFile, point: KnowledgePoint): Promise<void> {
    if (this.pendingKnowledgePointQuizzes.has(point.id)) return;
    this.pendingKnowledgePointQuizzes.add(point.id);
    try {
      const question = await this.plugin.ai.generateKnowledgePointQuiz(file.path, file.basename, point);
      await this.plugin.quizNotes.appendKnowledgePointQuiz(file, this.getCategory(file), point, question);
      this.invalidate(file.path);
      await this.refreshKnowledgePointData(file.path);
      new Notice("KnowFlow: 已为该知识点生成 1 道试题");
    } catch (error) {
      new Notice(`KnowFlow quiz failed: ${error instanceof Error ? error.message : String(error)}`, 8000);
    } finally {
      this.pendingKnowledgePointQuizzes.delete(point.id);
      this.onStateChange(file.path);
    }
  }

  async recordAnswer(session: QuizSession): Promise<void> {
    const question = session.questions[session.index];
    if (!session.selectedKey) throw new Error("请选择一个答案。");
    await this.plugin.quizNotes.recordAnswer(
      session.quizPath,
      session.index + 1,
      session.selectedKey,
      question.answerKey
    );
    this.invalidate(session.filePath);
  }

  invalidate(filePath: string): void {
    this.quizStatsCache.delete(filePath);
    this.knowledgePointCache.delete(filePath);
  }

  private async refreshQuizStats(path: string): Promise<void> {
    if (this.quizStatsPending.has(path)) return;
    this.quizStatsPending.add(path);
    try {
      this.quizStatsCache.set(path, await this.plugin.quizNotes.getStats(path));
      this.onStateChange(path);
    } finally {
      this.quizStatsPending.delete(path);
    }
  }
}
