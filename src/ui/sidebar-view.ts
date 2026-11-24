import { ItemView, MarkdownRenderer, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type KnowFlowPlugin from "../main";
import { ARTICLE_CATEGORIES } from "../services/clipping/clipping-pipeline";
import { createDailyTaskPlan, type DailyTaskCandidate } from "../services/learning/daily-tasks";
import { summarizeWeeklyReviewActivity } from "../services/learning/review-activity";
import { insertBelowCursor } from "../services/chat/editor-bridge";
import { KNOWFLOW_VIEW_TYPE, type ArticleStats, type ChatMessage, type ChatThread, type DailyReviewSession, type DailyTask, type DailyTaskPlan, type KnowledgePoint, type NoteSummary, type PipelineUiState, type QuizSession, type RelatedNote, type ViewContext } from "../types";
import { renderArticleDetailView } from "./article-detail-view";
import { renderTaskOverviewView } from "./task-overview-view";
import { renderChatComposer, renderCollapsedChatComposer } from "./chat-composer";
import { renderChatHistoryPopover } from "./chat-history-view";
import { renderClippingView, updateStreamingReasoning } from "./clipping-view";
import { applyActionLayout, button, formatDate, iconButton, row, section, setStyles, text } from "./dom";
import { renderQuizResultsView } from "./quiz-results-view";
import { renderQuizTestView } from "./quiz-test-view";
import { renderKnowledgePointsOverview } from "./knowledge-points-view";
import { renderShell } from "./shell";
import { SummaryController } from "./controllers/summary-controller";
import { QuizController } from "./controllers/quiz-controller";
import { ChatController } from "./controllers/chat-controller";

interface KnowledgePointViewState {
  filePath: string;
  selectedPointId: string | null;
}

interface QuizResultsState {
  filePath: string;
}

type ComposerFocus = "input" | "toggle";

interface CollapsedChat {
  draft: string;
  contextPaths: string[];
  thread: ChatThread | null;
  pendingReply?: ChatMessage;
}

interface RelatedNotesState {
  mtime: number;
  indexUpdatedAt: string;
  candidateKey: string;
  notes: RelatedNote[];
}

export class KnowFlowSidebarView extends ItemView {
  private chatController: ChatController;
  private streamingAnswerEl: HTMLElement | null = null;
  private streamingReasoningEl: HTMLElement | null = null;
  private streamingSummaryContentEl: HTMLElement | null = null;
  private streamingSummaryReasoningHistoryEl: HTMLElement | null = null;
  private streamingSummaryReasoningLatestEl: HTMLElement | null = null;
  private summaryController: SummaryController;
  private quizController: QuizController;
  private quizSession: QuizSession | null = null;
  private quizResults: QuizResultsState | null = null;
  private quizOpenPath: string | null = null;
  private knowledgePointView: KnowledgePointViewState | null = null;
  private pipelineStates = new Map<string, PipelineUiState>();
  private renderedContextKey: string | null = null;
  private composerExpanded = false;
  private composerPreference: "auto" | "open" | "closed" = "auto";
  private composerHostBox = "";
  private composerFitPending = false;
  private composerFitting = false;
  private composerResizeObserver: ResizeObserver | null = null;
  private composerDraft = "";
  private pendingComposerFocus: ComposerFocus | null = null;
  private collapsedChats = new Map<string, CollapsedChat>();
  private dailyTaskPlanLoads = new Set<string>();
  private dailyReviewLoads = new Set<string>();
  private relatedNotes = new Map<string, RelatedNotesState>();
  private relatedNoteLoads = new Set<string>();
  private relatedNoteErrors = new Map<string, string>();
  private vaultSearchEnabled = false;
  private chatContextPaths = new Set<string>();

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: KnowFlowPlugin
  ) {
    super(leaf);
    this.summaryController = new SummaryController(this.app, plugin, (filePath) => {
      if (this.plugin.router.getContext().activeFile?.path === filePath) this.render();
    });
    this.chatController = new ChatController(this.app, plugin, () => this.render());
    this.quizController = new QuizController(
      this.app,
      plugin,
      (file) => this.getSummaryMeta(file).category ?? this.plugin.settings.defaultArticleCategory,
      (filePath) => {
        if (
          this.plugin.router.getContext().activeFile?.path === filePath
          || this.knowledgePointView?.filePath === filePath
          || this.quizResults?.filePath === filePath
        ) this.render();
      }
    );
  }

  getViewType(): string {
    return KNOWFLOW_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "KnowFlow";
  }

  getIcon(): string {
    return "brain";
  }

  async onOpen(): Promise<void> {
    this.render();
    this.watchComposerHost();
  }

  async onClose(): Promise<void> {
    this.composerResizeObserver?.disconnect();
    this.composerResizeObserver = null;
    await super.onClose();
  }

  render(composerFocus?: ComposerFocus, draft?: string): void {
    const root = this.containerEl.children[1] as HTMLElement;
    const nextContextKey = this.getRenderContextKey();
    const currentScroll = root.querySelector<HTMLElement>(".kf-content")?.scrollTop ?? 0;
    const contextChanged = this.renderedContextKey !== nextContextKey;
    const shouldRestoreScroll = !contextChanged;
    const activeElement = root.ownerDocument.activeElement;
    this.pendingComposerFocus = composerFocus ?? null;
    if (!composerFocus && shouldRestoreScroll) {
      if (root.querySelector(".kf-input") === activeElement) this.pendingComposerFocus = "input";
      if (root.querySelector(".kf-composer-expand") === activeElement) this.pendingComposerFocus = "toggle";
    }
    if (contextChanged) {
      this.composerDraft = "";
      this.composerPreference = "auto";
      this.composerExpanded = Boolean(this.chatController.activeThread);
    }
    if (composerFocus === "input") this.composerExpanded = true;
    if (draft !== undefined) this.composerDraft = draft;
    root.empty();
    root.addClass("knowflow-view");
    setStyles(root, {
      backgroundColor: "color-mix(in srgb, var(--interactive-accent) 3%, var(--background-primary))",
      color: "var(--text-normal)",
      display: "flex",
      flexDirection: "column",
      fontSize: "13px",
      height: "100%",
      paddingBottom: "",
      position: "relative"
    });
    this.renderedContextKey = nextContextKey;

    if (this.chatController.activeThread) {
      this.renderChatThread(root, this.chatController.activeThread);
      this.restoreScroll(currentScroll, shouldRestoreScroll);
      return;
    }

    if (this.quizSession) {
      this.renderQuizTest(root, this.quizSession);
      this.restoreScroll(currentScroll, shouldRestoreScroll);
      return;
    }

    if (this.quizResults) {
      this.renderQuizResults(root, this.quizResults);
      this.restoreScroll(currentScroll, shouldRestoreScroll);
      return;
    }

    if (this.knowledgePointView) {
      this.renderKnowledgePoints(root, this.knowledgePointView);
      this.restoreScroll(currentScroll, shouldRestoreScroll);
      return;
    }

    const context = this.plugin.router.getContext();
    if (
      this.composerPreference === "auto"
      && context.activeFile
      && this.summaryController.isPending(context.activeFile.path)
    ) {
      this.composerExpanded = false;
    }

    if (context.mode === "clipping") {
      this.renderClipping(root, context);
      this.finishAutoComposer(root, contextChanged);
      this.restoreScroll(currentScroll, shouldRestoreScroll);
      return;
    }

    if (context.mode === "task-overview") {
      this.renderTaskOverview(root, context);
      this.restoreScroll(currentScroll, shouldRestoreScroll);
      return;
    }

    if (context.mode === "article-detail") {
      this.renderArticleDetail(root, context);
      this.finishAutoComposer(root, contextChanged);
      this.restoreScroll(currentScroll, shouldRestoreScroll);
      return;
    }

    this.renderEmpty(root);
    this.restoreScroll(currentScroll, shouldRestoreScroll);
  }

  private renderClipping(root: HTMLElement, context: ViewContext): void {
    const file = context.activeFile;
    if (!file) return this.renderEmpty(root);
    const summary = this.getSummaryViewModel(file);
    const summaryPending = this.summaryController.isPending(file.path);
    const summaryError = this.summaryController.getError(file.path);
    const streamingText = this.summaryController.getStreamingText(file.path);
    const streamingReasoning = this.summaryController.getStreamingReasoning(file.path);
    const pipelineState = this.pipelineStates.get(file.path);
    const persistedPipeline = this.plugin.store.getPipelineStatus(file.path);
    // 重新生成时不展示旧摘要正文，避免和流式过程叠在一起。阅读价值和分类仍取自 Frontmatter。
    const displaySummary = summaryPending ? null : summary;
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const readingValue = this.getFrontmatterReadingValueNumber(frontmatter) ?? 0;
    const suggestedCategory = this.getFrontmatterCategory(frontmatter);
    const related = this.getRelatedNotesProps(file);

    renderClippingView(root, {
      title: file.basename,
      summary: displaySummary,
      summaryPending,
      summaryError,
      streamingText,
      streamingReasoning,
      sourceLabel: "Clipping",
      pipelineState,
      persistedPipeline,
      currentCategory: this.categoryFolderName(file.path, `${this.plugin.settings.articlesFolder}/`) ?? undefined,
      readingValueLabel: readingValue > 0 ? `${readingValue}/5` : "--",
      suggestedCategoryLabel: suggestedCategory ?? "--",
      recommendedActionLabel: readingValue > 0
        ? this.recommendedActionLabel(this.recommendedActionFromReadingValue(readingValue))
        : "--",
      renderMarkdownSummary: (parent, markdown) => void this.renderMarkdownSummary(parent, markdown, file.path),
      onRefreshSummary: () => this.ensureSummary(file, true),
      onGenerateSummary: () => this.ensureSummary(file, true),
      onRunPipeline: async () => {
        await this.runPipeline(file);
      },
      onMoveCategory: async (category) => {
        await this.moveToCategory(file, category);
      },
      ...related
    });

    this.streamingSummaryContentEl = root.querySelector(".kf-streaming-text");
    this.streamingSummaryReasoningHistoryEl = root.querySelector(".kf-streaming-reasoning-history");
    this.streamingSummaryReasoningLatestEl = root.querySelector(".kf-streaming-reasoning-latest");
    this.renderComposer(root, context, file.basename, file);
  }

  private async ensureSummary(file: TFile, force: boolean): Promise<void> {
    await this.summaryController.ensureSummary(file, force, {
      onDelta: (visible, reasoning) => {
        if (this.plugin.router.getContext().activeFile?.path !== file.path) return;
        const needsContentEl = Boolean(visible) && !this.streamingSummaryContentEl;
        const needsReasoningEl = !visible && Boolean(reasoning) && !this.streamingSummaryReasoningLatestEl;
        if (needsContentEl || needsReasoningEl) {
          this.render();
          return;
        }
        if (this.streamingSummaryReasoningHistoryEl && this.streamingSummaryReasoningLatestEl) {
          updateStreamingReasoning(
            this.streamingSummaryReasoningHistoryEl,
            this.streamingSummaryReasoningLatestEl,
            reasoning
          );
        }
        if (this.streamingSummaryContentEl) this.streamingSummaryContentEl.textContent = visible;
      }
    });
    this.streamingSummaryContentEl = null;
    this.streamingSummaryReasoningHistoryEl = null;
    this.streamingSummaryReasoningLatestEl = null;
  }

  private renderTaskOverview(root: HTMLElement, context: ViewContext): void {
    const selectedPath = context.selectedPath ?? this.plugin.settings.articlesFolder;
    const scope = selectedPath.startsWith(this.plugin.settings.articlesFolder) ? selectedPath : this.plugin.settings.articlesFolder;
    const files = this.getArticleFiles(scope);
    const overview = this.summarizeArticles(scope, files);
    const { stats, categoryStats } = overview;
    const scopeLabel = scope.replace(`${this.plugin.settings.articlesFolder}/`, "") || "全部文章";
    const weeklyActivity = overview.weekly;
    const weeklyLearned = weeklyActivity.dailyLearned.reduce((sum, count) => sum + count, 0);
    const plan = this.getCurrentDailyTaskPlan(scope);
    if (!plan) void this.ensureDailyTaskPlan(scope, false, files);
    const reviewDate = localDateKey(new Date());
    const review = this.getCurrentDailyReview(reviewDate);
    if (!review) void this.ensureDailyReview(false);
    const loading = this.dailyTaskPlanLoads.has(dailyTaskPlanKey(reviewDate, scope)) || this.dailyReviewLoads.has(reviewDate);
    renderTaskOverviewView(root, {
      scopeLabel,
      stats,
      categoryStats,
      tasks: plan?.tasks ?? [],
      review,
      loading,
      weeklyLearned,
      weeklyReviewCount: weeklyActivity.reviewCount,
      weeklyReviewAccuracy: weeklyActivity.reviewAccuracy,
      weeklyReadTrend: weeklyActivity.dailyLearned,
      weeklyReviewTrend: weeklyActivity.dailyReview,
      onOpenTask: (task) => this.openDailyTask(task),
      onCompleteTask: (task) => {
        if (plan) void this.updateDailyTask(plan, task, "completed");
      },
      onRefreshTask: (task) => {
        if (plan) void this.refreshDailyTask(plan, task);
      },
      onSkipTask: (task) => {
        if (plan) void this.updateDailyTask(plan, task, "skipped");
      },
      onRefreshReview: () => void this.ensureDailyReview(true),
      onStartReview: () => {
        if (review) this.startDailyReview(review);
      }
    });
  }

  private getCurrentDailyTaskPlan(scopePath: string): DailyTaskPlan | null {
    const date = localDateKey(new Date());
    const existing = this.plugin.store.getDailyTaskPlan(date, scopePath);
    if (
      existing
      && existing.generatorVersion === 3
      && existing.newArticleLimit === this.plugin.settings.dailyNewArticleLimit
    ) return existing;
    return null;
  }

  private getCurrentDailyReview(date: string): DailyReviewSession | null {
    const current = this.plugin.dailyReview.getSession(date, this.plugin.settings.dailyReviewQuestionCap);
    if (current) return current;
    const existing = this.plugin.store.getDailyReviewSession(date);
    return existing && Object.keys(existing.answers).length > 0 ? existing : null;
  }

  private async ensureDailyTaskPlan(scopePath: string, force: boolean, files?: TFile[]): Promise<void> {
    const date = localDateKey(new Date());
    const loadKey = dailyTaskPlanKey(date, scopePath);
    if (this.dailyTaskPlanLoads.has(loadKey)) return;
    if (!force && this.getCurrentDailyTaskPlan(scopePath)) return;
    this.dailyTaskPlanLoads.add(loadKey);

    try {
      const existing = force ? null : this.plugin.store.getDailyTaskPlan(date, scopePath);
      const candidates = this.getDailyTaskCandidates(scopePath, files);

      const plan = createDailyTaskPlan({
        date,
        scopePath,
        generatedAt: new Date().toISOString(),
        newArticleLimit: this.plugin.settings.dailyNewArticleLimit,
        candidates,
        existingTasks: existing?.tasks
      });
      await this.plugin.store.saveDailyTaskPlan(plan);
    } catch (error) {
      new Notice(`KnowFlow: 生成今日任务失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.dailyTaskPlanLoads.delete(loadKey);
      if (this.plugin.router.getContext().mode === "task-overview") this.render();
    }
  }

  private async ensureDailyReview(force: boolean): Promise<void> {
    const date = localDateKey(new Date());
    if (this.dailyReviewLoads.has(date)) return;
    this.dailyReviewLoads.add(date);
    try {
      await this.plugin.dailyReview.ensureSession(date, this.plugin.settings.dailyReviewQuestionCap, force);
    } catch (error) {
      new Notice(`KnowFlow: 生成今日复习失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.dailyReviewLoads.delete(date);
      if (this.plugin.router.getContext().mode === "task-overview") this.render();
    }
  }

  private getDailyTaskCandidates(scopePath: string, files = this.getArticleFiles(scopePath)): DailyTaskCandidate[] {
    return files.map((file) => ({
      path: file.path,
      title: file.basename,
      learned: this.isArticleLearned(file)
    }));
  }

  private async refreshDailyTask(plan: DailyTaskPlan, task: DailyTask): Promise<void> {
    if (task.status !== "pending" || !task.targetPath) return;
    const loadKey = dailyTaskPlanKey(plan.date, plan.scopePath);
    if (this.dailyTaskPlanLoads.has(loadKey)) return;
    this.dailyTaskPlanLoads.add(loadKey);

    try {
      const candidates = this.getDailyTaskCandidates(plan.scopePath)
        .filter((candidate) => candidate.path !== task.targetPath);
      const existingTasks = plan.tasks.filter((existingTask) => existingTask.id !== task.id);
      const refreshed = createDailyTaskPlan({
        date: plan.date,
        scopePath: plan.scopePath,
        generatedAt: new Date().toISOString(),
        newArticleLimit: plan.newArticleLimit,
        candidates,
        existingTasks
      });
      const currentTypeCount = plan.tasks.filter((existingTask) => existingTask.type === task.type).length;
      const refreshedTypeCount = refreshed.tasks.filter((existingTask) => existingTask.type === task.type).length;
      if (refreshedTypeCount < currentTypeCount) {
        new Notice("KnowFlow: 暂无可替换的任务");
        return;
      }
      await this.plugin.store.saveDailyTaskPlan(refreshed);
    } catch (error) {
      new Notice(`KnowFlow: 更换任务失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.dailyTaskPlanLoads.delete(loadKey);
      if (this.plugin.router.getContext().mode === "task-overview") this.render();
    }
  }

  private openDailyTask(task: DailyTask): void {
    if (task.targetPath) void this.app.workspace.openLinkText(task.targetPath, "", false);
  }

  private async updateDailyTask(plan: DailyTaskPlan, task: DailyTask, status: "completed" | "skipped"): Promise<void> {
    try {
      const completedAt = status === "completed" ? new Date().toISOString() : null;
      if (status === "completed" && task.type === "new_note" && task.targetPath) {
        const file = this.app.vault.getAbstractFileByPath(task.targetPath);
        if (file instanceof TFile) {
          await this.plugin.learningNotes.markComplete(file, localDateKey(new Date()));
        }
        await this.plugin.store.markLearned(task.targetPath);
      }
      await this.plugin.store.updateDailyTaskStatus(plan.date, plan.scopePath, task.id, status, completedAt);
      this.render();
    } catch (error) {
      new Notice(`KnowFlow: 更新任务失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private renderArticleDetail(root: HTMLElement, context: ViewContext): void {
    const file = context.activeFile;
    if (!file) return this.renderEmpty(root);

    const summary = this.getSummaryViewModel(file);
    const summaryPending = this.summaryController.isPending(file.path);
    const summaryError = this.summaryController.getError(file.path);
    const streamingText = this.summaryController.getStreamingText(file.path);
    const streamingReasoning = this.summaryController.getStreamingReasoning(file.path);
    const quiz = this.quizController.getQuizStats(file.path);
    const knowledgePoints = this.quizController.getKnowledgePointData(file.path);
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const readingValue = this.getFrontmatterReadingValue(frontmatter) ?? (summary && summary.readingValue > 0 ? `${summary.readingValue}/5` : "--");
    const learningStatus = this.getFrontmatterLearningStatus(frontmatter) ?? (this.plugin.store.isLearned(file.path) ? "已学习" : "未学习");
    const pipelineState = this.pipelineStates.get(file.path);
    const persistedPipeline = this.plugin.store.getPipelineStatus(file.path);
    const suggestedCategory = this.getFrontmatterCategory(frontmatter);
    const related = this.getRelatedNotesProps(file);

    renderArticleDetailView(root, {
      title: file.basename,
      readingValue,
      learningStatus,
      knowledgePointCount: knowledgePoints?.groups.flatMap((group) => group.points).length ?? null,
      summary: summaryPending ? null : summary,
      summaryPending,
      summaryError,
      streamingText,
      streamingReasoning,
      sourceLabel: "文章",
      pipelineState,
      persistedPipeline,
      currentCategory: this.categoryFolderName(file.path, `${this.plugin.settings.articlesFolder}/`) ?? undefined,
      suggestedCategoryLabel: suggestedCategory ?? "--",
      onRunPipeline: async () => {
        await this.runPipeline(file);
      },
      onMoveCategory: async (category) => {
        await this.moveToCategory(file, category);
      },
      quizPending: this.quizController.isQuizPending(file.path) || this.quizOpenPath === file.path,
      hasAttempt: (quiz?.answered ?? 0) > 0,
      renderMarkdownSummary: (parent, markdown) => void this.renderMarkdownSummary(parent, markdown, file.path),
      onRefreshSummary: () => this.ensureSummary(file, true),
      onGenerateSummary: () => this.ensureSummary(file, true),
      onShowKnowledgePoints: () => this.openKnowledgePoints(file),
      onOpenQuiz: () => void this.openQuiz(file),
      ...related
    });

    this.streamingSummaryContentEl = root.querySelector(".kf-streaming-text");
    this.streamingSummaryReasoningHistoryEl = root.querySelector(".kf-streaming-reasoning-history");
    this.streamingSummaryReasoningLatestEl = root.querySelector(".kf-streaming-reasoning-latest");

    this.renderComposer(root, context, file.basename, file);
  }

  private renderKnowledgePoints(root: HTMLElement, state: KnowledgePointViewState): void {
    const sourceFile = this.app.vault.getAbstractFileByPath(state.filePath);
    if (!(sourceFile instanceof TFile)) {
      this.knowledgePointView = null;
      this.renderEmpty(root);
      return;
    }
    const cached = this.quizController.getKnowledgePointData(sourceFile.path);
    const groups = cached?.groups ?? [];
    const statuses = cached?.statuses ?? {};
    const loading = this.quizController.isKnowledgePointsPending(sourceFile.path);
    const common = {
      articleTitle: sourceFile.basename,
      groups,
      statuses,
      selectedPointId: state.selectedPointId,
      loading,
      onRefresh: () => void this.quizController.generateKnowledgePoints(sourceFile),
      onSelectPoint: (pointId: string) => {
        this.knowledgePointView = { filePath: sourceFile.path, selectedPointId: pointId };
      },
      onOpenEvidence: (point: KnowledgePoint) => {
        void this.openKnowledgePointEvidence(sourceFile, point);
      },
      onGenerateQuiz: (point: KnowledgePoint) => void this.quizController.generateKnowledgePointQuiz(sourceFile, point)
    };

    renderKnowledgePointsOverview(root, {
      ...common,
      onBack: () => {
        this.knowledgePointView = null;
        this.render();
      }
    });
  }

  private openKnowledgePoints(file: TFile): void {
    this.knowledgePointView = { filePath: file.path, selectedPointId: null };
    void this.quizController.refreshKnowledgePointData(file.path);
    this.render();
  }

  private resolveEvidenceHeading(file: TFile, section: string): string {
    const requested = normalizeHeading(section);
    const headings = this.app.metadataCache.getFileCache(file)?.headings ?? [];
    const exact = headings.find((heading) => normalizeHeading(heading.heading) === requested);
    if (exact) return exact.heading;
    const partial = headings.find((heading) => {
      const candidate = normalizeHeading(heading.heading);
      return candidate.includes(requested) || requested.includes(candidate);
    });
    return partial?.heading ?? section.replace(/^#+\s*/, "").trim();
  }

  private async openKnowledgePointEvidence(file: TFile, point: KnowledgePoint): Promise<void> {
    this.knowledgePointView = { filePath: file.path, selectedPointId: point.id };
    const heading = this.resolveEvidenceHeading(file, point.evidence.section);
    const leaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit)
      ?? this.app.workspace.getLeaf(false);
    await leaf.openFile(file, {
      active: true,
      eState: { subpath: `#${heading}` }
    });
  }


  private renderQuizResults(root: HTMLElement, state: QuizResultsState): void {
    const file = this.app.vault.getAbstractFileByPath(state.filePath);
    if (!(file instanceof TFile)) {
      this.quizResults = null;
      this.renderEmpty(root);
      return;
    }
    renderQuizResultsView(root, {
      title: file.basename,
      quiz: this.quizController.getQuizStats(file.path),
      pending: this.quizController.isQuizPending(file.path),
      onBack: () => {
        this.quizResults = null;
        this.render();
      },
      onRegenerate: () => void this.quizController.generateQuiz(file),
      onRetake: () => void this.startQuiz(file)
    });
  }

  private quizRequestStillCurrent(filePath: string): boolean {
    const context = this.plugin.router.getContext();
    return context.activeFile?.path === filePath
      && !this.chatController.activeThread
      && !this.knowledgePointView
      && !this.quizSession;
  }

  private async openQuiz(file: TFile): Promise<void> {
    if (this.quizOpenPath === file.path || this.quizController.isQuizPending(file.path)) return;
    this.quizOpenPath = file.path;
    try {
      const loaded = await this.plugin.quizNotes.loadQuestions(file.path);
      if (!loaded || loaded.questions.length === 0) {
        this.render();
        await this.quizController.generateQuiz(file);
        const created = await this.plugin.quizNotes.loadQuestions(file.path);
        if (!created || created.questions.length === 0) return;
      }
      if (!this.quizRequestStillCurrent(file.path)) return;
      this.quizResults = { filePath: file.path };
      this.render();
    } finally {
      if (this.quizOpenPath === file.path) {
        this.quizOpenPath = null;
        if (this.quizResults?.filePath !== file.path) this.render();
      }
    }
  }

  private renderQuizTest(root: HTMLElement, session: QuizSession): void {
    const reviewQuestion = session.reviewDate
      ? this.plugin.store.getDailyReviewSession(session.reviewDate)?.questions[session.index]
      : null;
    renderQuizTestView(root, {
      session,
      sourceLabel: reviewQuestion?.articleTitle,
      onOpenSource: reviewQuestion ? () => void this.openReviewSource(reviewQuestion.articlePath, reviewQuestion.question.sourceSection) : undefined,
      onBack: () => {
        this.quizSession = null;
        this.render();
      },
      onSelect: (key) => {
        session.selectedKey = key;
        this.render();
      },
      onSubmit: async () => {
        await this.submitQuizAnswer(session);
      },
      onNext: () => {
        session.index += 1;
        const review = session.reviewDate ? this.plugin.store.getDailyReviewSession(session.reviewDate) : null;
        const nextKey = session.reviewQuestionKeys?.[session.index];
        session.selectedKey = nextKey ? review?.answers[nextKey]?.selectedKey ?? null : null;
        session.submitted = nextKey ? Boolean(review?.answers[nextKey]) : false;
        this.render();
      },
      onFinish: () => {
        this.quizSession = null;
        this.render();
      }
    });
  }

  private async openReviewSource(articlePath: string, sourceSection?: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(articlePath);
    if (!(file instanceof TFile)) {
      new Notice("来源文章不存在。");
      return;
    }
    const leaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit)
      ?? this.app.workspace.getLeaf(false);
    await leaf.openFile(file, sourceSection
      ? { active: true, eState: { subpath: `#${this.resolveEvidenceHeading(file, sourceSection)}` } }
      : { active: true });
  }

  private renderEmpty(root: HTMLElement): void {
    const content = renderShell(root, "KnowFlow", "No context");
    const card = section(content, "kf-empty");
    text(card, "选择一个 KnowFlow 上下文", "kf-card-title");
    text(card, "打开 Clippings 中的文章会进入整理模式；选中 Articles 文件夹会显示学习总览；打开 Articles 中的具体文章会显示文章详情。", "kf-muted");
    const actions = row(card, "kf-actions");
    applyActionLayout(actions);
    button(actions, "刷新", () => this.render(), true);
  }

  private renderChatThread(root: HTMLElement, thread: ChatThread): void {
    const content = renderShell(root, "", "Ready", () => {
      this.chatController.activeThread = null;
      this.render();
    });
    this.streamingAnswerEl = null;
    this.streamingReasoningEl = null;

    for (const message of thread.messages) {
      if (message.role === "user") {
        const question = section(content, "kf-question");
        setStyles(question, {
          alignSelf: "stretch",
          backgroundColor: "color-mix(in srgb, var(--interactive-accent) 15%, var(--background-primary))",
          border: "1px solid color-mix(in srgb, var(--interactive-accent) 38%, var(--background-modifier-border))",
          gap: "10px",
          padding: "12px",
          textAlign: "left",
          width: "100%"
        });
        const questionText = text(question, message.content, "kf-question-text");
        setStyles(questionText, { textAlign: "left", width: "100%" });
        const footer = row(question);
        setStyles(footer, { justifyContent: "space-between", width: "100%" });
        text(footer, formatDate(message.createdAt), "kf-token-estimate");
        const actions = row(footer);
        setStyles(actions, { gap: "2px", marginLeft: "auto" });
        const userAction = (label: string, icon: string, onClick: () => void): void => {
          const action = setStyles(iconButton(actions, label, icon, onClick), {
            backgroundColor: "transparent",
            border: "0",
            color: "var(--interactive-accent)",
            height: "22px",
            width: "22px"
          });
          const svg = action.querySelector<SVGSVGElement>("svg");
          if (svg) Object.assign(svg.style, { height: "14px", width: "14px" });
        };
        userAction("复制问题", "copy", () => navigator.clipboard.writeText(message.content));
        userAction("编辑并重新提问", "square-pen", () => {
          this.openComposer(undefined, message.content);
        });
        userAction("删除本轮对话", "trash-2", () => {
          this.chatController.deleteTurn(thread, message.id);
        });
        continue;
      }

      const assistant = content.createDiv({ cls: "kf-assistant-message" });
      setStyles(assistant, {
        display: "flex",
        flexDirection: "column",
        gap: "8px"
      });

      const reasoning = assistant.createEl("details", { cls: "kf-thinking" });
      setStyles(reasoning, {
        backgroundColor: "var(--background-secondary)",
        border: "1px solid color-mix(in srgb, var(--interactive-accent) 22%, var(--background-modifier-border))",
        borderRadius: "8px",
        display: message.reasoning ? "block" : "none",
        padding: "9px 11px"
      });
      reasoning.createEl("summary", { text: "Thought process" });
      const reasoningBody = reasoning.createDiv();
      setStyles(reasoningBody, { fontSize: "12px", lineHeight: "1.5", marginTop: "7px", whiteSpace: "pre-wrap" });
      reasoningBody.textContent = message.reasoning;

      const answer = assistant.createDiv({ cls: "kf-answer" });
      setStyles(answer, {
        color: "var(--text-normal)",
        cursor: "text",
        fontSize: "13px",
        lineHeight: "1.5",
        minHeight: message.status === "pending" ? "24px" : "0",
        userSelect: "text",
        webkitUserSelect: "text",
        whiteSpace: message.status === "done" ? "normal" : "pre-wrap"
      });
      if (message.status === "done") {
        void this.renderMarkdownSummary(answer, message.content, thread.filePath ?? "");
      } else if (message.status === "error") {
        text(answer, `生成失败：${message.error ?? "未知错误"}`, "kf-muted");
      } else {
        answer.textContent = message.content || "正在等待模型响应…";
      }

      if (message.status === "pending" || message.status === "streaming") {
        this.streamingAnswerEl = answer;
        this.streamingReasoningEl = reasoningBody;
      }

      if (message.completedAt) {
        const footer = row(assistant);
        setStyles(footer, { justifyContent: "space-between", width: "100%" });
        text(footer, formatDate(message.completedAt), "kf-token-estimate");
        const actions = row(footer);
        setStyles(actions, { gap: "2px", marginLeft: "auto" });
        const chatAction = (label: string, icon: string, onClick: () => void): void => {
          const action = setStyles(iconButton(actions, label, icon, onClick), {
            backgroundColor: "transparent",
            border: "0",
            height: "22px",
            width: "22px"
          });
          const svg = action.querySelector<SVGSVGElement>("svg");
          if (svg) Object.assign(svg.style, { height: "14px", width: "14px" });
        };
        if (!message.kind) {
          chatAction("插入到光标下一行", "text-cursor-input", () => {
            if (!insertBelowCursor(this.app, thread.filePath, message.content)) {
              new Notice("未找到关联文章的编辑视图，请先打开关联文章。");
            }
          });
        }
        chatAction("复制回答", "copy", () => navigator.clipboard.writeText(message.content));
        if (!message.kind) {
          chatAction("重新生成", "refresh-cw", () => {
            const previous = this.chatController.findPreviousUserMessage(thread, message.id);
            const context = this.plugin.router.getContext();
            if (previous) void this.submitChat(previous.content, context, file instanceof TFile ? file : null, true);
          });
          chatAction("存为摘要", "save", () => void this.saveAssistantAsSummary(thread, message));
        }
      }
    }

    const context = this.plugin.router.getContext();
    const file = thread.filePath ? this.app.vault.getAbstractFileByPath(thread.filePath) : null;
    this.renderComposer(root, context, thread.contextLabel, file instanceof TFile ? file : null);
  }

  private renderComposer(root: HTMLElement, context: ViewContext, label: string, file: TFile | null): void {
    if (!this.composerExpanded) {
      const reply = this.collapsedChats.get(this.getRenderContextKey())?.pendingReply;
      let status = "";
      if (reply) {
        if (reply.status === "done") status = "回复已就绪";
        else if (reply.status === "error") status = "回复失败";
        else status = "Agent 正在处理…";
      }
      renderCollapsedChatComposer(root, status, this.pendingComposerFocus === "toggle", () => this.openComposer());
      return;
    }

    renderChatComposer(root, this.expandedComposerProps(label, file, this.pendingComposerFocus === "input", context));
  }

  private watchComposerHost(): void {
    const host = this.containerEl.children[1] as HTMLElement | undefined;
    if (!host || typeof ResizeObserver === "undefined") return;
    this.composerResizeObserver?.disconnect();
    this.composerResizeObserver = new ResizeObserver(() => {
      if (this.composerFitting || host.clientHeight <= 0) return;
      const box = `${host.clientWidth}x${host.clientHeight}`;
      if (box === this.composerHostBox) return;
      this.composerHostBox = box;
      if (this.composerPreference !== "auto" || !this.articleComposerCanAutoFit()) return;
      this.composerFitPending = true;
      this.render();
    });
    this.composerResizeObserver.observe(host);
  }

  private articleComposerCanAutoFit(): boolean {
    if (this.chatController.activeThread || this.quizSession || this.quizResults || this.knowledgePointView) return false;
    const mode = this.plugin.router.getContext().mode;
    return mode === "clipping" || mode === "article-detail";
  }

  private finishAutoComposer(root: HTMLElement, contextChanged: boolean): void {
    if (this.composerFitting || (!contextChanged && !this.composerFitPending)) return;
    this.composerFitPending = false;
    if (this.composerPreference !== "auto" || !this.articleComposerCanAutoFit()) return;
    const activePath = this.plugin.router.getContext().activeFile?.path;
    if (activePath && this.relatedNoteLoads.has(activePath)) return;
    if (activePath && this.summaryController.isPending(activePath)) return;
    if (!root.querySelector(".kf-composer") || root.clientHeight <= 0) return;
    const fits = this.cardsFitExpandedComposer(root);
    this.composerHostBox = `${root.clientWidth}x${root.clientHeight}`;
    if (fits === this.composerExpanded) return;
    this.composerExpanded = fits;
    this.composerFitting = true;
    try {
      this.render();
    } finally {
      this.composerFitting = false;
    }
  }

  private cardsFitExpandedComposer(root: HTMLElement): boolean {
    const content = root.querySelector<HTMLElement>(".kf-content");
    const composer = root.querySelector<HTMLElement>(".kf-composer");
    if (!content || !composer) return false;
    const flex = content.style.flex;
    const minHeight = content.style.minHeight;
    const height = content.style.height;
    content.style.flex = "0 0 auto";
    content.style.minHeight = "0";
    content.style.height = "auto";
    const cardsHeight = content.scrollHeight;
    content.style.flex = flex;
    content.style.minHeight = minHeight;
    content.style.height = height;
    const headerHeight = root.querySelector<HTMLElement>(".kf-header")?.offsetHeight ?? 0;
    const composerHeight = this.composerExpanded ? composer.offsetHeight : this.measureExpandedComposer(root);
    if (composerHeight <= 0) return false;
    return headerHeight + cardsHeight + composerHeight <= root.clientHeight + 1;
  }

  private measureExpandedComposer(root: HTMLElement): number {
    const context = this.plugin.router.getContext();
    const file = context.activeFile;
    const probe = root.createDiv();
    setStyles(probe, {
      left: "0",
      pointerEvents: "none",
      position: "absolute",
      visibility: "hidden",
      width: `${root.clientWidth}px`
    });
    try {
      renderChatComposer(probe, this.expandedComposerProps(file?.basename ?? "", file, false, context));
      return probe.querySelector<HTMLElement>(".kf-composer")?.offsetHeight ?? 0;
    } finally {
      probe.remove();
    }
  }

  private expandedComposerProps(label: string, file: TFile | null, focusDraft: boolean, context: ViewContext) {
    const usage = this.chatController.getUsage();
    return {
      contextLabel: label,
      modelName: this.plugin.settings.chatModel.model,
      draft: this.composerDraft,
      focusDraft,
      tokenCount: usage.totalTokens,
      tokenEstimated: usage.estimated,
      sending: this.chatController.isSending(),
      vaultSearchEnabled: this.vaultSearchEnabled,
      vaultSearchAvailable: this.plugin.semanticIndex.isReady(),
      additionalContextPaths: Array.from(this.chatContextPaths),
      onDraftChange: (value: string) => {
        this.composerDraft = value;
      },
      onSubmit: (question: string) => void this.submitChat(question, context, file),
      onSaveNote: () => void this.chatController.saveActiveThread(),
      onOpenHistory: () => void this.openChatHistory(),
      onToggleVaultSearch: () => {
        if (!this.vaultSearchEnabled && !this.plugin.semanticIndex.isReady()) {
          new Notice("请先在 Settings → Data 建立 Semantic index。");
          return;
        }
        this.vaultSearchEnabled = !this.vaultSearchEnabled;
        this.render();
      },
      onRemoveContext: (path: string) => {
        this.chatContextPaths.delete(path);
        this.render();
      },
      onCollapse: () => this.collapseComposer(file)
    };
  }

  private openComposer(attachPath?: string, draft?: string): void {
    const key = this.getRenderContextKey();
    const collapsed = this.composerExpanded ? undefined : this.collapsedChats.get(key);
    if (collapsed) {
      this.collapsedChats.delete(key);
      if (collapsed.thread) this.chatController.activeThread = collapsed.thread;
      this.chatContextPaths = new Set(collapsed.contextPaths);
    }
    if (attachPath) this.chatContextPaths.add(attachPath);
    this.composerPreference = "open";
    this.render("input", draft ?? collapsed?.draft);
  }

  private collapseComposer(file: TFile | null): void {
    const thread = this.chatController.activeThread;
    const context = this.plugin.router.getContext();
    const returnToArticle = thread && file && file.path === context.activeFile?.path
      && (context.mode === "clipping" || context.mode === "article-detail")
      && !this.quizSession && !this.quizResults && !this.knowledgePointView;
    if (returnToArticle) {
      this.chatController.activeThread = null;
      this.streamingAnswerEl = null;
      this.streamingReasoningEl = null;
    }
    this.collapsedChats.set(this.getRenderContextKey(), {
      draft: this.composerDraft,
      contextPaths: Array.from(this.chatContextPaths),
      thread: returnToArticle ? thread : null,
      pendingReply: thread?.messages.find((message) => message.status === "pending" || message.status === "streaming")
    });
    this.composerExpanded = false;
    this.composerPreference = "closed";
    this.chatContextPaths.clear();
    this.render("toggle");
  }

  private async submitChat(
    question: string,
    context = this.plugin.router.getContext(),
    file: TFile | null = context.activeFile,
    replay = false
  ): Promise<void> {
    await this.chatController.submit(question, context, file, {
      onStart: () => {
        this.composerDraft = "";
      },
      onContent: (message) => {
        if (this.streamingAnswerEl) this.streamingAnswerEl.textContent = message.content;
      },
      onReasoning: (message) => {
        if (!this.streamingReasoningEl) return;
        const details = this.streamingReasoningEl.closest("details") as HTMLElement | null;
        if (details) details.style.display = "block";
        this.streamingReasoningEl.textContent = message.reasoning;
      },
      useVaultSearch: this.vaultSearchEnabled,
      contextPaths: Array.from(this.chatContextPaths),
      replay
    });
  }

  tracksRelatedNote(file: TFile): boolean {
    const { mode, activeFile } = this.plugin.router.getContext();
    if (!activeFile || (mode !== "clipping" && mode !== "article-detail")) return false;
    return activeFile === file || (this.relatedNotes.get(activeFile.path)?.notes.some((note) => note.path === file.path) ?? false);
  }

  private getRelatedNotesProps(file: TFile) {
    const cached = this.relatedNotes.get(file.path);
    const indexUpdatedAt = this.plugin.semanticIndex.getStats().updatedAt;
    const fresh = cached?.mtime === file.stat.mtime && cached.indexUpdatedAt === indexUpdatedAt
      && cached.candidateKey === this.relatedNoteCandidateKey(cached.notes);
    if (
      file.extension === "md" && !fresh
      && !this.relatedNoteLoads.has(file.path)
      && !this.relatedNoteErrors.has(file.path)
    ) {
      void this.loadRelatedNotes(file);
    }
    const collapsed = this.composerExpanded ? undefined : this.collapsedChats.get(this.getRenderContextKey());
    const attachedPaths = collapsed ? new Set(collapsed.contextPaths) : this.chatContextPaths;
    return {
      notes: fresh ? cached.notes.map((note) => {
        const target = this.app.vault.getAbstractFileByPath(note.path);
        const frontmatter = target instanceof TFile ? this.app.metadataCache.getFileCache(target)?.frontmatter : undefined;
        return {
          ...note,
          briefDescription: this.getFrontmatterBriefDescription(frontmatter),
          addedToChat: attachedPaths.has(note.path)
        };
      }) : [],
      loading: this.relatedNoteLoads.has(file.path),
      error: this.relatedNoteErrors.get(file.path),
      indexReady: this.plugin.semanticIndex.isReady(),
      indexBuilding: this.plugin.semanticIndex.isBuilding(),
      indexScope: this.plugin.settings.articlesFolder,
      onBuildIndex: () => this.buildSemanticIndex(),
      onRetry: () => {
        this.relatedNoteErrors.delete(file.path);
        void this.loadRelatedNotes(file);
        this.render();
      },
      onOpen: (path: string) => void this.app.workspace.openLinkText(path, file.path, false),
      onAddToChat: (path: string) => this.openComposer(path)
    };
  }

  private relatedNoteCandidateKey(notes: RelatedNote[]): string {
    return JSON.stringify(notes.map(({ path }) => {
      const target = this.app.vault.getAbstractFileByPath(path);
      return [path, target instanceof TFile ? target.stat.mtime : null];
    }));
  }

  private async loadRelatedNotes(file: TFile): Promise<void> {
    const path = file.path;
    const mtime = file.stat.mtime;
    const indexUpdatedAt = this.plugin.semanticIndex.getStats().updatedAt;
    this.relatedNoteLoads.add(path);
    this.relatedNoteErrors.delete(path);
    try {
      const notes = await this.plugin.semanticIndex.findRelated(file);
      if (file.path !== path || file.stat.mtime !== mtime) return;
      const candidateKey = this.relatedNoteCandidateKey(notes);
      this.relatedNotes.set(path, { mtime, indexUpdatedAt, candidateKey, notes });
    } catch (error) {
      this.relatedNoteErrors.set(path, error instanceof Error ? error.message : String(error));
    } finally {
      this.relatedNoteLoads.delete(path);
      if (this.plugin.router.getContext().activeFile?.path === file.path) {
        if (this.composerPreference === "auto") this.composerFitPending = true;
        this.render();
      }
    }
  }

  private async buildSemanticIndex(): Promise<void> {
    if (this.plugin.semanticIndex.isBuilding()) return;
    try {
      const build = this.plugin.semanticIndex.rebuild();
      this.render();
      const stats = await build;
      this.relatedNoteErrors.clear();
      new Notice(`KnowFlow indexed ${stats.files} AI summaries.`);
    } catch (error) {
      new Notice(`KnowFlow index failed: ${error instanceof Error ? error.message : String(error)}`, 8000);
    } finally {
      this.render();
    }
  }

  private async saveAssistantAsSummary(thread: ChatThread, message: ChatMessage): Promise<void> {
    if (!thread.filePath) return;
    const target = this.app.vault.getAbstractFileByPath(thread.filePath);
    if (!(target instanceof TFile)) {
      new Notice("关联文章不存在。");
      return;
    }
    const summary = message.content;
    const reason = "用户从 Chat 手动保存为摘要。";
    await this.plugin.summaryNotes.applySummary(target, { summary, reason });
    this.summaryController.cacheText(target, { summary, reason });
    new Notice("Saved as AI Summary");
  }


  private async openChatHistory(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    const existing = root.querySelector(".kf-chat-history-layer");
    if (existing) {
      existing.remove();
      return;
    }
    const threads = await this.plugin.chatNotes.listThreads();
    renderChatHistoryPopover(root, {
      threads,
      onClose: () => root.querySelector(".kf-chat-history-layer")?.remove(),
      onOpen: (thread) => {
        this.chatController.activeThread = thread;
        this.render();
      }
    });
  }

  private async runPipeline(file: TFile): Promise<void> {
    if (this.pipelineStates.get(file.path)?.running) return;
    this.pipelineStates.set(file.path, {
      completed: [],
      skipped: [],
      stepInfo: {},
      currentStep: null,
      error: null,
      failedStep: null,
      running: true,
      visible: true
    });
    this.render();
    try {
      await this.plugin.pipeline.process(file, (step, status, info) => {
        const state = this.pipelineStates.get(file.path);
        if (!state) return;
        if (info) state.stepInfo[step] = info;
        if (status === "active") {
          if (state.currentStep && state.currentStep !== step && !state.completed.includes(state.currentStep)) {
            state.completed.push(state.currentStep);
          }
          state.currentStep = step;
        } else {
          const target = status === "completed" ? state.completed : state.skipped;
          if (!target.includes(step)) target.push(step);
          if (state.currentStep === step) state.currentStep = null;
        }
        state.running = true;
        state.visible = true;
        this.pipelineStates.set(file.path, state);
        this.render();
      });
      const state = this.pipelineStates.get(file.path);
      if (state) {
        if (state.currentStep && !state.completed.includes(state.currentStep)) {
          state.completed.push(state.currentStep);
        }
        state.currentStep = null;
        state.running = false;
        this.pipelineStates.set(file.path, state);
      }
      this.render();
    } catch (error) {
      const state = this.pipelineStates.get(file.path);
      if (state) {
        state.failedStep = state.currentStep;
        state.error = error instanceof Error ? error.message : String(error);
        state.running = false;
        state.visible = true;
        this.pipelineStates.set(file.path, state);
      }
      this.render();
      new Notice(`KnowFlow failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async moveToCategory(file: TFile, category: string): Promise<void> {
    try {
      await this.plugin.pipeline.moveToCategory(file, category);
      this.render();
    } catch (error) {
      new Notice(`KnowFlow move failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async startQuiz(file: TFile): Promise<void> {
    const loaded = await this.plugin.quizNotes.loadReviewQuestions(file.path);
    if (!loaded || loaded.entries.length === 0) {
      new Notice("请先生成试题。");
      return;
    }
    const firstUnanswered = loaded.entries.findIndex((entry) => entry.answerState.selectedKey === null);
    if (firstUnanswered < 0) {
      await this.plugin.quizNotes.clearAnswers(file.path);
      this.quizController.invalidate(file.path);
    }
    this.quizSession = {
      filePath: file.path,
      quizPath: loaded.quizPath,
      title: file.basename,
      questions: loaded.entries.map((entry) => entry.question),
      index: firstUnanswered >= 0 ? firstUnanswered : 0,
      selectedKey: null,
      submitted: false
    };
    this.render();
  }

  private startDailyReview(review: DailyReviewSession): void {
    if (review.questions.length === 0) return;
    const firstUnanswered = review.questions.findIndex((question) => !review.answers[question.key]);
    const index = firstUnanswered >= 0 ? firstUnanswered : 0;
    this.quizSession = {
      filePath: review.questions[index].articlePath,
      quizPath: review.questions[index].quizPath,
      title: "今日复习",
      questions: review.questions.map((question) => question.question),
      index,
      selectedKey: review.answers[review.questions[index].key]?.selectedKey ?? null,
      submitted: Boolean(review.answers[review.questions[index].key]),
      reviewDate: review.date,
      reviewQuestionKeys: review.questions.map((question) => question.key)
    };
    this.render();
  }

  private async submitQuizAnswer(session: QuizSession): Promise<void> {
    if (!session.selectedKey) {
      new Notice("请选择一个答案。");
      return;
    }
    if (session.reviewDate && session.reviewQuestionKeys) {
      const questionKey = session.reviewQuestionKeys[session.index];
      await this.plugin.dailyReview.recordAnswer(session.reviewDate, questionKey, session.selectedKey);
    } else {
      await this.quizController.recordAnswer(session);
    }
    session.submitted = true;
    this.render();
  }

  private getSummaryViewModel(file: TFile): NoteSummary | null {
    const text = this.summaryController.getSummaryText(file);
    if (text === null) return null;
    return {
      ...this.getSummaryMeta(file),
      filePath: file.path,
      title: file.basename,
      summary: text?.summary ?? "正在读取摘要正文...",
      reason: text?.reason ?? ""
    };
  }


  private summarizeArticles(scopePath: string, files: TFile[]): {
    stats: ArticleStats;
    categoryStats: Array<{ name: string; total: number; learned: number }>;
    weekly: { dailyLearned: number[]; dailyReview: number[]; reviewCount: number; reviewAccuracy: number | null };
  } {
    const weekStart = startOfLocalWeek(new Date());
    const learnedPathsByDay = Array.from({ length: 7 }, () => new Set<string>());
    const addLearnedPath = (path: string, date: Date): void => {
      const localDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      const index = Math.round((localDay.getTime() - weekStart.getTime()) / 86_400_000);
      if (index >= 0 && index < learnedPathsByDay.length) learnedPathsByDay[index].add(path);
    };
    const categories = new Map(ARTICLE_CATEGORIES.map((name) => [name, { name, total: 0, learned: 0 }]));
    const folder = `${this.plugin.settings.articlesFolder}/`;
    let learned = 0;

    for (const file of files) {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      const fileLearned = this.isLearnedStatus(frontmatter, file.path);
      if (fileLearned) learned += 1;
      const category = categories.get(this.categoryFolderName(file.path, folder) ?? "");
      if (category) {
        category.total += 1;
        if (fileLearned) category.learned += 1;
      }
      const date = this.getFrontmatterLearningDate(frontmatter);
      if (date) addLearnedPath(file.path, date);
    }

    for (const task of this.plugin.store.getCompletedTasksSince(weekStart)) {
      if (!task.targetPath?.startsWith(`${scopePath}/`) || !task.completedAt) continue;
      if (task.type === "new_note") addLearnedPath(task.targetPath, new Date(task.completedAt));
    }
    const reviewActivity = summarizeWeeklyReviewActivity(
      this.plugin.store.getCompletedReviewSessionsSince(weekStart),
      weekStart,
      scopePath,
      this.plugin.settings.articlesFolder
    );

    return {
      stats: {
        scopePath,
        total: files.length,
        learned,
        unread: Math.max(files.length - learned, 0),
        reviewDue: 0,
        weakPoints: 0
      },
      categoryStats: ARTICLE_CATEGORIES
        .map((name) => categories.get(name)!)
        .filter((category) => category.total > 0),
      weekly: {
        dailyLearned: learnedPathsByDay.map((paths) => paths.size),
        dailyReview: reviewActivity.dailyQuestions,
        reviewCount: reviewActivity.sessionCount,
        reviewAccuracy: reviewActivity.averageAccuracy
      }
    };
  }

  private categoryFolderName(path: string, folderPrefix: string): string | null {
    if (!path.startsWith(folderPrefix)) return null;
    const slash = path.indexOf("/", folderPrefix.length);
    if (slash <= folderPrefix.length) return null;
    return path.slice(folderPrefix.length, slash);
  }

  private getArticleFiles(scopePath: string): TFile[] {
    return this.app.vault.getMarkdownFiles()
      .filter((file) => file.path.startsWith(`${scopePath}/`));
  }

  private isArticleLearned(file: TFile): boolean {
    return this.isLearnedStatus(this.app.metadataCache.getFileCache(file)?.frontmatter, file.path);
  }

  private isLearnedStatus(frontmatter: Record<string, unknown> | undefined, path: string): boolean {
    const status = this.getFrontmatterLearningStatus(frontmatter);
    if (status) return !/未学习|待学习|未读|pending/i.test(status);
    return this.plugin.store.isLearned(path);
  }

  private getArticleReadingValue(file: TFile): number {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return this.getFrontmatterReadingValueNumber(frontmatter) ?? 0;
  }

  private getFrontmatterReadingValueNumber(frontmatter: Record<string, unknown> | undefined): number | null {
    const value = frontmatter?.["阅读价值"];
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private getFrontmatterCategory(frontmatter: Record<string, unknown> | undefined): string | null {
    const value = frontmatter?.["分类"];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private getFrontmatterBriefDescription(frontmatter: Record<string, unknown> | undefined): string | null {
    const value = frontmatter?.["简要描述"];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private getFrontmatterTags(frontmatter: Record<string, unknown> | undefined): string[] | null {
    const value = frontmatter?.tags;
    if (Array.isArray(value)) {
      const tags = value.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0);
      return tags.length > 0 ? tags : null;
    }
    if (typeof value === "string" && value.trim()) return [value.trim()];
    return null;
  }

  private getSummaryMeta(file: TFile): Omit<NoteSummary, "filePath" | "title" | "summary" | "reason"> {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const readingValue = this.getFrontmatterReadingValueNumber(frontmatter) ?? 0;
    return {
      briefDescription: this.getFrontmatterBriefDescription(frontmatter) ?? "",
      readingValue,
      category: this.getFrontmatterCategory(frontmatter) ?? this.plugin.settings.defaultArticleCategory,
      tags: this.getFrontmatterTags(frontmatter) ?? [],
      recommendedAction: this.recommendedActionFromReadingValue(readingValue)
    };
  }

  private getFrontmatterLearningDate(frontmatter: Record<string, unknown> | undefined): Date | null {
    const value = frontmatter?.["学习日期"];
    if (typeof value !== "string" && typeof value !== "number") return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private getFrontmatterReadingValue(frontmatter: Record<string, unknown> | undefined): string | null {
    const value = frontmatter?.["阅读价值"];
    if (typeof value === "number") return `${value}/5`;
    if (typeof value === "string" && value.trim()) {
      const normalized = value.trim();
      return normalized.includes("/") ? normalized : `${normalized}/5`;
    }
    return null;
  }

  private getFrontmatterLearningStatus(frontmatter: Record<string, unknown> | undefined): string | null {
    const value = frontmatter?.["学习状态"];
    if (Array.isArray(value)) {
      const first = value.find((item) => typeof item === "string" && item.trim());
      return typeof first === "string" ? first.trim() : null;
    }
    if (typeof value === "string" && value.trim()) return value.trim();
    return null;
  }

  private recommendedActionFromReadingValue(value: number): NoteSummary["recommendedAction"] {
    if (value <= 1) return "skip";
    if (value >= 5) return "keep_reference";
    if (value >= 4) return "deep_learn";
    return "skim";
  }

  private recommendedActionLabel(action: string): string {
    if (action === "skip") return "跳过";
    if (action === "skim") return "快速阅读";
    if (action === "deep_learn") return "深入学习";
    if (action === "keep_reference") return "长期参考";
    return "--";
  }

  private getRenderContextKey(): string {
    if (this.chatController.activeThread) return `chat:${this.chatController.activeThread.id}`;
    if (this.quizSession?.reviewDate) return `review:${this.quizSession.reviewDate}`;
    if (this.quizSession) return `quiz:${this.quizSession.filePath}`;
    if (this.quizResults) return `quiz-results:${this.quizResults.filePath}`;
    if (this.knowledgePointView) {
      return `knowledge:${this.knowledgePointView.filePath}`;
    }
    const context = this.plugin.router.getContext();
    return `${context.mode}:${context.activeFile?.path ?? context.selectedPath ?? ""}`;
  }

  private restoreScroll(scrollTop: number, shouldRestore: boolean): void {
    if (!shouldRestore || scrollTop <= 0) return;
    window.requestAnimationFrame(() => {
      const content = this.containerEl.querySelector<HTMLElement>(".kf-content");
      if (content) content.scrollTop = scrollTop;
    });
  }

  private async renderMarkdownSummary(parent: HTMLElement, markdown: string, sourcePath: string): Promise<void> {
    const container = parent.createDiv({ cls: "kf-markdown-summary markdown-rendered" });
    setStyles(container, {
      color: "var(--text-muted)",
      fontSize: "13px",
      lineHeight: "1.5"
    });
    await MarkdownRenderer.render(this.app, markdown, container, sourcePath, this);
    container.querySelectorAll("p").forEach((el) => {
      setStyles(el as HTMLElement, { margin: "0 0 6px" });
    });
    container.querySelectorAll("ul, ol").forEach((el) => {
      setStyles(el as HTMLElement, {
        margin: "2px 0 8px",
        paddingLeft: "18px"
      });
    });
    container.querySelectorAll("li").forEach((el) => {
      setStyles(el as HTMLElement, { margin: "2px 0" });
    });
    container.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((el) => {
      setStyles(el as HTMLElement, {
        color: "var(--text-normal)",
        fontSize: "13px",
        fontWeight: "650",
        margin: "8px 0 4px"
      });
    });
  }

}

function startOfLocalWeek(date: Date): Date {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = start.getDay();
  const diff = day === 0 ? 6 : day - 1;
  start.setDate(start.getDate() - diff);
  start.setHours(0, 0, 0, 0);
  return start;
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dailyTaskPlanKey(date: string, scopePath: string): string {
  return `${date}:${scopePath}`;
}

function normalizeHeading(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/^#+\s*/, "")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}
