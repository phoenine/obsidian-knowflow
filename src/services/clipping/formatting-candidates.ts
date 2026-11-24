export type FormattingCandidateType = "possible-heading" | "possible-code" | "fenced-code";

export interface FormattingCandidate {
  id: string;
  type: FormattingCandidateType;
  startLine: number;
  endLine: number;
  /** Exact source text used for stale-write protection. */
  content: string;
  /** Clean text presented to the LLM when it differs from the source. */
  analysisContent?: string;
  before: string;
  after: string;
  /** For HIGH-confidence code: the language to auto-apply, skipping LLM */
  autoLanguage?: string;
  /** Existing fence language when collecting a mangled fenced block. */
  fenceLanguage?: string;
  /** Body looks mangled (broken indent / mashed line breaks) and needs AI reformat. */
  needsReformat?: boolean;
  clippedLanguage?: string;
}

export interface FormattingDecision {
  id: string;
  action: "keep" | "heading" | "wrap-code" | "set-code-language" | "reformat-code" | "strip-line-numbers";
  level?: number;
  language?: string;
  /** Reformatted fence body (no opening/closing fences). */
  content?: string;
  /** One-based final source line within an explicitly marked clipper fragment. */
  throughLine?: number;
}

import { assessUnfencedCode } from "./code-confidence";
import { promptFenceStarts } from "../../../skills/clipping-update/scripts/prompt-blocks";
import { protectedLineIndices, protectedRanges } from "./protected-markdown";
import { clippedCodeRegions, restoreClippedFence } from "../../../skills/clipping-update/scripts/clipped-code";

const FORMATTING_BATCH_CHARS = 16000;

export function batchFormattingCandidates(
  candidates: FormattingCandidate[],
  limits: { maxChars?: number; maxItems?: number } = {}
): FormattingCandidate[][] {
  const maxChars = limits.maxChars ?? FORMATTING_BATCH_CHARS;
  const maxItems = limits.maxItems ?? Number.POSITIVE_INFINITY;
  const batches: FormattingCandidate[][] = [];
  let batch: FormattingCandidate[] = [];
  let chars = 0;

  for (const candidate of candidates) {
    const candidateChars = (candidate.analysisContent ?? candidate.content).length
      + candidate.before.length
      + candidate.after.length;
    if (batch.length > 0 && (batch.length >= maxItems || chars + candidateChars > maxChars)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(candidate);
    chars += candidateChars;
  }

  if (batch.length > 0) batches.push(batch);
  return batches;
}

export function applyFormattingDecisions(
  content: string,
  candidates: FormattingCandidate[],
  decisions: FormattingDecision[]
): string {
  return applyFormattingEdits(content, candidates, decisions).content;
}

export function applyFormattingEdits(
  content: string,
  candidates: FormattingCandidate[],
  decisions: FormattingDecision[]
): { content: string; applied: number } {
  const lines = content.split("\n");
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const accepted = decisions
    .map((decision) => ({ decision, candidate: byId.get(decision.id) }))
    .filter((item): item is { decision: FormattingDecision; candidate: FormattingCandidate } => Boolean(item.candidate))
    .sort((a, b) => b.candidate.startLine - a.candidate.startLine);

  const used = new Set<string>();
  let applied = 0;
  for (const { decision, candidate } of accepted) {
    if (used.has(candidate.id) || decision.action === "keep") continue;
    used.add(candidate.id);

    const current = lines.slice(candidate.startLine, candidate.endLine + 1).join("\n");
    if (candidate.type === "fenced-code") {
      const fenceLang = lines[candidate.startLine].replace(/^\s*```/, "").trim();
      const expected = `\`\`\`${fenceLang}\n${candidate.content}\n\`\`\``;
      if (current !== expected) continue;

      if (decision.action === "strip-line-numbers") {
        const body = stripSequentialLineNumbers(candidate.content);
        if (body === candidate.content) continue;
        lines.splice(candidate.startLine + 1, candidate.endLine - candidate.startLine - 1, ...body.split("\n"));
        applied += 1;
        continue;
      }

      if (decision.action === "reformat-code") {
        const language = resolveFenceLanguage(decision.language, candidate);
        const body = typeof decision.content === "string" ? trimCodeFenceBody(decision.content) : "";
        if (!language || !body || /```/.test(body) || !isSafeCodeReformat(candidate, body)) {
          continue;
        }
        lines.splice(
          candidate.startLine,
          candidate.endLine - candidate.startLine + 1,
          `\`\`\`${language}`,
          ...body.split("\n"),
          "```"
        );
        applied += 1;
        continue;
      }

      if (decision.action !== "set-code-language") continue;
      const language = resolveFenceLanguage(decision.language, candidate);
      const opening = `\`\`\`${language}`;
      if (!language || lines[candidate.startLine] === opening) continue;
      lines[candidate.startLine] = opening;
      applied += 1;
      continue;
    }

    if (current !== candidate.content) continue;
    if (candidate.type === "possible-code" && decision.action === "wrap-code") {
      if (candidate.clippedLanguage) {
        const through = decision.throughLine;
        if (through === undefined || !Number.isInteger(through) || through < 2 || through > candidate.endLine - candidate.startLine + 1) continue;
        const body = lines.slice(candidate.startLine + 1, candidate.startLine + through).join("\n");
        if (!body.trim()) continue;
        lines.splice(candidate.startLine, through, ...restoreClippedFence(body, candidate.clippedLanguage).split("\n"));
        applied += 1;
        continue;
      }
      const language = normalizeLanguage(decision.language) || "text";
      lines.splice(candidate.startLine, candidate.endLine - candidate.startLine + 1, `\`\`\`${language}`, current, "```");
      applied += 1;
      continue;
    }

    if (candidate.type === "possible-heading" && decision.action === "heading") {
      const level = decision.level === 3 || decision.level === 4 ? decision.level : 2;
      const heading = stripHeadingNumberPrefix(candidate.content
        .split("\n")
        .map((line) => line.trim().replace(/^\*\*(.+)\*\*$/, "$1"))
        .filter(Boolean)
        .join(" "));
      if (!heading) continue;
      const next = `${"#".repeat(level)} ${heading}`;
      if (current === next) continue;
      lines.splice(candidate.startLine, candidate.endLine - candidate.startLine + 1, next);
      applied += 1;
    }
  }

  return { content: lines.join("\n"), applied };
}

export function stripSequentialLineNumbers(body: string): string {
  const lines = body.split("\n");
  const numbered = lines
    .map((line, index) => {
      const match = /^(\s*)(\d+)(.*)$/.exec(line);
      return match ? { index, number: Number(match[2]), prefix: `${match[1]}${match[2]}`, rest: match[3] } : null;
    })
    .filter((item): item is { index: number; number: number; prefix: string; rest: string } => Boolean(item));

  if (numbered.length < 3) return body;
  if (numbered.some((item, index) => item.number !== numbered[0].number + index)) return body;
  if (numbered.every((item) => !item.rest)) return body;
  if (lines.some((line) => line.trim() && !/^\s*\d+/.test(line))) return body;

  const prefixes = new Map(numbered.map((item) => [item.index, item.prefix.length]));
  return lines.map((line, index) => {
    const length = prefixes.get(index);
    return length === undefined ? line : line.slice(length);
  }).join("\n");
}

function makeCandidate(
  index: number,
  type: FormattingCandidateType,
  startLine: number,
  endLine: number,
  content: string,
  lines: string[]
): FormattingCandidate {
  return {
    id: `format-${index + 1}`,
    type,
    startLine,
    endLine,
    content,
    before: nearestNonBlank(lines, startLine - 1, -1),
    after: nearestNonBlank(lines, endLine + 1, 1)
  };
}

function nearestNonBlank(lines: string[], start: number, step: -1 | 1): string {
  for (let index = start; index >= 0 && index < lines.length; index += step) {
    if (lines[index].trim()) return lines[index].trim().slice(0, 160);
  }
  return "";
}

function isProtectedMarkdownLine(line: string): boolean {
  const trimmed = line.trim();
  return /^(#{1,6}\s|>|!\[|\[!\[|<!--|[-*+]\s|\d+[.)]\s|\|)/.test(trimmed)
    || /^-{3,}$/.test(trimmed);
}

function isPossibleHeadingStart(lines: string[], index: number): boolean {
  const line = lines[index].trim();
  if (!line || line.length > 70 || isProtectedMarkdownLine(line)) return false;
  if (/^https?:\/\//i.test(line) || /[。！？；;]$/.test(line)) return false;

  const blankBefore = index === 0 || !lines[index - 1].trim();
  const blankAfter = index === lines.length - 1 || !lines[index + 1].trim();

  // 相邻短行合并为 multi-line 候选
  if (blankBefore && !blankAfter) {
    const next = lines[index + 1].trim();
    if (next && next.length <= 70 && !isProtectedMarkdownLine(lines[index + 1])
        && !/[。！？；;]$/.test(next) && !/^https?:\/\//i.test(next)) {
      const afterNext = index + 2 >= lines.length || !lines[index + 2].trim();
      if (afterNext) return true;
    }
  }

  return blankBefore && blankAfter;
}

function possibleHeadingRange(lines: string[], index: number): { start: number; end: number } {
  const current = lines[index].trim();

  // 数字前缀格式（如 "1. 标题" 或 "一、" 的变形）
  if (/^\d{1,2}[.)、]?$/.test(current)) {
    let next = index + 1;
    while (next < lines.length && !lines[next].trim()) next += 1;
    if (next < lines.length && lines[next].trim().length <= 70 && !isProtectedMarkdownLine(lines[next])) {
      return { start: index, end: next };
    }
  }

  // 相邻双行短文本合并
  const blankAfter = index === lines.length - 1 || !lines[index + 1].trim();
  if (!blankAfter) {
    const nextLine = lines[index + 1].trim();
    if (nextLine && nextLine.length <= 70 && !isProtectedMarkdownLine(lines[index + 1])
        && !/[。！？；;]$/.test(nextLine) && !/^https?:\/\//i.test(nextLine)) {
      const afterNext = index + 2 >= lines.length || !lines[index + 2].trim();
      if (afterNext) return { start: index, end: index + 1 };
    }
  }

  return { start: index, end: index };
}

function normalizeLanguage(value: string | undefined): string {
  const language = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z0-9_+-]{1,24}$/.test(language) ? language : "";
}

function resolveFenceLanguage(value: string | undefined, candidate: FormattingCandidate): string {
  if (preferTextLanguage(candidate.content)) return "text";
  return normalizeLanguage(value) || normalizeLanguage(candidate.fenceLanguage) || "text";
}

/**
 * AI code formatting may only change whitespace. Any changed command,
 * identifier, literal or punctuation means the result is unsafe to apply.
 */
export function hasSameNonWhitespaceContent(source: string, formatted: string): boolean {
  return source.replace(/\s/g, "") === formatted.replace(/\s/g, "");
}

export function isSafeCodeReformat(candidate: FormattingCandidate, formatted: string): boolean {
  const source = trimCodeFenceBody(candidate.content);
  return source === formatted || restoreClippedShellContinuations(source, candidate.fenceLanguage ?? "") === formatted;
}

export function restoreClippedShellContinuations(source: string, language: string): string {
  if (!/^(?:sh|bash|shell|zsh)$/.test(language) || /\n|<</.test(source)) return source;
  // Clipper can place escaped continuations and their options on one line.
  // Match continuations outside quotes and comments.
  const tokens = /"(?:\\.|[^"\\])*"?|'[^']*'?|`(?:\\.|[^`\\])*`?|(?:^|[ \t])#[^\n]*|(?<continuation>\\[ \t]{2,})(?=--[a-zA-Z])|\\./gm;
  return source.replace(tokens, (token, continuation: string | undefined) => continuation ? "\\\n  " : token);
}

/**
 * Remove leading/trailing blank lines only — preserve relative indentation.
 * `String.trim()` would strip the first line's indent and break alignment.
 */
export function trimCodeFenceBody(body: string): string {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && !lines[0].trim()) lines.shift();
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join("\n");
}

/**
 * True when the fence body is clearly not a programming language sample
 * (flow diagrams, Chinese prose, arrow chains). Prefer `text` over guessing.
 */
export function preferTextLanguage(body: string): boolean {
  const sample = body.trim();
  if (!sample) return true;
  const markdownStructure = /^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|!\[|\[[^\]]+\]\([^)]+\))/m.test(sample);
  const yamlLines = sample
    .split("\n")
    .filter((line) => /^\s*[^:#\n][^:\n]*:\s*\S.*$/.test(line)).length;
  if (markdownStructure || yamlLines >= 2) return false;
  const hasCodeSignal = /[{};=]|=>|::|<\/?\w|^\s*(def|class|import|from|const|let|var|function|export|SELECT|INSERT|UPDATE|DELETE|curl|sudo|docker|kubectl|npm|git)\b/im.test(sample)
    || /^\s*[{[]/.test(sample)
    || /^(apiVersion|kind|metadata):/m.test(sample);
  if (hasCodeSignal) return false;
  if (/[→←↑↓⟷]/.test(sample)) return true;
  const compact = sample.replace(/\s/g, "");
  if (!compact) return true;
  const cjk = (compact.match(/[\u3400-\u9fff]/g) || []).length;
  return cjk >= 4 && cjk / compact.length > 0.5;
}

/**
 * Detect clipper-mangled fence bodies that mechanical rules cannot reliably re-indent.
 */
export function needsCodeReformat(body: string): boolean {
  const lines = body.split("\n").filter((line) => line.trim());
  if (lines.length === 0) return false;
  // Backslash continuation mashed onto the same line: `cmd \  --flag`
  if (/\\\s{2,}\S/.test(body)) return true;
  // One/two very long lines that look like collapsed multi-line code
  if (lines.length <= 2) {
    const long = lines.find((line) => line.length > 160);
    if (long && /[;{}]|&&|\|\||\\|--[\w-]/.test(long)) return true;
  }
  // Substantial single-line JSON/YAML object
  if (lines.length === 1 && lines[0].length > 100 && /^\s*[{[]/.test(lines[0])) return true;
  return false;
}

function isUnsetFenceLanguage(language: string): boolean {
  return !language || language === "text" || language === "plain";
}

function makeFencedCodeCandidate(
  index: number,
  startLine: number,
  endLine: number,
  body: string,
  fenceLanguage: string,
  lines: string[]
): FormattingCandidate | null {
  const plainLooking = preferTextLanguage(body);
  const needsFmt = needsCodeReformat(body);
  const hasNumberPrefixes = stripSequentialLineNumbers(body) !== body;
  // Clear non-code prose: leave to mechanical `text` normalization, skip LLM.
  if (plainLooking && !needsFmt && !hasNumberPrefixes) return null;

  const needsLang = isUnsetFenceLanguage(fenceLanguage);
  if (!needsLang && !needsFmt && !hasNumberPrefixes) return null;

  const candidate = makeCandidate(index, "fenced-code", startLine, endLine, body, lines);
  if (fenceLanguage) candidate.fenceLanguage = fenceLanguage;
  if (needsFmt) candidate.needsReformat = true;
  return candidate;
}

/**
 * Strip bold markers and trim. Returns empty string if the result is
 * a pure number or empty — these should not be sent to the LLM.
 */
function normalizeCandidateContent(text: string): string {
  const normalized = text
    .replace(/^\*{1,2}|\*{1,2}$/g, "")
    .trim();
  if (!normalized) return "";
  // Pure numbers
  if (/^\d{1,3}[.)、]?$/.test(normalized)) return "";
  return normalized;
}

export function collectHeadingCandidates(content: string): FormattingCandidate[] {
  const lines = content.split("\n");
  const protectedLines = protectedLineIndices(protectedRanges(lines));
  const candidates: FormattingCandidate[] = [];
  let index = 0;
  while (index < lines.length) {
    if (protectedLines.has(index) || !isPossibleHeadingStart(lines, index)) {
      index += 1;
      continue;
    }
    const range = possibleHeadingRange(lines, index);
    if (protectedLines.has(range.end)) {
      index = range.end + 1;
      continue;
    }
    const rawContent = lines.slice(range.start, range.end + 1).join("\n");
    const normalized = normalizeCandidateContent(rawContent);
    if (!normalized) {
      index = range.end + 1;
      continue;
    }
    const candidate = makeCandidate(
      candidates.length,
      "possible-heading",
      range.start,
      range.end,
      rawContent,
      lines
    );
    candidate.analysisContent = normalized;
    candidates.push(candidate);
    index = range.end + 1;
  }
  return candidates;
}

export function collectCodeCandidates(content: string): {
  possibleCode: FormattingCandidate[];
  fencedCode: FormattingCandidate[];
} {
  const lines = content.split("\n");
  const ranges = protectedRanges(lines);
  const occupied = protectedLineIndices(ranges);
  const prompts = promptFenceStarts(lines, ranges);
  const fencedCode: FormattingCandidate[] = [];
  for (const { start, end, marker, closed } of ranges) {
    if (prompts.has(start) || !closed || marker !== "```" || !lines[start].startsWith(marker) || lines[end] !== marker) continue;
    const language = lines[start].slice(marker.length).trim();
    const body = lines.slice(start + 1, end).join("\n");
    const candidate = makeFencedCodeCandidate(fencedCode.length, start, end, body, language, lines);
    if (candidate) fencedCode.push(candidate);
  }

  const possibleCode: FormattingCandidate[] = [];
  let index = 0;
  while (index < lines.length) {
    if (occupied.has(index) || !lines[index].trim() || isProtectedMarkdownLine(lines[index])) {
      index += 1;
      continue;
    }
    const start = index;
    while (
      index + 1 < lines.length
      && !occupied.has(index + 1)
      && lines[index + 1].trim()
      && !isProtectedMarkdownLine(lines[index + 1])
    ) {
      index += 1;
    }
    const end = index;
    const block = lines.slice(start, end + 1);
    const prevLine = lines[start - 1]?.trim() ?? "";
    const assessment = assessUnfencedCode(block, prevLine);

    if (assessment.confidence === "high" && assessment.suggestedLanguage) {
      // HIGH: mark for auto-wrap in the pipeline
      const candidate = makeCandidate(possibleCode.length, "possible-code", start, end, block.join("\n"), lines);
      candidate.autoLanguage = assessment.suggestedLanguage;
      possibleCode.push(candidate);
    } else if (assessment.confidence === "medium") {
      // MEDIUM: send to LLM
      possibleCode.push(makeCandidate(possibleCode.length, "possible-code", start, end, block.join("\n"), lines));
    }
    // UNKNOWN: skip — not code-like enough
    for (let j = start; j <= end; j += 1) occupied.add(j);
    index += 1;
  }

  return { possibleCode, fencedCode };
}

export function collectClippedCodeCandidates(content: string): FormattingCandidate[] {
  const lines = content.split("\n");
  return clippedCodeRegions(lines).map(({ start, end, language }, index) => ({
    ...makeCandidate(index, "possible-code", start, end, lines.slice(start, end + 1).join("\n"), lines),
    clippedLanguage: language
  }));
}

export function collectPossibleCodeCandidates(content: string): FormattingCandidate[] {
  return collectCodeCandidates(content).possibleCode;
}

export function collectFencedCodeCandidates(content: string): FormattingCandidate[] {
  return collectCodeCandidates(content).fencedCode;
}

/**
 * Fix the orphan bold triplet pattern:
 *   **\n**text**\n**  →  **text**
 * Common in clippings where bold-delimited headings get split across lines.
 */
export function normalizeOrphanBoldTriplet(content: string): string {
  return content.replace(
    /(^|\n)\*\*[ \t]*\n+(\*\*.+?\*\*)[ \t]*\n+\*\*[ \t]*(?=\n|$)/g,
    "$1$2"
  );
}

/**
 * Treat the article title as the implicit H1: anchor the first body heading at
 * H2, preserve relative depth, and close downward level gaps. Fenced code is
 * excluded because Markdown and shell examples commonly contain lines
 * beginning with #/## that are not document headings.
 */
export function normalizeBodyHeadingLevels(content: string): string {
  const lines = content.split("\n");
  const protectedLines = protectedLineIndices(protectedRanges(lines));
  const headings: Array<{ index: number; indent: string; markers: string }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (protectedLines.has(index)) continue;
    const match = /^(\s{0,3})(#{1,6})(?:[ \t]+|$)/.exec(line);
    if (match) headings.push({ index, indent: match[1], markers: match[2] });
  }

  if (headings.length === 0) return content;
  const shift = headings[0].markers.length - 2;
  let previousLevel = 1;
  for (const heading of headings) {
    const shiftedLevel = Math.max(2, Math.min(6, heading.markers.length - shift));
    const newLevel = Math.min(shiftedLevel, previousLevel + 1);
    const text = lines[heading.index].slice(heading.indent.length + heading.markers.length).trim();
    const title = stripHeadingNumberPrefix(text);
    lines[heading.index] = `${heading.indent}${"#".repeat(newLevel)} ${title || text}`.trimEnd();
    previousLevel = newLevel;
  }
  return lines.join("\n");
}

const HEADING_NUMBER_PREFIX = /(?:(?:\d+(?:\.\d+)*\\?[.．、)）](?![\d.])|[一二三四五六七八九十百]+[.．、)）]|第[\d一二三四五六七八九十百]+[章节篇][：:、. \t])[ \t]*)/;

export function stripHeadingNumberPrefix(text: string): string {
  return text.replace(new RegExp(`^(?:${HEADING_NUMBER_PREFIX.source})+`), "").trim();
}
