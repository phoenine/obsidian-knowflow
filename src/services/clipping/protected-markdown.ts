interface ProtectedRange {
  start: number;
  end: number;
  marker: string;
  closed: boolean;
}

/** Scan before formatting so examples, math and Obsidian comments cannot become prose candidates. */
export function protectedRanges(lines: string[]): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];
  const listContentIndent = new Map<number, number>();
  let open: { start: number; marker: string; quoteDepth: number } | undefined;
  for (const [index, line] of lines.entries()) {
    const quoted = quotePrefix(line);
    if (open) {
      const { marker } = open;
      const sameQuote = quoted.depth === open.quoteDepth;
      const trimmed = marker === "$$" || marker === "%%" ? line.trim() : quoted.rest.trim();
      const closed = sameQuote && (marker === "$$" ? trimmed === "$$"
        : marker === "%%" ? trimmed.includes("%%")
        : trimmed.startsWith(marker) && [...trimmed].every((character) => character === marker[0]));
      if (closed) {
        ranges.push({ start: open.start, end: index, marker, closed: true });
        open = undefined;
      }
      continue;
    }
    noteListItem(quoted, listContentIndent);
    const fence = fenceMarker(quoted.rest, listContentIndent.get(quoted.depth) ?? -1);
    const trimmed = line.trim();
    if (fence || (quoted.depth === 0 && (trimmed === "$$" || (trimmed.startsWith("%%") && !trimmed.slice(2).includes("%%"))))) {
      open = { start: index, marker: fence ?? trimmed.slice(0, 2), quoteDepth: quoted.depth };
    }
  }
  if (open) ranges.push({ start: open.start, end: lines.length - 1, marker: open.marker, closed: false });
  return ranges;
}

function quotePrefix(line: string): { depth: number; rest: string } {
  let rest = line;
  let depth = 0;
  while (true) {
    const marker = /^>(?:[ \t])?/.exec(rest);
    if (!marker) return { depth, rest };
    depth += 1;
    rest = rest.slice(marker[0].length);
  }
}

function noteListItem(quoted: { depth: number; rest: string }, listContentIndent: Map<number, number>): void {
  if (!quoted.rest.trim()) return;
  const item = /^([ \t]*)(?:[-+*]|\d+[.)])[ \t]+/.exec(quoted.rest);
  if (item) {
    listContentIndent.set(quoted.depth, item[0].length);
    return;
  }
  const indent = /^[ \t]*/.exec(quoted.rest)?.[0].length ?? 0;
  const required = listContentIndent.get(quoted.depth);
  if (required !== undefined && indent >= required) return;
  listContentIndent.delete(quoted.depth);
}

function fenceMarker(rest: string, listContentIndent: number): string | undefined {
  const indented = /^( *)(`{3,}(?=[^`]*$)|~{3,}(?=[^~]*$))/.exec(rest);
  if (!indented) return undefined;
  const indent = indented[1].length;
  if (indent <= 3 || (listContentIndent >= 0 && indent >= listContentIndent)) return indented[2];
  return undefined;
}

export function protectedLineIndices(ranges: ProtectedRange[]): Set<number> {
  const indices = new Set<number>();
  for (const range of ranges) {
    for (let index = range.start; index <= range.end; index += 1) indices.add(index);
  }
  return indices;
}

export function inlineCodeClosingIndex(line: string, start: number, delimiter: string): number {
  const runs = /`+|[\r\n\u2028\u2029]/g;
  runs.lastIndex = start + delimiter.length;
  for (let run = runs.exec(line); run; run = runs.exec(line)) {
    if (run[0][0] !== "`") break;
    if (run[0] === delimiter) return run.index;
  }
  return -1;
}
