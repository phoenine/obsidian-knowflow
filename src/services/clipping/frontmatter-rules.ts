export interface FrontmatterUpdateData {
  title: string;
  today: string;
}

export interface SummaryFrontmatterData {
  description: string;
  readingValue: number;
  category: string;
  tags: string[];
}

const KNOWFLOW_FIELD_ORDER = [
  "创建日期",
  "简要描述",
  "阅读价值",
  "文章作者",
  "分类",
  "tags",
  "网址",
  "学习日期",
  "学习状态",
  "状态"
];

export function applyArticleFrontmatter(content: string, originalContent: string, templateContent: string, data: FrontmatterUpdateData): string {
  const body = stripFrontmatter(content).trim();
  const original = splitFrontmatter(originalContent);
  const template = splitFrontmatter(templateContent).frontmatter;
  let nextFrontmatter = original.frontmatter ?? "";
  nextFrontmatter = nextFrontmatter
    .replace(/^创建日期:[ \t]*["']?<%[^\n]*%>["']?[ \t]*$/m, `创建日期: ${data.today}`)
    .replace(/^学习日期:[ \t]*["']?<%[^\n]*%>["']?[ \t]*$/m, "学习日期:")
    .replace(/^阅读价值:[ \t]*["']?0["']?[ \t]*$/m, "阅读价值:");
  // Quote bare author handles produced by some clippers so the value stays valid YAML.
  nextFrontmatter = normalizeAuthorField(nextFrontmatter);
  const defaults: Record<string, string | string[]> = {
    创建日期: data.today,
    学习状态: ["", "  - 未学习"],
    状态: "true"
  };
  const keys = template === null ? KNOWFLOW_FIELD_ORDER : extractTopLevelKeys(template);
  for (const key of keys) {
    const templateValue = template === null ? undefined : getFieldBlock(template, key);
    const value = (key === "创建日期" || key === "学习日期") && typeof templateValue === "string"
      && /^["']?<%.*%>["']?$/.test(templateValue.trim())
      ? key === "创建日期" ? data.today : ""
      : templateValue ?? defaults[key] ?? "";
    nextFrontmatter = upsertFrontmatterField(nextFrontmatter, key, value, true);
  }

  return `---\n${nextFrontmatter.trim()}\n---\n\n${body}\n`;
}

/**
 * Writes only the supplied note properties. Other frontmatter fields and the
 * body stay untouched. Callers decide whether an existing value may be replaced.
 */
export function applySummaryFrontmatter(content: string, data: Partial<SummaryFrontmatterData>): string {
  const { description, readingValue, category, tags } = data;
  if (description === undefined && readingValue === undefined && category === undefined && tags === undefined) return content;
  const { frontmatter, body } = splitFrontmatter(content);
  let next = frontmatter ?? "";
  if (description !== undefined) {
    const text = description.replace(/\n/g, " ").trim().slice(0, 180);
    next = upsertFrontmatterField(next, "简要描述", text ? quoteYamlString(text) : "", false);
  }
  if (readingValue !== undefined) next = upsertFrontmatterField(next, "阅读价值", readingValue > 0 ? String(readingValue) : "", false);
  if (category !== undefined) next = upsertFrontmatterField(next, "分类", category, false);
  if (tags !== undefined) next = upsertFrontmatterField(next, "tags", formatTagsList(tags), false);
  return `---\n${next.trim()}\n---\n${body}`;
}

export function hasEmptyNoteProperties(frontmatter: string | null): boolean {
  return isEmptyDescription(frontmatter) || isEmptyReadingValue(frontmatter)
    || isEmptyCategory(frontmatter) || isEmptyTags(frontmatter);
}

/**
 * Fills 简要描述、阅读价值、分类 and tags.
 * During 整理, `replaceExisting` writes the new values over the old ones.
 * A completed pass with no 简要描述 clears that field. A missing proposal keeps it.
 * The other three stay when this pass has no new value.
 */
export function fillEmptyNoteProperties(
  content: string,
  proposal: Partial<SummaryFrontmatterData> | undefined,
  options?: { replaceExisting?: boolean }
): { content: string; filled: string[]; clearedDescription: boolean } {
  const frontmatter = splitFrontmatter(content).frontmatter;
  const data: Partial<SummaryFrontmatterData> = {};
  const filled: string[] = [];
  let clearedDescription = false;
  const replace = options?.replaceExisting === true;
  if (!proposal) return { content, filled, clearedDescription };
  if (replace) {
    if (proposal.description) {
      data.description = proposal.description;
      filled.push("简要描述");
    } else if (!isEmptyDescription(frontmatter)) {
      data.description = "";
      clearedDescription = true;
    }
  } else if (proposal.description && isEmptyDescription(frontmatter)) {
    data.description = proposal.description;
    filled.push("简要描述");
  }
  if (proposal.readingValue && (replace || isEmptyReadingValue(frontmatter))) {
    data.readingValue = proposal.readingValue;
    filled.push("阅读价值");
  }
  if (proposal.category && (replace || isEmptyCategory(frontmatter))) {
    data.category = proposal.category;
    filled.push("分类");
  }
  if (proposal.tags?.length && (replace || isEmptyTags(frontmatter))) {
    data.tags = proposal.tags;
    filled.push("标签");
  }
  return { content: filled.length || clearedDescription ? applySummaryFrontmatter(content, data) : content, filled, clearedDescription };
}

export function updateFrontmatterCategory(content: string, category: string): string {
  const parsed = splitFrontmatter(content);
  if (parsed.frontmatter === null) return content;
  const nextFrontmatter = upsertFrontmatterField(parsed.frontmatter, "分类", category, false);
  return `---\n${nextFrontmatter.trim()}\n---\n${parsed.body}`;
}

export function applyLearningCompletionFrontmatter(content: string, learningDate: string): string {
  const parsed = splitFrontmatter(content);
  let nextFrontmatter = parsed.frontmatter ?? "";
  nextFrontmatter = upsertFrontmatterField(nextFrontmatter, "学习日期", learningDate, false);
  nextFrontmatter = upsertFrontmatterField(nextFrontmatter, "学习状态", ["", "  - 已学习"], false);
  return `---\n${nextFrontmatter.trim()}\n---\n${parsed.body}`;
}

export function splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const normalized = content.replace(/\r\n/g, "\n");
  const open = /^(?:\uFEFF)?---[ \t]*\n/.exec(normalized);
  if (!open) return { frontmatter: null, body: normalized };
  const rest = normalized.slice(open[0].length);
  const close = /^---[ \t]*(?:\n|$)/m.exec(rest);
  if (!close) return { frontmatter: null, body: normalized };
  return {
    frontmatter: rest.slice(0, close.index).replace(/\n$/, ""),
    body: rest.slice(close.index + close[0].length)
  };
}

function stripFrontmatter(content: string): string {
  return splitFrontmatter(content).body;
}

/**
 * This module intentionally parses frontmatter with regex/line-scanning
 * instead of a real YAML library, so it can round-trip a file while only
 * touching the specific fields KnowFlow owns — preserving field order,
 * comments and non-standard Templater expressions (e.g.
 * `<% tp.date.now("YYYY-MM-DD") %>`) that a YAML parser would either choke
 * on or silently reformat away. The trade-off is that it only understands a
 * conventional subset of YAML:
 * - A top-level key must start at column 0 with no leading whitespace.
 * - Continuation/block-scalar lines belonging to a key must be indented
 *   (space or tab; both count as "not a new key" here).
 * - Duplicate top-level keys are not supported: only the first occurrence
 *   is read/updated, matching normal YAML semantics loosely but without
 *   validation.
 * - A key line's own value is treated as an opaque string; multi-line
 *   block scalars (`|`, `>`, ...) and inline flow values (`[a, b]`) are
 *   preserved verbatim rather than being parsed into structured data,
 *   except for the specific fields KnowFlow rewrites itself.
 */
function extractTopLevelKeys(frontmatter: string): string[] {
  return frontmatter
    .split("\n")
    .map((line) => /^([^:#\s][^:]*):(?:\s.*)?$/.exec(line)?.[1]?.trim())
    .filter((key): key is string => Boolean(key));
}

function upsertFrontmatterField(frontmatter: string, key: string, value: string | string[], appendOnly: boolean): string {
  const lines = frontmatter ? frontmatter.split("\n") : [];
  const range = findFieldRange(lines, key);
  const replacement = formatFrontmatterField(key, value);
  if (range && !appendOnly) {
    return [
      ...lines.slice(0, range.start),
      ...replacement,
      ...lines.slice(range.end)
    ].join("\n");
  }
  if (range) return frontmatter;
  return [...lines, ...replacement].filter((line, index) => line !== "" || index < lines.length).join("\n");
}

function findFieldRange(lines: string[], key: string): { start: number; end: number } | null {
  const start = lines.findIndex((line) => new RegExp(`^${escapeRegExp(key)}:\\s*`).test(line));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^[^:#\s][^:]*:\s*/.test(lines[end])) {
    end += 1;
  }
  return { start, end };
}

function isEmptyDescription(frontmatter: string | null): boolean {
  return isBlankScalar(frontmatter, "简要描述");
}

function isEmptyReadingValue(frontmatter: string | null): boolean {
  const value = scalarValue(frontmatter, "阅读价值");
  return !value || value === "0";
}

function isEmptyCategory(frontmatter: string | null): boolean {
  return isBlankScalar(frontmatter, "分类");
}

function isEmptyTags(frontmatter: string | null): boolean {
  const tags = tagTokens(frontmatter);
  return tags.length === 0 || tags.every((tag) => tag.toLowerCase() === "clippings");
}

function isBlankScalar(frontmatter: string | null, key: string): boolean {
  const value = scalarValue(frontmatter, key);
  return !value || /^<%.*%>$/.test(value);
}

function scalarValue(frontmatter: string | null, key: string): string {
  if (!frontmatter) return "";
  const value = getFieldBlock(frontmatter, key);
  const text = Array.isArray(value) ? value.join("\n") : value ?? "";
  return text.trim().replace(/^["']|["']$/g, "");
}

function tagTokens(frontmatter: string | null): string[] {
  if (!frontmatter) return [];
  const value = getFieldBlock(frontmatter, "tags");
  if (value === undefined) return [];
  const raw = Array.isArray(value) ? value.join("\n") : value;
  return raw.split(/[\n,\[\]]+/)
    .map((item) => item.replace(/^\s*-\s*/, "").trim().replace(/^#+/, "").replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function getFieldBlock(frontmatter: string, key: string): string | string[] | undefined {
  const lines = frontmatter.split("\n");
  const range = findFieldRange(lines, key);
  if (!range) return undefined;
  const [first, ...rest] = lines.slice(range.start, range.end);
  const value = first.replace(new RegExp(`^${escapeRegExp(key)}:\\s*`), "");
  return rest.length > 0 ? [value, ...rest] : value;
}

function formatFrontmatterField(key: string, value: string | string[]): string[] {
  if (Array.isArray(value)) {
    const [first = "", ...rest] = value;
    return [`${key}:${first ? ` ${first}` : ""}`, ...rest];
  }
  if (key === "tags" && !value.trim()) return ["tags:"];
  return [value.trim() ? `${key}: ${value}` : `${key}:`];
}

/**
 * Replaces the frontmatter `tags` list with the AI's topic tags every time
 * the pipeline runs, fully overriding the "clippings" placeholder the
 * template seeds new notes with — otherwise those AI-generated tags never
 * end up anywhere Obsidian's own tag search/graph view can see them.
 */
function formatTagsList(tags: string[]): string[] {
  const normalized = Array.from(new Set(tags.map(normalizeObsidianTag).filter(Boolean)));
  const list = normalized.length > 0 ? normalized : ["clippings"];
  return ["", ...list.map((tag) => `  - ${tag}`)];
}

function normalizeObsidianTag(value: string): string {
  return value.trim().replace(/^#+/, "").replace(/\s+/g, "-");
}

function quoteYamlString(value: string): string {
  return JSON.stringify(value);
}

function normalizeAuthorField(frontmatter: string): string {
  return frontmatter.replace(/^文章作者:[ \t]*(.*)$/m, (_line, raw: string) => {
    let value = raw.trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    const link = /^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]$/.exec(value.trim());
    if (link) value = (link[2] || link[1]).trim();
    if (!value) return "文章作者:";
    if (value.startsWith("@") || /[:#&*!|>%@`'"\\[\]]/.test(value)) return `文章作者: ${quoteYamlString(value)}`;
    return `文章作者: ${value}`;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
