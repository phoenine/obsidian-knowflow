import type { QuizStats } from "../types";
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
  const content = renderShell(root, "Quiz", "考试成绩", props.onBack);
  const card = section(content, "kf-quiz");
  text(card, props.title, "kf-card-title");
  const metrics = row(card, "kf-metrics");
  applyMetricsLayout(metrics);
  const answered = props.quiz?.answered ?? 0;
  const finished = Boolean(props.quiz && props.quiz.total > 0 && answered === props.quiz.total);
  const retakeLabel = props.pending || answered === 0 ? "开始考试" : finished ? "重新考试" : "继续考试";
  metric(metrics, "题目", props.quiz ? String(props.quiz.total) : "--");
  metric(metrics, "正确率", finished && props.quiz?.accuracy != null ? `${props.quiz.accuracy}%` : "--");
  metric(metrics, "错题", props.quiz ? String(props.quiz.wrong) : "--");
  if (props.pending) {
    text(card, "正在生成试题…", "kf-muted");
  } else if (props.quiz && props.quiz.answered === 0) {
    text(card, "还没有考试记录。", "kf-muted");
  } else if (props.quiz && !finished) {
    text(card, `已答 ${props.quiz.answered}/${props.quiz.total}。`, "kf-muted");
  }

  const actions = row(card, "kf-actions");
  applyActionLayout(actions);
  const regenerate = button(actions, props.pending ? "生成中…" : "重新生成", props.onRegenerate);
  regenerate.disabled = props.pending;
  if (props.pending) {
    regenerate.style.cursor = "default";
    regenerate.style.opacity = "0.72";
  }
  const retake = button(actions, retakeLabel, props.onRetake, true);
  const canRetake = !props.pending && props.quiz?.total !== 0;
  retake.disabled = !canRetake;
  if (!canRetake) {
    retake.style.cursor = "default";
    retake.style.opacity = "0.72";
  }
}
