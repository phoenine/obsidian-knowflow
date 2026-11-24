import { protectedLineIndices, protectedRanges } from "../../../src/services/clipping/protected-markdown";

const PROMPT_LABEL = /^(?:提示词(?:节选)?|(?:生图|绘图|生成|编辑)提示词|(?:image )?prompt(?: excerpt)?)\s*[：:]?$/i;
const RESULT_LABEL = /^(?:点评|效果展示|生成效果|生成结果|结果对比|测试结果|模型表现|成图(?:展示|对比)?|参考图|results?(?: comparison)?)[：:]?$/i;
const RESULT_CAPTION = /^(?:第[一二三四五六七八九十\d]+行|(?:上|下|左|右)图)\s*(?:左边|右边|从左|从右|依次|为|是|[:：])/;
const ENCODED_SPACE_LINE = /^(?:[ \t]|&#x(?:20|a0);|&#(?:32|160);|&nbsp;)+$/i;

export function formatPromptBlocks(content: string): {
  content: string;
  wrapped: number;
  existing: number;
  skipped: number;
  bodies: string[];
} {
  const lines = content.split("\n");
  const ranges = protectedRanges(lines);
  const protectedLines = protectedLineIndices(ranges);
  const edits: Array<{ start: number; end: number; replacement: string[] }> = [];
  const bodies: string[] = [];
  let wrapped = 0;
  let existing = 0;
  let skipped = 0;

  for (const { label, start, fence } of promptSections(lines, ranges, protectedLines)) {
    if (fence) {
      existing += 1;
      const body = lines.slice(fence.start + 1, fence.end);
      const language = lines[fence.start].trim().slice(fence.marker.length).trim();
      if (/^(?:text|plain|plaintext)?$/i.test(language)) {
        const prompt = unwrapLegacyTextFence(body);
        bodies.push(prompt.join("\n"));
        edits.push({ start: fence.start, end: fence.end + 1, replacement: textFence(prompt) });
      } else {
        bodies.push(body.join("\n"));
      }
      clearEncodedSeparators(label, start);
      continue;
    }

    let end = start;
    while (end < lines.length && !protectedLines.has(end) && !endsPrompt(lines[end])) end += 1;
    while (end > start && !lines[end - 1].trim()) end -= 1;
    if (start === end) {
      skipped += 1;
      continue;
    }
    const body = lines.slice(start, end);
    bodies.push(body.join("\n"));
    const replacement = textFence(body);
    if (start === label + 1) replacement.unshift("");
    if (lines[end]?.trim()) replacement.push("");
    clearEncodedSeparators(label, start);
    edits.push({ start, end, replacement });
    wrapped += 1;
  }

  for (const { start, end, replacement } of edits.reverse()) {
    lines.splice(start, end - start, ...replacement);
  }
  return { content: lines.join("\n"), wrapped, existing, skipped, bodies };

  function clearEncodedSeparators(label: number, start: number): void {
    for (let index = label + 1; index < start; index += 1) {
      if (lines[index].trim()) edits.push({ start: index, end: index + 1, replacement: [""] });
    }
  }
}

export function promptFenceStarts(lines: string[], ranges: ReturnType<typeof protectedRanges>): Set<number> {
  return new Set(promptSections(lines, ranges, protectedLineIndices(ranges))
    .flatMap(({ fence }) => fence ? [fence.start] : []));
}

function promptSections(lines: string[], ranges: ReturnType<typeof protectedRanges>, protectedLines: Set<number>) {
  const fences = new Map(ranges.filter(({ closed, marker }) => closed && /^[`~]/.test(marker)).map((range) => [range.start, range]));
  return lines.flatMap((line, label) => {
    if (protectedLines.has(label) || /^(?: {4}|\t)/.test(line) || !PROMPT_LABEL.test(labelText(line))) return [];
    let start = label + 1;
    while (start < lines.length && (!lines[start].trim() || ENCODED_SPACE_LINE.test(lines[start]))) start += 1;
    return [{ label, start, fence: fences.get(start) }];
  });
}

function labelText(line: string): string {
  return line.trim()
    .replace(/^#{1,6}[ \t]+/, "")
    .replace(/^\d+(?:\.\d+)*\.?[ \t]+/, "")
    .replace(/[：:][ \t]*$/, "")
    .replace(/^\*\*(.*)\*\*$/, "$1")
    .replace(/^【(.*)】$/, "$1")
    .trim();
}

function endsPrompt(line: string): boolean {
  const content = line.trim();
  const label = labelText(content);
  return /^(?:#{1,6}\s|!\[|\[!\[|>|<!--|(?:---|\*\*\*|___)[ \t]*$|<img\b)/i.test(content)
    || PROMPT_LABEL.test(label) || RESULT_LABEL.test(label) || RESULT_CAPTION.test(label);
}

function textFence(lines: string[]): string[] {
  const markerLength = lines.reduce((length, line) => {
    const run = /^ {0,3}(`{3,})/.exec(line)?.[1].length ?? 0;
    return Math.max(length, run + 1);
  }, 3);
  const marker = "`".repeat(markerLength);
  return [`${marker}text`, ...lines, marker];
}

function unwrapLegacyTextFence(body: string[]): string[] {
  let start = 0;
  let end = body.length;
  while (start < end && (!body[start].trim() || ENCODED_SPACE_LINE.test(body[start]))) start += 1;
  while (end > start && (!body[end - 1].trim() || ENCODED_SPACE_LINE.test(body[end - 1]))) end -= 1;
  if (!/^ {0,3}~{3,}text[ \t]*$/i.test(body[start] ?? "")) return body;
  const [fence] = protectedRanges(body.slice(start, end));
  return fence?.closed && fence.end === end - start - 1 ? body.slice(start + 1, end - 1) : body;
}
