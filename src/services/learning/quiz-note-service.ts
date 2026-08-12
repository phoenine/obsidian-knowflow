import { TFile, normalizePath } from "obsidian";
import type { App } from "obsidian";
import type { KnowledgePoint, KnowledgePointGroup, KnowledgePointStatus, KnowFlowSettings, QuizQuestion, QuizStats } from "../../types";
import { mergeKnowledgePointGroups, parseKnowledgePoints, upsertKnowledgePoints } from "./knowledge-points";
import { NoteOperationCoordinator } from "../core/note-operation-coordinator";
import { appendQuizQuestion, applyQuizAnswer, buildQuizNoteContent, computeKnowledgePointStatuses, computeQuizStats, parseQuizCallout, parseQuizEntries, parseQuizNote, sanitizeQuizFileName, setExamPassed, updateQuizSourcePath, upsertQuizCallout, upsertQuizQuestions } from "./quiz-notes";
import type { ParsedQuizQuestion } from "./quiz-notes";

/**
 * Bridges the pure quiz-notes.ts markdown logic with the vault: creates/
 * updates quiz notes under settings.archiveFolder. The source article's
 * managed Quiz callout is the only index pointing back to its quiz note.
 */
export class QuizNoteService {
  constructor(
    private app: App,
    private settings: KnowFlowSettings,
    private noteOperations: NoteOperationCoordinator
  ) {}

  updateSettings(settings: KnowFlowSettings): void {
    this.settings = settings;
  }

  async saveQuiz(sourceFile: TFile, category: string, questions: QuizQuestion[]): Promise<string> {
    return this.noteOperations.runExclusive(sourceFile.path, () => this.saveQuizExclusive(sourceFile, category, questions));
  }

  private async saveQuizExclusive(sourceFile: TFile, category: string, questions: QuizQuestion[]): Promise<string> {
    await this.ensureArchiveFolder();
    const sourceContent = await this.app.vault.read(sourceFile);
    const existingPath = parseQuizCallout(sourceContent);
    const quizPath = existingPath && await this.app.vault.adapter.exists(existingPath)
      ? existingPath
      : await this.resolveNewQuizPath(sourceFile.basename, new Date());

    const existingFile = this.app.vault.getAbstractFileByPath(quizPath);
    if (existingFile instanceof TFile) {
      const existingContent = await this.app.vault.read(existingFile);
      await this.app.vault.modify(existingFile, setExamPassed(upsertQuizQuestions(existingContent, questions), false));
    } else {
      const content = buildQuizNoteContent(
        { sourcePath: sourceFile.path, category, createdAt: new Date().toISOString() },
        questions
      );
      await this.app.vault.create(quizPath, content);
    }

    const nextSourceContent = upsertQuizCallout(sourceContent, quizPath);
    if (nextSourceContent !== sourceContent) {
      await this.app.vault.modify(sourceFile, nextSourceContent);
    }
    return quizPath;
  }

  async loadQuestions(notePath: string): Promise<{ quizPath: string; questions: QuizQuestion[] } | null> {
    const quizPath = await this.resolveQuizPath(notePath);
    if (!quizPath) return null;
    const file = this.app.vault.getAbstractFileByPath(quizPath);
    if (!(file instanceof TFile)) return null;
    const content = await this.app.vault.read(file);
    const questions = parseQuizNote(content, notePath);
    return questions.length > 0 ? { quizPath, questions } : null;
  }

  async loadReviewQuestions(notePath: string): Promise<{ quizPath: string; entries: ParsedQuizQuestion[] } | null> {
    const quizPath = await this.resolveQuizPath(notePath);
    if (!quizPath) return null;
    const file = this.app.vault.getAbstractFileByPath(quizPath);
    if (!(file instanceof TFile)) return null;
    const entries = parseQuizEntries(await this.app.vault.read(file), notePath);
    return entries.length > 0 ? { quizPath, entries } : null;
  }

  async listReviewQuestions(): Promise<Array<{
    articlePath: string;
    articleTitle: string;
    quizPath: string;
    entries: ParsedQuizQuestion[];
  }>> {
    const folder = `${normalizePath(this.archiveFolder())}/`;
    const quizFiles = this.app.vault.getMarkdownFiles()
      .filter((file) => file.path.startsWith(folder))
      .filter((file) => !file.path.startsWith(`${folder}Daily-Quiz/`))
      .filter((file) => /_Quiz(?: \d+)?\.md$/i.test(file.path));
    const results = await Promise.all(quizFiles.map(async (file) => {
      const content = await this.app.vault.read(file);
      const articlePath = parseQuizSourcePath(content);
      if (!articlePath) return null;
      const sourceFile = this.app.vault.getAbstractFileByPath(articlePath);
      if (!(sourceFile instanceof TFile)) return null;
      const entries = parseQuizEntries(content, sourceFile.path);
      return entries.length > 0
        ? { articlePath: sourceFile.path, articleTitle: sourceFile.basename, quizPath: file.path, entries }
        : null;
    }));
    return results.filter((result): result is NonNullable<typeof result> => result !== null);
  }

  async getStats(notePath: string): Promise<QuizStats> {
    const empty: QuizStats = { total: 0, answered: 0, accuracy: null, wrong: 0 };
    const quizPath = await this.resolveQuizPath(notePath);
    if (!quizPath) return empty;
    const file = this.app.vault.getAbstractFileByPath(quizPath);
    if (!(file instanceof TFile)) return empty;
    const content = await this.app.vault.read(file);
    return computeQuizStats(content);
  }

  async hasQuiz(notePath: string): Promise<boolean> {
    const quizPath = await this.resolveQuizPath(notePath);
    if (!quizPath) return false;
    const file = this.app.vault.getAbstractFileByPath(quizPath);
    if (!(file instanceof TFile)) return false;
    return parseQuizNote(await this.app.vault.read(file), notePath).length > 0;
  }

  async saveKnowledgePoints(
    sourceFile: TFile,
    category: string,
    groups: KnowledgePointGroup[]
  ): Promise<{ quizPath: string; groups: KnowledgePointGroup[] }> {
    return this.noteOperations.runExclusive(
      sourceFile.path,
      () => this.saveKnowledgePointsExclusive(sourceFile, category, groups)
    );
  }

  private async saveKnowledgePointsExclusive(
    sourceFile: TFile,
    category: string,
    groups: KnowledgePointGroup[]
  ): Promise<{ quizPath: string; groups: KnowledgePointGroup[] }> {
    await this.ensureArchiveFolder();
    const sourceContent = await this.app.vault.read(sourceFile);
    const existingPath = parseQuizCallout(sourceContent);
    const quizPath = existingPath && await this.app.vault.adapter.exists(existingPath)
      ? existingPath
      : await this.resolveNewQuizPath(sourceFile.basename, new Date());
    const existingFile = this.app.vault.getAbstractFileByPath(quizPath);
    let savedGroups = groups;
    if (existingFile instanceof TFile) {
      const content = await this.app.vault.read(existingFile);
      savedGroups = mergeKnowledgePointGroups(parseKnowledgePoints(content), groups);
      await this.app.vault.modify(existingFile, upsertKnowledgePoints(content, savedGroups));
    } else {
      const content = buildQuizNoteContent(
        { sourcePath: sourceFile.path, category, createdAt: new Date().toISOString() },
        []
      );
      await this.app.vault.create(quizPath, upsertKnowledgePoints(content, groups));
    }
    const nextSourceContent = upsertQuizCallout(sourceContent, quizPath);
    if (nextSourceContent !== sourceContent) await this.app.vault.modify(sourceFile, nextSourceContent);
    return { quizPath, groups: savedGroups };
  }

  async loadKnowledgePoints(notePath: string): Promise<{
    quizPath: string;
    groups: KnowledgePointGroup[];
    statuses: Record<string, KnowledgePointStatus>;
  } | null> {
    const quizPath = await this.resolveQuizPath(notePath);
    if (!quizPath) return null;
    const file = this.app.vault.getAbstractFileByPath(quizPath);
    if (!(file instanceof TFile)) return null;
    const content = await this.app.vault.read(file);
    const groups = parseKnowledgePoints(content);
    return groups.length > 0 ? { quizPath, groups, statuses: computeKnowledgePointStatuses(content) } : null;
  }

  async appendKnowledgePointQuiz(
    sourceFile: TFile,
    category: string,
    point: KnowledgePoint,
    question: QuizQuestion
  ): Promise<string> {
    let quizPath = await this.resolveQuizPath(sourceFile.path);
    if (!quizPath) {
      const saved = await this.saveKnowledgePoints(sourceFile, category, [{ title: "核心知识点", points: [point] }]);
      quizPath = saved.quizPath;
    }
    const file = this.app.vault.getAbstractFileByPath(quizPath);
    if (!(file instanceof TFile)) throw new Error(`Quiz note not found: ${quizPath}`);
    const content = await this.app.vault.read(file);
    await this.app.vault.modify(file, setExamPassed(
      appendQuizQuestion(content, { ...question, knowledgePointId: point.id }),
      false
    ));
    return quizPath;
  }

  async updateSourcePath(newPath: string): Promise<void> {
    const quizPath = await this.resolveQuizPath(newPath);
    if (!quizPath) return;
    await this.updateQuizSourceLink(quizPath, newPath);
  }

  async updateSourceFolder(newFolder: string): Promise<void> {
    const prefix = `${newFolder}/`;
    const files = this.app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(prefix));
    await Promise.all(files.map((file) => this.updateSourcePath(file.path)));
  }

  /** `displayIndex` is 1-based, matching the question's position in the session. Returns whether the answer was correct. */
  async recordAnswer(
    quizPath: string,
    displayIndex: number,
    selectedKey: string,
    correctAnswerKey: string,
    expectedQuestion?: string
  ): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(quizPath);
    if (!(file instanceof TFile)) throw new Error(`Quiz note not found: ${quizPath}`);
    const content = await this.app.vault.read(file);
    if (expectedQuestion) {
      const current = parseQuizEntries(content, "")[displayIndex - 1]?.question.question;
      if (current !== expectedQuestion) throw new Error("题库内容已变化，请刷新今日复习后重试。");
    }
    const correct = selectedKey === correctAnswerKey;
    const date = new Date().toISOString().slice(0, 10);
    const patched = applyQuizAnswer(content, displayIndex, selectedKey, correct, date);
    // "考试结果" mirrors the study-quiz convention: true once every question
    // in the note has been answered and every answer is currently correct.
    const stats = computeQuizStats(patched);
    const passed = stats.total > 0 && stats.answered === stats.total && stats.wrong === 0;
    await this.app.vault.modify(file, setExamPassed(patched, passed));
    return correct;
  }

  private async resolveNewQuizPath(title: string, date: Date): Promise<string> {
    const base = sanitizeQuizFileName(title);
    const folder = this.archiveFolder();
    const datePrefix = date.toISOString().slice(0, 10);
    let candidate = normalizePath(`${folder}/${datePrefix}_${base}_Quiz.md`);
    let suffix = 2;
    while (await this.app.vault.adapter.exists(candidate)) {
      candidate = normalizePath(`${folder}/${datePrefix}_${base}_Quiz ${suffix}.md`);
      suffix += 1;
    }
    return candidate;
  }

  private async ensureArchiveFolder(): Promise<void> {
    const folder = normalizePath(this.archiveFolder());
    if (await this.app.vault.adapter.exists(folder)) return;
    await this.app.vault.createFolder(folder);
  }

  private async updateQuizSourceLink(quizPath: string, sourcePath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(quizPath);
    if (!(file instanceof TFile)) return;
    const content = await this.app.vault.read(file);
    const next = updateQuizSourcePath(content, sourcePath);
    if (next !== content) {
      await this.app.vault.modify(file, next);
    }
  }

  private async resolveQuizPath(sourcePath: string): Promise<string | null> {
    const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(sourceFile instanceof TFile)) return null;
    const sourceContent = await this.app.vault.read(sourceFile);
    return parseQuizCallout(sourceContent);
  }

  private archiveFolder(): string {
    return this.settings.archiveFolder || "Archives";
  }
}

function parseQuizSourcePath(content: string): string | null {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(content)?.[1] ?? "";
  const field = /^(?:原文|原文链接):\s*.+$/m.exec(frontmatter)?.[0];
  const target = field ? /\[\[([^|\]]+)(?:\|[^\]]*)?\]\]/.exec(field)?.[1]?.trim() : null;
  if (!target) return null;
  const normalized = normalizePath(target.replace(/^\.\.\//, "").replace(/\.md$/i, ""));
  return `${normalized}.md`;
}
