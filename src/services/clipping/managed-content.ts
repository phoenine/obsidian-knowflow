import { protectedLineIndices, protectedRanges } from "./protected-markdown";

const LEGACY_RELATED_LINKS_TITLE = "> [!info]- KnowFlow 相关文章";
const FRONTMATTER = /^(?:\uFEFF)?---[ \t]*\r?\n(?:[^\n]*\n)*?---[ \t]*(?:\r?\n|$)/;

export function prepareArticleForAi(content: string): string {
  return stripManagedArticleSections(content)
    .replace(/[ \t]*<!-- knowflow-translation -->[ \t]*/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function stripManagedArticleSections(content: string): string {
  return removeKnowledgeMapSection(removeManagedCallouts(stripFrontmatter(content)));
}

export function stripFrontmatter(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .replace(FRONTMATTER, "")
    .replace(/^\uFEFF/, "");
}

export function insertArticleCallout(content: string, lines: string[]): string {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const frontmatter = FRONTMATTER.exec(content)?.[0] ?? (content.startsWith("\uFEFF") ? "\uFEFF" : "");
  const prefix = frontmatter.length > 1
    ? frontmatter + (frontmatter.endsWith("\n") ? newline : newline.repeat(2))
    : frontmatter;
  return prefix + lines.join(newline) + newline.repeat(2) + content.slice(frontmatter.length);
}

function removeManagedCallouts(content: string): string {
  const lines = content.split("\n");
  const protectedLines = protectedLineIndices(protectedRanges(lines));
  const result: string[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!protectedLines.has(index) && (/^> \[!(?:summary|question)\][+-]?\s+(?:AI 摘要|Quiz)\s*$/.test(lines[index])
      || lines[index] === LEGACY_RELATED_LINKS_TITLE
      || /^> \[!note\]-?\s*KnowFlow (?:时效更新|知识更新) · \d{4}-\d{2}-\d{2}$/.test(lines[index]))) {
      index += 1;
      while (index < lines.length && /^\s*>/.test(lines[index])) index += 1;
      continue;
    }
    result.push(lines[index]);
    index += 1;
  }
  return result.join("\n");
}

function removeKnowledgeMapSection(content: string): string {
  return content.replace(
    /^## (?:Knowledge Map|知识骨架)\s*\n[\s\S]*?(?=^##\s|(?![\s\S]))/gim,
    ""
  );
}

