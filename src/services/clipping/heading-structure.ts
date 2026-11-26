import { protectedLineIndices, protectedRanges } from "./protected-markdown";
import { collectClippedCodeCandidates, collectCodeCandidates, stripHeadingNumberPrefix } from "./formatting-candidates";

export type HeadingEditType = "format" | "level" | "demote";

export interface HeadingInput {
  mode: "full" | "compressed";
  text: string;
  tokens: number;
  /** What the model saw for every line it may edit, keyed by zero-based line index. */
  shown: Map<number, ShownLine>;
}

interface ShownLine {
  text: string;
  truncated: boolean;
}

export interface HeadingEditResult {
  content: string;
  applied: number;
  rejected: number;
  /** Set when the whole answer was refused; the content is then unchanged. */
  discarded?: string;
}

interface PlannedEdit {
  index: number;
  next: string;
}

export const HEADING_FULL_BUDGET = 16000;
export const HEADING_COMPRESSED_BUDGET = 32000;
const COMPRESSED_LINE_LIMIT = 80;
const COMPRESSED_PREFIX = 60;
const MISMATCH_RATIO = 0.3;
const MISMATCH_MIN_EDITS = 3;
const ATX = /^( {0,3})(#{1,6})(?:[ \t]+|$)(.*)$/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;
const EDIT_TYPES = new Set<HeadingEditType>(["format", "level", "demote"]);

/** Rough token count used only for the input budget: one per CJK character, about 3.5 characters otherwise. */
export function estimateTokens(text: string): number {
  const cjk = text.match(/[\u3000-\u9fff\uff00-\uffef]/g)?.length ?? 0;
  return Math.ceil(cjk + (text.length - cjk) / 3.5);
}

export function buildHeadingInput(content: string): HeadingInput | { skipped: string } {
  const lines = content.split("\n");
  const protectedKinds = headingProtectedLines(content);
  const full = renderInput(lines, protectedKinds, false);
  const fullTokens = estimateTokens(full.text);
  if (fullTokens <= HEADING_FULL_BUDGET) return { mode: "full", text: full.text, tokens: fullTokens, shown: full.shown };
  const compressed = renderInput(lines, protectedKinds, true);
  const compressedTokens = estimateTokens(compressed.text);
  if (compressedTokens <= HEADING_COMPRESSED_BUDGET) {
    return { mode: "compressed", text: compressed.text, tokens: compressedTokens, shown: compressed.shown };
  }
  return { skipped: "正文过长" };
}

export function readHeadingEdits(payload: unknown): unknown[] {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { edits?: unknown }).edits)) {
    throw new Error("标题结构缺少 edits 数组。");
  }
  return (payload as { edits: unknown[] }).edits;
}

/**
 * The model decides which lines are headings and at what level. The program only checks that every edit
 * points at the line the model saw, that nothing but heading markers changed, and that no new downward
 * level skip appears. The written text always comes from the source line, never from the model.
 */
export function applyHeadingEdits(content: string, input: Pick<HeadingInput, "shown">, edits: unknown[]): HeadingEditResult {
  const lines = content.split("\n");
  const unchanged = (discarded: string): HeadingEditResult => ({ content, applied: 0, rejected: edits.length, discarded });
  let mismatched = 0;
  let invalid = 0;
  const byLine = new Map<number, PlannedEdit[]>();
  for (const raw of edits) {
    const planned = planEdit(lines, input.shown, raw);
    if (planned === "mismatch") mismatched += 1;
    else if (!planned) invalid += 1;
    else byLine.set(planned.index, [...(byLine.get(planned.index) ?? []), planned]);
  }
  if (edits.length >= MISMATCH_MIN_EDITS && mismatched / edits.length > MISMATCH_RATIO) {
    return unchanged("行号与原文对不上的修改过多");
  }
  let planned = [...byLine.values()].filter((group) => group.length === 1).map(([edit]) => edit);
  invalid += [...byLine.values()].filter((group) => group.length > 1).reduce((sum, group) => sum + group.length, 0);

  const headingLines = [...input.shown.keys()].sort((a, b) => a - b);
  const baseline = downwardSkips(lines, headingLines);
  const addsSkip = (candidate: string[]): boolean => [...downwardSkips(candidate, headingLines)].some((index) => !baseline.has(index));
  let next = applyPlanned(lines, planned);
  if (addsSkip(next)) {
    const culprit = planned.find((edit) => !addsSkip(applyPlanned(lines, planned.filter((other) => other !== edit))));
    if (!culprit) return unchanged("修改会造成新的标题跳级");
    planned = planned.filter((edit) => edit !== culprit);
    invalid += 1;
    next = applyPlanned(lines, planned);
  }
  if (contentSignature(next) !== contentSignature(lines)) return unchanged("修改改动了正文文字");
  return { content: next.join("\n"), applied: planned.length, rejected: invalid + mismatched };
}

/** Section numbers are added back by Obsidian's numbering plugin, so body headings keep only their words. */
export function stripHeadingNumbers(content: string): string {
  const lines = content.split("\n");
  const protectedLines = protectedLineIndices(protectedRanges(lines));
  return lines.map((line, index) => {
    if (protectedLines.has(index)) return line;
    const match = ATX.exec(line);
    if (!match) return line;
    const text = match[3].trim();
    const title = stripHeadingNumberPrefix(text);
    return title && title !== text ? `${match[1]}${match[2]} ${title}` : line;
  }).join("\n");
}

/** Lines the heading step must neither show in full nor edit, with a short label for the placeholder. */
export function headingProtectedLines(content: string): Map<number, string> {
  const lines = content.split("\n");
  const kinds = new Map<number, string>();
  for (const { start, end, marker } of protectedRanges(lines)) {
    const kind = marker === "$$" ? "公式" : marker === "%%" ? "批注" : "代码";
    for (let index = start; index <= end; index += 1) kinds.set(index, kind);
  }
  let inComment = false;
  for (const [index, line] of lines.entries()) {
    if (kinds.has(index)) continue;
    const trimmed = line.trim();
    if (inComment || trimmed.startsWith("<!--")) {
      kinds.set(index, "注释");
      inComment = !trimmed.slice(inComment ? 0 : 4).includes("-->");
    } else if (trimmed.startsWith(">")) kinds.set(index, "引用");
  }
  // GFM tables may omit the outer pipes; the delimiter row under the header is what makes them tables.
  for (const [index, line] of lines.entries()) {
    const header = lines[index - 1];
    if (!header?.includes("|") || !line.includes("|") || !TABLE_DELIMITER.test(line)) continue;
    if (kinds.has(index) || kinds.has(index - 1) || ATX.test(header) || LIST_ITEM.test(header)) continue;
    kinds.set(index - 1, "表格");
    kinds.set(index, "表格");
    for (let row = index + 1; row < lines.length; row += 1) {
      const body = lines[row];
      if (!body.trim() || kinds.has(row) || ATX.test(body) || LIST_ITEM.test(body)) break;
      kinds.set(row, "表格");
    }
  }
  for (const [index, line] of lines.entries()) {
    if (line.trimStart().startsWith("|") && !kinds.has(index)) kinds.set(index, "表格");
  }
  // Unfenced code is fenced only after this step. A `# comment` inside it already reads as a heading,
  // so the suspected range and any heading line glued to it stay out of reach.
  const code = collectCodeCandidates(content).possibleCode;
  for (const { startLine, endLine } of [...code, ...collectClippedCodeCandidates(content)]) {
    let start = startLine;
    let end = endLine;
    while (start > 0 && !kinds.has(start - 1) && ATX.test(lines[start - 1])) start -= 1;
    while (end + 1 < lines.length && !kinds.has(end + 1) && ATX.test(lines[end + 1])) end += 1;
    for (let index = start; index <= end; index += 1) if (!kinds.has(index)) kinds.set(index, "疑似代码");
  }
  return kinds;
}

function renderInput(lines: string[], kinds: Map<number, string>, compress: boolean): { text: string; shown: Map<number, ShownLine> } {
  const output: string[] = [];
  const shown = new Map<number, ShownLine>();
  for (let index = 0; index < lines.length; index += 1) {
    const kind = kinds.get(index);
    if (kind) {
      let end = index;
      while (end + 1 < lines.length && kinds.get(end + 1) === kind) end += 1;
      output.push(`${end > index ? `${index + 1}-${end + 1}` : index + 1}|[${kind}]`);
      index = end;
      continue;
    }
    const line = lines[index];
    if (!line.trim()) continue;
    const truncated = compress && line.length > COMPRESSED_LINE_LIMIT && !ATX.test(line);
    const text = truncated ? `${line.slice(0, COMPRESSED_PREFIX)}…（共 ${line.length} 字）` : line;
    shown.set(index, { text: truncated ? line.slice(0, COMPRESSED_PREFIX) : line, truncated });
    output.push(`${index + 1}|${text}`);
  }
  return { text: output.join("\n"), shown };
}

function planEdit(lines: string[], shown: Map<number, ShownLine>, raw: unknown): PlannedEdit | "mismatch" | null {
  if (!raw || typeof raw !== "object") return null;
  const edit = raw as Record<string, unknown>;
  if (!EDIT_TYPES.has(edit.type as HeadingEditType) || typeof edit.line !== "number" || !Number.isInteger(edit.line)) return null;
  const index = edit.line - 1;
  const seen = shown.get(index);
  if (!seen || typeof edit.text !== "string") return null;
  if (!echoMatches(edit.text, lines[index], seen)) return "mismatch";

  const current = lines[index];
  const heading = ATX.exec(current);
  const level = typeof edit.level === "number" && Number.isInteger(edit.level) && edit.level >= 2 && edit.level <= 4 ? edit.level : 0;
  if (edit.type === "format") {
    if (heading || !level || /^\s*(?:[-*+]\s|!\[|\[\[|<|---+\s*$)/.test(current)) return null;
    if (LIST_ITEM.test(current) && !isStandaloneNumberedLine(lines, index)) return null;
    const text = unbold(current.trim());
    return text ? { index, next: `${"#".repeat(level)} ${text}` } : null;
  }
  if (!heading) return null;
  const text = heading[3].trim();
  if (edit.type === "level") {
    if (!level || level === heading[2].length || !text) return null;
    return { index, next: `${heading[1]}${"#".repeat(level)} ${text}` };
  }
  return text ? { index, next: text } : null;
}

/**
 * `1. 引言` between paragraphs is a lost section heading; the same line inside a run of items, or with text
 * continuing under it, belongs to a real list and must stay there.
 */
function isStandaloneNumberedLine(lines: string[], index: number): boolean {
  if (/^\s/.test(lines[index]) || lines[index + 1]?.trim()) return false;
  const neighbour = (step: -1 | 1): string | undefined => {
    for (let other = index + step; other >= 0 && other < lines.length; other += step) {
      if (lines[other].trim()) return lines[other];
    }
    return undefined;
  };
  return ![neighbour(-1), neighbour(1)].some((line) => line !== undefined && LIST_ITEM.test(line));
}

function echoMatches(echo: string, line: string, seen: ShownLine): boolean {
  const said = comparable(echo);
  if (!said) return false;
  return said === comparable(line) || (seen.truncated && said === comparable(seen.text));
}

function comparable(text: string): string {
  return unbold(text.trim().replace(/^#{1,6}(?:[ \t]+|$)/, "").trim()).replace(/\s+/g, "");
}

function unbold(text: string): string {
  return text.replace(/^\*\*([^*](?:.*[^*])?)\*\*$/, "$1").trim();
}

function applyPlanned(lines: string[], planned: PlannedEdit[]): string[] {
  const next = [...lines];
  for (const { index, next: line } of planned) next[index] = line;
  return next;
}

/** Lines of headings that go more than one level deeper than the heading before them; the title is level 1. */
function downwardSkips(lines: string[], indices: number[]): Set<number> {
  let previous = 1;
  const skips = new Set<number>();
  for (const index of indices) {
    const match = ATX.exec(lines[index]);
    if (!match) continue;
    const level = match[2].length;
    if (level > previous + 1) skips.add(index);
    previous = level;
  }
  return skips;
}

function contentSignature(lines: string[]): string {
  return lines.map((line) => comparable(line)).join("\n");
}
