import { setIcon } from "obsidian";
import type { RelatedNote } from "../types";
import { applyActionLayout, button, cardHeader, row, section, setStyles, text } from "./dom";

export interface RelevantNotesCardProps {
  notes: RelatedNote[];
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
  cardHeader(card, "git-fork", "Relevant Notes", (header) => {
    if (props.indexReady) text(header, `${props.notes.length} 篇`, "kf-pill");
  });

  if (!props.indexReady) {
    text(
      card,
      props.indexBuilding
        ? "正在建立语义索引。完成后会自动显示相关文章。"
        : `尚未建立语义索引。先配置 Embedding model，再为 ${props.indexScope} 建立本地索引。`,
      "kf-muted"
    );
    const actions = row(card, "kf-actions");
    applyActionLayout(actions);
    const build = button(actions, props.indexBuilding ? "建立中…" : "建立索引", () => {
      void props.onBuildIndex();
    }, true);
    build.disabled = props.indexBuilding;
    return;
  }

  if (props.loading) {
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
      border: "1px solid var(--background-modifier-border)",
      borderRadius: "8px",
      display: "flex",
      flexDirection: "column",
      gap: "5px",
      padding: "9px 10px"
    });
    const titleRow = row(item);
    setStyles(titleRow, { gap: "6px" });
    const open = titleRow.createEl("button", { text: note.title, attr: { title: `打开 ${note.path}` } });
    setStyles(open, {
      background: "transparent",
      border: "0",
      color: "var(--text-normal)",
      cursor: "pointer",
      flex: "1",
      fontSize: "13px",
      fontWeight: "600",
      overflow: "hidden",
      padding: "0",
      textAlign: "left",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    });
    open.addEventListener("click", () => props.onOpen(note.path));
    const add = titleRow.createEl("button", { attr: { "aria-label": "加入 Chat", title: "加入 Chat" } });
    setIcon(add, "message-circle-plus");
    setStyles(add, {
      background: "transparent",
      border: "0",
      color: "var(--text-muted)",
      cursor: "pointer",
      display: "inline-flex",
      padding: "2px"
    });
    add.addEventListener("click", () => props.onAddToChat(note.path));
    text(item, note.path, "kf-token-estimate");
    text(item, note.excerpt, "kf-muted");
    const reasons = row(item);
    setStyles(reasons, { flexWrap: "wrap", gap: "5px" });
    for (const reason of note.reasons) {
      const chip = reasons.createSpan({ text: reason });
      setStyles(chip, {
        backgroundColor: "color-mix(in srgb, var(--interactive-accent) 9%, transparent)",
        borderRadius: "999px",
        color: "var(--text-accent)",
        fontSize: "11px",
        padding: "2px 7px"
      });
    }
  }
}
