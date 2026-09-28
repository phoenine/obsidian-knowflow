import { normalizePath, TFile } from "obsidian";
import type { App } from "obsidian";
import type { AiModelConfig, KnowFlowSettings, RelatedNote, SemanticIndexStats } from "../../types";
import { EmbeddingTransport } from "../ai/embedding-transport";
import { chunkArticle, isMarkdownInFolder, searchSemanticChunks, type SemanticChunk } from "./semantic-search";

interface PersistedSemanticIndex {
  version: 1;
  modelKey: string;
  updatedAt: string;
  chunks: SemanticChunk[];
}

const EMPTY_INDEX: PersistedSemanticIndex = {
  version: 1,
  modelKey: "",
  updatedAt: "",
  chunks: []
};
const EMBEDDING_BATCH_SIZE = 16;

/** Owns KnowFlow's local semantic index and its exact cosine retrieval boundary. */
export class SemanticIndexService {
  private data: PersistedSemanticIndex = structuredClone(EMPTY_INDEX);
  private building = false;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(
    private app: App,
    private settings: KnowFlowSettings,
    private indexPath: string,
    private transport = new EmbeddingTransport()
  ) {}

  async load(): Promise<void> {
    try {
      if (!await this.app.vault.adapter.exists(this.indexPath)) return;
      const parsed = JSON.parse(await this.app.vault.adapter.read(this.indexPath)) as Partial<PersistedSemanticIndex>;
      if (parsed.version !== 1 || !Array.isArray(parsed.chunks)) return;
      this.data = {
        version: 1,
        modelKey: typeof parsed.modelKey === "string" ? parsed.modelKey : "",
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
        chunks: parsed.chunks.filter(isSemanticChunk)
      };
    } catch {
      this.data = structuredClone(EMPTY_INDEX);
    }
  }

  updateSettings(settings: KnowFlowSettings): void {
    this.settings = settings;
  }

  isBuilding(): boolean {
    return this.building;
  }

  isReady(): boolean {
    return this.data.chunks.length > 0 && this.isCompatible();
  }

  getStats(): SemanticIndexStats {
    return {
      files: new Set(this.data.chunks.map((chunk) => chunk.path)).size,
      chunks: this.data.chunks.length,
      model: this.data.modelKey ? this.data.modelKey.split("|").slice(-1)[0] ?? "" : "",
      updatedAt: this.data.updatedAt,
      compatible: this.isCompatible()
    };
  }

  async rebuild(onProgress?: (indexed: number, total: number) => void): Promise<SemanticIndexStats> {
    this.assertEnabled();
    if (this.building) throw new Error("Semantic index is already building.");
    this.building = true;
    try {
      const files = this.getArticleFiles();
      const chunks: SemanticChunk[] = [];
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        chunks.push(...await this.embedFile(file));
        onProgress?.(index + 1, files.length);
      }
      assertConsistentDimensions(chunks);
      this.data = {
        version: 1,
        modelKey: modelKey(
          this.settings.embeddingModel,
          this.settings.articlesFolder,
          this.settings.semanticIndexExcludeFolders
        ),
        updatedAt: new Date().toISOString(),
        chunks
      };
      await this.save();
      return this.getStats();
    } finally {
      this.building = false;
    }
  }

  async refreshFile(file: TFile): Promise<void> {
    if (this.building || !this.isReady()) return;
    if (!this.isArticle(file)) {
      await this.removePath(file.path);
      return;
    }
    const chunks = await this.embedFile(file);
    const current = this.app.vault.getAbstractFileByPath(file.path);
    if (!(current instanceof TFile)) {
      await this.removePath(file.path);
      return;
    }
    assertMatchingDimension(chunks, this.data.chunks.filter((chunk) => chunk.path !== file.path));
    this.data.chunks = this.data.chunks.filter((chunk) => chunk.path !== file.path).concat(chunks);
    this.data.updatedAt = new Date().toISOString();
    await this.save();
  }

  async removePath(path: string): Promise<void> {
    const next = this.data.chunks.filter((chunk) => chunk.path !== path);
    if (next.length === this.data.chunks.length) return;
    this.data.chunks = next;
    this.data.updatedAt = new Date().toISOString();
    await this.save();
  }

  async removeFolder(folderPath: string): Promise<void> {
    const prefix = `${folderPath.replace(/\/$/, "")}/`;
    const next = this.data.chunks.filter((chunk) => !chunk.path.startsWith(prefix));
    if (next.length === this.data.chunks.length) return;
    this.data.chunks = next;
    this.data.updatedAt = new Date().toISOString();
    await this.save();
  }

  async migratePath(oldPath: string, newPath: string): Promise<void> {
    let changed = false;
    this.data.chunks = this.data.chunks.map((chunk) => {
      if (chunk.path !== oldPath) return chunk;
      changed = true;
      const title = newPath.split("/").slice(-1)[0]?.replace(/\.md$/i, "") ?? chunk.title;
      return { ...chunk, id: chunk.id.replace(`${oldPath}#`, `${newPath}#`), path: newPath, title };
    });
    if (!changed) return;
    this.data.updatedAt = new Date().toISOString();
    await this.save();
  }

  async migrateFolder(oldFolder: string, newFolder: string): Promise<void> {
    const oldPrefix = `${oldFolder.replace(/\/$/, "")}/`;
    const newPrefix = `${newFolder.replace(/\/$/, "")}/`;
    let changed = false;
    this.data.chunks = this.data.chunks.flatMap((chunk) => {
      if (!chunk.path.startsWith(oldPrefix)) return chunk;
      const path = `${newPrefix}${chunk.path.slice(oldPrefix.length)}`;
      changed = true;
      if (!isMarkdownInFolder(
        { path, extension: "md" },
        this.settings.articlesFolder,
        this.settings.semanticIndexExcludeFolders
      )) return [];
      return { ...chunk, id: chunk.id.replace(`${chunk.path}#`, `${path}#`), path };
    });
    if (!changed) return;
    this.data.updatedAt = new Date().toISOString();
    await this.save();
  }

  async clear(): Promise<void> {
    this.data = structuredClone(EMPTY_INDEX);
    if (await this.app.vault.adapter.exists(this.indexPath)) {
      await this.app.vault.adapter.remove(this.indexPath);
    }
  }

  async findRelated(file: TFile, limit = 5): Promise<RelatedNote[]> {
    if (!this.isReady()) return [];
    const indexedSource = this.data.chunks.filter((chunk) => chunk.path === file.path && chunk.mtime === file.stat.mtime);
    const sourceChunks = indexedSource.length > 0
      ? indexedSource
      : await this.embedFile(file);
    assertMatchingDimension(sourceChunks, this.data.chunks);
    const hits = searchSemanticChunks(
      this.data.chunks,
      sourceChunks.map((chunk) => chunk.embedding),
      Math.max(40, limit * 12),
      file.path
    );
    const bestByPath = new Map<string, { chunk: SemanticChunk; score: number }>();
    for (const hit of hits) {
      if (!(this.app.vault.getAbstractFileByPath(hit.chunk.path) instanceof TFile)) continue;
      const current = bestByPath.get(hit.chunk.path);
      if (!current || hit.score > current.score) bestByPath.set(hit.chunk.path, hit);
    }

    return Array.from(bestByPath.values())
      .map((hit) => ({ ...hit, score: Math.min(1, hit.score + this.relationshipBoost(file, hit.chunk.path)) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map(({ chunk, score }) => ({
        path: chunk.path,
        title: chunk.title,
        excerpt: excerptFromChunk(chunk),
        score,
        reasons: this.relationshipReasons(file, chunk.path)
      }));
  }

  async searchContext(query: string, excludedPath?: string, limit = 5): Promise<string> {
    if (!this.isReady() || !query.trim()) return "";
    const [embedding] = await this.transport.embed(this.settings.embeddingModel, [query.trim()]);
    assertMatchingDimension([{ embedding }], this.data.chunks);
    const hits = searchSemanticChunks(this.data.chunks, [embedding], Math.max(limit * 4, limit), excludedPath);
    const selected: typeof hits = [];
    const perPath = new Map<string, number>();
    for (const hit of hits) {
      const count = perPath.get(hit.chunk.path) ?? 0;
      if (count >= 2) continue;
      selected.push(hit);
      perPath.set(hit.chunk.path, count + 1);
      if (selected.length >= limit) break;
    }
    return selected.map((hit, index) => [
      `[检索来源 ${index + 1}: ${hit.chunk.path}${hit.chunk.heading ? ` > ${hit.chunk.heading}` : ""}]`,
      excerptFromChunk(hit.chunk, 1200)
    ].join("\n")).join("\n\n");
  }

  private async embedFile(file: TFile): Promise<SemanticChunk[]> {
    const markdown = await this.app.vault.cachedRead(file);
    const chunks = chunkArticle(file.path, file.basename, markdown, file.stat.mtime);
    for (let start = 0; start < chunks.length; start += EMBEDDING_BATCH_SIZE) {
      const batch = chunks.slice(start, start + EMBEDDING_BATCH_SIZE);
      const vectors = await this.transport.embed(this.settings.embeddingModel, batch.map((chunk) => chunk.content));
      vectors.forEach((vector, index) => {
        batch[index].embedding = vector;
      });
    }
    return chunks;
  }

  private getArticleFiles(): TFile[] {
    return this.app.vault.getMarkdownFiles().filter((file) => this.isArticle(file));
  }

  private isArticle(file: TFile): boolean {
    return isMarkdownInFolder(
      file,
      this.settings.articlesFolder,
      this.settings.semanticIndexExcludeFolders
    );
  }

  private relationshipReasons(source: TFile, targetPath: string): string[] {
    const reasons: string[] = ["语义相似"];
    const sourceMeta = this.app.metadataCache.getFileCache(source)?.frontmatter;
    const target = this.app.vault.getAbstractFileByPath(targetPath);
    const targetMeta = target instanceof TFile ? this.app.metadataCache.getFileCache(target)?.frontmatter : undefined;
    const sharedTags = intersect(readTags(sourceMeta?.tags), readTags(targetMeta?.tags));
    if (sharedTags.length > 0) reasons.push(`共同标签：${sharedTags.slice(0, 2).join("、")}`);
    const sourceCategory = scalar(sourceMeta?.["分类"]);
    const targetCategory = scalar(targetMeta?.["分类"]);
    if (sourceCategory && sourceCategory === targetCategory) reasons.push(`同属：${sourceCategory}`);
    const outgoing = this.app.metadataCache.resolvedLinks[source.path] ?? {};
    if (targetPath in outgoing) reasons.push("当前文章引用");
    const targetOutgoing = this.app.metadataCache.resolvedLinks[targetPath] ?? {};
    if (source.path in targetOutgoing) reasons.push("引用当前文章");
    return reasons;
  }

  private relationshipBoost(source: TFile, targetPath: string): number {
    const reasons = this.relationshipReasons(source, targetPath);
    return reasons.reduce((total, reason) => {
      if (reason.startsWith("共同标签")) return total + 0.04;
      if (reason.startsWith("同属")) return total + 0.02;
      if (reason.includes("引用")) return total + 0.05;
      return total;
    }, 0);
  }

  private isCompatible(): boolean {
    return this.settings.embeddingModel.runtime !== "disabled"
      && this.data.modelKey === modelKey(
        this.settings.embeddingModel,
        this.settings.articlesFolder,
        this.settings.semanticIndexExcludeFolders
      )
      && hasConsistentDimensions(this.data.chunks);
  }

  private assertEnabled(): void {
    if (this.settings.embeddingModel.runtime === "disabled") {
      throw new Error("请先在 AI Models 中配置 Embedding model。");
    }
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.data);
    const task = this.saveQueue.then(() => this.app.vault.adapter.write(normalizePath(this.indexPath), snapshot));
    this.saveQueue = task.catch(() => {});
    return task;
  }
}

function modelKey(config: AiModelConfig, articlesFolder: string, excludedFolders: string[] = []): string {
  const scope = articlesFolder.trim().replace(/^\/+|\/+$/g, "");
  const excluded = excludedFolders.map((folder) => folder.trim()).filter(Boolean).sort().join(",");
  return `${scope}|exclude:${excluded}|${config.runtime}|${config.apiBaseUrl.trim().replace(/\/+$/g, "")}|${config.model.trim()}`;
}

function isSemanticChunk(value: unknown): value is SemanticChunk {
  if (!value || typeof value !== "object") return false;
  const chunk = value as Partial<SemanticChunk>;
  return typeof chunk.id === "string"
    && typeof chunk.path === "string"
    && typeof chunk.title === "string"
    && typeof chunk.heading === "string"
    && typeof chunk.content === "string"
    && typeof chunk.mtime === "number"
    && Array.isArray(chunk.embedding)
    && chunk.embedding.length > 0
    && chunk.embedding.every((item) => typeof item === "number" && Number.isFinite(item));
}

function hasConsistentDimensions(chunks: Array<{ embedding: number[] }>): boolean {
  if (chunks.length === 0) return true;
  const dimension = chunks[0].embedding.length;
  return dimension > 0 && chunks.every((chunk) => chunk.embedding.length === dimension);
}

function assertConsistentDimensions(chunks: Array<{ embedding: number[] }>): void {
  if (!hasConsistentDimensions(chunks)) {
    throw new Error("Embedding endpoint changed vector dimensions while building the index. Rebuild with one model configuration.");
  }
}

function assertMatchingDimension(
  candidate: Array<{ embedding: number[] }>,
  existing: Array<{ embedding: number[] }>
): void {
  assertConsistentDimensions(candidate);
  assertConsistentDimensions(existing);
  if (candidate.length === 0 || existing.length === 0) return;
  if (candidate[0].embedding.length !== existing[0].embedding.length) {
    throw new Error("Embedding dimensions no longer match the saved index. Rebuild the semantic index.");
  }
}

function excerptFromChunk(chunk: SemanticChunk, maxChars = 240): string {
  const body = chunk.content.replace(/^标题：.*\n小节：.*\n\n/, "").replace(/\s+/g, " ").trim();
  return body.length > maxChars ? `${body.slice(0, maxChars).trimEnd()}…` : body;
}

function readTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map(normalizeTag).filter(Boolean);
  if (typeof value === "string") return value.split(/[,\s]+/).map(normalizeTag).filter(Boolean);
  return [];
}

function normalizeTag(value: string): string {
  return value.trim().replace(/^#/, "").toLocaleLowerCase();
}

function intersect(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return Array.from(new Set(left.filter((item) => rightSet.has(item))));
}

function scalar(value: unknown): string {
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]).trim() : "";
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}
