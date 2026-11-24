import { francAll } from "franc-min";
import { stripManagedArticleSections } from "./managed-content";
import { protectedLineIndices, protectedRanges } from "./protected-markdown";

const TRANSLATION_MARKER = "<!-- knowflow-translation -->";
// Short samples and close language rankings are deliberately treated as uncertain.
const MIN_LANGUAGE_CHARS = 30;
const MIN_LANGUAGE_MARGIN = 0.05;

export function englishArticleSkipReason(content: string): string | undefined {
  const blocks = collectLanguageBlocks(content);
  if (blocks.length === 0) return "无可翻译正文";
  if (blocks.some((block) => /\p{Script=Han}/u.test(block))) return "正文包含中文";
  const text = blocks.join("\n\n");
  for (const sample of [text, ...blocks.flatMap(languageSamples)]) {
    const rankings = francAll(sample, { minLength: MIN_LANGUAGE_CHARS });
    const [language, score] = rankings[0];
    if (language === "und" || (rankings[1] && score - rankings[1][1] < MIN_LANGUAGE_MARGIN)) {
      return "正文语言无法确定";
    }
    if (language !== "eng") return "非英文或混合语言正文";
  }
  return undefined;
}

function languageSamples(text: string): string[] {
  // franc examines only the first 2048 characters. Check every part of long
  // paragraphs so a later non-English section cannot be hidden by an English lead.
  const samples: string[] = [];
  while (text.length > 1800) {
    const space = text.lastIndexOf(" ", 1800);
    const end = space >= 1500 ? space : 1800;
    samples.push(text.slice(0, end));
    text = text.slice(end).trim();
  }
  if (samples.length > 0 && text.length < MIN_LANGUAGE_CHARS) samples[samples.length - 1] += ` ${text}`;
  else samples.push(text);
  return samples;
}

function collectLanguageBlocks(content: string): string[] {
  const source = stripManagedArticleSections(content)
    .replace(/<!--(?!\s*knowflow-translation\s*-->)[\s\S]*?-->/g, "");
  const sourceLines = source.split("\n");
  const protectedLines = protectedLineIndices(protectedRanges(sourceLines));
  const lines = sourceLines.map((line, index) => {
    if (protectedLines.has(index) || (/^(?: {4}|\t)/.test(line) && !/^\s*(?:[-+*]|\d+[.)])\s/.test(line))) return "";
    return line;
  });
  const rawBlocks = lines.join("\n").split(/\n\s*\n/);
  return rawBlocks.flatMap((block, index) => {
    // Both current inline translations and legacy separate translation blocks
    // carry this marker. Leave their Chinese text out of language detection.
    if (block.includes(TRANSLATION_MARKER) || rawBlocks[index + 1]?.trim() === TRANSLATION_MARKER) return [];
    const prose = block.split("\n").map((line) => {
      const text = line.replace(/^\s*(?:>\s*)+/, "").trim();
      if (/^#{1,6}\s/.test(text)) return /\p{Script=Han}/u.test(text) ? text : "";
      if (/^(?:\||\[![^\]]+\]|\[[^\]]+\]:|[-=*_]{3,}$)/.test(text)) return "";
      return translationProse(text.replace(/^(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, ""));
    }).filter(Boolean).join("\n");
    return /\p{L}/u.test(prose) ? [prose] : [];
  });
}

export function translationProse(value: string): string {
  if (isLibraryMetadata(value)) return "";
  const withoutCode = value.replace(/(`+)[\s\S]*?\1/g, "").replace(/\$[^$\n]+\$/g, "");
  // Standalone links are references, even when their labels contain many letters.
  const links = /!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)|\[\[[^\]]+\]\]|<https?:\/\/[^>]+>/g;
  const outsideLinks = withoutCode.replace(links, "").replace(/https?:\/\/\S+/g, "");
  if (!/\p{L}/u.test(outsideLinks)) return "";
  return withoutCode
    .replace(/!\[[^\]]*\]\((?:[^()]|\([^()]*\))*\)/g, "")
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target: string, label?: string) => label ?? target)
    .replace(/https?:\/\/\S+/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[*_~]/g, "")
    .trim();
}

function isLibraryMetadata(value: string): boolean {
  if (/[\r\n]/.test(value)) return false;
  const fields = value.replace(/\*\*|__/g, "").split(/\s+[—–]\s+|[｜|]/).map((field) => field.trim());
  return fields.length >= 3 && Boolean(fields[0]) && fields.slice(1).every((field) =>
    /^`[^`]+`$/.test(field)
      || /^(?:GitHub\s+)?Stars?\s*:?\s*[\d,.]+[kKmM]?$/i.test(field)
      || /^v?\d+(?:\.\d+)+(?:[-+][\w.-]+)?$/.test(field)
      || /^(?:MIT|ISC|Apache-\d+(?:\.\d+)*|BSD-\d-Clause|(?:A?GPL|LGPL|MPL)-\d+(?:\.\d+)*(?:-(?:only|or-later))?)$/.test(field)
  );
}
