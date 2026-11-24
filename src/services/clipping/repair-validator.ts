import { parseYaml } from "obsidian";
import type { App } from "obsidian";
import { protectedLineIndices, protectedRanges } from "./protected-markdown";
import { splitFrontmatter } from "./frontmatter-rules";
import { stripFrontmatter } from "./managed-content";

/**
 * Basic markdown structure validation. Returns { valid: false, error }
 * on the first problem found, or { valid: true } on success.
 */
export function validateMarkdownIntegrity(content: string): { valid: boolean; error?: string } {
  const open = protectedRanges(stripFrontmatter(content).split("\n")).find((range) => !range.closed);
  if (open) return { valid: false, error: `Unclosed Markdown block ${open.marker} at line ${open.start + 1}` };
  return { valid: true };
}

export function inspectClippingOutput(app: App, path: string, original: string, result: string, restoredImages?: Set<string>): string[] {
  const { frontmatter, body } = splitFrontmatter(result);
  let properties: unknown;
  try {
    properties = frontmatter === null ? null : parseYaml(frontmatter);
  } catch {
    throw new Error("Frontmatter 无法解析为 YAML，原文已保留。");
  }
  if (frontmatter === null || (frontmatter.trim() && (!properties || typeof properties !== "object" || Array.isArray(properties)))) {
    throw new Error("Frontmatter 缺少有效的 YAML 属性，原文已保留。");
  }

  const integrity = validateMarkdownIntegrity(result);
  if (!integrity.valid) throw new Error("修复后 Markdown 结构异常：" + integrity.error);

  const before = inspectBody(splitFrontmatter(original).body);
  const after = inspectBody(body);
  const remaining = new Map<string, number>();
  for (const { target } of after.images) remaining.set(target, (remaining.get(target) ?? 0) + 1);
  for (const { target } of before.images) {
    const count = remaining.get(target) ?? 0;
    if (!count) {
      if (restoredImages?.has(target)) continue;
      throw new Error("整理结果丢失或修改了图片或嵌入目标，原文已保留。");
    }
    remaining.set(target, count - 1);
  }

  const warnings: string[] = [];
  if (after.mismatchedTables) warnings.push(after.mismatchedTables + " 处表格表头和分隔行列数不一致");
  const malformed = new Set<string>();
  const unresolved = new Set<string>();
  for (const { target, malformedPath, wikilink } of after.images) {
    if (restoredImages?.has(target)) continue;
    if (malformedPath) {
      malformed.add(target);
      continue;
    }
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue;
    let linkpath: string;
    try {
      const destination = target.split("#", 1)[0];
      linkpath = wikilink ? destination : decodeURIComponent(destination);
    } catch {
      malformed.add(target);
      continue;
    }
    if (linkpath && !app.metadataCache.getFirstLinkpathDest(linkpath, path)) unresolved.add(target);
  }
  if (malformed.size) warnings.push(malformed.size + " 个图片或嵌入路径可能无法渲染");
  if (unresolved.size) warnings.push(unresolved.size + " 个本地图片或嵌入目标未解析");
  return warnings;
}

function inspectBody(body: string): {
  images: Array<{ target: string; malformedPath: boolean; wikilink: boolean }>;
  mismatchedTables: number;
} {
  const lines = body.split("\n");
  const protectedLines = protectedLineIndices(protectedRanges(lines));
  const images: Array<{ target: string; malformedPath: boolean; wikilink: boolean }> = [];
  let mismatchedTables = 0;
  for (const [index, line] of lines.entries()) {
    if (protectedLines.has(index)) continue;
    const trimmed = line.trim();
    if (/^\|\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|$/.test(trimmed) && !protectedLines.has(index - 1)) {
      const header = lines[index - 1]?.trim();
      if (header?.startsWith("|") && header.endsWith("|")
        && header.replace(/\\./g, "").split("|").length !== trimmed.split("|").length) mismatchedTables += 1;
    }

    const visible = line.replace(/(^|[^`])(`+)(?!`).*?[^`]\2(?!`)/g, "$1").replace(/%%.*?%%|<!--.*?-->/g, "");
    for (const match of visible.matchAll(/!\[\[([^\]]+)\]\]|!\[(?:\\.|[^\]\\])*\]\((<[^>]+>(?:[ \t]+(?:"[^"]*"|'[^']*'))?|(?:\\.|[^()\\]|\([^()]*\))+)\)/g)) {
      if (visible[(match.index ?? 0) - 1] === "\\") continue;
      if (match[1] !== undefined) {
        images.push({ target: match[1].split("|", 1)[0].trim(), malformedPath: false, wikilink: true });
        continue;
      }
      const destination = match[2].trim().replace(/[ \t]+(?:"[^"]*"|'[^']*'|\([^()]*\))$/, "");
      const angle = /^<(.+)>$/.exec(destination);
      images.push({
        target: (angle?.[1] ?? destination).replace(/\\([\\()[\]<> ])/g, "$1"),
        malformedPath: !angle && /(^|[^\\])[ \t]/.test(destination),
        wikilink: false
      });
    }
  }
  return { images, mismatchedTables };
}
