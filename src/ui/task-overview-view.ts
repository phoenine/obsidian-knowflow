import { setIcon } from "obsidian";
import type { ArticleStats, DailyReviewSession, DailyTask } from "../types";
import { t } from "../i18n";
import { iconButton, setStyles } from "./dom";
import { renderBrandShell } from "./shell";

interface TaskOverviewViewProps {
  scopeLabel: string;
  stats: ArticleStats;
  categoryStats: Array<{ name: string; total: number; learned: number }>;
  tasks: DailyTask[];
  review: DailyReviewSession | null;
  loading: boolean;
  weeklyLearned: number;
  weeklyReviewCount: number;
  weeklyReviewAccuracy: number | null;
  weeklyReadTrend: number[];
  weeklyReviewTrend: number[];
  onOpenTask: (task: DailyTask) => void;
  onCompleteTask: (task: DailyTask) => void;
  onRefreshTask: (task: DailyTask) => void;
  onSkipTask: (task: DailyTask) => void;
  onRefreshReview: () => void;
  onStartReview: () => void;
}

const PALETTE = {
  background: "#FBFCF8",
  surface: "#FAFCF8",
  text: "#18361D",
  muted: "#6F7D70",
  accent: "#3E7F34",
  review: "#A56F1B",
  border: "#D9E8D5",
  divider: "#D9E3D6",
  track: "#DCE7D8"
};

const METRIC_LABEL_FONT_SIZE = "11px";
const METRIC_LABEL_LINE_HEIGHT = "15px";
const METRIC_VALUE_FONT_SIZE = "13px";
const METRIC_VALUE_LINE_HEIGHT = "17px";

export function renderTaskOverviewView(root: HTMLElement, props: TaskOverviewViewProps): void {
  const pendingTasks = props.tasks.filter((task) => task.status === "pending");
  const completedTasks = props.tasks.filter((task) => task.status === "completed");
  const resolvedTasks = props.tasks.filter((task) => task.status !== "pending");
  const dailyNew = countTasks(props.tasks, "new_note");
  const dailyReview = props.review?.questions.length ?? 0;
  const reviewCompleted = Boolean(props.review?.completedAt);
  const totalTaskCount = props.tasks.length + (dailyReview > 0 ? 1 : 0);
  const completedTaskCount = resolvedTasks.length + (reviewCompleted ? 1 : 0);
  const progressPercent = totalTaskCount > 0
    ? Math.round((completedTaskCount / totalTaskCount) * 100)
    : 0;

  const content = renderBrandShell(root, t("taskOverview"));
  setStyles(content, {
    backgroundColor: PALETTE.background,
    gap: "0",
    padding: "14px"
  });
  const page = content.createDiv({ cls: "kf-task-overview-page" });
  setStyles(page, {
    backgroundColor: PALETTE.background,
    color: PALETTE.text,
    fontFamily: '"Noto Sans SC", "PingFang SC", sans-serif',
    minHeight: "100%"
  });

  renderTodayCard(page, {
    ...props,
    completedCount: completedTasks.length + (reviewCompleted ? 1 : 0),
    dailyNew,
    dailyReview,
    pendingCount: pendingTasks.length,
    progressPercent
  });
  setStyles(page.createDiv({ cls: "kf-today-card-divider" }), {
    backgroundColor: PALETTE.border,
    height: "1px",
    margin: "14px 4px 0"
  });
  renderLearningTrend(
    page,
    props.weeklyReadTrend,
    props.weeklyReviewTrend,
    props.weeklyLearned,
    props.weeklyReviewCount,
    props.weeklyReviewAccuracy
  );
  renderArticleStats(page, props.scopeLabel, props.stats, props.categoryStats);
}

interface TodayCardProps extends TaskOverviewViewProps {
  completedCount: number;
  dailyNew: number;
  dailyReview: number;
  pendingCount: number;
  progressPercent: number;
}

function renderTodayCard(parent: HTMLElement, props: TodayCardProps): void {
  const card = parent.createDiv({ cls: "kf-today-card" });
  setStyles(card, {
    backgroundColor: PALETTE.surface,
    border: `1px solid #D4E2D1`,
    borderRadius: "8px",
    marginTop: "14px",
    padding: "14px 14px 8px"
  });

  const hero = card.createDiv();
  setStyles(hero, {
    alignItems: "center",
    display: "grid",
    gap: "12px",
    gridTemplateColumns: "minmax(0, 1fr) 88px",
    minHeight: "82px"
  });
  const copy = hero.createDiv();
  const heading = copy.createDiv();
  setStyles(heading, { alignItems: "center", display: "flex", gap: "8px" });
  createIcon(heading, "leaf", 20);
  setStyles(heading.createDiv({ text: t("todayLearning") }), {
    fontSize: "15px",
    fontWeight: "650",
    lineHeight: "20px"
  });
  setStyles(copy.createDiv({ text: t("dailyMotto") }), {
    color: PALETTE.muted,
    fontSize: "13px",
    lineHeight: "18px",
    marginTop: "12px"
  });
  renderProgressRing(hero, props.progressPercent);

  const metrics = card.createDiv();
  setStyles(metrics, {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    margin: "14px 0 12px"
  });
  dailyMetric(metrics, t("newArticles"), t("articleCount", { count: props.dailyNew }));
  dailyMetric(metrics, t("review"), t("questionCount", { count: props.dailyReview }), true);
  dailyMetric(metrics, t("completed"), t("itemCount", {
    done: props.completedCount,
    total: props.tasks.length + (props.dailyReview > 0 ? 1 : 0)
  }), true);

  divider(card);
  const taskHeading = card.createDiv();
  setStyles(taskHeading, {
    alignItems: "center",
    display: "flex",
    gap: "10px",
    margin: "10px 0 4px"
  });
  createIcon(taskHeading, "calendar-check", 16, PALETTE.text);
  const totalTasks = props.tasks.length + (props.dailyReview > 0 ? 1 : 0);
  setStyles(taskHeading.createDiv({ text: t("todayTasks", { count: totalTasks }) }), {
    fontSize: "14px",
    fontWeight: "600",
    lineHeight: "19px"
  });

  if (props.loading) {
    stateMessage(card, t("generatingReview"));
  } else if (totalTasks === 0) {
    stateMessage(card, props.review && props.review.bankSize > 0
      ? t("noDueReview")
      : t("noLearningItems"));
  } else {
    const taskRows = props.tasks.map((task) => taskRow(card, task, props));
    if (props.review && props.review.questions.length > 0) {
      taskRows.push(reviewTaskRow(card, props.review, props));
    }
    const updateTaskRows = (expanded: boolean): void => {
      const visibleCount = expanded ? taskRows.length : Math.min(4, taskRows.length);
      for (const [index, row] of taskRows.entries()) {
        row.style.display = index < visibleCount ? "grid" : "none";
        row.style.borderBottom = index < visibleCount - 1 ? `1px solid ${PALETTE.border}` : "none";
      }
    };
    updateTaskRows(false);
    if (taskRows.length > 4) {
      expandButton(card, taskRows.length - 4, t("itemsUnit"), updateTaskRows);
    } else if (props.pendingCount === 0) {
      setStyles(card.createDiv({ text: t("tasksDone") }), {
        color: PALETTE.accent,
        fontSize: "13px",
        fontWeight: "500",
        padding: "14px 0 3px",
        textAlign: "center"
      });
    }
  }
}

function reviewTaskRow(parent: HTMLElement, review: DailyReviewSession, props: TaskOverviewViewProps): HTMLElement {
  const answered = Object.keys(review.answers).length;
  const item = parent.createDiv({ cls: "kf-today-task-row" });
  setStyles(item, {
    alignItems: "center",
    display: "grid",
    gap: "8px",
    gridTemplateColumns: "18px minmax(0, 1fr) 24px 24px",
    minHeight: "38px"
  });
  const status = item.createDiv();
  setStyles(status, {
    alignItems: "center",
    backgroundColor: review.completedAt ? PALETTE.accent : PALETTE.background,
    border: `1.3px solid ${PALETTE.accent}`,
    borderRadius: "50%",
    color: PALETTE.background,
    display: "flex",
    height: "15px",
    justifyContent: "center",
    width: "15px"
  });
  if (review.completedAt) createIcon(status, "check", 10, PALETTE.background);

  const copy = item.createDiv();
  setStyles(copy.createDiv({ text: t("todayReview") }), {
    color: PALETTE.review,
    fontSize: "13px",
    fontWeight: "400",
    lineHeight: "17px",
    textDecoration: review.completedAt ? "line-through" : "none"
  });

  taskAction(item, t("refreshQuestions"), "refresh-cw", answered === 0, props.onRefreshReview);
  taskAction(
    item,
    review.completedAt ? t("viewResult") : answered > 0 ? t("continueQuiz") : t("startQuiz"),
    "clipboard-check",
    true,
    props.onStartReview
  );
  return item;
}

function renderProgressRing(parent: HTMLElement, percent: number): void {
  const column = parent.createDiv();
  setStyles(column, {
    alignItems: "center",
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    minWidth: "0"
  });
  const ring = column.createDiv({ cls: "kf-task-progress-ring" });
  setStyles(ring, {
    alignItems: "center",
    background: `conic-gradient(${PALETTE.accent} 0 ${percent}%, #E3EBE0 ${percent}% 100%)`,
    borderRadius: "50%",
    boxSizing: "border-box",
    display: "flex",
    flex: "0 0 auto",
    height: "72px",
    justifyContent: "center",
    padding: "6px",
    width: "72px"
  });
  const center = ring.createDiv();
  setStyles(center, {
    alignItems: "center",
    backgroundColor: PALETTE.surface,
    borderRadius: "50%",
    display: "flex",
    height: "100%",
    justifyContent: "center",
    width: "100%"
  });
  setStyles(center.createDiv({ text: `${percent}%` }), {
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: "18px",
    fontWeight: "800",
    lineHeight: "21px"
  });
  setStyles(column.createDiv({ text: t("todayProgress") }), {
    color: PALETTE.muted,
    fontSize: "11px",
    lineHeight: "14px",
    overflowWrap: "anywhere",
    textAlign: "center",
    width: "100%"
  });
}

function dailyMetric(parent: HTMLElement, label: string, value: string, separated = false): void {
  const item = parent.createDiv();
  setStyles(item, {
    borderLeft: separated ? `1px solid ${PALETTE.divider}` : "none",
    minWidth: "0",
    padding: "0 12px",
    textAlign: "center"
  });
  setStyles(item.createDiv({ text: label }), {
    color: PALETTE.muted,
    fontSize: METRIC_LABEL_FONT_SIZE,
    fontWeight: "500",
    lineHeight: METRIC_LABEL_LINE_HEIGHT,
    overflowWrap: "anywhere"
  });
  setStyles(item.createDiv({ text: value }), {
    borderTop: `1px solid ${PALETTE.divider}`,
    color: PALETTE.accent,
    fontSize: METRIC_VALUE_FONT_SIZE,
    fontWeight: "700",
    lineHeight: METRIC_VALUE_LINE_HEIGHT,
    marginTop: "5px",
    paddingTop: "5px"
  });
}

function taskRow(parent: HTMLElement, task: DailyTask, props: TaskOverviewViewProps): HTMLElement {
  const item = parent.createDiv({ cls: "kf-today-task-row" });
  setStyles(item, {
    alignItems: "center",
    borderBottom: "none",
    display: "grid",
    gap: "8px",
    gridTemplateColumns: "18px minmax(0, 1fr) 24px 24px",
    minHeight: "38px"
  });

  const status = item.createEl("button", {
    cls: "kf-task-status-button",
    attr: {
      "aria-label": task.status === "pending" ? t("completeTask", { title: task.title }) : taskStatusLabel(task.status),
      title: task.status === "pending" ? t("markComplete") : taskStatusLabel(task.status)
    }
  });
  setStyles(status, {
    alignItems: "center",
    background: task.status === "completed" ? PALETTE.accent : PALETTE.background,
    border: `1.3px solid ${PALETTE.accent}`,
    borderRadius: "50%",
    color: PALETTE.background,
    cursor: task.status === "pending" ? "pointer" : "default",
    display: "flex",
    height: "15px",
    justifyContent: "center",
    padding: "0",
    width: "15px"
  });
  if (task.status === "completed") createIcon(status, "check", 10, PALETTE.background);
  status.disabled = task.status !== "pending";
  status.addEventListener("click", (event) => {
    event.stopPropagation();
    props.onCompleteTask(task);
  });

  const title = item.createEl("a", {
    text: task.title,
    cls: "internal-link kf-today-task-link",
    attr: {
      href: task.targetPath ?? "#",
      "data-href": task.targetPath ?? "",
      title: task.title
    }
  });
  setStyles(title, {
    color: task.status === "skipped" ? PALETTE.muted : PALETTE.text,
    cursor: task.targetPath ? "pointer" : "default",
    fontSize: "13px",
    lineHeight: "18px",
    overflow: "hidden",
    textDecoration: task.status === "completed" ? "line-through" : "none",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap"
  });
  title.addEventListener("click", (event) => {
    event.preventDefault();
    if (task.targetPath) props.onOpenTask(task);
  });

  taskAction(item, t("swapArticle"), "refresh-cw", task.status === "pending", () => props.onRefreshTask(task));
  taskAction(item, t("skipTask"), "skip-forward", task.status === "pending", () => props.onSkipTask(task));
  return item;
}

function taskAction(parent: HTMLElement, label: string, icon: string, enabled: boolean, onClick: () => void): void {
  const action = setStyles(iconButton(parent, label, icon, onClick), {
    backgroundColor: "transparent",
    borderColor: PALETTE.border,
    color: PALETTE.accent,
    cursor: enabled ? "pointer" : "default",
    height: "24px",
    opacity: enabled ? "1" : "0.35",
    width: "24px"
  });
  action.disabled = !enabled;
  const svg = action.querySelector<SVGSVGElement>("svg");
  if (svg) Object.assign(svg.style, { height: "13px", width: "13px" });
}

function renderLearningTrend(
  parent: HTMLElement,
  weeklyReadTrend: number[],
  weeklyReviewTrend: number[],
  weeklyLearned: number,
  weeklyReviewCount: number,
  weeklyReviewAccuracy: number | null
): void {
  const section = parent.createDiv({ cls: "kf-learning-trend" });
  setStyles(section, { padding: "14px 4px 0" });
  sectionHeading(section, "chart-no-axes-column", t("learningTrend"), 15);

  const chart = section.createDiv();
  setStyles(chart, {
    borderBottom: `1px solid #7FA87B`,
    display: "grid",
    gap: "18px",
    gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
    height: "104px",
    marginTop: "3px",
    padding: "0 13px"
  });
  const days = [t("weekdayMon"), t("weekdayTue"), t("weekdayWed"), t("weekdayThu"), t("weekdayFri"), t("weekdaySat"), t("weekdaySun")];
  const readValues = days.map((_, index) => weeklyReadTrend[index] ?? 0);
  const reviewValues = days.map((_, index) => weeklyReviewTrend[index] ?? 0);
  const totals = days.map((_, index) => readValues[index] + reviewValues[index]);
  const maxValue = Math.max(1, ...totals);
  const today = (new Date().getDay() + 6) % 7;
  for (let index = 0; index < days.length; index += 1) {
    const column = chart.createDiv();
    const tooltip = t("trendTooltip", { read: readValues[index], review: reviewValues[index] });
    column.setAttribute("aria-label", tooltip);
    column.setAttribute("title", tooltip);
    setStyles(column, {
      alignItems: "center",
      display: "flex",
      flexDirection: "column",
      height: "100%",
      justifyContent: "space-between"
    });
    setStyles(column.createDiv({ text: days[index] }), {
      fontSize: "12px",
      fontWeight: "500",
      lineHeight: "16px"
    });
    const stack = column.createDiv({ attr: { title: tooltip } });
    setStyles(stack, {
      alignItems: "stretch",
      display: "flex",
      flexDirection: "column",
      height: "70px",
      justifyContent: "flex-end",
      width: "16px"
    });
    const readHeight = trendSegmentHeight(readValues[index], maxValue);
    const reviewHeight = trendSegmentHeight(reviewValues[index], maxValue);
    if (reviewHeight > 0) {
      setStyles(stack.createDiv(), {
        backgroundColor: "#D6A24F",
        borderRadius: readHeight > 0 ? "4px 4px 0 0" : "4px",
        height: `${reviewHeight}px`
      });
    }
    if (readHeight > 0) {
      setStyles(stack.createDiv(), {
        backgroundColor: PALETTE.accent,
        borderRadius: reviewHeight > 0 ? "0 0 2px 2px" : "4px 4px 2px 2px",
        height: `${readHeight}px`
      });
    }
  }

  const stats = section.createDiv();
  setStyles(stats, {
    display: "grid",
    gap: "14px 8px",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    padding: "18px 0 15px"
  });
  const streak = currentWeekStreak(readValues, today);
  const trendItems: Array<[string, string]> = [
    [t("streak"), t(streak === 1 ? "dayCountOne" : "dayCount", { count: streak })],
    [t("weeklyReading"), t("articleCount", { count: weeklyLearned })],
    [t("weeklyReview"), t("reviewCount", { count: weeklyReviewCount })],
    [t("averageAccuracy"), weeklyReviewAccuracy === null ? "--" : `${weeklyReviewAccuracy}%`]
  ];
  for (const [index, [label, value]] of trendItems.entries()) {
    trendMetric(stats, label, value, index % 2 === 1);
  }
}

function trendSegmentHeight(value: number, maxValue: number): number {
  return value > 0 ? Math.max(4, Math.round((value / maxValue) * 70)) : 0;
}

function trendMetric(parent: HTMLElement, label: string, value: string, separated = false): void {
  const item = parent.createDiv();
  setStyles(item, {
    borderLeft: separated ? `1px solid ${PALETTE.divider}` : "none",
    minWidth: "0",
    padding: "0 9px",
    textAlign: "center"
  });
  setStyles(item.createDiv({ text: label }), {
    color: PALETTE.muted,
    fontSize: METRIC_LABEL_FONT_SIZE,
    fontWeight: "500",
    lineHeight: METRIC_LABEL_LINE_HEIGHT,
    overflowWrap: "anywhere"
  });
  setStyles(item.createDiv({ text: value }), {
    borderTop: `1px solid ${PALETTE.divider}`,
    color: PALETTE.accent,
    fontSize: METRIC_VALUE_FONT_SIZE,
    fontWeight: "700",
    lineHeight: METRIC_VALUE_LINE_HEIGHT,
    marginTop: "5px",
    paddingTop: "5px"
  });
}

function renderArticleStats(
  parent: HTMLElement,
  scopeLabel: string,
  stats: ArticleStats,
  categories: TaskOverviewViewProps["categoryStats"]
): void {
  const section = parent.createDiv({ cls: "kf-task-article-stats" });
  setStyles(section, {
    borderTop: `1px solid ${PALETTE.border}`,
    padding: "17px 4px 0"
  });
  const header = section.createDiv();
  setStyles(header, {
    alignItems: "center",
    display: "flex",
    gap: "8px",
    justifyContent: "space-between",
    minWidth: "0"
  });
  sectionHeading(header, "chart-pie", t("categoryStats"), 15);
  setStyles(header.createDiv({ text: scopeLabel === t("allArticles") ? t("allShort") : scopeLabel }), {
    flex: "0 1 auto",
    fontSize: "11px",
    fontWeight: "500",
    lineHeight: "14px",
    maxWidth: "46%",
    overflow: "hidden",
    textAlign: "right",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap"
  });

  const metrics = section.createDiv();
  setStyles(metrics, {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    margin: "14px 0 9px"
  });
  articleMetric(metrics, t("articles"), stats.total);
  articleMetric(metrics, t("learned"), stats.learned, true);
  articleMetric(metrics, t("unread"), stats.unread, true);

  if (categories.length === 0) {
    stateMessage(section, t("noCategoryData"));
    return;
  }
  const categoryRows: HTMLElement[] = [];
  for (const category of categories) {
    const item = section.createDiv();
    categoryRows.push(item);
    setStyles(item, {
      alignItems: "center",
      display: "grid",
      gap: "7px",
      gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.4fr) minmax(48px, 0.7fr)",
      minHeight: "28px"
    });
    setStyles(item.createDiv({ text: category.name }), {
      fontSize: "12px",
      fontWeight: "500",
      lineHeight: "16px",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    });
    const learnedLabel = t("learnedOf", { total: category.total, learned: category.learned });
    setStyles(item.createDiv({ text: learnedLabel, attr: { title: learnedLabel } }), {
      fontSize: "11px",
      lineHeight: "14px",
      minWidth: "0",
      overflowWrap: "anywhere"
    });
    progressBar(item, category.total > 0 ? Math.round((category.learned / category.total) * 100) : 0);
  }
  const updateCategoryRows = (expanded: boolean): void => {
    for (const [index, row] of categoryRows.entries()) {
      row.style.display = expanded || index < 4 ? "grid" : "none";
    }
  };
  updateCategoryRows(false);
  if (categories.length > 4) {
    expandButton(section, categories.length - 4, t("categoriesUnit"), updateCategoryRows);
  }
}

function articleMetric(parent: HTMLElement, label: string, value: number, separated = false): void {
  const item = parent.createDiv();
  setStyles(item, {
    borderLeft: separated ? `1px solid ${PALETTE.divider}` : "none",
    minHeight: "47px",
    padding: "0 12px",
    textAlign: "center"
  });
  setStyles(item.createDiv({ text: label }), {
    color: PALETTE.muted,
    fontSize: METRIC_LABEL_FONT_SIZE,
    fontWeight: "500",
    lineHeight: METRIC_LABEL_LINE_HEIGHT,
    overflowWrap: "anywhere"
  });
  setStyles(item.createDiv({ text: String(value) }), {
    borderTop: `1px solid ${PALETTE.divider}`,
    color: PALETTE.accent,
    fontSize: METRIC_VALUE_FONT_SIZE,
    fontWeight: "700",
    lineHeight: METRIC_VALUE_LINE_HEIGHT,
    marginTop: "5px",
    paddingTop: "5px"
  });
}

function sectionHeading(parent: HTMLElement, icon: string, label: string, fontSize: number): HTMLElement {
  const heading = parent.createDiv();
  setStyles(heading, { alignItems: "center", display: "flex", flex: "1", gap: "8px", minWidth: "0" });
  createIcon(heading, icon, 20);
  setStyles(heading.createDiv({ text: label }), {
    fontSize: `${fontSize}px`,
    fontWeight: "500",
    lineHeight: fontSize >= 19 ? "25px" : "20px",
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap"
  });
  return heading;
}

function progressBar(parent: HTMLElement, percent: number): void {
  const track = parent.createDiv();
  setStyles(track, {
    backgroundColor: PALETTE.track,
    borderRadius: "3px",
    height: "5px",
    minWidth: "0",
    overflow: "hidden"
  });
  setStyles(track.createDiv(), {
    backgroundColor: PALETTE.accent,
    borderRadius: "3px",
    height: "100%",
    width: `${Math.max(0, Math.min(100, percent))}%`
  });
}

function divider(parent: HTMLElement): void {
  setStyles(parent.createDiv(), { backgroundColor: PALETTE.border, height: "1px", width: "100%" });
}

function expandButton(
  parent: HTMLElement,
  hiddenCount: number,
  unit: string,
  onToggle: (expanded: boolean) => void
): void {
  let expanded = false;
  const control = parent.createEl("button", {
    cls: "kf-expand-button",
    attr: { "aria-expanded": "false", title: t("expandAll") }
  });
  setStyles(control, {
    alignItems: "center",
    background: "transparent",
    border: "0",
    color: PALETTE.accent,
    cursor: "pointer",
    display: "flex",
    fontFamily: '"Noto Sans SC", "PingFang SC", sans-serif',
    fontSize: "12px",
    fontWeight: "500",
    gap: "5px",
    justifyContent: "center",
    lineHeight: "16px",
    margin: "7px auto 0",
    padding: "7px 8px 3px"
  });
  const label = control.createSpan();
  const icon = createIcon(control, "chevron-down", 14);
  const updateControl = (): void => {
    label.textContent = expanded ? t("collapseAll") : t("expandRemaining", { count: hiddenCount, unit });
    control.setAttribute("aria-expanded", String(expanded));
    control.setAttribute("title", expanded ? t("collapseAll") : t("expandAll"));
    icon.style.transform = expanded ? "rotate(180deg)" : "rotate(0deg)";
  };
  updateControl();
  control.addEventListener("click", () => {
    expanded = !expanded;
    onToggle(expanded);
    updateControl();
  });
}

function stateMessage(parent: HTMLElement, message: string): void {
  setStyles(parent.createDiv({ text: message }), {
    color: PALETTE.muted,
    fontSize: "13px",
    lineHeight: "18px",
    padding: "18px 0",
    textAlign: "center"
  });
}

function createIcon(parent: HTMLElement, icon: string, size: number, color = PALETTE.accent): HTMLSpanElement {
  const span = parent.createSpan();
  setIcon(span, icon);
  return setStyles(span, {
    alignItems: "center",
    color,
    display: "inline-flex",
    flex: "0 0 auto",
    height: `${size}px`,
    justifyContent: "center",
    width: `${size}px`
  });
}

function countTasks(tasks: DailyTask[], type: DailyTask["type"]): number {
  return tasks.filter((task) => task.type === type).length;
}

function taskStatusLabel(status: DailyTask["status"]): string {
  if (status === "completed") return t("taskCompleted");
  if (status === "skipped") return t("taskSkipped");
  return t("taskPending");
}

function currentWeekStreak(values: number[], today: number): number {
  let index = today;
  if ((values[index] ?? 0) === 0) index -= 1;
  let streak = 0;
  while (index >= 0 && (values[index] ?? 0) > 0) {
    streak += 1;
    index -= 1;
  }
  return streak;
}
