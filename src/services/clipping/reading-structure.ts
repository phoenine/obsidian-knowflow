import { protectedLineIndices, protectedRanges } from "./protected-markdown";

const TABLE_DIVIDER = /^\|\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|$/;

/** Fix a malformed separator when the header and all surviving rows agree on their width. */
export function repairTableDividers(content: string): string {
  const lines = content.split("\n");
  const protectedLines = protectedLineIndices(protectedRanges(lines));
  for (let index = 1; index < lines.length - 1; index += 1) {
    if (protectedLines.has(index) || protectedLines.has(index - 1) || !TABLE_DIVIDER.test(lines[index].trim())) continue;
    const header = tableCells(lines[index - 1]);
    const divider = tableCells(lines[index]);
    if (header.length < 2 || header.length === divider.length) continue;

    let next = index + 1;
    while (next < lines.length && !protectedLines.has(next) && tableCells(lines[next]).length === header.length) next += 1;
    if (next === index + 1 || tableCells(lines[next] ?? "").length) continue;
    lines[index] = tableRow(header.map((_, column) => divider[column] ?? "---"));
  }
  return lines.join("\n");
}

function tableCells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return [];
  return trimmed.slice(1, -1).split(/(?<!\\)\|/).map((cell) => cell.trim());
}

function tableRow(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}
