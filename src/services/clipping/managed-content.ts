export function prepareArticleForAi(content: string): string {
  return removeKnowledgeMapSection(removeManagedCallouts(stripFrontmatter(content)))
    .replace(/[ \t]*<!-- knowflow-translation -->[ \t]*/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function stripFrontmatter(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .replace(/^---\n[\s\S]*?\n---\n?/, "");
}

function removeManagedCallouts(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let index = 0;
  while (index < lines.length) {
    if (/^> \[!(?:summary|question)\][+-]?\s+(?:AI 摘要|Quiz)\s*$/.test(lines[index])) {
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
