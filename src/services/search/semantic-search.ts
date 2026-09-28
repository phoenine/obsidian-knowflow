import { prepareArticleForAi } from "../clipping/managed-content";

export interface SemanticChunk {
  id: string;
  path: string;
  title: string;
  heading: string;
  content: string;
  embedding: Float32Array;
  mtime: number;
}

export interface SemanticSearchHit {
  chunk: SemanticChunk;
  score: number;
}

const MAX_CHUNK_CHARS = 1800;
const CHUNK_OVERLAP_CHARS = 180;

/** Avoids scheduling semantic work for unrelated Vault files. */
export function isMarkdownInFolder(
  file: { path: string; extension: string },
  folder: string,
  excludedFolders: string[] = []
): boolean {
  const root = folder.replace(/^\/+|\/+$/g, "");
  const path = file.path.replace(/^\/+|\/+$/g, "");
  const prefix = `${root}/`;
  if (file.extension !== "md" || !path.startsWith(prefix)) return false;
  const relativeParent = path.slice(prefix.length).split("/").slice(0, -1).join("/");
  const parentSegments = relativeParent.split("/").filter(Boolean);
  return !excludedFolders.some((value) => {
    const normalized = value.trim().replace(/^\/+|\/+$/g, "");
    if (!normalized) return false;
    const relativeRule = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
    if (!relativeRule.includes("/")) return parentSegments.includes(relativeRule);
    return relativeParent === relativeRule || relativeParent.startsWith(`${relativeRule}/`);
  });
}

/** Splits source Markdown into heading-aware chunks suitable for embedding. */
export function chunkArticle(path: string, title: string, markdown: string, mtime: number): SemanticChunk[] {
  const content = prepareArticleForAi(markdown);
  if (!content) return [];

  const sections: Array<{ heading: string; text: string }> = [];
  let heading = title;
  let lines: string[] = [];
  const flush = (): void => {
    const text = lines.join("\n").trim();
    if (text) sections.push({ heading, text });
    lines = [];
  };

  for (const line of content.split("\n")) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match) {
      flush();
      heading = match[2].trim();
    } else {
      lines.push(line);
    }
  }
  flush();

  const chunks: SemanticChunk[] = [];
  for (const section of sections) {
    const embeddingHeading = truncate(section.heading, 300);
    const prefix = `标题：${truncate(title, 300)}\n小节：${embeddingHeading}\n\n`;
    const bodyLimit = Math.max(400, MAX_CHUNK_CHARS - prefix.length);
    const overlap = Math.min(CHUNK_OVERLAP_CHARS, Math.floor(bodyLimit / 4));
    for (const part of splitLongText(section.text, bodyLimit, overlap)) {
      const index = chunks.length;
      chunks.push({
        id: `${path}#${index}`,
        path,
        title,
        heading: section.heading,
        content: `${prefix}${part}`,
        embedding: new Float32Array(),
        mtime
      });
    }
  }
  return chunks;
}

/** Returns cosine similarity, or zero for invalid/mismatched vectors. */
export function cosineSimilarity(left: ArrayLike<number>, right: ArrayLike<number>): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

/** Ranks indexed chunks against one or more query embeddings. */
export function searchSemanticChunks(
  chunks: SemanticChunk[],
  queryEmbeddings: ArrayLike<number>[],
  limit: number,
  excludedPath?: string
): SemanticSearchHit[] {
  if (queryEmbeddings.length === 0 || limit <= 0) return [];
  return chunks
    .filter((chunk) => chunk.path !== excludedPath)
    .map((chunk) => ({
      chunk,
      score: Math.max(...queryEmbeddings.map((query) => normalizedDotProduct(query, chunk.embedding)))
    }))
    .filter((hit) => Number.isFinite(hit.score) && hit.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

function normalizedDotProduct(left: ArrayLike<number>, right: ArrayLike<number>): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) dot += left[index] * right[index];
  return dot;
}

/** Converts provider vectors to normalized Float32, optionally truncating Matryoshka embeddings. */
export function normalizeEmbedding(values: number[], dimensions = 0): Float32Array {
  if (values.length === 0) throw new Error("Embedding vector is empty.");
  if (dimensions > values.length) {
    throw new Error(`Requested ${dimensions} embedding dimensions, but the model returned ${values.length}.`);
  }
  const length = dimensions > 0 ? dimensions : values.length;
  const result = new Float32Array(length);
  let norm = 0;
  for (let index = 0; index < length; index += 1) {
    const value = values[index];
    if (!Number.isFinite(value)) throw new Error("Embedding vector contains a non-finite value.");
    result[index] = value;
    norm += value * value;
  }
  if (norm === 0) throw new Error("Embedding vector has zero magnitude.");
  const scale = 1 / Math.sqrt(norm);
  for (let index = 0; index < result.length; index += 1) result[index] *= scale;
  return result;
}

function splitLongText(text: string, maxChars: number, overlap: number): string[] {
  if (text.length <= maxChars) return [text];
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars);
    if (end < text.length) {
      const boundary = Math.max(
        text.lastIndexOf("\n\n", end),
        text.lastIndexOf("。", end),
        text.lastIndexOf(". ", end)
      );
      if (boundary > start + Math.floor(maxChars * 0.55)) end = boundary + 1;
    }
    parts.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return parts.filter(Boolean);
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}
