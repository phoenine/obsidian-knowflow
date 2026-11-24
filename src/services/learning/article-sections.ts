import { protectedLineIndices, protectedRanges } from "../clipping/protected-markdown";

export function splitArticleSections(content: string, depth = 2): Array<{ title: string; content: string }> {
  const lines = content.split("\n");
  const protectedLines = protectedLineIndices(protectedRanges(lines));
  const sections: Array<{ title: string; content: string }> = [];
  let title = "导语";
  let start = 0;
  const append = (end: number): void => {
    const body = lines.slice(start, end).join("\n").trim();
    if (body) sections.push({ title, content: body });
  };
  const sectionHeading = new RegExp(`^ {0,3}#{${depth}}[ \t]+(.+)`);
  for (const [index, line] of lines.entries()) {
    if (protectedLines.has(index)) continue;
    const heading = sectionHeading.exec(line);
    if (!heading) continue;
    append(index);
    title = heading[1].trim();
    start = index + 1;
  }
  append(lines.length);
  return sections;
}
