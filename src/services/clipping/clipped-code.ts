import { protectedLineIndices, protectedRanges } from "./protected-markdown";

const CLIPPED_MARKER = /^ {0,3}\.{3}(python|bash|sh|shell|yaml|yml|json|markdown|md|text|javascript|typescript|js|ts|sql|html|css)\s*$/i;

export function clippedCodeRegions(lines: string[]): Array<{ start: number; end: number; language: string }> {
  const protectedLines = protectedLineIndices(protectedRanges(lines));
  const regions: Array<{ start: number; end: number; language: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (protectedLines.has(index)) continue;
    const marker = CLIPPED_MARKER.exec(lines[index]);
    if (!marker) continue;
    let end = index + 1;
    while (end < lines.length && !protectedLines.has(end)
      && !CLIPPED_MARKER.test(lines[end]) && !/^ {0,3}(?:#{2,6}\s|!\[|>)/.test(lines[end])) end += 1;
    if (lines.slice(index + 1, end).some((line) => line.trim())) {
      regions.push({ start: index, end: end - 1, language: marker[1].toLowerCase() });
    }
    index = end - 1;
  }
  return regions;
}

export function restoreClippedFence(body: string, language: string): string {
  const lines = body.split("\n");
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const restored = lines.map((line) => {
    if (language === "text") return line;
    const unescaped = line.replace(/\\([\\`*_\[\]#])/g, "$1");
    return language === "markdown" || language === "md" ? unescaped
      : unescaped.replace(/^　+/, (indent) => "  ".repeat(indent.length));
  });
  const maxFence = restored.reduce((max, line) => Math.max(max, /^ {0,3}(`+)/.exec(line)?.[1].length ?? 0), 2);
  const fence = "`".repeat(maxFence + 1);
  return [`${fence}${language}`, ...restored, fence].join("\n");
}

/**
 * WeChat and similar clippers insert one blank line between every line of a
 * code block, and the same rhythm inside a Python triple-quoted template.
 * Prompt paragraphs in a `text` fence stay separated.
 */
export function removeClipperFenceSpacing(body: string, language: string): string {
  const lang = language.trim().toLowerCase();
  if (!lang || lang === "text" || lang === "plain") {
    return isPromptProse(body) ? body : removeUniformClipperBlanks(body);
  }
  const source = lang === "python" || lang === "py" ? compactPythonStringSpacing(body) : body;
  if (lang === "python" || lang === "py") return removePythonClipperSpacing(source);
  return removeUniformClipperBlanks(source);
}

function isPromptProse(body: string): boolean {
  const lines = body.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length < 3) return true;
  const prose = lines.filter((line) => /[。！？.!?]$/.test(line) || /[\u3400-\u9fff]/.test(line) && line.length > 24).length;
  return prose / lines.length >= 0.5;
}

function removeUniformClipperBlanks(body: string): string {
  const lines = body.split("\n");
  const removed = new Set(clipperBlankGaps(lines).map(({ previous }) => previous + 1));
  if (removed.size === 0) return body;
  return lines.filter((_line, index) => !removed.has(index)).join("\n");
}

function compactPythonStringSpacing(body: string): string {
  const lines = body.split("\n");
  const removed = new Set<number>();
  for (const range of pythonTripleQuoteRanges(lines)) {
    const slice = lines.slice(range.start, range.end + 1);
    for (const gap of clipperBlankGaps(slice)) removed.add(range.start + gap.previous + 1);
  }
  if (removed.size === 0) return body;
  return lines.filter((_line, index) => !removed.has(index)).join("\n");
}

function pythonTripleQuoteRanges(lines: string[]): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const token = /"""|'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#.*/g;
  let quote: string | undefined;
  let start = -1;
  for (const [index, line] of lines.entries()) {
    let offset = 0;
    while (offset < line.length || quote) {
      if (quote) {
        const closing = new RegExp(`${quote}|\\\\.`, "g");
        closing.lastIndex = offset;
        let match = closing.exec(line);
        while (match && match[0] !== quote) match = closing.exec(line);
        if (!match) break;
        offset = closing.lastIndex;
        ranges.push({ start, end: index });
        quote = undefined;
        start = -1;
      } else {
        token.lastIndex = offset;
        const match = token.exec(line);
        if (!match || match[0][0] === "#") break;
        offset = token.lastIndex;
        if (match[0] === '"""' || match[0] === "'''") {
          quote = match[0];
          start = index;
        }
      }
    }
  }
  return ranges.filter((range) => range.end > range.start);
}

/** Some clippers emit one empty paragraph between every source-code line. */
export function removePythonClipperSpacing(body: string): string {
  const lines = body.split("\n");
  // A backslash can continue a quoted string or an expression onto the next line.
  if (lines.some((line) => /\\[ \t]*$/.test(line))) return body;

  const literalLines = pythonMultilineStringLines(lines);
  const removed = new Set<number>();
  for (const { previous, next } of clipperBlankGaps(lines, literalLines)) {
    if (literalLines.has(previous + 1)) continue;
    const declaration = /^(?:class |(?:async )?def |@)/.test(lines[next]);
    if (declaration && next === previous + 2 && !/^@/.test(lines[previous])) continue;
    removed.add(previous + 1);
  }
  return lines.filter((_line, index) => !removed.has(index)).join("\n");
}

export function repairClippedYaml(body: string, parseYaml: (source: string) => unknown): string {
  const parse = (source: string): string | undefined => {
    try {
      return JSON.stringify(parseYaml(source));
    } catch {
      return undefined;
    }
  };

  let source = body;
  let parsed = parse(body);
  if (parsed === undefined) {
    const repaired = body.replace(/^( *[A-Za-z_][\w.-]*):((?:\.\.?\/|\/)[^\s#]+)(?=[ \t]*(?:#|$))/gm, "$1: $2");
    if (repaired === body) return body;
    parsed = parse(repaired);
    if (parsed === undefined) return body;
    source = repaired;
  }

  const lines = source.split("\n");
  const removed = new Set(clipperBlankGaps(lines).map(({ previous }) => previous + 1));
  if (removed.size === 0) return source;
  const compact = lines.filter((_line, index) => !removed.has(index)).join("\n");
  return parse(compact) === parsed ? compact : source;
}

function clipperBlankGaps(lines: string[], protectedLines = new Set<number>()): Array<{ previous: number; next: number }> {
  const nonBlank = lines.map((line, index) => line.trim() ? index : -1).filter((index) => index >= 0);
  const gaps = nonBlank.slice(1).flatMap((next, index) => {
    const previous = nonBlank[index];
    return protectedLines.has(previous) && protectedLines.has(next) ? [] : [{ previous, next }];
  });
  if (gaps.length < 3 || gaps.some(({ previous, next }) => next === previous + 1)
    || gaps.filter(({ previous, next }) => next === previous + 2).length < gaps.length * 0.8) return [];
  return gaps;
}

function pythonMultilineStringLines(lines: string[]): Set<number> {
  const protectedLines = new Set<number>();
  const token = /"""|'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#.*/g;
  let quote: string | undefined;
  for (const [index, line] of lines.entries()) {
    let offset = 0;
    while (offset < line.length || quote) {
      if (quote) {
        protectedLines.add(index);
        const closing = new RegExp(`${quote}|\\\\.`, "g");
        closing.lastIndex = offset;
        let match = closing.exec(line);
        while (match && match[0] !== quote) match = closing.exec(line);
        if (!match) break;
        offset = closing.lastIndex;
        quote = undefined;
      } else {
        token.lastIndex = offset;
        const match = token.exec(line);
        if (!match || match[0][0] === "#") break;
        offset = token.lastIndex;
        if (match[0] === '"""' || match[0] === "'''") quote = match[0];
      }
    }
  }
  return protectedLines;
}

export function prettyJsonBlock(body: string, language: string): string {
  if (language.toLowerCase() !== "json" || body.includes("\n")) return body;
  const trimmed = body.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return body;
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (value === null || typeof value !== "object") return body;
    return JSON.stringify(value, null, 2);
  } catch {
    return body;
  }
}
