import type { KnowledgePoint, KnowledgePointGroup, KnowledgePointType } from "../types";

const KNOWLEDGE_BLOCK_START = "<!-- knowflow:knowledge-points:start -->";
const KNOWLEDGE_BLOCK_END = "<!-- knowflow:knowledge-points:end -->";
const KNOWLEDGE_TYPES = new Set<KnowledgePointType>(["概念", "机制", "对比", "流程", "原则", "实践"]);

export function buildKnowledgePointsBlock(groups: KnowledgePointGroup[]): string {
  const body = groups.flatMap((group) => [
    `### ${cleanInline(group.title)}`,
    "",
    ...group.points.flatMap((point) => [renderKnowledgePoint(point), ""])
  ]);
  return [
    KNOWLEDGE_BLOCK_START,
    "",
    "## 知识点",
    "",
    ...body,
    KNOWLEDGE_BLOCK_END
  ].join("\n").replace(/\n{3,}/g, "\n\n");
}

export function upsertKnowledgePoints(content: string, groups: KnowledgePointGroup[]): string {
  const normalized = content.replace(/\r\n/g, "\n");
  const block = buildKnowledgePointsBlock(groups);
  const range = findManagedRange(normalized);
  if (range) {
    return `${normalized.slice(0, range.start).trimEnd()}\n\n${block}\n\n${normalized.slice(range.end).trimStart()}`.trimEnd() + "\n";
  }

  const quizStart = normalized.indexOf("<!-- study-quiz:start -->");
  if (quizStart >= 0) {
    return `${normalized.slice(0, quizStart).trimEnd()}\n\n${block}\n\n${normalized.slice(quizStart).trimStart()}`.trimEnd() + "\n";
  }

  const frontmatter = /^---\n[\s\S]*?\n---\n?/.exec(normalized);
  const insertAt = frontmatter ? frontmatter[0].length : 0;
  return `${normalized.slice(0, insertAt).trimEnd()}\n\n${block}\n\n${normalized.slice(insertAt).trimStart()}`.trimEnd() + "\n";
}

export function parseKnowledgePoints(content: string): KnowledgePointGroup[] {
  const normalized = content.replace(/\r\n/g, "\n");
  const range = findManagedRange(normalized);
  if (!range) return [];
  const body = normalized.slice(range.start + KNOWLEDGE_BLOCK_START.length, range.end - KNOWLEDGE_BLOCK_END.length);
  const groups: KnowledgePointGroup[] = [];
  let current: KnowledgePointGroup | null = null;
  const lines = body.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const groupMatch = /^###\s+(.+?)\s*$/.exec(lines[index]);
    if (groupMatch) {
      current = { title: groupMatch[1].trim(), points: [] };
      groups.push(current);
      continue;
    }
    if (!/^> \[!note\][+-]?\s+/.test(lines[index])) continue;
    const block: string[] = [];
    while (index < lines.length && lines[index].startsWith(">")) {
      block.push(lines[index].replace(/^> ?/, ""));
      index += 1;
    }
    index -= 1;
    const point = parseKnowledgePoint(block);
    if (!point) continue;
    if (!current) {
      current = { title: "核心知识点", points: [] };
      groups.push(current);
    }
    current.points.push(point);
  }

  return groups.filter((group) => group.points.length > 0);
}

/** Keeps user-edited points with the same stable ID and only adds newly generated points. */
export function mergeKnowledgePointGroups(
  existingGroups: KnowledgePointGroup[],
  generatedGroups: KnowledgePointGroup[]
): KnowledgePointGroup[] {
  const existingById = new Map(existingGroups.flatMap((group) => group.points).map((point) => [point.id, point]));
  const generatedIds = new Set(generatedGroups.flatMap((group) => group.points).map((point) => point.id));
  const merged = generatedGroups.map((group) => ({
    title: group.title,
    points: group.points.map((point) => existingById.get(point.id) ?? point)
  }));
  for (const group of existingGroups) {
    const preserved = group.points.filter((point) => !generatedIds.has(point.id));
    if (preserved.length === 0) continue;
    const target = merged.find((candidate) => candidate.title === group.title);
    if (target) target.points.push(...preserved);
    else merged.push({ title: group.title, points: preserved });
  }
  return merged;
}

export function normalizeKnowledgePointGroups(value: unknown): KnowledgePointGroup[] {
  const rawGroups = isRecord(value) && Array.isArray(value.groups) ? value.groups : [];
  const usedIds = new Set<string>();
  return rawGroups.flatMap((rawGroup, groupIndex): KnowledgePointGroup[] => {
    if (!isRecord(rawGroup) || !Array.isArray(rawGroup.points)) return [];
    const groupTitle = cleanInline(rawGroup.title) || `知识分组 ${groupIndex + 1}`;
    const points = rawGroup.points.flatMap((rawPoint, pointIndex): KnowledgePoint[] => {
      if (!isRecord(rawPoint)) return [];
      const title = cleanInline(rawPoint.title);
      const explanation = cleanText(rawPoint.explanation);
      const question = cleanText(rawPoint.question);
      const evidence = isRecord(rawPoint.evidence) ? rawPoint.evidence : {};
      const section = cleanInline(evidence.section);
      const excerpt = cleanText(evidence.excerpt);
      if (!title || !explanation || !question || !section || !excerpt) return [];
      const type = KNOWLEDGE_TYPES.has(rawPoint.type as KnowledgePointType)
        ? rawPoint.type as KnowledgePointType
        : "概念";
      const id = uniqueKnowledgePointId(rawPoint.slug, title, groupIndex, pointIndex, usedIds);
      const relations = isRecord(rawPoint.relations) ? rawPoint.relations : {};
      return [{
        id,
        title,
        type,
        explanation,
        evidence: { section, excerpt },
        question,
        relations: {
          dependsOn: normalizeRelationIds(relations.dependsOn),
          extends: normalizeRelationIds(relations.extends)
        }
      }];
    });
    return points.length > 0 ? [{ title: groupTitle, points }] : [];
  });
}

function renderKnowledgePoint(point: KnowledgePoint): string {
  const lines = [
    `[!note]- ${cleanInline(point.title)}`,
    `**类型**：${point.type}`,
    "",
    "**核心解释**",
    "",
    ...quoteText(point.explanation),
    "",
    `**原文依据**：${cleanInline(point.evidence.section)}`,
    "",
    ...quoteText(point.evidence.excerpt).map((line) => `> ${line}`),
    "",
    "**检验问题**",
    "",
    ...quoteText(point.question)
  ];
  if (point.relations.dependsOn.length > 0) {
    lines.push("", `**依赖**：${point.relations.dependsOn.map((id) => `\`${id}\``).join("、")}`);
  }
  if (point.relations.extends.length > 0) {
    lines.push("", `**扩展**：${point.relations.extends.map((id) => `\`${id}\``).join("、")}`);
  }
  lines.push("", `^${point.id}`);
  return lines.map((line) => `> ${line}`).join("\n");
}

function parseKnowledgePoint(lines: string[]): KnowledgePoint | null {
  const title = /^\[!note\][+-]?\s+(.+)$/.exec(lines[0])?.[1]?.trim() ?? "";
  const typeValue = /^\*\*类型\*\*[：:]\s*(.+)$/m.exec(lines.join("\n"))?.[1]?.trim() ?? "概念";
  const type = KNOWLEDGE_TYPES.has(typeValue as KnowledgePointType) ? typeValue as KnowledgePointType : "概念";
  const sourceIndex = lines.findIndex((line) => /^\*\*原文依据\*\*[：:]/.test(line));
  const explanationIndex = lines.findIndex((line) => line === "**核心解释**");
  const questionIndex = lines.findIndex((line) => line === "**检验问题**");
  const relationIndex = lines.findIndex((line) => /^\*\*(?:依赖|扩展)\*\*[：:]/.test(line));
  const id = lines.map((line) => /^\^([A-Za-z0-9-]+)$/.exec(line)?.[1]).find(Boolean) ?? "";
  if (!title || !id || explanationIndex < 0 || sourceIndex < 0 || questionIndex < 0) return null;
  const explanation = cleanParsedLines(lines.slice(explanationIndex + 1, sourceIndex));
  const section = lines[sourceIndex].replace(/^\*\*原文依据\*\*[：:]\s*/, "").trim();
  const excerpt = cleanParsedLines(lines.slice(sourceIndex + 1, questionIndex).map((line) => line.replace(/^> ?/, "")));
  const questionEnd = relationIndex >= 0 ? relationIndex : lines.findIndex((line) => /^\^/.test(line));
  const question = cleanParsedLines(lines.slice(questionIndex + 1, questionEnd >= 0 ? questionEnd : lines.length));
  if (!explanation || !section || !excerpt || !question) return null;
  return {
    id,
    title,
    type,
    explanation,
    evidence: { section, excerpt },
    question,
    relations: {
      dependsOn: parseRelations(lines, "依赖"),
      extends: parseRelations(lines, "扩展")
    }
  };
}

function findManagedRange(content: string): { start: number; end: number } | null {
  const start = content.indexOf(KNOWLEDGE_BLOCK_START);
  const markerEnd = content.indexOf(KNOWLEDGE_BLOCK_END);
  if (start < 0 || markerEnd < start) return null;
  return { start, end: markerEnd + KNOWLEDGE_BLOCK_END.length };
}

function parseRelations(lines: string[], label: string): string[] {
  const line = lines.find((candidate) => new RegExp(`^\\*\\*${label}\\*\\*[：:]`).test(candidate));
  return line ? Array.from(line.matchAll(/`([A-Za-z0-9-]+)`/g), (match) => match[1]) : [];
}

function normalizeRelationIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => normalizeId(item)).filter(Boolean)))
    .map((id) => id.startsWith("kf-kp-") ? id : `kf-kp-${id}`);
}

function uniqueKnowledgePointId(
  slug: unknown,
  title: string,
  groupIndex: number,
  pointIndex: number,
  usedIds: Set<string>
): string {
  const normalizedSlug = normalizeId(slug);
  const base = normalizedSlug || `kf-kp-${stableHash(`${groupIndex}:${pointIndex}:${title}`)}`;
  const prefixed = base.startsWith("kf-kp-") ? base : `kf-kp-${base}`;
  let id = prefixed;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${prefixed}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(id);
  return id;
}

function normalizeId(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/^\^/, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56);
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function quoteText(value: string): string[] {
  return cleanText(value).split("\n");
}

function cleanParsedLines(lines: string[]): string {
  return lines.join("\n").replace(/^\s+|\s+$/g, "").replace(/\n{3,}/g, "\n\n");
}

function cleanInline(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim() : "";
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
