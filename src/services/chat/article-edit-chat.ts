import { t } from "../../i18n";
import { prepareChatEdits, type EditCommit, type EditItem, type EditSkipReason, type NoteEdit } from "../core/note-edits";

export type { EditItem, NoteEdit };

const ARTICLE_EDIT_CHARS = 24000;
const QUESTION = /[？?]|为什么|怎么|如何|是否|是什么|吗$|对吗|好吗/;
const LEAD = "^(?:请你?|麻烦你?)?\\s*(?:帮我)?\\s*";

/**
 * A direct instruction to change the open article. Questions, freshness checks,
 * and code-format requests stay on their own paths.
 */
export function isArticleEditRequest(question: string): boolean {
  const text = question.trim().replace(/[。！!]+$/, "");
  if (!text || text.length > 800 || QUESTION.test(text)) return false;
  if (/代码/.test(text) && /格式化|排版|修复|整理|重排|还原|补全|注释/.test(text)) return false;
  if (/过时|时效|outdated/i.test(text) && /检查|check|review/i.test(text)) return false;
  if (new RegExp(`${LEAD}(?:把|将).{1,200}(?:改成|换成|替换成|改为|删掉|删除|去掉|改短|改长|改得|简化|重写|润色)`).test(text)) return true;
  if (new RegExp(`${LEAD}(?:修改|改写|重写|替换|删掉|删除|去掉|润色|精简)(?:一下|下)?`).test(text)) return true;
  if (new RegExp(`${LEAD}改(?:一下|下)(?:这|本)?(?:篇文章|文章|这段|这一段|这段话|标题|开头|结尾|原文|句子|表述|说法)`).test(text)) return true;
  if (new RegExp(`${LEAD}(?:在|往|给).{0,80}(?:加上|添加|插入|补充)`).test(text)) return true;
  if (new RegExp(`${LEAD}(?:优化|调整)(?:一下|下)?(?:这|本)?(?:篇文章|文章|这段|这一段|这段话|标题|开头|结尾|原文)`).test(text)) return true;
  if (/(?:改成|换成|改为|改短|改写|重写|删掉|润色)/.test(text) && /文章|这段|段落|标题|开头|结尾|原文|笔记|句子/.test(text)) return true;
  if (/^(?:please\s+)?(?:change|replace|rewrite|delete|remove|shorten|edit)\b/i.test(text)) return true;
  return false;
}

/** A yes to "要把这些内容写进文章吗？". Anything longer goes through intent detection. */
export function isEditOfferAccepted(reply: string): boolean {
  const text = reply.trim().replace(/[。！!.]+$/, "");
  return /^(?:要|好|好的|可以|行|嗯|写|写吧|写进去|写进文章|加上|补充|ok|yes)$/i.test(text);
}

/** The model only sees this excerpt. `before` is still matched against the full note. */
export function articleForEdit(article: string, instruction: string): { text: string; truncated: boolean } {
  if (article.length <= ARTICLE_EDIT_CHARS) return { text: article, truncated: false };
  const parts = [article.slice(0, 8000)];
  const seen: number[] = [];
  for (const match of instruction.matchAll(/[「“"']([^」”"']{6,180})[」”"']/g)) {
    const at = article.indexOf(match[1]);
    if (at < 0) continue;
    const start = Math.max(0, at - 1200);
    if (seen.some((item) => Math.abs(item - start) < 2000)) continue;
    seen.push(start);
    parts.push(article.slice(start, start + 5000));
    if (parts.join("").length >= ARTICLE_EDIT_CHARS) break;
  }
  return { text: parts.join("\n\n[...]\n\n"), truncated: true };
}

const SKIP_REASON = {
  missing: "articleEditReasonMissing",
  ambiguous: "articleEditReasonAmbiguous",
  paragraph: "articleEditReasonParagraph",
  conflict: "articleEditReasonConflict",
  span: "articleEditReasonSpan",
  protected: "articleEditReasonProtected"
} as const satisfies Record<EditSkipReason, string>;

export function readArticleEdits(payload: unknown): NoteEdit[] | null {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { edits?: unknown }).edits)) return null;
  const edits: NoteEdit[] = [];
  for (const item of (payload as { edits: unknown[] }).edits) {
    const edit = readEdit(item);
    if (!edit) continue;
    edits.push(edit);
    if (edits.length >= 8) break;
  }
  return edits;
}

export function chatEdits(original: string, edits: readonly unknown[]): ReturnType<typeof prepareChatEdits> {
  const normalized: NoteEdit[] = [];
  for (const item of edits) {
    const edit = readEdit(item);
    if (edit) normalized.push(edit);
  }
  return prepareChatEdits(original, normalized);
}

export function renderArticleEditReview(items: EditItem[]): string {
  const sections = items.map((item, index) => renderEdit(index, item.edits[0]));
  const ask = items.length === 1 ? t("articleEditAskOne") : t("articleEditAsk");
  return [sections.join("\n\n---\n\n"), ask].join("\n\n");
}

export function renderArticleEditResult(commit: EditCommit, remaining: EditItem[]): string {
  const parts: string[] = [];
  if (commit.written.length) parts.push(t("articleEditApplied", { count: commit.written.length }));
  for (const skip of commit.skipped) {
    parts.push(t("articleEditSkipped", { n: skip.index + 1, reason: t(SKIP_REASON[skip.reason]) }));
  }
  if (!commit.written.length && !commit.skipped.length) parts.push(t("freshnessUnchanged"));
  if (remaining.length) parts.push(renderArticleEditReview(remaining));
  return parts.join("\n\n");
}

function readEdit(item: unknown): NoteEdit | null {
  if (!item || typeof item !== "object") return null;
  const record = item as { op?: unknown; anchor?: unknown; before?: unknown; at?: unknown; text?: unknown; after?: unknown };
  const named = record.op === "insert" || record.op === "replace" || record.op === "delete";
  if (typeof record.op === "string" && !named) return null;
  const anchor = typeof record.anchor === "string" ? record.anchor : !named && typeof record.before === "string" ? record.before : "";
  if (!anchor.trim()) return null;
  const text = typeof record.text === "string" ? record.text : !named && typeof record.after === "string" ? record.after : "";
  if (!named) {
    if (typeof record.after === "string" && !text) return { op: "delete", anchor };
    if (!text || text === anchor) return null;
    return { op: "replace", anchor, text };
  }
  if (record.op === "delete") return { op: "delete", anchor };
  if (record.op === "insert") {
    if ((record.at !== "before" && record.at !== "after") || !text.trim()) return null;
    return { op: "insert", anchor, at: record.at, text };
  }
  if (!text || text === anchor) return null;
  return { op: "replace", anchor, text };
}

function renderEdit(index: number, edit: NoteEdit | undefined): string {
  if (!edit) return `**${index + 1}**`;
  const label = edit.op === "insert" ? t("articleEditInsert") : edit.op === "delete" ? t("articleEditRemove") : t("articleEditReplace");
  const parts = [`**${index + 1}** · ${label}`, `**原文**\n\n${fenced(preview(edit.anchor))}`];
  if (edit.op === "delete") parts.push(`**修改后**\n\n${t("articleEditDelete")}`);
  else parts.push(`**修改后**\n\n${fenced(preview(edit.text ?? ""))}`);
  return parts.join("\n\n");
}

function preview(value: string): string {
  return value.length > 1500 ? `${value.slice(0, 1500)}\n…` : value;
}

function fenced(value: string): string {
  const longest = value.match(/`+/g)?.reduce((length, run) => Math.max(length, run.length), 0) ?? 0;
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${value}\n${fence}`;
}
