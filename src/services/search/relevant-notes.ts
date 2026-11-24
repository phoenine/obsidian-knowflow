import { TFile, type App } from "obsidian";
import type { KnowFlowSettings, RelatedNote } from "../../types";
import { isMarkdownInFolder } from "./semantic-search";

export interface SemanticNoteMatch {
  path: string;
  similarity: number;
}

const MIN_SIMILARITY = 0.55;
const MAX_GAP_FROM_BEST = 0.15;
const RANK_OFFSET = 10;
const COMMON_TITLE_TERMS = new Set([
  "the", "and", "how", "for", "with", "from", "agent", "agents", "engineering", "guide", "tutorial",
  "github", "skill", "skills", "使用", "介绍", "人工智能", "智能体", "入门", "教程", "指南"
]);

export function rankRelevantNotes(
  app: App,
  file: TFile,
  semantic: SemanticNoteMatch[],
  settings: KnowFlowSettings,
  limit: number
): RelatedNote[] {
  const { vault, metadataCache } = app;
  const sourceTags = new Set(readTags(metadataCache.getFileCache(file)?.frontmatter?.tags));
  const sharesTag = (note: TFile) =>
    sourceTags.size > 0 && readTags(metadataCache.getFileCache(note)?.frontmatter?.tags).some((tag) => sourceTags.has(tag));
  const isCandidate = (note: TFile) => note !== file
    && isMarkdownInFolder(note, settings.articlesFolder, settings.semanticIndexExcludeFolders);

  const semanticMatches = semantic.flatMap(({ path, similarity }) => {
    const note = vault.getAbstractFileByPath(path);
    return note instanceof TFile && isCandidate(note) && Number.isFinite(similarity) ? [{ note, similarity }] : [];
  }).sort((left, right) => right.similarity - left.similarity);
  const cutoff = Math.max(MIN_SIMILARITY, (semanticMatches[0]?.similarity ?? 0) - MAX_GAP_FROM_BEST);
  const ranked = new Map<string, { file: TFile; score: number }>();
  for (const [rank, { note, similarity }] of semanticMatches.entries()) {
    if (similarity < cutoff) break;
    if (!ranked.has(note.path)) ranked.set(note.path, { file: note, score: 1 / (RANK_OFFSET + rank) });
  }

  const sourceTerms = new Set(titleTerms(file.basename));
  if (sourceTerms.size) {
    const titleMatches = vault.getMarkdownFiles().flatMap((note) => {
      if (!isCandidate(note)) return [];
      const matches = titleTerms(note.basename).filter((term) => sourceTerms.has(term));
      // A version token can distinguish matches after a topic term matches.
      if (!matches.some((term) => !/^v\d+$/.test(term))) return [];
      return [{ note, matches: matches.length }];
    }).sort((left, right) => right.matches - left.matches || left.note.path.localeCompare(right.note.path));
    for (const [rank, { note }] of titleMatches.slice(0, limit).entries()) {
      const score = (ranked.get(note.path)?.score ?? 0) + 0.9 / (RANK_OFFSET + rank);
      ranked.set(note.path, { file: note, score });
    }
  }

  return [...ranked.values()]
    .map(({ file: note, score }) => ({ note, score: score + (sharesTag(note) ? 0.005 : 0) }))
    .sort((left, right) => right.score - left.score || left.note.path.localeCompare(right.note.path))
    .slice(0, limit)
    .map(({ note }) => ({ path: note.path, title: note.basename }));
}

function titleTerms(title: string): string[] {
  const words = title.normalize("NFKC").toLowerCase().match(/[a-z][a-z0-9+#]*|[\u3400-\u9fff]{2,}/g) ?? [];
  return [...new Set(words.filter((word) =>
    (word.length >= 3 || /[0-9#\u3400-\u9fff]/.test(word)) && !COMMON_TITLE_TERMS.has(word)
  ))];
}

function readTags(value: unknown): string[] {
  const tags: unknown[] = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/) : [];
  return tags.flatMap((tag) => typeof tag === "string" ? [tag.trim().toLowerCase().replace(/^#/, "")] : []).filter(Boolean);
}
