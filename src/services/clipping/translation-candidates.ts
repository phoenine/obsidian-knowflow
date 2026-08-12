export interface TranslationCandidate {
  id: string;
  startLine: number;
  endLine: number;
  source: string;
  content: string;
}

export interface TranslationDecision {
  id: string;
  translation: string;
}

const TRANSLATION_BATCH_CHARS = 12000;
const TRANSLATION_MARKER = "<!-- knowflow-translation -->";

export function collectTranslationCandidates(content: string): TranslationCandidate[] {
  const lines = content.split("\n");
  const candidates: TranslationCandidate[] = [];
  let inFence = false;
  let inMath = false;
  let index = 0;

  while (index < lines.length) {
    if (/^\s*(?:```|~~~)/.test(lines[index])) {
      inFence = !inFence;
      index += 1;
      continue;
    }
    if (/^\s*\$\$\s*$/.test(lines[index])) {
      inMath = !inMath;
      index += 1;
      continue;
    }
    if (inFence || inMath || !isPlainParagraphLine(lines[index])) {
      const listItem = inFence || inMath ? null : getListItemContent(lines[index]);
      if (listItem && isTranslatableEnglish(listItem) && !lines[index].includes(TRANSLATION_MARKER)) {
        candidates.push({
          id: `translation-${candidates.length + 1}`,
          startLine: index,
          endLine: index,
          source: lines[index],
          content: listItem
        });
      }
      index += 1;
      continue;
    }
    if (/^\s*(?:={3,}|-{3,})\s*$/.test(lines[index + 1] ?? "")) {
      index += 1;
      continue;
    }

    const startLine = index;
    while (index + 1 < lines.length && isPlainParagraphLine(lines[index + 1])) index += 1;
    const endLine = index;
    const source = lines.slice(startLine, endLine + 1).join("\n");
    const paragraph = source.trim();
    if (isTranslatableEnglish(paragraph) && !source.includes(TRANSLATION_MARKER) && !hasManagedTranslationAfter(lines, endLine)) {
      candidates.push({
        id: `translation-${candidates.length + 1}`,
        startLine,
        endLine,
        source,
        content: paragraph
      });
    }
    index += 1;
  }
  return candidates;
}

export function batchTranslationCandidates(candidates: TranslationCandidate[]): TranslationCandidate[][] {
  const batches: TranslationCandidate[][] = [];
  let batch: TranslationCandidate[] = [];
  let chars = 0;
  for (const candidate of candidates) {
    if (batch.length > 0 && chars + candidate.content.length > TRANSLATION_BATCH_CHARS) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(candidate);
    chars += candidate.content.length;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

export function applyTranslationDecisions(
  content: string,
  candidates: TranslationCandidate[],
  decisions: TranslationDecision[]
): string {
  const lines = content.split("\n");
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const accepted = decisions
    .map((decision) => ({ decision, candidate: byId.get(decision.id) }))
    .filter((item): item is { decision: TranslationDecision; candidate: TranslationCandidate } =>
      Boolean(item.candidate) && isValidTranslation(item.decision.translation)
    )
    .sort((a, b) => b.candidate.startLine - a.candidate.startLine);

  const used = new Set<string>();
  for (const { decision, candidate } of accepted) {
    if (used.has(candidate.id)) continue;
    used.add(candidate.id);
    const current = lines.slice(candidate.startLine, candidate.endLine + 1).join("\n");
    if (current !== candidate.source) continue;
    lines[candidate.endLine] = appendInlineTranslation(lines[candidate.endLine], decision.translation.trim());
  }
  return lines.join("\n");
}

function isPlainParagraphLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return !/^(?:#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\||!\[|\[\[|<|---+$|\$\$)/.test(trimmed);
}

function getListItemContent(line: string): string | null {
  const match = line.match(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/);
  return match?.[1]?.trim() || null;
}

function isTranslatableEnglish(value: string): boolean {
  const latin = value.match(/[A-Za-z]/g)?.length ?? 0;
  const cjk = value.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  return latin >= 20 && cjk === 0 && !isMostlyUrl(value);
}

function isMostlyUrl(value: string): boolean {
  const withoutUrls = value.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, "");
  return withoutUrls.length < 20;
}

function hasManagedTranslationAfter(lines: string[], endLine: number): boolean {
  let index = endLine + 1;
  while (index < lines.length && !lines[index].trim()) index += 1;
  while (index < lines.length && isPlainParagraphLine(lines[index])) index += 1;
  return lines[index]?.trim() === TRANSLATION_MARKER;
}

function appendInlineTranslation(line: string, translation: string): string {
  const trailingWhitespace = line.match(/\s*$/)?.[0] ?? "";
  const body = trailingWhitespace ? line.slice(0, -trailingWhitespace.length) : line;
  return `${body}（${translation}） ${TRANSLATION_MARKER}${trailingWhitespace}`;
}

function isValidTranslation(value: string): boolean {
  if (typeof value !== "string") return false;
  const translation = value.trim();
  return translation.length > 0
    && translation.length <= 12000
    && /[\u3400-\u9fff]/.test(translation)
    && !/[\r\n]/.test(translation)
    && !translation.includes(TRANSLATION_MARKER)
    && !/```|~~~/.test(translation);
}
