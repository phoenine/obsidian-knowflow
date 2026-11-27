import type { FreshnessReview } from "../learning/article-freshness";
import { t } from "../../i18n";

export type FreshnessRequest =
  | { kind: "check" | "check-and-update" | "classify" }
  | { kind: "apply"; numbers: number[] | "all"; label?: string };

const REVISION_NUMBER = /^[一二三四五六七八九十]$/;
const CHINESE_NUMBERS = "零一二三四五六七八九十";

/** Only a direct request from the user can authorize a write. */
export function parseFreshnessRequest(question: string): FreshnessRequest | null {
  const text = question.trim().replace(/[。！.!]+$/, "").replace(/^(?:请(?:帮我)?|麻烦(?:帮我)?|帮我)\s*/, "");
  if (/^(?:检查并更新(?:当前文章|这篇文章|本文)?(?:的过时内容)?|(?:check|review) and update (?:this|the current) (?:article|note))$/i.test(text)) {
    return { kind: "check-and-update" };
  }
  if (/^(?:(?:应用|采纳)(?:全部|所有|这些)(?:修订|更新|修改)?|全部应用|apply all(?: (?:revisions|changes))?)$/i.test(text)) {
    return { kind: "apply", numbers: "all" };
  }
  const pointed = /^(?:应用|采纳|apply)\s*[:：]\s*(\d{1,2}|[一二三四五六七八九十])(?:\s*[·•]\s*(.+))?$/i.exec(text);
  if (pointed) {
    const number = REVISION_NUMBER.test(pointed[1]) ? CHINESE_NUMBERS.indexOf(pointed[1]) : Number(pointed[1]);
    return { kind: "apply", numbers: [number], label: pointed[2]?.trim() };
  }
  const list = /^(?:应用|采纳)\s*(.+)$/.exec(text)?.[1];
  const englishItem = /^apply(?:\s+(?:revision|change|item))?\s+(\d{1,2})$/i.exec(text);
  if (englishItem) return { kind: "apply", numbers: [Number(englishItem[1])] };
  if (list && /^第/.test(list)) {
    const items = list.replace(/(?:修订|更新|修改)$/, "").split(/[、,，和及与]/);
    const values = items.map((item) => /^\s*第?\s*(\d{1,2}|[一二三四五六七八九十])\s*[条项个]?\s*$/.exec(item)?.[1]);
    if (values.every((value): value is string => value !== undefined)) {
      return { kind: "apply", numbers: values.map((value) => REVISION_NUMBER.test(value) ? CHINESE_NUMBERS.indexOf(value) : Number(value)) };
    }
  }
  if (/^(?:检查(?:一下)?(?:当前文章|这篇文章|本文)(?:是否|有没有|有无)过时[？?]?|检查(?:这篇|当前)?文章时效[？?]?|check (?:whether|if) (?:this|the current) (?:article|note) is outdated\??)$/i.test(text)) {
    return { kind: "check" };
  }
  if (/过时|时效|仍然适用|最新|旧版本|现行|还能用|obsolete|outdated|up[- ]to[- ]date|current version/i.test(text)) {
    return { kind: "classify" };
  }
  return null;
}

/** The quoted action and status must belong to the numbered suggestion. */
export function freshnessSelectionMatches(action: string, status: string, label: string): boolean {
  const compact = (value: string): string => value.replace(/\s+/g, "");
  return compact(label) === compact(`${action}·${status}`);
}

/** A direct answer to the update prompt. It only applies while a review is waiting. */
export function parseArticleUpdateReply(question: string): "accept" | "decline" | null {
  const text = question.trim().replace(/[。！.!？?]+$/, "").replace(/^(?:请(?:帮我)?|麻烦(?:帮我)?|帮我)\s*/, "");
  if (/^(?:不(?:用|要|更新|改了)?|先不(?:用|更新)?|保持原文|不用更新|no|don't update|do not update|keep(?: the)? (?:original|note))$/i.test(text)) return "decline";
  if (/^(?:好的|同意|更新|更新原文|更新文章|帮我更新(?:原文|文章)?|按建议更新|update(?: the (?:article|note))?|apply(?: the)? suggestions?)$/i.test(text)) return "accept";
  return null;
}

export function renderFreshnessReview(_title: string, review: FreshnessReview): string {
  const unfinished = (reason: string): boolean => reason.includes("尚未完成");
  const incomplete = review.incomplete.length
    || review.unverified.some((item) => unfinished(item.reason))
    || (review.followUp ?? []).some((item) => unfinished(item.reason));
  const followUp = renderFollowUp(review);
  if (!review.updates.length) {
    const parts: string[] = [];
    if (incomplete) parts.push(t("freshnessIncomplete"));
    else if (review.unverified.length) parts.push(t("freshnessInsufficient"));
    if (followUp) parts.push(followUp);
    return parts.length ? parts.join("\n\n") : t("freshnessNone");
  }
  const updates = review.updates.map((update, index) => renderFreshnessUpdate(index, update));
  return [
    ...(incomplete ? [t("freshnessPartial")] : []),
    updates.join("\n\n---\n\n"),
    ...(followUp ? [followUp] : []),
    t("freshnessAsk")
  ].join("\n\n");
}

function renderFollowUp(review: FreshnessReview): string {
  const seen = new Set((review.followUp ?? []).map((item) => item.text));
  const items = [...(review.followUp ?? []), ...review.unverified.filter((item) => !seen.has(item.text))];
  if (!items.length) return "";
  const lines = items.map((item) => `- ${markdownText(item.text)}：${markdownText(item.reason)}`);
  return [t("freshnessFollowUp"), ...lines].join("\n");
}

export function renderFreshnessApplied(applied: number, remaining: number): string {
  if (remaining > 0) return t("freshnessAppliedRemaining", { count: applied, remaining });
  return t("freshnessApplied", { count: applied });
}

const FRESHNESS_SKIP = {
  missing: "articleEditReasonMissing",
  ambiguous: "articleEditReasonAmbiguous",
  paragraph: "articleEditReasonParagraph",
  conflict: "articleEditReasonConflict",
  span: "articleEditReasonSpan",
  protected: "articleEditReasonProtected"
} as const;

export function renderFreshnessCommit(
  written: number,
  skipped: Array<{ index: number; reason: string }>,
  unselected: number
): string {
  const parts: string[] = [];
  if (written) parts.push(renderFreshnessApplied(written, unselected));
  for (const skip of skipped) {
    const reason = FRESHNESS_SKIP[skip.reason as keyof typeof FRESHNESS_SKIP] ?? "articleEditReasonMissing";
    parts.push(t("articleEditSkipped", { n: skip.index + 1, reason: t(reason) }));
  }
  if (!parts.length) parts.push(t("freshnessUnchanged"));
  return parts.join("\n\n");
}

function renderFreshnessUpdate(index: number, update: FreshnessReview["updates"][number]): string {
  const parts = [`**${index + 1}** · **${update.action}** · *${markdownText(update.status)}*`];
  if (update.before) parts.push(`**原文**\n> ${markdownText(update.before)}`);
  if (update.action !== "删除" && update.after) parts.push(`**建议**\n${emphasizeProse(update.after)}`);
  if (update.reason) parts.push(`*说明*　${markdownText(update.reason)}`);
  parts.push(update.source.url
    ? `**依据**　${markdownText(update.source.quote)} · [${markdownText(update.source.title)}](<${update.source.url}>)`
    : `**依据**　${t("freshnessModelBasis")}`);
  return parts.join("\n\n");
}

function emphasizeProse(value: string): string {
  const text = markdownText(value);
  const marked = text.replace(/「([^」]+)」/g, "**$1**");
  const sentences = marked.match(/[^。！？]*[。！？]|[^。！？]+$/g)?.map((sentence) => sentence.trimStart()) ?? [];
  if (sentences.length >= 2 && !sentences[0].includes("**")) sentences[0] = `**${sentences[0]}**`;
  return sentences.join("");
}

function markdownText(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/[\\`*_{}\[\]()<>#~!|]/g, "\\$&");
}
