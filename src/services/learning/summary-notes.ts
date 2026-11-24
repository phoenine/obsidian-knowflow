import { splitFrontmatter } from "../clipping/frontmatter-rules";
import { protectedLineIndices, protectedRanges } from "../clipping/protected-markdown";

// A managed AI summary is identified by its summary type and exact
// "AI 摘要" title outside protected Markdown blocks.
const CALLOUT_TITLE = "> [!summary]- AI 摘要";
const CALLOUT_TITLE_PATTERN = /^> \[!summary\][+-]? AI 摘要\s*$/;

export interface SummaryText {
  summary: string;
  reason: string;
}

/** Renders the collapsed-by-default callout block. */
export function buildSummaryCallout(text: SummaryText): string {
  const body = quoteAsCallout(alignSummaryOutline(text.summary.trim()) || "AI 未返回有效摘要。");
  const reasonBlock = text.reason.trim() ? [">", `> **推荐理由**：${text.reason.trim()}`] : [];
  return [CALLOUT_TITLE, ...body, ...reasonBlock].join("\n");
}

/**
 * Inserts the managed callout right after frontmatter, or replaces the
 * existing managed callout so refreshing never stacks AI summaries.
 */
export function upsertSummaryCallout(content: string, text: SummaryText): string {
  const normalized = content.replace(/\r\n/g, "\n");
  const callout = buildSummaryCallout(text);
  const lines = normalized.split("\n");
  const range = findCalloutLineRange(lines);
  if (range) {
    return [...lines.slice(0, range.start), ...callout.split("\n"), ...lines.slice(range.end)].join("\n");
  }
  const { frontmatter, body } = splitFrontmatter(normalized);
  const trimmedBody = body.replace(/^\n+/, "");
  if (frontmatter === null) {
    return `${callout}\n\n${trimmedBody}`;
  }
  return `---\n${frontmatter}\n---\n\n${callout}\n\n${trimmedBody}`;
}

/** Extracts the managed summary/reason text back out of a note's markdown. */
export function parseSummaryCallout(content: string): SummaryText | null {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const range = findCalloutLineRange(lines);
  if (!range) return null;

  const blockLines = lines.slice(range.start, range.end).filter((line) => !CALLOUT_TITLE_PATTERN.test(line));
  const reasonIndex = blockLines.findIndex((line) => /^>\s*\*\*推荐理由\*\*：/.test(line));
  const summaryLines = reasonIndex >= 0 ? blockLines.slice(0, reasonIndex) : blockLines;
  const reasonLine = reasonIndex >= 0 ? blockLines[reasonIndex] : "";

  return {
    summary: alignSummaryOutline(unquoteCallout(summaryLines)),
    reason: reasonLine.replace(/^>\s*\*\*推荐理由\*\*：/, "").trim()
  };
}

const RANGE_ITEM = /^(\s*)(\d{1,3})\s*[-–—~～至到]\s*(\d{1,3})[.、．]\s*(.+)$/;
const ORDERED_ITEM = /^\s*(\d+)[.、．]\s+\S/;

const SUMMARY_METADATA = /^(?:title|value|tags|briefDescription|readingValue|category|reason|标题|简要描述|阅读价值|分类|标签)\s*[:：]\s*\S/i;

/** Drops a leading metadata block only when the real summary outline follows it. */
function stripSummaryMetadata(summary: string): string {
  const lines = summary.split("\n");
  let index = 0;
  let removed = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) {
      if (removed === 0) {
        index += 1;
        continue;
      }
      break;
    }
    if (!SUMMARY_METADATA.test(line)) break;
    removed += 1;
    index += 1;
  }
  if (removed < 2) return summary;
  while (index < lines.length && !lines[index].trim()) index += 1;
  const rest = lines.slice(index).join("\n").trim();
  const first = rest.split("\n").find((line) => line.trim())?.trim() ?? "";
  if (!/^#{1,6}\s+\S/.test(first)) return summary;
  return rest;
}

/** Keep merged chapter ranges, but use a real ordered-list marker so they stay aligned. */
export function alignSummaryOutline(summary: string): string {
  summary = stripSummaryMetadata(summary);
  let lastNumber = 0;
  let inFence = false;
  return summary.split("\n").map((line) => {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    if (/^#{1,6}\s+/.test(line)) {
      lastNumber = 0;
      return line;
    }
    const range = RANGE_ITEM.exec(line);
    if (range) {
      const start = Number(range[2]);
      const end = Number(range[3]);
      if (end >= start) {
        const marker = lastNumber > 0 ? lastNumber + 1 : start;
        lastNumber = marker;
        return `${marker}. ${withChapterRange(range[4].trim(), start, end)}`;
      }
    }
    const ordered = ORDERED_ITEM.exec(line);
    if (ordered) lastNumber = Number(ordered[1]);
    return line;
  }).join("\n");
}

function withChapterRange(body: string, start: number, end: number): string {
  const label = `${start}–${end}`;
  if (body.includes(label) || body.includes(`${start}-${end}`) || body.includes(`${start}~${end}`)) return body;
  const titled = /^([^：:]{1,40})([：:])(.*)$/.exec(body);
  if (!titled) return `${label} ${body}`;
  const rest = titled[3].trim();
  return `${titled[1]}（${label}）${titled[2]}${rest}`;
}

/**
 * Returns the character offset right after the summary callout block.
 * Returns null if there's no managed summary callout yet.
 */
export function findSummaryCalloutEndIndex(content: string): number | null {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const range = findCalloutLineRange(lines);
  if (!range) return null;
  return lines.slice(0, range.end).join("\n").length;
}

/**
 * A callout/blockquote in Obsidian runs from its title line through the
 * last contiguous line starting with `>` — the first line that doesn't is
 * what ends it, no explicit terminator needed.
 */
function findCalloutLineRange(lines: string[]): { start: number; end: number } | null {
  const protectedLines = protectedLineIndices(protectedRanges(lines));
  const start = lines.findIndex((line, index) => !protectedLines.has(index) && CALLOUT_TITLE_PATTERN.test(line));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && lines[end].startsWith(">")) {
    end += 1;
  }
  return { start, end };
}

function quoteAsCallout(text: string): string[] {
  return text.split("\n").map((line) => (line ? `> ${line}` : ">"));
}

function unquoteCallout(lines: string[]): string {
  return lines
    .map((line) => line.replace(/^>\s?/, ""))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}
