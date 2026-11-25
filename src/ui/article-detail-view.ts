import { renderArticleMaintenanceActions, renderKnowledgePointsButton, renderQuizButton, renderSummaryCard, type ArticleMaintenanceProps, type SummaryCardProps } from "./clipping-view";
import { applyMetricsLayout, metric, row, section, text } from "./dom";
import { t } from "../i18n";
import { renderBrandShell } from "./shell";
import { renderRelevantNotesCard, type RelevantNotesCardProps } from "./relevant-notes-view";

interface ArticleDetailViewProps extends SummaryCardProps, RelevantNotesCardProps, ArticleMaintenanceProps {
  title: string;
  readingValue: string;
  learningStatus: string;
  knowledgePointCount: number | null;
  quizPending: boolean;
  hasAttempt: boolean;
  onShowKnowledgePoints: () => void;
  onOpenQuiz: () => void;
}

export function renderArticleDetailView(root: HTMLElement, props: ArticleDetailViewProps): void {
  const content = renderBrandShell(root, t("articleAssistant"), (actions) => {
    renderArticleMaintenanceActions(actions, props);
    renderKnowledgePointsButton(actions, props.onShowKnowledgePoints);
    renderQuizButton(actions, props.quizPending, props.hasAttempt, props.onOpenQuiz);
  });

  const article = section(content, "kf-current");
  text(article, props.title, "kf-card-title");
  const metrics = row(article, "kf-metrics");
  applyMetricsLayout(metrics);
  metric(metrics, t("readingValue"), props.readingValue);
  metric(metrics, t("status"), props.learningStatus);
  const knowledgeLabel = props.knowledgePointCount === null ? "--" : props.knowledgePointCount > 0 ? String(props.knowledgePointCount) : t("notGenerated");
  metric(metrics, t("knowledgePoints"), knowledgeLabel, props.onShowKnowledgePoints, knowledgeLabel === t("notGenerated"));

  renderSummaryCard(content, props);
  renderRelevantNotesCard(content, props);
}
