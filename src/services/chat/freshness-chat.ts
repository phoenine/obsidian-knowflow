import type { FreshnessReview } from "../learning/article-freshness";

export type FreshnessRequest =
  | { kind: "check" | "check-and-update" | "classify" }
  | { kind: "apply"; numbers: number[] | "all" };

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
  const list = /^(?:应用|采纳)\s*(.+)$/.exec(text)?.[1];
  const englishItem = /^apply (?:revision|change|item)\s+(\d{1,2})$/i.exec(text);
  if (englishItem) return { kind: "apply", numbers: [Number(englishItem[1])] };
  if (list && /^第/.test(list)) {
    const items = list.replace(/(?:修订|更新|修改)$/, "").split(/[、,，和及与]/);
    const values = items.map((item) => /^\s*第?\s*(\d{1,2}|[一二三四五六七八九十])\s*[条项]?\s*$/.exec(item)?.[1]);
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

/** A direct answer to the update prompt. It only applies while a review is waiting. */
export function parseArticleUpdateReply(question: string): "accept" | "decline" | null {
  const text = question.trim().replace(/[。！.!？?]+$/, "").replace(/^(?:请(?:帮我)?|麻烦(?:帮我)?|帮我)\s*/, "");
  if (/^(?:不(?:用|要|更新|改了)?|先不(?:用|更新)?|保持原文|不用更新)$/.test(text)) return "decline";
  if (/^(?:好的|同意|更新|更新原文|更新文章|帮我更新(?:原文|文章)?|按建议更新)$/.test(text)) return "accept";
  return null;
}

export function renderFreshnessReview(_title: string, review: FreshnessReview): string {
  if (!review.updates.length) {
    return review.unverified.length ? "这些内容证据不足，原文先不改。" : "没有需要更新的内容。";
  }
  const updates = review.updates.map((update, index) => renderFreshnessUpdate(index, update));
  return [
    updates.join("\n\n---\n\n"),
    "要不要按这些建议更新原文？回复「更新」写入全部建议，回复「应用第 1 条」只写选中的项，回复「不用」则保持原文。"
  ].join("\n\n");
}

export function renderFreshnessApplied(applied: number, remaining: number): string {
  if (remaining > 0) return `已更新 ${applied} 项，写在对应章节里。还有 ${remaining} 项没写入。`;
  return `已更新 ${applied} 项，写在对应章节里。`;
}

function renderFreshnessUpdate(index: number, update: FreshnessReview["updates"][number]): string {
  const parts = [`**${index + 1}** · **${update.action}** · *${markdownText(update.status)}*`];
  if (update.before) parts.push(`**原文**\n> ${markdownText(update.before)}`);
  if (update.action !== "删除" && update.after) parts.push(`**建议**\n${emphasizeProse(update.after)}`);
  if (update.reason) parts.push(`*说明*　${markdownText(update.reason)}`);
  parts.push(`**依据**　${markdownText(update.source.quote)} · [${markdownText(update.source.title)}](<${update.source.url}>)`);
  return parts.join("\n\n");
}

function emphasizeProse(value: string): string {
  const text = markdownText(value);
  const marked = text.replace(/「([^」]+)」/g, "**$1**");
  const sentences = marked.split(/(?<=[。！？])\s*/).filter(Boolean);
  if (sentences.length >= 2 && !sentences[0].includes("**")) sentences[0] = `**${sentences[0]}**`;
  return sentences.join("");
}

function markdownText(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/[\\`*_{}\[\]()<>#~!|]/g, "\\$&");
}
