import type { TFile } from "obsidian";

export const KNOWFLOW_VIEW_TYPE = "knowflow-sidebar";

export type KnowFlowMode =
  | "empty"
  | "clipping"
  | "task-overview"
  | "article-detail"
  | "quiz-test"
  | "chat-result";

export type AiRuntime = "openai-compatible" | "ollama" | "lm-studio" | "disabled";

export interface AiModelConfig {
  runtime: AiRuntime;
  apiBaseUrl: string;
  apiKey: string;
  model: string;
}

export interface KnowFlowSettings {
  clippingFolder: string;
  articlesFolder: string;
  semanticIndexExcludeFolders: string[];
  defaultArticleCategory: string;
  archiveFolder: string;
  chatConversationFolder: string;
  templatePath: string;
  summaryModel: AiModelConfig;
  knowledgeMapModel: AiModelConfig;
  pipelineModel: AiModelConfig;
  chatModel: AiModelConfig;
  quizModel: AiModelConfig;
  embeddingModel: AiModelConfig;
  autoCreateCategoryFolders: boolean;
  confirmBeforeWrite: boolean;
  translateEnglishClippings: boolean;
  autoOrganize: boolean;
  autoGenerateSummary: boolean;
  autoGenerateQuiz: boolean;
  dailyNewArticleLimit: number;
  dailyReviewQuestionCap: number;
}

export interface RelatedNote {
  path: string;
  title: string;
  excerpt: string;
  score: number;
  reasons: string[];
}

export interface SemanticIndexStats {
  files: number;
  chunks: number;
  model: string;
  updatedAt: string;
  compatible: boolean;
}

export interface NoteSummary {
  filePath: string;
  title: string;
  briefDescription: string;
  summary: string;
  readingValue: number;
  recommendedAction: "skip" | "skim" | "deep_learn" | "keep_reference";
  category: string;
  reason: string;
  tags: string[];
}

export interface QuizStats {
  total: number;
  answered: number;
  accuracy: number | null;
  wrong: number;
}

export interface QuizOption {
  key: string;
  content: string;
}

export interface QuizAnswerState {
  selectedKey: string | null;
  correct: boolean | null;
  answeredAt: string | null;
}

export interface QuizQuestion {
  id: string;
  notePath: string;
  knowledgePointId?: string;
  sourceSection?: string;
  question: string;
  type: "single_choice";
  options: QuizOption[];
  answerKey: string;
  explanation: string;
  difficulty: number;
  createdAt: string;
}

export type KnowledgePointType = "概念" | "机制" | "对比" | "流程" | "原则" | "实践";

export interface KnowledgePointRelations {
  dependsOn: string[];
  extends: string[];
}

export interface KnowledgePoint {
  id: string;
  title: string;
  type: KnowledgePointType;
  explanation: string;
  evidence: {
    section: string;
    excerpt: string;
  };
  question: string;
  relations: KnowledgePointRelations;
}

export interface KnowledgePointGroup {
  title: string;
  points: KnowledgePoint[];
}

export type KnowledgePointStatus = "untested" | "mastered" | "review";

export interface QuizSession {
  filePath: string;
  quizPath: string;
  title: string;
  questions: QuizQuestion[];
  index: number;
  selectedKey: string | null;
  submitted: boolean;
  reviewDate?: string;
  reviewQuestionKeys?: string[];
}

export type ReviewQuestionPriority = "wrong" | "unseen" | "due";

export interface DailyReviewQuestion {
  key: string;
  articlePath: string;
  articleTitle: string;
  quizPath: string;
  displayIndex: number;
  priority: ReviewQuestionPriority;
  question: QuizQuestion;
}

export interface DailyReviewAnswer {
  questionKey: string;
  selectedKey: string;
  correct: boolean;
  answeredAt: string;
}

export interface DailyReviewSession {
  generatorVersion: number;
  date: string;
  generatedAt: string;
  questionCap: number;
  bankSize: number;
  questions: DailyReviewQuestion[];
  answers: Record<string, DailyReviewAnswer>;
  completedAt: string | null;
}

export interface PipelineStatus {
  path: string;
  status: "raw" | "processed" | "failed";
  updatedAt: string;
  error?: string;
}

export interface PipelineUiState {
  completed: string[];
  skipped: string[];
  stepInfo: Record<string, string>;
  currentStep: string | null;
  error: string | null;
  failedStep: string | null;
  running: boolean;
  visible: boolean;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning: string;
  createdAt: string;
  completedAt?: string;
  status: "pending" | "streaming" | "done" | "error";
  error?: string;
}

export interface ChatThread {
  id: string;
  sourceMode: KnowFlowMode;
  filePath: string | null;
  contextLabel: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
  usage: ChatUsage;
}

export interface ViewContext {
  mode: KnowFlowMode;
  activeFile: TFile | null;
  selectedPath: string | null;
}

export interface ArticleStats {
  scopePath: string;
  total: number;
  learned: number;
  unread: number;
  reviewDue: number;
  weakPoints: number;
}

export type DailyTaskType = "new_note";
export type DailyTaskStatus = "pending" | "completed" | "skipped";

export interface DailyTask {
  id: string;
  type: DailyTaskType;
  title: string;
  targetPath: string | null;
  status: DailyTaskStatus;
  completedAt: string | null;
}

export interface DailyTaskPlan {
  generatorVersion: number;
  date: string;
  scopePath: string;
  generatedAt: string;
  newArticleLimit: number;
  tasks: DailyTask[];
}
