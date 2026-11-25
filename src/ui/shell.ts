import { setIcon } from "obsidian";
import { iconButton, setStyles, text } from "./dom";

export function renderShell(root: HTMLElement, title: string, status: string, onBack?: () => void, subtitle = ""): HTMLElement {
  const header = root.createDiv({ cls: "kf-header" });
  setStyles(header, {
    alignItems: "center",
    backgroundColor: "var(--background-primary)",
    borderBottom: "1px solid color-mix(in srgb, var(--interactive-accent) 18%, var(--background-modifier-border))",
    display: "flex",
    justifyContent: "space-between",
    padding: "16px 18px"
  });
  const left = header.createDiv({ cls: "kf-header-left" });
  setStyles(left, {
    alignItems: "center",
    display: "flex",
    flex: "1",
    gap: "10px",
    minWidth: "0",
    overflow: "hidden"
  });
  if (onBack) {
    iconButton(left, "Back", "arrow-left", onBack);
  }
  if (title || subtitle) {
    const copy = left.createDiv();
    setStyles(copy, { display: "flex", flex: "1", flexDirection: "column", gap: "2px", minWidth: "0" });
    if (title) {
      setStyles(copy.createDiv({ text: title, cls: "kf-title" }), {
        color: "var(--text-normal)",
        fontSize: subtitle ? "15px" : "20px",
        fontWeight: "650",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap"
      });
    }
    if (subtitle) {
      setStyles(copy.createDiv({ text: subtitle, cls: "kf-muted" }), {
        fontSize: "12px",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap"
      });
    }
  }
  if (status) {
    setStyles(header.createDiv({ text: status, cls: "kf-status" }), {
      color: "var(--text-accent)",
      fontSize: "12px",
      fontWeight: "600"
    });
  }
  return setStyles(root.createDiv({ cls: "kf-content" }), {
    display: "flex",
    flex: "1",
    flexDirection: "column",
    gap: "14px",
    overflowY: "auto",
    padding: "18px"
  });
}

export function renderBrandShell(
  root: HTMLElement,
  subtitle: string,
  renderActions?: (actions: HTMLElement) => void
): HTMLElement {
  const header = root.createDiv({ cls: "kf-header kf-clipping-header" });
  setStyles(header, {
    alignItems: "center",
    backgroundColor: "var(--background-primary)",
    borderBottom: "1px solid color-mix(in srgb, var(--interactive-accent) 18%, var(--background-modifier-border))",
    display: "flex",
    justifyContent: "space-between",
    padding: "8px 18px 8px 13px",
    position: "relative",
    zIndex: "5"
  });

  const brand = header.createDiv();
  setStyles(brand, {
    alignItems: "center",
    display: "flex",
    gap: "12px",
    minWidth: "0"
  });
  const logo = brand.createSpan();
  setIcon(logo, "brain-circuit");
  setStyles(logo, {
    color: "var(--interactive-accent)",
    display: "inline-flex",
    flex: "0 0 auto"
  });
  const copy = brand.createDiv();
  text(copy, "KnowFlow", "kf-brand-title");
  text(copy, subtitle, "kf-muted");
  if (renderActions) {
    const actions = header.createDiv({ cls: "kf-header-actions" });
    setStyles(actions, {
      alignItems: "center",
      display: "flex",
      flex: "0 0 auto",
      gap: "6px",
      position: "relative"
    });
    renderActions(actions);
  }

  return setStyles(root.createDiv({ cls: "kf-content" }), {
    display: "flex",
    flex: "1",
    flexDirection: "column",
    gap: "14px",
    overflowY: "auto",
    padding: "14px"
  });
}
