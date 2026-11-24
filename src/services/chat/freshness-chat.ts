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

export function renderFreshnessReview(title: string, review: FreshnessReview, applied?: number): string {
  const note = markdownText(title);
  const lines = [`**《${note}》时效检查 · ${review.checkedOn}**`];
  if (applied !== undefined) {
    lines.push(`已更新 ${applied} 项，原笔记已记录修改前后的内容和来源。`);
  } else if (review.recommendation) {
    const { claim, quote, reason, source } = review.recommendation;
    lines.push(`**建议删除**。${markdownText(reason)}`, `原文：${markdownText(claim)}`, citedQuote(quote, source));
  } else if (!review.corrections.length) {
    lines.push(review.sourcesFound ? "现有资料没有支持可应用的修订。" : "未找到可核验的公开资料。");
  }
  if (review.truncated) lines.push("本次覆盖正文前 24,000 个字符。");
  const corrections = review.corrections.map(({ before, after, quote, source }, index) =>
    `**第 ${index + 1} 条**　${markdownText(before)} → ${markdownText(after)}\n\n${citedQuote(quote, source)}`
  );
  if (corrections.length) lines.push(...corrections);
  if (review.risks.length) lines.push("**待核验**", review.risks.map((risk) => `- ${markdownText(risk)}`).join("\n"));
  if (applied === undefined && corrections.length > 0) {
    lines.push("回复「应用第 1 条」「应用第 1、2 条」或「应用全部」即可写入对应修订。");
  }
  return lines.join("\n\n");
}

function citedQuote(quote: string, source: { title: string; url: string }): string {
  return `依据：${markdownText(quote)} · [${markdownText(source.title)}](<${source.url}>)`;
}

function markdownText(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/[\\`*_{}\[\]()<>#~!|]/g, "\\$&");
}
