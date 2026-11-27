import { collectFencedBlocks, type FormattingCandidate } from "../clipping/formatting-candidates";
import { protectedLineIndices, protectedRanges } from "../clipping/protected-markdown";
import { t } from "../../i18n";

export interface CodeFormatScope {
  section?: string;
  index?: number;
  /** The user asked for explanatory comments in addition to formatting. */
  comments?: boolean;
}

const COMMENT_REQUEST = /(?:增加|添加|加上|加|补充)(?:一些|一下|些)?注释/;

export interface LocatedCodeBlock {
  candidate: FormattingCandidate;
  section: string;
}

const CHINESE_NUMBERS: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10
};

// Phrases that only describe the request, not the section. Multi-character phrases only,
// so a section name that contains one of these characters is not damaged.
const REQUEST_FILLER = [
  "请帮我", "帮我", "请你", "麻烦", "格式化下", "格式化", "排版", "修复", "整理", "重排", "还原", "补全", "重新", "一下",
  "下面的", "下面", "所有的", "全部的", "所有", "全部", "文章里所有的", "文章中所有的", "文章里的", "文章中的", "文中的",
  "文章里", "文章中", "文中", "这篇文章", "本文", "章节", "代码块", "代码"
].sort((a, b) => b.length - a.length);
const FILLER_PATTERN = new RegExp(REQUEST_FILLER.join("|"), "g");
// Single-character connectors left at the edges after the phrases are removed.
const EDGE_CONNECTORS = /^[\s，,、的里中把将在给]+|[\s，,、的里中把将在给]+$/g;

/**
 * A direct instruction to format code blocks. Questions about code formatting
 * ("为什么这段代码格式不对？") are not requests.
 */
export function parseCodeFormatRequest(question: string): CodeFormatScope | null {
  const text = question.trim().replace(/[。！!]+$/, "");
  if (/^(?:我(?:觉得|认为|建议)|建议|如果|假如|假设|不要|先不要|别)/.test(text)) return null;
  if (/[？?]|为什么|怎么|如何|是否|是什么|原理|规则|区别|吗$/.test(text)) return null;
  const comments = COMMENT_REQUEST.test(text);
  if (!/代码/.test(text) || !(comments || /格式化|排版|修复|整理|重排|还原|补全/.test(text))) return null;
  const ordinal = /第\s*(\d+|[一二三四五六七八九十]{1,3})\s*个代码块/;
  const indexed = ordinal.exec(text);
  const index = indexed ? parseOrdinal(indexed[1]) : undefined;
  const rest = text
    .replace(ordinal, "")
    .replace(COMMENT_REQUEST, "")
    .replace(FILLER_PATTERN, "")
    .replace(EDGE_CONNECTORS, "")
    .trim();
  return {
    ...(rest ? { section: rest } : {}),
    ...(index !== undefined ? { index } : {}),
    ...(comments ? { comments: true } : {})
  };
}

/** "应用第 1 个" / "应用全部" / "apply 2" — picks items from the pending preview. */
export function parseCodeFormatApply(question: string): number[] | "all" | null {
  const text = question.trim().replace(/[。！.!]+$/, "");
  if (/^(?:应用|采纳)(?:全部|所有|这些)$/.test(text)) return "all";
  const chinese = /^(?:应用|采纳)\s*第?\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*(?:个|块|条|项)?$/.exec(text)?.[1];
  if (chinese) return [parseOrdinal(chinese)];
  const english = /^apply\s+(?:code block\s+)?(\d{1,2})$/i.exec(text)?.[1];
  if (english) return [Number(english)];
  return null;
}

/**
 * Pick the fenced blocks the user named. The section is matched against the
 * nearest heading above each block. `index` counts within the matched blocks.
 */
export function locateCodeBlocks(content: string, scope: CodeFormatScope): { blocks: LocatedCodeBlock[]; error?: "section" | "ambiguous" | "index" } {
  const lines = content.split("\n");
  const protectedLines = protectedLineIndices(protectedRanges(lines));
  const headings: Array<{ line: number; title: string }> = [];
  lines.forEach((line, index) => {
    if (protectedLines.has(index)) return;
    const match = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) headings.push({ line: index, title: match[1].replace(/\*\*/g, "") });
  });

  let blocks: LocatedCodeBlock[] = collectFencedBlocks(content).map((candidate) => {
    const heading = [...headings].reverse().find((item) => item.line < candidate.startLine);
    return { candidate, section: heading?.title ?? "" };
  });

  if (scope.section) {
    const key = normalizeTitle(scope.section);
    const exact = headings.filter(({ title }) => normalizeTitle(title) === key);
    const matched = exact.length ? exact : headings.filter(({ title }) => titleMatches(normalizeTitle(title), key));
    if (matched.length > 1) return { blocks: [], error: "ambiguous" };
    if (!matched.length) return { blocks: [], error: "section" };
    blocks = blocks.filter(({ section }) => section === matched[0].title);
    if (!blocks.length) return { blocks: [], error: "section" };
  }
  if (scope.index !== undefined) {
    const picked = blocks[scope.index - 1];
    if (!picked) return { blocks: [], error: "index" };
    blocks = [picked];
  }
  return { blocks };
}

export function renderCodeFormatReview(items: Array<{ section: string; language: string; content: string }>): string {
  const sections = items.map((item, index) => {
    const title = `**${index + 1}** · ${markdownText(item.section || t("codeFormatBody"))} · ${markdownText(item.language || "text")}`;
    return `${title}\n\n\`\`\`${item.language || "text"}\n${item.content}\n\`\`\``;
  });
  const ask = items.length === 1 ? t("codeFormatAskOne") : t("codeFormatAsk");
  return [sections.join("\n\n---\n\n"), ask].join("\n\n");
}

function normalizeTitle(value: string): string {
  return value.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}

function titleMatches(title: string, key: string): boolean {
  if (!title || !key) return false;
  return title.includes(key) || (title.length >= 2 && key.includes(title));
}

function parseOrdinal(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  if (value.length === 1) return CHINESE_NUMBERS[value] ?? 0;
  if (value.startsWith("十")) return 10 + (CHINESE_NUMBERS[value.slice(1)] ?? 0);
  if (value.endsWith("十")) return (CHINESE_NUMBERS[value.slice(0, -1)] ?? 0) * 10;
  const [tens, ones] = value.split("十");
  return (CHINESE_NUMBERS[tens] ?? 0) * 10 + (CHINESE_NUMBERS[ones] ?? 0);
}

function markdownText(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/[\\`*_{}\[\]()<>#~!|]/g, "\\$&");
}
