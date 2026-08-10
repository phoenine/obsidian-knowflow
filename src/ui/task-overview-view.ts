import type { ArticleStats, DailyTask } from "../types";
import { applyMetricsLayout, button, cardHeader, iconButton, metric, row, section, setStyles, text } from "./dom";
import { renderBrandShell } from "./shell";

interface TaskOverviewViewProps {
  scopeLabel: string;
  stats: ArticleStats;
  clippingStats: { total: number; summarized: number; highValue: number };
  categoryStats: Array<{ name: string; total: number; learned: number }>;
  tasks: DailyTask[];
  loading: boolean;
  weeklyLearned: number;
  onStartDaily: () => void;
  onRegenerate: () => void;
  onOpenTask: (task: DailyTask) => void;
  onCompleteTask: (task: DailyTask) => void;
  onSkipTask: (task: DailyTask) => void;
}

export function renderTaskOverviewView(root: HTMLElement, props: TaskOverviewViewProps): void {
  const content = renderBrandShell(root, "Task Overview");

  const pendingTasks = props.tasks.filter((task) => task.status === "pending");
  const completedTasks = props.tasks.filter((task) => task.status === "completed");
  const resolvedTasks = props.tasks.filter((task) => task.status !== "pending");
  const dailyNew = countTasks(props.tasks, "new_note");
  const dailyReview = countTasks(props.tasks, "review_note");
  const dailyWeakPoints = countTasks(props.tasks, "weak_point");

  const daily = section(content, "kf-daily");
  cardHeader(daily, "calendar-check", "今日任务", (header) => {
    text(header, props.loading ? "生成中…" : `${resolvedTasks.length}/${props.tasks.length} 已处理`, "kf-pill");
  });
  const dailyMetrics = row(daily, "kf-metrics");
  applyMetricsLayout(dailyMetrics);
  metric(dailyMetrics, "新文章", String(dailyNew));
  metric(dailyMetrics, "复习", String(dailyReview));
  metric(dailyMetrics, "薄弱点", String(dailyWeakPoints));
  if (props.loading) {
    text(daily, "正在筛选已生成 Quiz 的复习文章…", "kf-muted");
  } else if (props.tasks.length === 0) {
    text(daily, "当前范围内暂无可生成的学习任务。", "kf-muted");
  } else {
    for (const task of props.tasks) {
      taskRow(daily, task, props);
    }
  }
  const actions = row(daily, "kf-actions");
  const startButton = button(actions, pendingTasks.length > 0 ? "开始今日学习任务" : "今日任务已完成", props.onStartDaily, true);
  startButton.disabled = props.loading || pendingTasks.length === 0;
  const regenerateButton = button(actions, "重新生成", props.onRegenerate);
  regenerateButton.disabled = props.loading;

  const progress = section(content, "kf-progress");
  cardHeader(progress, "trending-up", "学习进度");
  progressRow(progress, "本周阅读", `${props.weeklyLearned} 篇`, props.weeklyLearned > 0 ? "持续" : "待开始");
  progressRow(progress, "今日完成", `${completedTasks.length} 项`, pendingTasks.length > 0 ? `${pendingTasks.length} 项待处理` : "已清空");
  progressRow(progress, "平均正确率", "--", "生成 Quiz 后统计");

  const clipping = section(content, "kf-clipping-stats");
  cardHeader(clipping, "inbox", "Clipping 统计");
  const clippingMetrics = row(clipping, "kf-metrics");
  applyMetricsLayout(clippingMetrics);
  metric(clippingMetrics, "待整理", String(props.clippingStats.total));
  metric(clippingMetrics, "已摘要", String(props.clippingStats.summarized));
  metric(clippingMetrics, "高价值", String(props.clippingStats.highValue));

  const articles = section(content, "kf-article-categories");
  cardHeader(articles, "folder-open", "Articles 分类统计", (header) => {
    text(header, props.scopeLabel, "kf-pill");
  });
  const articleMetrics = row(articles, "kf-metrics");
  applyMetricsLayout(articleMetrics);
  metric(articleMetrics, "文章", String(props.stats.total));
  metric(articleMetrics, "已学习", String(props.stats.learned));
  metric(articleMetrics, "待读", String(props.stats.unread));
  for (const category of props.categoryStats.slice(0, 6)) {
    categoryRow(articles, category.name, category.total, category.learned);
  }
}

function progressRow(parent: HTMLElement, label: string, value: string, trend: string): void {
  const item = row(parent, "kf-progress-row");
  setStyles(item, {
    justifyContent: "space-between",
    padding: "6px 0"
  });
  const left = item.createDiv();
  text(left, label, "kf-progress-label");
  text(left, trend, "kf-muted");
  text(item, value, "kf-progress-value");
}

function taskRow(parent: HTMLElement, task: DailyTask, props: TaskOverviewViewProps): void {
  const item = row(parent, "kf-task-row");
  setStyles(item, {
    backgroundColor: "color-mix(in srgb, var(--interactive-accent) 5%, var(--background-secondary))",
    border: "1px solid color-mix(in srgb, var(--interactive-accent) 10%, transparent)",
    borderRadius: "7px",
    gap: "9px",
    padding: "8px 9px"
  });
  const badge = item.createDiv({ text: taskTypeLabel(task.type) });
  setStyles(badge, {
    color: "var(--text-accent)",
    flex: "0 0 auto",
    fontSize: "12px",
    fontWeight: "600",
    whiteSpace: "nowrap"
  });
  const titleEl = text(item, task.title, task.status === "completed" ? "kf-muted kf-task-completed" : "kf-muted");
  setStyles(titleEl, {
    flex: "1",
    overflow: "hidden",
    textDecoration: task.status === "completed" ? "line-through" : "none",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap"
  });
  if (task.status === "pending") {
    if (task.targetPath) iconButton(item, "打开任务", "arrow-up-right", () => props.onOpenTask(task));
    iconButton(item, "标记完成", "check", () => props.onCompleteTask(task));
    iconButton(item, "跳过", "forward", () => props.onSkipTask(task));
  } else {
    text(item, task.status === "completed" ? "已完成" : "已跳过", "kf-pill");
  }
}

function countTasks(tasks: DailyTask[], type: DailyTask["type"]): number {
  return tasks.filter((task) => task.type === type).length;
}

function taskTypeLabel(type: DailyTask["type"]): string {
  if (type === "review_note") return "复习";
  if (type === "weak_point") return "薄弱点";
  return "学习";
}

function categoryRow(parent: HTMLElement, category: string, total: number, learned: number): void {
  const item = row(parent, "kf-category-row");
  setStyles(item, {
    justifyContent: "space-between",
    padding: "6px 0"
  });
  const left = item.createDiv();
  text(left, category, "kf-progress-label");
  text(left, `已学习 ${learned} / ${total}`, "kf-muted");
  text(item, `${Math.max(total - learned, 0)} 待读`, "kf-progress-value");
}
