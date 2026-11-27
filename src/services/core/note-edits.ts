import { protectedLineIndices, protectedRanges } from "../clipping/protected-markdown";

/**
 * One confirmed change against the original Markdown.
 * `paragraph` is the preview-time paragraph. Inserts always carry it.
 * Freshness suggestions carry it on every op so a changed paragraph drops the whole suggestion.
 * Callout inserts set `stack` so several notes can share one paragraph boundary.
 * Heading numbers are left untouched; Obsidian's own numbering plugin owns those.
 */
export interface NoteEdit {
  op: "insert" | "replace" | "delete";
  anchor: string;
  at?: "before" | "after";
  text?: string;
  paragraph?: string;
  stack?: boolean;
}

export interface EditItem {
  edits: NoteEdit[];
  /** Set when the item cannot be located even against the preview text. */
  skip?: EditSkipReason;
}

export type EditSkipReason = "missing" | "ambiguous" | "paragraph" | "conflict" | "span" | "protected";

export interface EditCommit {
  content: string;
  written: number[];
  skipped: Array<{ index: number; reason: EditSkipReason }>;
}

const FRONTMATTER = /^(?:\uFEFF)?---[ \t]*\n(?:[^\n]*\n)*?---[ \t]*(?:\n|$)/;
const MANAGED_CALLOUT = /^> \[!(?:summary|question)\][+-]?\s+(?:AI 摘要|Quiz)\s*$/;
const LEGACY_RELATED = "> [!info]- KnowFlow 相关文章";
const KNOWLEDGE_NOTE = /^> \[!note\]-?\s*KnowFlow (?:时效更新|知识更新) · \d{4}-\d{2}-\d{2}$/;
const KNOWLEDGE_START = "<!-- knowflow:knowledge-points:start -->";
const KNOWLEDGE_END = "<!-- knowflow:knowledge-points:end -->";
const HEADING = /^ {0,3}#{1,6}[ \t]+\S/;
const WORD = /[A-Za-z0-9]/;

interface NoteView {
  normalized: string;
  /** normalized index → original index. The last entry is original.length. */
  map: number[];
  newline: "\n" | "\r\n";
}

interface Paragraph {
  start: number;
  end: number;
  text: string;
  unclosedFrom: number | undefined;
}

interface Located {
  item: number;
  start: number;
  end: number;
  text: string;
  /** Freshness callouts may share a boundary. Chat inserts may not. */
  stack: boolean;
}

/** Turn model output into items. Invalid anchors are returned separately and are not confirmable. */
export function prepareChatEdits(
  original: string,
  edits: NoteEdit[]
): { items: EditItem[]; rejected: Array<{ index: number; reason: EditSkipReason }> } {
  const items: EditItem[] = [];
  const rejected: Array<{ index: number; reason: EditSkipReason }> = [];
  edits.slice(0, 8).forEach((edit, index) => {
    const prepared = previewEdit(original, edit);
    if ("reason" in prepared) rejected.push({ index, reason: prepared.reason });
    else items.push({ edits: [prepared] });
  });
  return { items, rejected };
}

/** Locate every selected item against one copy of the note, then write the ones that still fit. */
export function commitNoteEdits(original: string, items: EditItem[], selected: ReadonlySet<number>): EditCommit {
  const view = openNote(original);
  const skipped: Array<{ index: number; reason: EditSkipReason }> = [];
  const located = new Map<number, Located[]>();
  for (const index of [...selected].sort((a, b) => a - b)) {
    const item = items[index];
    if (!item) continue;
    if (item.skip) {
      skipped.push({ index, reason: item.skip });
      continue;
    }
    const ops: Located[] = [];
    let failed: EditSkipReason | null = null;
    for (const edit of item.edits) {
      const place = placeEdit(view, edit);
      if ("reason" in place) {
        failed = place.reason;
        break;
      }
      ops.push({ item: index, stack: Boolean(edit.stack), ...place });
    }
    if (failed) skipped.push({ index, reason: failed });
    else located.set(index, ops);
  }

  const conflicted = conflictingItems([...located.values()].flat());
  for (const index of conflicted) {
    located.delete(index);
    skipped.push({ index, reason: "conflict" });
  }

  const writes = [...located.values()].flat().sort(compareWrites);
  let content = original;
  for (const write of writes) content = content.slice(0, write.start) + write.text + content.slice(write.end);
  skipped.sort((a, b) => a.index - b.index);
  return { content, written: [...located.keys()].sort((a, b) => a - b), skipped };
}

export function paragraphOf(original: string, anchor: string): string | null {
  const context = anchorContext(original, anchor);
  return typeof context === "string" ? null : context.paragraph;
}

/** The preview paragraph and the character immediately after a unique anchor. */
export function anchorContext(original: string, anchor: string): { paragraph: string; next: string } | EditSkipReason {
  const view = openNote(original);
  const found = findAnchor(view, anchor);
  if (!found) return "missing";
  if (Array.isArray(found)) return "ambiguous";
  return { paragraph: paragraphAt(view, found.start, found.end).text, next: view.normalized[found.end] ?? "" };
}

function previewEdit(original: string, edit: NoteEdit): NoteEdit | { reason: EditSkipReason } {
  const view = openNote(original);
  const found = findAnchor(view, edit.anchor);
  if (!found) return { reason: "missing" };
  if (Array.isArray(found)) return { reason: "ambiguous" };
  const paragraph = paragraphAt(view, found.start, found.end);
  if (edit.op === "insert") {
    const reason = checkInsert(view, paragraph, found, edit.at);
    return reason ? { reason } : { ...edit, paragraph: paragraph.text };
  }
  if (edit.paragraph !== undefined && edit.paragraph !== paragraph.text) return { reason: "paragraph" };
  return edit;
}

function placeEdit(view: NoteView, edit: NoteEdit): { start: number; end: number; text: string } | { reason: EditSkipReason } {
  const found = findAnchor(view, edit.anchor);
  if (!found) return { reason: "missing" };
  if (Array.isArray(found)) return { reason: "ambiguous" };
  const paragraph = paragraphAt(view, found.start, found.end);
  if (edit.op === "insert") {
    const reason = checkInsert(view, paragraph, found, edit.at);
    if (reason) return { reason };
  }
  if (edit.paragraph !== undefined && edit.paragraph !== paragraph.text) return { reason: "paragraph" };
  const text = withNewline(edit.text ?? "", view.newline);
  if (edit.op === "delete") return { start: found.originalStart, end: found.originalEnd, text: "" };
  if (edit.op === "replace") return { start: found.originalStart, end: found.originalEnd, text };
  const gap = view.newline + view.newline;
  if (edit.at === "before") {
    const start = paragraph.originalStart;
    return { start, end: start, text: `${text}${gap}` };
  }
  const suffix = view.normalized.slice(paragraph.end);
  const separator = suffix.trim() && !/^\n[ \t]*\n/.test(suffix) ? view.newline : "";
  return { start: paragraph.originalEnd, end: paragraph.originalEnd, text: `${gap}${text}${separator}` };
}

function conflictingItems(ops: Located[]): Set<number> {
  const conflicted = new Set<number>();
  for (let left = 0; left < ops.length; left += 1) {
    for (let right = left + 1; right < ops.length; right += 1) {
      const a = ops[left];
      const b = ops[right];
      if (a.item === b.item) continue;
      if (!overlaps(a, b)) continue;
      conflicted.add(a.item);
      conflicted.add(b.item);
    }
  }
  return conflicted;
}

/** Higher offsets first. A range that shares its start with an insert must run first, or the insert shifts the range onto the new text. */
function compareWrites(a: Located, b: Located): number {
  if (a.start !== b.start) return b.start - a.start;
  const aInsert = a.start === a.end;
  const bInsert = b.start === b.end;
  if (aInsert !== bInsert) return aInsert ? 1 : -1;
  return b.item - a.item;
}

function overlaps(a: Located, b: Located): boolean {
  const aInsert = a.start === a.end;
  const bInsert = b.start === b.end;
  if (aInsert && bInsert) return a.start === b.start && !(a.stack && b.stack);
  if (aInsert) return b.start < a.start && a.start < b.end;
  if (bInsert) return a.start < b.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}

function findAnchor(view: NoteView, anchor: string): { start: number; end: number; originalStart: number; originalEnd: number } | Array<unknown> | null {
  const needle = anchor.replace(/\r\n/g, "\n");
  if (!needle.trim()) return null;
  const excluded = exclusionRanges(view.normalized);
  const hits: Array<{ start: number; end: number }> = [];
  let from = 0;
  while (from <= view.normalized.length) {
    const start = view.normalized.indexOf(needle, from);
    if (start < 0) break;
    const end = start + needle.length;
    from = start + 1;
    if (excluded.some((range) => start < range.end && end > range.start)) continue;
    if (!wordBounded(view.normalized, start, end)) continue;
    hits.push({ start, end });
    if (hits.length > 1) return hits;
  }
  const hit = hits[0];
  if (!hit) return null;
  return {
    ...hit,
    originalStart: view.map[hit.start],
    originalEnd: view.map[hit.end]
  };
}

function checkInsert(
  view: NoteView,
  paragraph: Paragraph,
  anchor: { start: number; end: number },
  at: NoteEdit["at"]
): EditSkipReason | undefined {
  const before = view.normalized.slice(Math.min(anchor.start, paragraph.start), paragraph.start);
  const after = view.normalized.slice(paragraph.end, Math.max(anchor.end, paragraph.end));
  if (before.trim() || after.trim()) return "span";
  const offset = at === "before" ? paragraph.start : paragraph.end;
  return paragraph.unclosedFrom !== undefined && offset > paragraph.unclosedFrom ? "protected" : undefined;
}

function paragraphAt(view: NoteView, start: number, end: number): Paragraph & { originalStart: number; originalEnd: number } {
  const lines = lineTable(view.normalized);
  const ranges = protectedRanges(lines.map((line) => line.text));
  const protectedLines = protectedLineIndices(ranges);
  const unclosed = ranges.find((range) => !range.closed);
  const excluded = exclusionRanges(view.normalized);
  const excludedLine = (line: number): boolean => {
    const entry = lines[line];
    return Boolean(entry && excluded.some((range) => entry.start < range.end && entry.end > range.start));
  };
  const inside = lines.findIndex((line) => start < line.end && end > line.start);
  const index = inside < 0 ? lines.length - 1 : inside;
  const boundary = (line: number): boolean => {
    const entry = lines[line];
    if (!entry) return false;
    if (excludedLine(line)) return true;
    if (protectedLines.has(line)) return false;
    return !entry.text.trim() || HEADING.test(entry.text);
  };
  let first = index;
  let last = index;
  if (!(lines[index] && HEADING.test(lines[index].text) && !protectedLines.has(index))) {
    while (first > 0 && !boundary(first - 1)) first -= 1;
    while (last + 1 < lines.length && !boundary(last + 1)) last += 1;
  }
  const textStart = lines[first]?.start ?? 0;
  const textEnd = lines[last] ? lines[last].start + lines[last].text.length : view.normalized.length;
  return {
    start: textStart,
    end: textEnd,
    text: view.normalized.slice(textStart, textEnd),
    unclosedFrom: unclosed && lines[unclosed.start].start,
    originalStart: view.map[textStart] ?? 0,
    originalEnd: view.map[textEnd] ?? view.map[view.map.length - 1]
  };
}

function lineTable(normalized: string): Array<{ start: number; end: number; text: string }> {
  const lines: Array<{ start: number; end: number; text: string }> = [];
  let start = 0;
  for (let index = 0; index <= normalized.length; index += 1) {
    if (index !== normalized.length && normalized[index] !== "\n") continue;
    lines.push({ start, end: index + (index < normalized.length ? 1 : 0), text: normalized.slice(start, index) });
    start = index + 1;
  }
  return lines.length ? lines : [{ start: 0, end: 0, text: "" }];
}

function exclusionRanges(normalized: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const frontmatter = FRONTMATTER.exec(normalized);
  if (frontmatter) ranges.push({ start: 0, end: frontmatter[0].length });
  const lines = lineTable(normalized);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.text === KNOWLEDGE_START) {
      let end = index;
      while (end + 1 < lines.length && lines[end].text !== KNOWLEDGE_END) end += 1;
      ranges.push({ start: line.start, end: lines[end].end });
      index = end + 1;
      continue;
    }
    if (MANAGED_CALLOUT.test(line.text) || line.text === LEGACY_RELATED || KNOWLEDGE_NOTE.test(line.text)) {
      let end = index + 1;
      while (end < lines.length && /^\s*>/.test(lines[end].text)) end += 1;
      ranges.push({ start: line.start, end: end < lines.length ? lines[end - 1].end : normalized.length });
      index = end;
      continue;
    }
    index += 1;
  }
  return ranges;
}

function wordBounded(content: string, start: number, end: number): boolean {
  const text = content.slice(start, end);
  return !(WORD.test(text[0] ?? "") && WORD.test(content[start - 1] ?? ""))
    && !(WORD.test(text.at(-1) ?? "") && WORD.test(content[end] ?? ""));
}

function openNote(original: string): NoteView {
  const map: number[] = [];
  let normalized = "";
  for (let index = 0; index < original.length; index += 1) {
    if (original[index] === "\r" && original[index + 1] === "\n") continue;
    const fromCrlf = original[index] === "\n" && original[index - 1] === "\r";
    map.push(fromCrlf ? index - 1 : index);
    normalized += original[index];
  }
  map.push(original.length);
  return { normalized, map, newline: original.includes("\r\n") ? "\r\n" : "\n" };
}

function withNewline(text: string, newline: "\n" | "\r\n"): string {
  const normalized = text.replace(/\r\n/g, "\n");
  return newline === "\n" ? normalized : normalized.replace(/\n/g, newline);
}
