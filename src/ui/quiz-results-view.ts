import type { QuizStats } from "../types";
import { t } from "../i18n";
import { applyActionLayout, applyMetricsLayout, button, metric, row, section, text } from "./dom";
import { renderShell } from "./shell";

interface QuizResultsViewProps {
  title: string;
  quiz: QuizStats | null;
  pending: boolean;
  onBack: () => void;
  onRegenerate: () => void;
  onRetake: () => void;
}

export function renderQuizResultsView(root: HTMLElement, props: QuizResultsViewProps): void {
  const content = renderShell(root, "Quiz", t("quizScore"), props.onBack);
  const card = section(content, "kf-quiz");
  text(card, props.title, "kf-card-title");
  const metrics = row(card, "kf-metrics");
  applyMetricsLayout(metrics);
  const answered = props.quiz?.answered ?? 0;
  const finished = Boolean(props.quiz && props.quiz.total > 0 && answered === props.quiz.total);
  const retakeLabel = props.pending || answered === 0 ? t("startQuiz") : finished ? t("retakeQuiz") : t("continueQuiz");
  metric(metrics, t("questions"), props.quiz ? String(props.quiz.total) : "--");
  metric(metrics, t("accuracy"), finished && props.quiz?.accuracy != null ? `${props.quiz.accuracy}%` : "--");
  metric(metrics, t("wrongAnswers"), props.quiz ? String(props.quiz.wrong) : "--");
  if (props.pending) {
    text(card, t("generatingQuiz"), "kf-muted");
  } else if (props.quiz && props.quiz.answered === 0) {
    text(card, t("noQuizRecord"), "kf-muted");
  } else if (props.quiz && !finished) {
    text(card, t("answeredProgress", { answered: props.quiz.answered, total: props.quiz.total }), "kf-muted");
  }

  const actions = row(card, "kf-actions");
  applyActionLayout(actions);
  const regenerate = button(actions, props.pending ? t("generating") : t("regenerateQuiz"), props.onRegenerate);
  regenerate.disabled = props.pending;
  if (props.pending) {
    regenerate.setCssStyles({ cursor: "default", opacity: "0.72" });
  }
  const retake = button(actions, retakeLabel, props.onRetake, true);
  const canRetake = !props.pending && props.quiz?.total !== 0;
  retake.disabled = !canRetake;
  if (!canRetake) {
    retake.setCssStyles({ cursor: "default", opacity: "0.72" });
  }
}
