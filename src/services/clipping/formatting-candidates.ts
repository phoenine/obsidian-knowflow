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
import { promptFenceStarts } from "./prompt-blocks";
import { protectedLineIndices, protectedRanges } from "./protected-markdown";
import { clippedCodeRegions, restoreClippedFence } from "./clipped-code";

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
  decisions: FormattingDecision[],
  /**
   * `trustReformat`: the user confirmed each reformat in a preview, so the
   * character-level check is skipped. Only the structural checks remain.
   */
  options: { trustReformat?: boolean } = {}
): { content: string; applied: number; rejectedReformats: number } {
  const lines = content.split("\n");
  let rejectedReformats = 0;
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
        // Only blocks the program flagged as collapsed may be rewritten. The prompt says so, but the
        // model is not trusted to follow it: a normal block must never be rewritten.
        if (!candidate.needsReformat) continue;
        const language = resolveFenceLanguage(decision.language, candidate);
        const body = typeof decision.content === "string" ? trimCodeFenceBody(decision.content) : "";
        const safe = options.trustReformat || isSafeAutomaticReformat(candidate, body, language);
        if (!language || !body || /```/.test(body) || !safe || introducesRestrictedBreak(candidate.content, body)) {
          rejectedReformats += 1;
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

  return { content: lines.join("\n"), applied, rejectedReformats };
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

/** Check the content of a reformat before showing it for confirmation in chat. */
export function isSafeCodeReformat(candidate: FormattingCandidate, formatted: string): boolean {
  const source = trimCodeFenceBody(candidate.content);
  if (source === formatted) return true;
  return sameCodeTokens(source, formatted) && sameStringLiterals(source, formatted);
}

function isSafeAutomaticReformat(candidate: FormattingCandidate, formatted: string, language: string): boolean {
  const source = trimCodeFenceBody(candidate.content);
  if (source === formatted) return true;
  if (/^(?:sh|bash|shell|zsh)$/.test(language)) {
    if (/<<|\n/.test(source)) return false;
    const tokens = /"(?:\\.|[^"\\])*"?|'[^']*'?|`(?:\\.|[^`\\])*\x60?|(?:^|[ \t])#[^\n]*|(?<continuation>\\[ \t]{2,})(?=--[a-zA-Z])|\\./gm;
    return source.replace(tokens, (token, continuation: string | undefined) => continuation ? "\\\n  " : token) === formatted;
  }
  // For indentation-sensitive code, only restore line breaks that map back to
  // visible indentation in the flattened original. Preserve all intact lines.
  if (!PYTHON_LABELS.has(language) || /"""|'''/.test(source) || !isSafeCodeReformat(candidate, formatted)) return false;
  const output = formatted.split("\n");
  let index = 0;
  for (const line of source.split("\n")) {
    const first = output[index++];
    if (line === first) continue;
    if (!first || !line.startsWith(first)
      || !/(?:\b(?:def|class|if|elif|else|for|while|try|except|finally|with)\b|^from [\w.]+ import \w+def )[^\n]*?: {4,}\S/.test(line)) return false;
    let remaining = line.slice(first.length);
    let previous = first;
    let hasJoinedStatements = false;
    while (remaining) {
      let next = output[index++];
      while (next === "") next = output[index++];
      if (!next) return false;
      if (remaining.startsWith(next) && /^ {4,}\S/.test(next)
        && !/[=+\-*/%&|^~!<>.\\]$/.test(previous.trimEnd())
        && !RESTRICTED_LINE_END.test(previous.trimEnd())) {
        const statement = next.trimStart();
        if (/:$/.test(previous) && /^(?:def|class|if|for|while|try|with)\b.*:$/.test(statement)) {
          hasJoinedStatements = true;
        } else if (!/[:(\[,\s]$/.test(previous) && /^(?:return|raise|else|elif|except|finally)\b|^(?!(?:and|or|not|if|in|is)\b)[A-Za-z_]\w*\(/.test(statement)) {
          hasJoinedStatements = true;
        }
        remaining = remaining.slice(next.length);
      } else if (/^from [\w.]+ import \w+$/.test(previous) && /^(?:async )?def \w+\(/.test(next) && remaining.startsWith(next)) {
        hasJoinedStatements = true;
        remaining = remaining.slice(next.length);
      } else {
        return false;
      }
      previous = next;
    }
    if (!hasJoinedStatements) return false;
  }
  return index === output.length;
}

const RESTRICTED_LINE_END = /\b(?:return|throw|yield|break|continue)$/;

/**
 * A line break right after `return`, `throw`, `yield`, `break` or `continue` can change what the code does
 * (automatic semicolon insertion makes `return` + newline + `1` return undefined). Token comparison ignores
 * whitespace, so this is checked separately. Breaks that already exist in the source are allowed.
 */
export function introducesRestrictedBreak(source: string, formatted: string): boolean {
  const original = new Set(trimCodeFenceBody(source).split("\n").map((line) => line.trim()));
  const lines = trimCodeFenceBody(formatted).split("\n");
  return lines.some((line, index) => {
    const text = line.trim();
    return index < lines.length - 1 && RESTRICTED_LINE_END.test(text) && !original.has(text);
  });
}

/** Comment-only change check: the code must be the same once `//` and `# ` comments are ignored. */
export function sameCodeIgnoringComments(source: string, formatted: string): boolean {
  const strip = (text: string) => trimCodeFenceBody(text).split("\n").map(codePart).join("\n");
  return sameCodeTokens(strip(source), strip(formatted));
}

export function sameCodeTokens(source: string, formatted: string): boolean {
  return comparableTokens(source) === comparableTokens(formatted);
}

function comparableTokens(text: string): string {
  return text.replace(/\s/g, "");
}

function sameStringLiterals(source: string, formatted: string): boolean {
  const literals = (text: string) => [...text.matchAll(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g)].map((match) => match[0]);
  const left = literals(source);
  const right = literals(formatted);
  return left.length === right.length && left.every((literal, index) => literal === right[index]);
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
  if (lines.some(isFlattenedLine)) return true;
  if (lines.map(codePart).some((line) => line.length > 160 && (line.match(/;/g)?.length ?? 0) >= 3)) return true;
  // Substantial single-line JSON/YAML object
  if (lines.length === 1 && lines[0].length > 100 && /^\s*[{[]/.test(lines[0])) return true;
  return false;
}

/**
 * A line the clipper joined without newlines. Indentation survives only as runs of spaces and statements
 * are glued together, which ordinary code never does. Python has no `;` or braces to give it away, so the
 * signals are structural rather than keyword based.
 */
/** The code on a line without a trailing `//` or `# ` comment. Comments may be long; the code must not be. */
function codePart(line: string): string {
  return line.replace(/(^|\s)(\/\/|#\s).*$/, "$1");
}

function isFlattenedLine(line: string): boolean {
  // The whole line, comments included: a clipper that glued code onto a `# ...` comment still flattened it.
  const text = line.trim();
  // A block opener followed by an indentation run on the same line: `def f(x):    return x`, `(    step`.
  if (text.length >= 40 && (/[{(\[;]\s{4,}\S/.test(text) || /[)\]]\s*:\s{4,}\S/.test(text)
    || /\b(?:else|try|finally)\s*:\s{4,}\S/.test(text))) return true;
  if (text.length >= 60 && /,\s{4,}\S/.test(text)) return true;
  // Aligned columns merged onto one line.
  if (text.length > 80 && /\S {4,}\S/.test(text)) return true;
  // Statements glued together: `f(x)TWO = ...`, `xONE = ...`, `values):` followed by `def`, a comment stuck to `)`.
  if (/[)\]}][A-Za-z_]\w*\s=\s/.test(text)) return true;
  if ((text.match(/\s=\s/g) ?? []).length >= 2 && /[a-z0-9_][A-Z][A-Z0-9_]{1,}\s=\s/.test(text)) return true;
  if (!/\b(?:typedef|undef|subclass)\b/.test(text) && /\w(?:def|class)\s+\w+\s*[(:]/.test(text)) return true;
  return /[)\]}]#\s/.test(text);
}

const PYTHON_LABELS = new Set(["python", "py", "python3", "py3", "ipython", "pycon", "cython"]);

/**
 * The clipper labels fences by auto-detection, and short Python often comes back as perl, ruby or css.
 * Only constructs that exist in Python alone count as a contradiction; anything less is left to the label.
 */
export function contradictsPythonLabel(body: string, language: string): boolean {
  const label = language.trim().toLowerCase();
  if (!label || PYTHON_LABELS.has(label) || isUnsetFenceLanguage(label)) return false;
  return /\bdef\s+\w+\s*\([^)\n]*\)\s*(?:->\s*[^:\n]+)?:/.test(body)
    || /\blambda\s+[\w*][\w\s,*=]*:/.test(body)
    || /^\s*from\s+[\w.]+\s+import\s+\w/m.test(body);
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
  const wrongLabel = contradictsPythonLabel(body, fenceLanguage);
  if (!needsLang && !needsFmt && !hasNumberPrefixes && !wrongLabel) return null;

  const candidate = makeCandidate(index, "fenced-code", startLine, endLine, body, lines);
  if (fenceLanguage) candidate.fenceLanguage = fenceLanguage;
  if (wrongLabel) candidate.autoLanguage = "python";
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

/**
 * Every closed fenced block in document order, without the automatic filter.
 * Used when the user explicitly asks to format specific blocks in chat.
 */
export function collectFencedBlocks(content: string): FormattingCandidate[] {
  const lines = content.split("\n");
  const ranges = protectedRanges(lines);
  const prompts = promptFenceStarts(lines, ranges);
  const blocks: FormattingCandidate[] = [];
  for (const { start, end, marker, closed } of ranges) {
    if (prompts.has(start) || !closed || marker !== "```" || !lines[start].startsWith(marker) || lines[end] !== marker) continue;
    const body = lines.slice(start + 1, end).join("\n");
    if (!body.trim()) continue;
    const language = lines[start].slice(marker.length).trim();
    const candidate = makeCandidate(blocks.length, "fenced-code", start, end, body, lines);
    blocks.push({
      ...candidate,
      id: `fence-${blocks.length + 1}`,
      needsReformat: true,
      ...(language ? { fenceLanguage: language } : {})
    });
  }
  return blocks;
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

const PUNCTUATION = /[\p{P}\p{S}]/u;

/**
 * CommonMark only closes `**` when it is right-flanking: a closing run preceded
 * by punctuation must be followed by whitespace or punctuation (and mirrored for
 * opening). Clippings often contain `**标题：**正文`, which therefore never
 * renders as bold. This is also what Obsidian's bold hotkey produces when text is
 * typed right after the selection, so it is a common source of broken bold.
 *
 * Fix: insert one space on the side that is broken, keeping the bold span and
 * its punctuation intact:
 *   **标题：**正文     → **标题：** 正文
 *   文字**“引号”**后面 → 文字 **“引号”** 后面
 */
export function repairBoldFlankingLine(line: string): string {
  if (!line.includes("**")) return line;
  const parts: Array<{ text: string; literal: boolean }> = [];
  let last = 0;
  for (const match of line.matchAll(INLINE_LITERAL)) {
    const start = match.index ?? 0;
    if (start > last) parts.push({ text: line.slice(last, start), literal: false });
    parts.push({ text: match[0], literal: true });
    last = start + match[0].length;
  }
  if (last < line.length) parts.push({ text: line.slice(last), literal: false });
  // A bold span never crosses a literal, but the character next to a literal still decides flanking.
  return parts.map((part, index) => {
    if (part.literal) return part.text;
    const previous = parts[index - 1];
    const next = parts[index + 1];
    return repairBoldFlankingText(part.text, previous?.text.at(-1), next?.text[0]);
  }).join("");
}

/**
 * Text that must stay byte-for-byte: it is not prose, so `**` inside it is not bold.
 * Inline code (backtick runs of equal length), link/image targets, wikilinks, HTML tags,
 * bare URLs and inline math.
 */
const INLINE_LITERAL = new RegExp([
  "(?<!`)(`+)(?!`)[^\\n]*?(?<!`)\\1(?!`)",
  "\\]\\((?:[^()\\n]|\\([^()\\n]*\\))*\\)",
  "\\[\\[[^\\]\\n]*\\]\\]",
  "<[A-Za-z/][^>\\n]*>",
  "https?:\\/\\/[^\\s<>]+",
  "\\$[^$\\n]+\\$"
].join("|"), "g");

function repairBoldFlankingText(text: string, outerBefore?: string, outerAfter?: string): string {
  return text.replace(/\*\*([^*\n]+?)\*\*/g, (match: string, inner: string, offset: number) => {
    const before = offset > 0 ? text[offset - 1] : outerBefore;
    const after = offset + match.length < text.length ? text[offset + match.length] : outerAfter;
    if (before === "*" || after === "*") return match;
    if (/^\s|\s$/.test(inner)) return match;
    const needsOpenFix = before !== undefined && !/\s/.test(before) && !PUNCTUATION.test(before) && PUNCTUATION.test(inner[0]);
    const needsCloseFix = after !== undefined && !/\s/.test(after) && !PUNCTUATION.test(after) && PUNCTUATION.test(inner[inner.length - 1]);
    if (!needsOpenFix && !needsCloseFix) return match;
    const opening = needsOpenFix ? " " : "";
    const closing = needsCloseFix ? " " : "";
    return `${opening}**${inner}**${closing}`;
  });
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
