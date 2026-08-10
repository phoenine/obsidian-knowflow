import { setIcon } from "obsidian";
import type { KnowledgePoint, KnowledgePointGroup, KnowledgePointStatus } from "../types";
import { setStyles } from "./dom";

interface KnowledgePointsOverviewProps {
  articleTitle: string;
  groups: KnowledgePointGroup[];
  statuses: Record<string, KnowledgePointStatus>;
  selectedPointId: string | null;
  loading: boolean;
  onBack: () => void;
  onRefresh: () => void;
  onSelectPoint: (pointId: string) => void;
  onOpenEvidence: (point: KnowledgePoint) => void;
  onGenerateQuiz: (point: KnowledgePoint) => void;
}

const COLORS = {
  text: "#18361D",
  body: "#293B2D",
  secondary: "#39483C",
  muted: "#657166",
  accent: "#2F8731",
  marker: "#58A64E",
  border: "#D9E8D5",
  surface: "#FBFCF8"
};

const FONT = '"Noto Sans SC", "PingFang SC", system-ui, sans-serif';

export function renderKnowledgePointsOverview(root: HTMLElement, props: KnowledgePointsOverviewProps): void {
  const content = knowledgeShell(root, props);
  const points = props.groups.flatMap((group) => group.points);
  let selectedPoint = points.find((point) => point.id === props.selectedPointId) ?? points[0] ?? null;
  const expandedGroups = new Set<string>();

  const renderContent = (): void => {
    content.empty();
    setStyles(content.createDiv({ text: props.articleTitle }), {
      color: COLORS.text,
      fontSize: "15px",
      fontWeight: "650",
      lineHeight: "21px",
      overflowWrap: "anywhere"
    });
    setStyles(content.createDiv({ text: `${points.length} 个核心知识点` }), {
      color: "#629160",
      fontSize: "13px",
      fontWeight: "500",
      lineHeight: "18px",
      marginTop: "7px"
    });
    divider(content, "24px -7px 17px");

    if (props.loading) {
      state(content, "正在从文章中提取核心知识点…");
      return;
    }
    if (points.length === 0) {
      state(content, "尚未生成知识点");
      const generate = content.createEl("button", { text: "生成知识点" });
      styleQuizButton(generate);
      generate.addEventListener("click", props.onRefresh);
      return;
    }

    const tree = content.createDiv();
    setStyles(tree, { display: "flex", flexDirection: "column", gap: "14px" });
    for (const group of props.groups) {
      renderGroup(
        tree,
        group,
        selectedPoint?.id ?? "",
        props.statuses,
        expandedGroups.has(group.title),
        (expanded) => {
          if (expanded) expandedGroups.add(group.title);
          else expandedGroups.delete(group.title);
        },
        (point) => {
          if (selectedPoint?.id === point.id) return;
          selectedPoint = point;
          props.onSelectPoint(point.id);
          renderContent();
        }
      );
    }

    divider(content, "20px -24px 0");
    if (selectedPoint) renderPointDetails(content, selectedPoint, points, props);
  };

  renderContent();
}

function knowledgeShell(root: HTMLElement, props: KnowledgePointsOverviewProps): HTMLElement {
  setStyles(root, {
    backgroundColor: COLORS.surface,
    color: COLORS.text,
    display: "flex",
    flexDirection: "column",
    fontFamily: FONT,
    height: "100%",
    overflow: "hidden"
  });
  const header = root.createDiv({ cls: "kf-knowledge-header" });
  setStyles(header, {
    alignItems: "center",
    borderBottom: `1px solid ${COLORS.border}`,
    display: "flex",
    flex: "0 0 63px",
    padding: "0 24px"
  });
  const back = bareIconButton(header, "返回", "arrow-left", props.onBack, 18);
  setStyles(back, { color: "#24482A", marginRight: "14px" });
  setStyles(header.createDiv({ text: "知识点" }), {
    color: COLORS.text,
    fontSize: "15px",
    fontWeight: "650",
    lineHeight: "20px"
  });
  const update = header.createEl("button", { attr: { "aria-label": "更新知识点" } });
  setStyles(update, {
    alignItems: "center",
    background: "transparent",
    border: "0",
    color: COLORS.accent,
    cursor: props.loading ? "default" : "pointer",
    display: "flex",
    fontFamily: FONT,
    fontSize: "13px",
    marginLeft: "auto",
    opacity: props.loading ? "0.55" : "1",
    padding: "6px 0"
  });
  update.createSpan({ text: props.loading ? "生成中…" : "更新" });
  update.addEventListener("click", () => {
    if (!props.loading) props.onRefresh();
  });

  return setStyles(root.createDiv({ cls: "kf-content kf-knowledge-content" }), {
    display: "flex",
    flex: "1 1 auto",
    flexDirection: "column",
    overflowY: "auto",
    padding: "20px 24px 24px"
  });
}

function renderGroup(
  parent: HTMLElement,
  group: KnowledgePointGroup,
  selectedId: string,
  statuses: Record<string, KnowledgePointStatus>,
  expanded: boolean,
  onToggle: (expanded: boolean) => void,
  onSelect: (point: KnowledgePoint) => void
): void {
  const groupEl = parent.createDiv();
  const heading = groupEl.createDiv();
  setStyles(heading, {
    alignItems: "center",
    display: "grid",
    gap: "13px",
    gridTemplateColumns: "20px minmax(0, 1fr)"
  });
  const toggle = bareIconButton(
    heading,
    `${expanded ? "折叠" : "展开"} ${group.title}`,
    expanded ? "chevron-down" : "chevron-right",
    () => {
      expanded = !expanded;
      rows.style.display = expanded ? "block" : "none";
      const label = `${expanded ? "折叠" : "展开"} ${group.title}`;
      toggle.setAttribute("aria-label", label);
      toggle.setAttribute("title", label);
      setIcon(toggle, expanded ? "chevron-down" : "chevron-right");
      onToggle(expanded);
    },
    11
  );
  setStyles(toggle, {
    backgroundColor: COLORS.surface,
    border: "1px solid #C6DEC2",
    borderRadius: "4px",
    color: "#24482A",
    height: "20px",
    width: "20px"
  });
  setStyles(heading.createDiv({ text: group.title }), {
    color: COLORS.text,
    fontSize: "14px",
    fontWeight: "650",
    lineHeight: "19px",
    overflowWrap: "anywhere"
  });

  const rows = groupEl.createDiv();
  setStyles(rows, {
    borderLeft: "1px solid #4E9F49",
    display: expanded ? "block" : "none",
    marginLeft: "9px",
    padding: "8px 0 0 23px"
  });
  for (const point of group.points) {
    const selected = point.id === selectedId;
    const item = rows.createEl("button", { attr: { title: `选择：${point.title}` } });
    setStyles(item, {
      alignItems: "start",
      background: selected ? "linear-gradient(90deg, #EAF4E6 0%, #F3F9F0 100%)" : "transparent",
      border: selected ? "1px solid #84B97A" : "1px solid transparent",
      borderRadius: "7px",
      color: selected ? "#345536" : COLORS.secondary,
      cursor: "pointer",
      display: "grid",
      fontFamily: FONT,
      fontSize: "13px",
      fontWeight: selected ? "500" : "400",
      gap: "10px",
      gridTemplateColumns: "12px minmax(0, 1fr)",
      height: "auto",
      lineHeight: "20px",
      margin: "0 0 5px 0",
      minHeight: "37px",
      overflow: "visible",
      padding: "7px 10px",
      position: "relative",
      textAlign: "left",
      whiteSpace: "normal",
      width: "100%"
    });
    const branch = item.createSpan();
    setStyles(branch, {
      backgroundColor: "#4E9F49",
      height: "1px",
      left: "-24px",
      position: "absolute",
      top: "18px",
      width: "23px"
    });
    const marker = pointMarker(selected, statuses[point.id]);
    setStyles(marker, { marginTop: "4px" });
    item.appendChild(marker);
    setStyles(item.createSpan({ text: point.title }), {
      minWidth: "0",
      overflowWrap: "anywhere",
      whiteSpace: "normal"
    });
    item.addEventListener("click", () => onSelect(point));
  }
}

function renderPointDetails(
  parent: HTMLElement,
  point: KnowledgePoint,
  points: KnowledgePoint[],
  props: KnowledgePointsOverviewProps
): void {
  const details = parent.createDiv();
  setStyles(details, { paddingTop: "20px" });

  const card = detailCard(details);
  setStyles(card.createDiv({ text: point.title }), {
    color: "#204523",
    fontSize: "14px",
    fontWeight: "700",
    lineHeight: "22px",
    overflowWrap: "anywhere",
    whiteSpace: "normal"
  });

  const meta = card.createDiv();
  setStyles(meta, {
    alignItems: "center",
    display: "flex",
    fontSize: "12px",
    justifyContent: "space-between",
    lineHeight: "17px",
    marginTop: "8px"
  });
  const type = meta.createSpan({ text: point.type });
  styleMetaTag(type, COLORS.accent, "#B8D9B4");
  const status = meta.createSpan({ text: statusLabel(props.statuses[point.id]) });
  styleMetaTag(status, COLORS.muted, "#D3DDD1");

  divider(card, "12px 0");
  paragraph(card, point.explanation);

  divider(card, "16px 0");
  sectionTitle(card, "原文依据");

  const source = card.createDiv();
  setStyles(source, {
    alignItems: "flex-start",
    display: "flex",
    fontSize: "12px",
    lineHeight: "18px",
    marginTop: "10px"
  });
  setStyles(source.createSpan({ text: "来源：" }), {
    color: "#639261",
    flex: "0 0 auto",
    fontWeight: "700"
  });
  const sourceLink = source.createEl("a", { text: point.evidence.section, href: "#" });
  setStyles(sourceLink, {
    color: COLORS.accent,
    cursor: "pointer",
    minWidth: "0",
    overflowWrap: "anywhere",
    textDecoration: "underline",
    textDecorationColor: "#B8D9B4",
    textUnderlineOffset: "2px",
    whiteSpace: "normal"
  });
  sourceLink.addEventListener("click", (event) => {
    event.preventDefault();
    props.onOpenEvidence(point);
  });
  divider(card, "10px 0");
  const excerpt = card.createDiv({ text: point.evidence.excerpt });
  setStyles(excerpt, {
    borderLeft: "3px solid #E0EEDF",
    color: "#526056",
    fontSize: "12px",
    lineHeight: "20px",
    overflowWrap: "anywhere",
    paddingLeft: "12px",
    whiteSpace: "pre-wrap"
  });

  divider(card, "16px 0");
  sectionTitle(card, "检验问题");
  paragraph(card, point.question, { marginTop: "10px" });

  if (point.relations.dependsOn.length > 0 || point.relations.extends.length > 0) {
    divider(card, "16px 0 12px");
    const relations = card.createDiv();
    setStyles(relations, {
      display: "grid",
      gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
      minHeight: "30px"
    });
    relation(relations, "link-2", "依赖：", point.relations.dependsOn, points, false);
    relation(relations, "git-branch", "扩展：", point.relations.extends, points, true);
  }

  const generate = card.createEl("button");
  styleQuizButton(generate);
  const icon = generate.createSpan();
  setIcon(icon, "file-text");
  setStyles(icon, { display: "inline-flex", height: "19px", width: "19px" });
  generate.createSpan({ text: "针对该知识点出题" });
  generate.addEventListener("click", () => props.onGenerateQuiz(point));
}

function detailCard(parent: HTMLElement): HTMLElement {
  return setStyles(parent.createDiv(), {
    backgroundColor: "var(--background-primary)",
    border: "1px solid color-mix(in srgb, var(--interactive-accent) 28%, var(--background-modifier-border))",
    borderRadius: "10px",
    padding: "14px"
  });
}

function styleMetaTag(tag: HTMLElement, color: string, borderColor: string): void {
  setStyles(tag, {
    border: `1px solid ${borderColor}`,
    borderRadius: "999px",
    color,
    fontWeight: "600",
    padding: "2px 8px",
    whiteSpace: "nowrap"
  });
}

function relation(parent: HTMLElement, iconName: string, label: string, ids: string[], points: KnowledgePoint[], separated: boolean): void {
  const item = parent.createDiv();
  setStyles(item, {
    alignItems: "flex-start",
    borderLeft: separated ? `1px solid ${COLORS.border}` : "0",
    display: "grid",
    gap: "8px",
    gridTemplateColumns: "16px minmax(0, 1fr)",
    padding: separated ? "1px 0 1px 20px" : "1px 12px 1px 0"
  });
  const icon = item.createSpan();
  setIcon(icon, iconName);
  setStyles(icon, { color: COLORS.accent, display: "inline-flex", height: "16px", marginTop: "1px", width: "16px" });
  const text = item.createDiv();
  const titles = ids.map((id) => points.find((point) => point.id === id)?.title ?? id);
  setStyles(text.createSpan({ text: label }), { color: "#253F29", fontSize: "12px", fontWeight: "700" });
  setStyles(text.createSpan({ text: titles.length > 0 ? titles.join("、") : "无" }), {
    color: "#667168",
    fontSize: "11px",
    lineHeight: "16px",
    overflowWrap: "anywhere",
    whiteSpace: "normal"
  });
}

function pointMarker(selected: boolean, status: KnowledgePointStatus | undefined): HTMLSpanElement {
  const marker = document.createElement("span");
  setStyles(marker, {
    alignItems: "center",
    backgroundColor: COLORS.surface,
    border: `${selected ? "1.5px" : "1px"} solid ${selected ? COLORS.marker : statusColor(status)}`,
    borderRadius: "50%",
    display: "inline-flex",
    flex: "0 0 auto",
    height: "12px",
    justifyContent: "center",
    width: "12px"
  });
  if (selected) {
    setStyles(marker.createSpan(), {
      backgroundColor: COLORS.marker,
      borderRadius: "50%",
      height: "6px",
      width: "6px"
    });
  }
  return marker;
}

function bareIconButton(parent: HTMLElement, label: string, icon: string, onClick: () => void, size: number): HTMLButtonElement {
  const button = parent.createEl("button", { attr: { "aria-label": label, title: label } });
  setStyles(button, {
    alignItems: "center",
    background: "transparent",
    border: "0",
    cursor: "pointer",
    display: "inline-flex",
    justifyContent: "center",
    padding: "0"
  });
  setIcon(button, icon);
  const svg = button.querySelector("svg");
  if (svg) Object.assign(svg.style, { height: `${size}px`, width: `${size}px` });
  button.addEventListener("click", onClick);
  return button;
}

function styleQuizButton(button: HTMLButtonElement): void {
  setStyles(button, {
    alignItems: "center",
    background: COLORS.surface,
    border: "1px solid #55A850",
    borderRadius: "4px",
    color: "#4D984B",
    cursor: "pointer",
    display: "flex",
    fontFamily: FONT,
    fontSize: "13px",
    fontWeight: "400",
    gap: "9px",
    height: "40px",
    justifyContent: "center",
    marginTop: "20px",
    padding: "0 14px",
    width: "100%"
  });
}

function sectionTitle(parent: HTMLElement, value: string): void {
  setStyles(parent.createDiv({ text: value }), {
    color: COLORS.accent,
    fontSize: "13px",
    lineHeight: "18px"
  });
}

function paragraph(parent: HTMLElement, value: string, extra: Partial<CSSStyleDeclaration> = {}): void {
  setStyles(parent.createDiv({ text: value }), {
    color: COLORS.body,
    fontSize: "13px",
    lineHeight: "21px",
    overflowWrap: "anywhere",
    whiteSpace: "pre-wrap",
    ...extra
  });
}

function statusLabel(status: KnowledgePointStatus | undefined): string {
  if (status === "mastered") return "已掌握";
  if (status === "review") return "需复习";
  return "未测试";
}

function statusColor(status: KnowledgePointStatus | undefined): string {
  if (status === "mastered") return COLORS.marker;
  if (status === "review") return "#C9823B";
  return "#9BA89A";
}

function divider(parent: HTMLElement, margin: string): void {
  setStyles(parent.createDiv(), {
    backgroundColor: COLORS.border,
    flex: "0 0 1px",
    height: "1px",
    margin
  });
}

function state(parent: HTMLElement, value: string): void {
  setStyles(parent.createDiv({ text: value }), {
    color: COLORS.muted,
    fontSize: "13px",
    lineHeight: "20px",
    padding: "32px 0 18px",
    textAlign: "center"
  });
}
