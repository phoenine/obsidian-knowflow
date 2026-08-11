import type { QuizStats } from "../types";
import { renderSummaryCard, type SummaryCardProps } from "./clipping-view";
import { applyActionLayout, applyMetricsLayout, button, cardHeader, metric, row, section, text } from "./dom";
import { renderBrandShell } from "./shell";

interface ArticleDetailViewProps extends SummaryCardProps {
  title: string;
  readingValue: string;
  learningStatus: string;
  knowledgePointCount: number | null;
  knowledgeMapPending: boolean;
  quizPending: boolean;
  quiz: QuizStats;
  onGenerateKnowledgeMap: () => void;
  onShowKnowledgePoints: () => void;
  onGenerateQuiz: () => void;
  onStartQuiz: () => void;
}

export function renderArticleDetailView(root: HTMLElement, props: ArticleDetailViewProps): void {
  const content = renderBrandShell(root, "Article assistant");

  const article = section(content, "kf-current");
  text(article, props.title, "kf-card-title");
  const metrics = row(article, "kf-metrics");
  applyMetricsLayout(metrics);
  metric(metrics, "阅读价值", props.readingValue);
  metric(metrics, "状态", props.learningStatus);
  metric(metrics, "知识点", props.knowledgePointCount === null ? "--" : String(props.knowledgePointCount));

  renderSummaryCard(content, props);

  const mapCard = section(content, "kf-knowledge-map");
  cardHeader(mapCard, "git-fork", "Knowledge Map", (header) => {
    text(header, "Mermaid", "kf-pill");
  });
  text(mapCard, "AI 根据文章结构选择辐射图、时间线或思维导图，并插入原文的 ## Knowledge Map 区块。", "kf-muted");
  const mapActions = row(mapCard, "kf-actions");
  applyActionLayout(mapActions);
  const generateMapButton = button(
    mapActions,
    props.knowledgeMapPending ? "正在生成…" : "生成 Mermaid",
    props.onGenerateKnowledgeMap,
    true
  );
  generateMapButton.disabled = props.knowledgeMapPending;
  generateMapButton.setAttribute("aria-busy", String(props.knowledgeMapPending));
  if (props.knowledgeMapPending) {
    generateMapButton.style.cursor = "default";
    generateMapButton.style.opacity = "0.72";
  }
  button(mapActions, "查看知识点", props.onShowKnowledgePoints);

  const quizCard = section(content, "kf-quiz");
  cardHeader(quizCard, "list-checks", "Quiz");
  const quizMetrics = row(quizCard, "kf-metrics");
  applyMetricsLayout(quizMetrics);
  metric(quizMetrics, "题目", String(props.quiz.total));
  metric(quizMetrics, "正确率", props.quiz.accuracy === null ? "--" : `${props.quiz.accuracy}%`);
  metric(quizMetrics, "错题", String(props.quiz.wrong));
  const actions = row(quizCard, "kf-actions");
  applyActionLayout(actions);
  const generateQuizButton = button(
    actions,
    props.quizPending ? "生成中…" : props.quiz.total > 0 ? "重新生成" : "生成试题",
    props.onGenerateQuiz,
    true
  );
  generateQuizButton.disabled = props.quizPending;
  generateQuizButton.setAttribute("aria-busy", String(props.quizPending));
  if (props.quizPending) {
    generateQuizButton.style.cursor = "default";
    generateQuizButton.style.opacity = "0.72";
  }
  button(actions, "开始测试", props.onStartQuiz);
}
