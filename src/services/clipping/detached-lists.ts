import { protectedLineIndices, protectedRanges } from "./protected-markdown";

export function restoreDetachedLists(content: string): string {
  const lines = content.split("\n");
  const protectedLines = protectedLineIndices(protectedRanges(lines));
  const edits: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (protectedLines.has(index) || lines[index].trim() !== "1") continue;
    const run: typeof edits = [];
    let item = index;
    for (let number = 1; lines[item]?.trim() === String(number) && !protectedLines.has(item); number += 1) {
      const next = nextNonBlank(lines, item + 1);
      if (next < item + 2 || protectedLines.has(next) || !isDetachedListBody(lines[next] ?? "")) break;
      if (lines[next + 1]?.trim()) break;
      run.push({ start: item, end: next });
      item = nextNonBlank(lines, next + 1);
    }
    if (run.length > 1) edits.push(...run);
  }
  for (const { start, end } of edits.reverse()) {
    lines.splice(start, end - start + 1, `${lines[start].trim()}. ${lines[end]}`);
  }
  return lines.join("\n");
}

function isDetachedListBody(line: string): boolean {
  const text = line.trim().replace(/^(?:\*\*|__|~~|==|`|\*|_)+/, "");
  return /^[\p{L}"“‘（(]/u.test(text);
}

function nextNonBlank(lines: string[], start: number): number {
  let index = start;
  while (index < lines.length && !lines[index].trim()) index += 1;
  return index;
}
