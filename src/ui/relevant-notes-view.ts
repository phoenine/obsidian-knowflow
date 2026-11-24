import { setIcon } from "obsidian";
import type { RelatedNote } from "../types";
import { applyActionLayout, button, cardHeader, iconButton, row, section, setStyles, text } from "./dom";

export interface RelevantNotesCardProps {
  notes: Array<RelatedNote & { briefDescription: string | null; addedToChat: boolean }>;
  loading: boolean;
  error?: string;
  indexReady: boolean;
  indexBuilding: boolean;
  indexScope: string;
  onBuildIndex: () => Promise<void>;
  onRetry: () => void;
  onOpen: (path: string) => void;
  onAddToChat: (path: string) => void;
}

/** Renders related-note discovery with explicit index and failure states. */
export function renderRelevantNotesCard(content: HTMLElement, props: RelevantNotesCardProps): void {
  const card = section(content, "kf-relevant-notes");
  const indexAction = props.indexReady ? "重建摘要索引" : "建立摘要索引";
  cardHeader(card, "git-fork", "Relevant Notes", (header) => {
    const rebuild = iconButton(
      header,
      props.indexBuilding ? `正在${indexAction}` : indexAction,
      "refresh-cw",
      () => void props.onBuildIndex()
    );
    setStyles(rebuild, { background: "transparent", border: "0", boxShadow: "none", flex: "0 0 auto" });
    rebuild.disabled = props.indexBuilding;
    rebuild.setAttribute("aria-busy", String(props.indexBuilding));
  });
  if (props.indexBuilding) {
    text(card, `正在${indexAction}…`, "kf-muted").setAttribute("role", "status");
  } else if (!props.indexReady) {
    text(card, `可用 ${props.indexScope} 中已有的 AI 摘要建立索引。`, "kf-muted");
  }

  if (props.loading && props.notes.length === 0) {
    text(card, "正在查找相关文章…", "kf-muted");
    return;
  }
  if (props.error) {
    text(card, `检索失败：${props.error}`, "kf-muted");
    const actions = row(card, "kf-actions");
    applyActionLayout(actions);
    button(actions, "重试", props.onRetry);
    return;
  }
  if (props.notes.length === 0) {
    text(card, "暂未找到相关文章。", "kf-muted");
    return;
  }
  const list = card.createDiv({ cls: "kf-relevant-list" });
  setStyles(list, { display: "flex", flexDirection: "column", gap: "6px" });
  for (const note of props.notes) {
    const item = list.createDiv({ cls: "kf-relevant-item" });
    setStyles(item, {
      backgroundColor: note.addedToChat
        ? "color-mix(in srgb, var(--interactive-accent) 12%, var(--background-primary))"
        : "",
      border: "1px solid var(--background-modifier-border)",
      borderRadius: "8px",
      display: "flex",
      flexDirection: "column",
      gap: "5px",
      padding: "9px 10px"
    });
    const titleRow = row(item);
    setStyles(titleRow, { gap: "6px" });
    const open = titleRow.createEl("button", { attr: { title: `打开 ${note.title}` } });
    setStyles(open, {
      background: "transparent",
      border: "0",
      boxShadow: "none",
      color: "var(--text-normal)",
      cursor: "pointer",
      display: "flex",
      flex: "1 1 0",
      fontSize: "13px",
      fontWeight: "600",
      justifyContent: "flex-start",
      minWidth: "0",
      padding: "0",
      textAlign: "left"
    });
    setStyles(open.createSpan({ text: note.title }), {
      minWidth: "0",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    });
    open.addEventListener("click", () => props.onOpen(note.path));
    const chatLabel = note.addedToChat ? "已加入对话，点击打开" : "加入 Chat";
    const add = titleRow.createEl("button", { attr: { "aria-label": chatLabel, title: chatLabel } });
    setIcon(add, note.addedToChat ? "check" : "message-circle-plus");
    setStyles(add, {
      background: "transparent",
      border: "0",
      color: note.addedToChat ? "var(--text-accent)" : "var(--text-muted)",
      cursor: "pointer",
      display: "inline-flex",
      flex: "0 0 auto",
      padding: "2px"
    });
    add.addEventListener("click", () => props.onAddToChat(note.path));
    if (note.briefDescription) {
      const description = text(item, note.briefDescription, "kf-muted");
      description.title = note.briefDescription;
      setStyles(description, {
        color: "color-mix(in srgb, var(--text-normal) 68%, var(--background-primary))",
        display: "-webkit-box",
        fontSize: "12px",
        fontWeight: "400",
        overflow: "hidden",
        overflowWrap: "anywhere",
        textAlign: "left",
        webkitBoxOrient: "vertical",
        webkitLineClamp: "2",
        whiteSpace: "normal"
      });
    }
  }
}
