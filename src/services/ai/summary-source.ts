import { prepareArticleForAi } from "../clipping/managed-content";
import { protectedLineIndices, protectedRanges } from "../clipping/protected-markdown";
import { splitArticleSections } from "../learning/article-sections";

export interface SummarySourceSection {
  title: string;
  content: string;
}

const INPUT_CHARS = 10_000;
const MAX_SECTIONS = 24;

export function prepareSummarySource(markdown: string): {
  sections: SummarySourceSection[];
  sampled: boolean;
} {
  const article = compactMedia(prepareArticleForAi(markdown));
  let logical = splitArticleSections(article);
  if (logical.length === 1 && logical[0].title === "导语") {
    const alternative = splitArticleSections(article, 1);
    logical = alternative.length === 1 && alternative[0].title === "导语"
      ? splitArticleSections(article, 3)
      : alternative;
  }
  if (!logical.length) throw new Error("当前文章没有可用于生成摘要的正文。");
  const groupSize = Math.ceil(logical.length / MAX_SECTIONS);
  const sections: SummarySourceSection[] = [];
  for (let start = 0; start < logical.length; start += groupSize) {
    const group = logical.slice(start, start + groupSize);
    const first = group[0];
    const last = group[group.length - 1];
    const title = group.length === 1 ? first.title.slice(0, 96)
      : first.title.slice(0, 45) + " 至 " + last.title.slice(0, 45);
    const content = group.length === 1 ? first.content
      : group.map((section) => "## " + section.title + "\n" + section.content).join("\n\n");
    sections.push({ title, content });
  }
  const overhead = sections.reduce((sum, section) => sum + section.title.length + 40, 0);
  const allowances = allocateSectionBudget(sections, INPUT_CHARS - overhead);
  return {
    sections: sections.map((section, index) => ({ ...section, content: sampleText(section.content, allowances[index]) })),
    sampled: sections.some(({ content }, index) => content.length > allowances[index])
  };
}

function sampleText(text: string, max: number): string {
  if (text.length <= max) return text;
  const gap = "\n[…]\n";
  const width = Math.floor((max - gap.length * 2) / 3);
  if (width < 1) return text.slice(0, max);
  const middle = Math.floor((text.length - width) / 2);
  return [text.slice(0, width), text.slice(middle, middle + width), text.slice(-width)].join(gap);
}

function allocateSectionBudget(sections: SummarySourceSection[], budget: number): number[] {
  const order = sections.map(({ content }, index) => ({ length: content.length, index }))
    .sort((left, right) => left.length - right.length);
  const allowances = sections.map(() => 0);
  let remaining = Math.max(0, budget);
  for (const [position, { length, index }] of order.entries()) {
    const allowance = Math.min(length, Math.floor(remaining / (sections.length - position)));
    allowances[index] = allowance;
    remaining -= allowance;
  }
  return allowances;
}

function compactMedia(article: string): string {
  const lines = article.split("\n");
  const protectedLines = protectedLineIndices(protectedRanges(lines));
  return lines.map((line, index) => {
    if (protectedLines.has(index)) return line;
    const image = /^ *!\[((?:\\.|[^\]\\])*)\]\(.*\)\s*$/.exec(line);
    if (image) return image[1].trim() ? "（图注）" + image[1].trim().slice(0, 64) : "";
    return /^ *!\[\[[^\]]+\]\]\s*$/.test(line) ? "" : line;
  }).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
