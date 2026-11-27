import { setIcon } from "obsidian";
import { ARTICLE_CATEGORIES } from "../services/clipping/clipping-pipeline";
import type { NoteSummary, PipelineStatus, PipelineUiState } from "../types";
import { t } from "../i18n";
import { applyActionLayout, applyMetricsLayout, attachPressFeedback, button, cardHeader, iconSpan, metric, row, section, setStyles, text } from "./dom";
import { renderBrandShell } from "./shell";
import { renderRelevantNotesCard, type RelevantNotesCardProps } from "./relevant-notes-view";

export interface SummaryCardProps {
  summary: NoteSummary | null;
  summaryPending: boolean;
  summaryError: string | undefined;
  streamingText?: string;
  streamingReasoning?: string;
  sourceLabel: string;
  renderMarkdownSummary: (parent: HTMLElement, markdown: string) => void;
  onRefreshSummary: () => Promise<void>;
  onGenerateSummary: () => Promise<void>;
}

export interface ArticleMaintenanceProps {
  pipelineState: PipelineUiState | undefined;
  persistedPipeline: PipelineStatus;
  currentCategory: string | undefined;
  suggestedCategoryLabel: string;
  onRunPipeline: () => Promise<void>;
  onMoveCategory: (category: string) => Promise<void>;
}

interface ClippingViewProps extends SummaryCardProps, RelevantNotesCardProps, ArticleMaintenanceProps {
  title: string;
  readingValueLabel: string;
  recommendedActionLabel: string;
}

export function renderClippingView(root: HTMLElement, props: ClippingViewProps): void {
  const content = renderBrandShell(root, t("clippingAssistant"), (actions) => {
    renderArticleMaintenanceActions(actions, props);
  });

  const current = section(content, "kf-current");
  const titleRow = row(current);
  iconSpan(titleRow, "file-text");
  text(titleRow, props.title, "kf-card-title");
  const metrics = row(current, "kf-metrics");
  applyMetricsLayout(metrics);
  metric(metrics, t("readingValue"), props.readingValueLabel);
  metric(metrics, t("recommendedAction"), props.recommendedActionLabel);
  metric(metrics, t("suggestedFolder"), props.suggestedCategoryLabel);

  renderSummaryCard(content, props);
  renderRelevantNotesCard(content, props);
}

export function renderSummaryCard(content: HTMLElement, props: SummaryCardProps): void {
  const summary = section(content, "kf-summary");
  // A fixed minimum replaces the flex item's content-based minimum, so a long
  // stream would paint past the border. Keep the reserved height, but never
  // shrink the card below the text it already has.
  setStyles(summary, {
    flexShrink: "0",
    minWidth: "0",
    ...(props.summaryPending ? { minHeight: "400px" } : {})
  });
  let refreshButton!: HTMLButtonElement;
  cardHeader(summary, "sparkles", t("aiSummary"), (header) => {
    refreshButton = unborderedIconButton(header, t("refreshSummary"), "refresh-cw", () => {
      if (!props.summaryPending) {
        void lockButton(refreshButton, props.onRefreshSummary);
      }
    });
  });
  if (!props.summary && !props.summaryError && !props.summaryPending) {
    refreshButton.hide();
  }
  if (props.summaryPending) {
    refreshButton.disabled = true;
    setStyles(refreshButton, {
      cursor: "default",
      opacity: "0.72"
    });
    refreshButton.animate(
      [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }],
      { duration: 900, iterations: Infinity }
    );
  }
  if (props.summary && !props.summaryPending) {
    props.renderMarkdownSummary(summary, `${props.summary.summary}${props.summary.reason ? `\n\n> ${props.summary.reason}` : ""}`);
  } else if (props.summaryPending && props.streamingText) {
    // 正式内容开始后完全替换 reasoning，避免两个信息层争夺注意力。
    const streamEl = summary.createDiv({ cls: "kf-streaming-text" });
    setStyles(streamEl, {
      color: "var(--text-muted)",
      fontSize: "13px",
      lineHeight: "1.5",
      maxWidth: "100%",
      minWidth: "0",
      overflowWrap: "anywhere",
      whiteSpace: "pre-wrap"
    });
    streamEl.setText(props.streamingText);
  } else if (props.summaryPending && props.streamingReasoning) {
    const viewport = summary.createDiv({ cls: "kf-streaming-reasoning-viewport" });
    setStyles(viewport, {
      height: "280px",
      maskImage: "linear-gradient(to bottom, transparent 0%, black 30%, black 100%)",
      overflow: "hidden",
      position: "relative"
    });
    const flow = viewport.createDiv({ cls: "kf-streaming-reasoning-flow" });
    setStyles(flow, {
      fontSize: "12px",
      lineHeight: "1.5",
      minHeight: "100%",
      overflowWrap: "anywhere",
      whiteSpace: "pre-wrap"
    });
    const historyEl = flow.createSpan({ cls: "kf-streaming-reasoning-history" });
    setStyles(historyEl, { color: "var(--text-muted)" });
    const latestEl = flow.createSpan({ cls: "kf-streaming-reasoning-latest" });
    setStyles(latestEl, { color: "var(--text-normal)", fontWeight: "500" });
    updateStreamingReasoning(historyEl, latestEl, props.streamingReasoning);
    const separator = summary.createDiv({ cls: "kf-reasoning-separator" });
    setStyles(separator, {
      borderTop: "1px solid var(--background-modifier-border)",
      margin: "8px 0"
    });
    renderPendingSummary(summary, props.sourceLabel);
  } else {
    if (props.summaryPending) {
      renderPendingSummary(summary, props.sourceLabel);
    } else if (props.summaryError) {
      text(summary, t("summaryFailed", { message: props.summaryError }), "kf-muted");
    } else {
      text(summary, t("noSummary"), "kf-muted");
    }
    if (!props.summaryPending) {
      const summaryActions = row(summary, "kf-actions");
      applyActionLayout(summaryActions);
      const generateButton = button(summaryActions, props.summaryError ? t("regenerateSummary") : t("generateSummary"), () => {
        void lockButton(generateButton, props.onGenerateSummary);
      }, true);
    }
  }
}

export function updateStreamingReasoning(
  historyEl: HTMLElement,
  latestEl: HTMLElement,
  reasoning: string
): void {
  const { history, latest } = splitReasoningFocus(reasoning);
  historyEl.setText(history);
  latestEl.setText(latest);
  const viewport = latestEl.closest<HTMLElement>(".kf-streaming-reasoning-viewport");
  window.requestAnimationFrame(() => {
    if (viewport?.isConnected) viewport.scrollTop = viewport.scrollHeight;
  });
}

function splitReasoningFocus(reasoning: string): { history: string; latest: string } {
  const focusLength = 120;
  if (reasoning.length <= focusLength) return { history: "", latest: reasoning };

  // 优先聚焦当前段落；段落过长时保留最后一小段，避免整屏一直保持高亮。
  const lastBreak = reasoning.lastIndexOf("\n", reasoning.length - 2);
  let splitAt = lastBreak >= reasoning.length - focusLength ? lastBreak + 1 : reasoning.length - focusLength;
  const nextWhitespace = reasoning.slice(splitAt, splitAt + 24).search(/\s/);
  if (lastBreak < reasoning.length - focusLength && nextWhitespace >= 0) {
    splitAt += nextWhitespace + 1;
  }
  return {
    history: reasoning.slice(0, splitAt),
    latest: reasoning.slice(splitAt)
  };
}

export function renderArticleMaintenanceActions(parent: HTMLElement, props: ArticleMaintenanceProps): void {
  renderOrganizeButton(parent, props);
  renderMoveButton(parent, props);
}

export function renderKnowledgePointsButton(parent: HTMLElement, onOpen: () => void): void {
  headerIconButton(parent, t("knowledgePoints"), "network", onOpen);
}

export function renderQuizButton(parent: HTMLElement, pending: boolean, hasAttempt: boolean, onOpen: () => void): void {
  const label = pending ? t("quizGenerating") : hasAttempt ? t("viewQuizScore") : t("quiz");
  const quiz = headerIconButton(parent, label, pending ? "loader-2" : "clipboard-check", () => {
    if (!pending) onOpen();
  });
  if (pending) {
    quiz.disabled = true;
    setStyles(quiz, { color: "var(--interactive-accent)", cursor: "default", opacity: "1" });
    const icon = quiz.querySelector("svg");
    if (icon) {
      icon.setCssStyles({ transformBox: "fill-box", transformOrigin: "center" });
      icon.animate(
        [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }],
        { duration: 900, iterations: Infinity }
      );
    }
    return;
  }
  if (!hasAttempt) return;
  setStyles(quiz, {
    backgroundColor: "var(--interactive-accent)",
    borderColor: "var(--interactive-accent)",
    color: "var(--text-on-accent)"
  });
}

function renderOrganizeButton(parent: HTMLElement, props: ArticleMaintenanceProps): void {
  const running = props.pipelineState?.running === true;
  const error = running ? undefined : props.pipelineState?.error ?? (props.persistedPipeline.status === "failed" ? props.persistedPipeline.error : undefined);
  const processed = !running && !error && props.persistedPipeline.status === "processed";
  const label = running ? t("organizing") : error ? compactErrorMessage(error) : processed ? t("organized") : t("organizeArticle");
  const organize = headerIconButton(parent, label, running ? "loader-2" : "list-checks", () => {
    if (!running) void props.onRunPipeline();
  });
  if (running) {
    organize.disabled = true;
    setStyles(organize, { color: "var(--interactive-accent)", cursor: "default", opacity: "1" });
    const icon = organize.querySelector("svg");
    if (icon) {
      icon.setCssStyles({ transformBox: "fill-box", transformOrigin: "center" });
      icon.animate(
        [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }],
        { duration: 900, iterations: Infinity }
      );
    }
  } else if (error) {
    setStyles(organize, { color: "var(--text-error)" });
  } else if (processed) {
    setStyles(organize, {
      backgroundColor: "var(--interactive-accent)",
      borderColor: "var(--interactive-accent)",
      color: "var(--text-on-accent)"
    });
  }
}

function renderMoveButton(parent: HTMLElement, props: ArticleMaintenanceProps): void {
  const move = headerIconButton(parent, t("moveCategory"), "folder-input", () => {
    const existing = parent.querySelector<HTMLElement>(".kf-move-menu");
    if (existing) {
      existing.remove();
      return;
    }
    const menu = parent.createDiv({ cls: "kf-move-menu" });
    setStyles(menu, {
      backgroundColor: "var(--background-primary)",
      border: "1px solid color-mix(in srgb, var(--interactive-accent) 28%, var(--background-modifier-border))",
      borderRadius: "10px",
      boxShadow: "0 8px 24px color-mix(in srgb, var(--background-modifier-box-shadow) 35%, transparent)",
      display: "flex",
      flexDirection: "column",
      maxHeight: "280px",
      overflowY: "auto",
      padding: "4px",
      position: "absolute",
      right: "0",
      top: "calc(100% + 6px)",
      width: "168px",
      zIndex: "20"
    });
    const suggested = ARTICLE_CATEGORIES.find((category) => category === props.suggestedCategoryLabel);
    const ordered = suggested ? [suggested, ...ARTICLE_CATEGORIES.filter((category) => category !== suggested)] : [...ARTICLE_CATEGORIES];
    for (const category of ordered) {
      const current = category === props.currentCategory;
      const item = menu.createEl("button", { cls: "kf-move-option" });
      setStyles(item, {
        alignItems: "center",
        backgroundColor: "transparent",
        border: "0",
        borderRadius: "7px",
        color: "var(--text-normal)",
        cursor: current ? "default" : "pointer",
        display: "flex",
        fontSize: "13px",
        gap: "8px",
        justifyContent: "space-between",
        minHeight: "30px",
        padding: "4px 8px",
        textAlign: "left"
      });
      item.createSpan({ text: category });
      const hint = current ? t("currentCategory") : category === suggested ? t("suggestedCategory") : "";
      if (hint) {
        setStyles(item.createSpan({ text: hint }), {
          color: "var(--text-muted)",
          flex: "0 0 auto",
          fontSize: "11px"
        });
      }
      item.addEventListener("click", () => {
        menu.remove();
        if (!current) void props.onMoveCategory(category);
      });
    }
    const close = (event: PointerEvent) => {
      const target = event.target;
      if (!menu.isConnected || (target instanceof Node && (menu.contains(target) || move.contains(target)))) {
        if (!menu.isConnected) document.removeEventListener("pointerdown", close, true);
        return;
      }
      menu.remove();
      document.removeEventListener("pointerdown", close, true);
    };
    document.addEventListener("pointerdown", close, true);
  });
}

function headerIconButton(parent: HTMLElement, label: string, icon: string, onClick: () => void): HTMLButtonElement {
  const button = parent.createEl("button", { cls: "kf-icon-button", attr: { "aria-label": label } });
  setStyles(button, {
    alignItems: "center",
    backgroundColor: "var(--background-primary)",
    border: "1px solid color-mix(in srgb, var(--interactive-accent) 28%, var(--background-modifier-border))",
    borderRadius: "8px",
    color: "var(--interactive-accent)",
    cursor: "pointer",
    display: "inline-flex",
    height: "28px",
    justifyContent: "center",
    padding: "0",
    width: "28px"
  });
  setIcon(button, icon);
  attachPressFeedback(button);
  button.addEventListener("click", onClick);
  return button;
}

function unborderedIconButton(parent: HTMLElement, label: string, icon: string, onClick: () => void): HTMLButtonElement {
  const button = parent.createEl("button", { cls: "kf-icon-button", attr: { "aria-label": label } });
  setStyles(button, {
    alignItems: "center",
    backgroundColor: "transparent",
    border: "0",
    borderRadius: "7px",
    color: "var(--text-muted)",
    cursor: "pointer",
    display: "inline-flex",
    height: "26px",
    justifyContent: "center",
    padding: "0",
    transition: "filter 120ms ease, opacity 120ms ease, transform 120ms ease",
    width: "26px"
  });
  setIcon(button, icon);
  attachPressFeedback(button);
  button.addEventListener("click", onClick);
  return button;
}

async function lockButton(button: HTMLButtonElement, action: () => Promise<void>): Promise<void> {
  if (button.disabled) return;
  button.disabled = true;
  setStyles(button, {
    cursor: "default",
    filter: "brightness(1.03)",
    opacity: "0.72"
  });
  try {
    await action();
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      setStyles(button, {
        cursor: "pointer",
        filter: "none",
        opacity: "1"
      });
    }
  }
}

function renderPendingSummary(parent: HTMLElement, sourceLabel: string): void {
  const line = text(parent, t("summarizingFrom", { source: sourceLabel }), "kf-muted");
  const dots = line.createSpan();
  setStyles(dots, { display: "inline-block", textAlign: "left", width: "1.4em" });
  let count = 0;
  const timer = window.setInterval(() => {
    if (!line.isConnected) {
      window.clearInterval(timer);
      return;
    }
    count = count % 3 + 1;
    dots.setText(".".repeat(count));
  }, 420);
  dots.setText(".");
}

function compactErrorMessage(error: string): string {
  const firstLine = error.split("\n").find((line) => line.trim())?.trim() ?? error.trim();
  return firstLine
    .replace(/\s{2,}/g, " ")
    .slice(0, 120);
}
