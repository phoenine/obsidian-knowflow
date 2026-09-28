import { normalizePath, TFile } from "obsidian";
import type { App, DataAdapter } from "obsidian";
import type { AiModelConfig, KnowFlowSettings, RelatedNote, SemanticIndexStats } from "../../types";
import { EmbeddingTransport } from "../ai/embedding-transport";
import { chunkArticle, isMarkdownInFolder, normalizeEmbedding, searchSemanticChunks, type SemanticChunk } from "./semantic-search";

interface PersistedFileRecord { slot: string; path: string; title: string; mtime: number; chunks: number; }
interface PersistedSemanticIndexV2 {
  version: 2; modelKey: string; updatedAt: string; generation: string; dimension: number; files: PersistedFileRecord[];
}
interface PersistedSegment {
  version: 2; modelKey: string; path: string; title: string; mtime: number; dimension: number;
  chunks: Array<{ heading: string; content: string }>;
}
interface BuildPointer { version: 2; modelKey: string; generation: string; }

const EMPTY_INDEX: PersistedSemanticIndexV2 = {
  version: 2, modelKey: "", updatedAt: "", generation: "", dimension: 0, files: []
};
const EMBEDDING_BATCH_SIZE = 16;

/** Owns the sharded v2 semantic index and exact in-memory cosine retrieval. */
export class SemanticIndexService {
  private data: PersistedSemanticIndexV2 = cloneEmptyIndex();
  private chunks: SemanticChunk[] = [];
  private chunksLoaded = false;
  private loadPromise: Promise<void> | null = null;
  private building = false;
  private saveQueue: Promise<void> = Promise.resolve();
  private readonly storageRoot: string;
  private readonly buildPointerPath: string;

  constructor(
    private app: App,
    private settings: KnowFlowSettings,
    private indexPath: string,
    private transport = new EmbeddingTransport()
  ) {
    const base = indexPath.replace(/\.json$/i, "");
    this.storageRoot = normalizePath(`${base}-v2`);
    this.buildPointerPath = normalizePath(`${base}-build.json`);
  }

  async load(): Promise<void> {
    this.data = cloneEmptyIndex();
    this.chunks = [];
    this.chunksLoaded = false;
    try {
      if (!await this.app.vault.adapter.exists(this.indexPath)) return;
      const parsed = JSON.parse(await this.app.vault.adapter.read(this.indexPath)) as Partial<PersistedSemanticIndexV2>;
      if (isManifestV2(parsed)) this.data = parsed;
    } catch {
      this.data = cloneEmptyIndex();
    }
  }

  updateSettings(settings: KnowFlowSettings): void { this.settings = settings; }
  isBuilding(): boolean { return this.building; }
  isReady(): boolean { return this.data.files.some((file) => file.chunks > 0) && this.isCompatible(); }

  getStats(): SemanticIndexStats {
    return {
      files: this.data.files.length,
      chunks: this.data.files.reduce((total, file) => total + file.chunks, 0),
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
      const files = this.getArticleFiles().sort((left, right) => left.path.localeCompare(right.path));
      const key = currentModelKey(this.settings);
      const generation = await this.getOrCreateBuildGeneration(key);
      const records: PersistedFileRecord[] = [];
      let dimension = 0;

      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const slot = String(index).padStart(6, "0");
        let fileChunks = await this.loadSegment(generation, slot, key, file.path, file.stat.mtime);
        if (!fileChunks) {
          fileChunks = await this.embedFile(file);
          await this.writeSegment(generation, slot, key, file, fileChunks);
        }
        const fileDimension = fileChunks[0]?.embedding.length ?? 0;
        if (fileDimension > 0 && dimension > 0 && fileDimension !== dimension) {
          throw new Error("Embedding endpoint changed vector dimensions while building the index.");
        }
        if (fileDimension > 0) dimension = fileDimension;
        records.push({ slot, path: file.path, title: file.basename, mtime: file.stat.mtime, chunks: fileChunks.length });
        onProgress?.(index + 1, files.length);
      }

      const previousGeneration = this.data.generation;
      this.data = { version: 2, modelKey: key, updatedAt: new Date().toISOString(), generation, dimension, files: records };
      this.chunks = [];
      this.chunksLoaded = false;
      await this.saveManifest();
      await removeIfExists(this.app.vault.adapter, this.buildPointerPath);
      if (previousGeneration && previousGeneration !== generation) {
        await removeDirectoryIfExists(this.app.vault.adapter, this.generationPath(previousGeneration));
      }
      return this.getStats();
    } finally {
      this.building = false;
    }
  }

  async refreshFile(file: TFile): Promise<void> {
    if (this.building || !this.isReady()) return;
    if (!this.isArticle(file)) return this.removePath(file.path);
    const fileChunks = await this.embedFile(file);
    this.assertDimension(fileChunks);
    if (!(this.app.vault.getAbstractFileByPath(file.path) instanceof TFile)) return this.removePath(file.path);
    const existing = this.data.files.find((record) => record.path === file.path);
    const slot = existing?.slot ?? nextSlot(this.data.files);
    await this.writeSegment(this.data.generation, slot, this.data.modelKey, file, fileChunks);
    if (this.chunksLoaded) this.chunks = this.chunks.filter((chunk) => chunk.path !== file.path).concat(fileChunks);
    const record = { slot, path: file.path, title: file.basename, mtime: file.stat.mtime, chunks: fileChunks.length };
    this.data.files = this.data.files.filter((item) => item.path !== file.path).concat(record);
    if (this.data.dimension === 0 && fileChunks[0]) this.data.dimension = fileChunks[0].embedding.length;
    this.data.updatedAt = new Date().toISOString();
    await this.saveManifest();
  }

  async removePath(path: string): Promise<void> {
    const record = this.data.files.find((item) => item.path === path);
    if (!record) return;
    this.data.files = this.data.files.filter((item) => item.path !== path);
    if (this.chunksLoaded) this.chunks = this.chunks.filter((chunk) => chunk.path !== path);
    await this.removeSegment(this.data.generation, record.slot);
    this.data.updatedAt = new Date().toISOString();
    await this.saveManifest();
  }

  async removeFolder(folderPath: string): Promise<void> {
    const prefix = `${folderPath.replace(/\/$/, "")}/`;
    const targets = this.data.files.filter((file) => file.path.startsWith(prefix));
    if (targets.length === 0) return;
    const slots = new Set(targets.map((file) => file.slot));
    this.data.files = this.data.files.filter((file) => !slots.has(file.slot));
    if (this.chunksLoaded) this.chunks = this.chunks.filter((chunk) => !chunk.path.startsWith(prefix));
    await Promise.all(targets.map((file) => this.removeSegment(this.data.generation, file.slot)));
    this.data.updatedAt = new Date().toISOString();
    await this.saveManifest();
  }

  async migratePath(oldPath: string, newPath: string): Promise<void> {
    const record = this.data.files.find((item) => item.path === oldPath);
    if (!record) return;
    if (!isMarkdownInFolder({ path: newPath, extension: "md" }, this.settings.articlesFolder, this.settings.semanticIndexExcludeFolders)) {
      return this.removePath(oldPath);
    }
    const file = this.app.vault.getAbstractFileByPath(newPath);
    if (!(file instanceof TFile)) return;
    const existing = await this.loadSegment(this.data.generation, record.slot, this.data.modelKey, oldPath, record.mtime);
    if (!existing) throw new Error(`Semantic index segment is missing or invalid: ${oldPath}`);
    const renamed = existing.map((chunk) => ({
      ...chunk, id: chunk.id.replace(`${oldPath}#`, `${newPath}#`), path: newPath, title: file.basename
    }));
    await this.writeSegment(this.data.generation, record.slot, this.data.modelKey, file, renamed);
    if (this.chunksLoaded) this.chunks = this.chunks.filter((chunk) => chunk.path !== oldPath).concat(renamed);
    Object.assign(record, { path: newPath, title: file.basename, mtime: file.stat.mtime, chunks: renamed.length });
    this.data.updatedAt = new Date().toISOString();
    await this.saveManifest();
  }

  async migrateFolder(oldFolder: string, newFolder: string): Promise<void> {
    const oldPrefix = `${oldFolder.replace(/\/$/, "")}/`;
    const records = this.data.files.filter((file) => file.path.startsWith(oldPrefix));
    for (const record of records) {
      await this.migratePath(record.path, `${newFolder.replace(/\/$/, "")}/${record.path.slice(oldPrefix.length)}`);
    }
  }

  async clear(): Promise<void> {
    const activeGeneration = this.data.generation;
    const build = await this.readBuildPointer();
    this.data = cloneEmptyIndex();
    this.chunks = [];
    this.chunksLoaded = false;
    await removeIfExists(this.app.vault.adapter, this.indexPath);
    await removeIfExists(this.app.vault.adapter, this.buildPointerPath);
    if (activeGeneration) await removeDirectoryIfExists(this.app.vault.adapter, this.generationPath(activeGeneration));
    if (build?.generation && build.generation !== activeGeneration) {
      await removeDirectoryIfExists(this.app.vault.adapter, this.generationPath(build.generation));
    }
  }

  async findRelated(file: TFile, limit = 5): Promise<RelatedNote[]> {
    if (!this.isReady()) return [];
    await this.ensureChunksLoaded();
    const indexedSource = this.chunks.filter((chunk) => chunk.path === file.path && chunk.mtime === file.stat.mtime);
    const sourceChunks = indexedSource.length > 0 ? indexedSource : await this.embedFile(file);
    this.assertDimension(sourceChunks);
    const hits = searchSemanticChunks(this.chunks, sourceChunks.map((chunk) => chunk.embedding), Math.max(40, limit * 12), file.path);
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
      .map(({ chunk, score }) => ({ path: chunk.path, title: chunk.title, excerpt: excerptFromChunk(chunk), score, reasons: this.relationshipReasons(file, chunk.path) }));
  }

  async searchContext(query: string, excludedPath?: string, limit = 5): Promise<string> {
    if (!this.isReady() || !query.trim()) return "";
    await this.ensureChunksLoaded();
    const [raw] = await this.transport.embed(this.settings.embeddingModel, [query.trim()]);
    const embedding = normalizeEmbedding(raw, this.settings.embeddingDimensions);
    this.assertDimension([{ embedding }]);
    const hits = searchSemanticChunks(this.chunks, [embedding], Math.max(limit * 4, limit), excludedPath);
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
        batch[index].embedding = normalizeEmbedding(vector, this.settings.embeddingDimensions);
      });
    }
    return chunks;
  }

  private async ensureChunksLoaded(): Promise<void> {
    if (this.chunksLoaded) return;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      const chunks: SemanticChunk[] = [];
      for (const record of this.data.files) {
        const loaded = await this.loadSegment(this.data.generation, record.slot, this.data.modelKey, record.path, record.mtime);
        if (!loaded) throw new Error(`Semantic index segment is missing or invalid: ${record.path}`);
        chunks.push(...loaded);
      }
      this.chunks = chunks;
      this.chunksLoaded = true;
    })();
    try { await this.loadPromise; } finally { this.loadPromise = null; }
  }

  private async getOrCreateBuildGeneration(key: string): Promise<string> {
    const existing = await this.readBuildPointer();
    if (existing?.generation === this.data.generation) {
      await removeIfExists(this.app.vault.adapter, this.buildPointerPath);
    } else if (existing?.modelKey === key && await this.app.vault.adapter.exists(this.generationPath(existing.generation))) {
      return existing.generation;
    } else if (existing?.generation) {
      await removeDirectoryIfExists(this.app.vault.adapter, this.generationPath(existing.generation));
    }
    const generation = createGenerationId();
    await ensureDirectory(this.app.vault.adapter, this.storageRoot);
    await ensureDirectory(this.app.vault.adapter, this.generationPath(generation));
    await this.app.vault.adapter.write(this.buildPointerPath, JSON.stringify({ version: 2, modelKey: key, generation }));
    return generation;
  }

  private async readBuildPointer(): Promise<BuildPointer | null> {
    try {
      if (!await this.app.vault.adapter.exists(this.buildPointerPath)) return null;
      const value = JSON.parse(await this.app.vault.adapter.read(this.buildPointerPath)) as Partial<BuildPointer>;
      return value.version === 2 && typeof value.modelKey === "string" && typeof value.generation === "string" ? value as BuildPointer : null;
    } catch { return null; }
  }

  private async writeSegment(generation: string, slot: string, key: string, file: TFile, chunks: SemanticChunk[]): Promise<void> {
    const dimension = chunks[0]?.embedding.length ?? 0;
    if (chunks.some((chunk) => chunk.embedding.length !== dimension)) throw new Error("Embedding endpoint returned inconsistent dimensions.");
    const segment: PersistedSegment = {
      version: 2, modelKey: key, path: file.path, title: file.basename, mtime: file.stat.mtime, dimension,
      chunks: chunks.map((chunk) => ({ heading: chunk.heading, content: chunk.content }))
    };
    const vectors = new Float32Array(chunks.length * dimension);
    chunks.forEach((chunk, index) => vectors.set(chunk.embedding, index * dimension));
    const { meta, binary } = this.segmentPaths(generation, slot);
    await this.app.vault.adapter.write(meta, JSON.stringify(segment));
    await this.app.vault.adapter.writeBinary(binary, vectors.buffer);
  }

  private async loadSegment(generation: string, slot: string, key: string, path: string, mtime: number): Promise<SemanticChunk[] | null> {
    try {
      const { meta, binary } = this.segmentPaths(generation, slot);
      if (!await this.app.vault.adapter.exists(meta) || !await this.app.vault.adapter.exists(binary)) return null;
      const segment = JSON.parse(await this.app.vault.adapter.read(meta)) as Partial<PersistedSegment>;
      if (!isSegmentV2(segment, key, path, mtime)) return null;
      const vectors = new Float32Array(await this.app.vault.adapter.readBinary(binary));
      if (vectors.length !== segment.chunks.length * segment.dimension) return null;
      return segment.chunks.map((chunk, index) => ({
        id: `${segment.path}#${index}`, path: segment.path, title: segment.title, heading: chunk.heading, content: chunk.content,
        embedding: vectors.subarray(index * segment.dimension, (index + 1) * segment.dimension), mtime: segment.mtime
      }));
    } catch { return null; }
  }

  private async removeSegment(generation: string, slot: string): Promise<void> {
    const { meta, binary } = this.segmentPaths(generation, slot);
    await Promise.all([removeIfExists(this.app.vault.adapter, meta), removeIfExists(this.app.vault.adapter, binary)]);
  }

  private segmentPaths(generation: string, slot: string): { meta: string; binary: string } {
    const root = this.generationPath(generation);
    return { meta: normalizePath(`${root}/${slot}.json`), binary: normalizePath(`${root}/${slot}.bin`) };
  }

  private generationPath(generation: string): string { return normalizePath(`${this.storageRoot}/${generation}`); }
  private getArticleFiles(): TFile[] { return this.app.vault.getMarkdownFiles().filter((file) => this.isArticle(file)); }
  private isArticle(file: TFile): boolean { return isMarkdownInFolder(file, this.settings.articlesFolder, this.settings.semanticIndexExcludeFolders); }

  private assertDimension(chunks: Array<{ embedding: Float32Array }>): void {
    const dimension = chunks[0]?.embedding.length ?? 0;
    if (dimension > 0 && this.data.dimension > 0 && dimension !== this.data.dimension) {
      throw new Error("Embedding dimensions no longer match the saved index. Rebuild the semantic index.");
    }
    if (chunks.some((chunk) => chunk.embedding.length !== dimension)) throw new Error("Embedding endpoint returned inconsistent dimensions.");
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
    if (targetPath in (this.app.metadataCache.resolvedLinks[source.path] ?? {})) reasons.push("当前文章引用");
    if (source.path in (this.app.metadataCache.resolvedLinks[targetPath] ?? {})) reasons.push("引用当前文章");
    return reasons;
  }

  private relationshipBoost(source: TFile, targetPath: string): number {
    return this.relationshipReasons(source, targetPath).reduce((total, reason) => {
      if (reason.startsWith("共同标签")) return total + 0.04;
      if (reason.startsWith("同属")) return total + 0.02;
      if (reason.includes("引用")) return total + 0.05;
      return total;
    }, 0);
  }

  private isCompatible(): boolean { return this.settings.embeddingModel.runtime !== "disabled" && this.data.modelKey === currentModelKey(this.settings); }
  private assertEnabled(): void { if (this.settings.embeddingModel.runtime === "disabled") throw new Error("请先在 AI Models 中配置 Embedding model。"); }

  private saveManifest(): Promise<void> {
    const snapshot = JSON.stringify(this.data);
    const task = this.saveQueue.then(() => this.app.vault.adapter.write(normalizePath(this.indexPath), snapshot));
    this.saveQueue = task.catch(() => {});
    return task;
  }
}

function currentModelKey(settings: KnowFlowSettings): string {
  const scope = settings.articlesFolder.trim().replace(/^\/+|\/+$/g, "");
  const excluded = settings.semanticIndexExcludeFolders.map((folder) => folder.trim()).filter(Boolean).sort().join(",");
  const config = settings.embeddingModel;
  return `${scope}|exclude:${excluded}|dims:${settings.embeddingDimensions}|${modelKey(config)}`;
}
function modelKey(config: AiModelConfig): string { return `${config.runtime}|${config.apiBaseUrl.trim().replace(/\/+$/g, "")}|${config.model.trim()}`; }
function cloneEmptyIndex(): PersistedSemanticIndexV2 { return { ...EMPTY_INDEX, files: [] }; }
function createGenerationId(): string { return `gen-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`; }
function nextSlot(files: PersistedFileRecord[]): string {
  const next = files.reduce((max, file) => Math.max(max, Number.parseInt(file.slot, 10) || 0), -1) + 1;
  return String(next).padStart(6, "0");
}

function isManifestV2(value: Partial<PersistedSemanticIndexV2>): value is PersistedSemanticIndexV2 {
  return value.version === 2 && typeof value.modelKey === "string" && typeof value.updatedAt === "string"
    && typeof value.generation === "string" && typeof value.dimension === "number" && Array.isArray(value.files)
    && value.files.every((file) => Boolean(file) && typeof file.slot === "string" && typeof file.path === "string"
      && typeof file.title === "string" && typeof file.mtime === "number" && typeof file.chunks === "number");
}

function isSegmentV2(value: Partial<PersistedSegment>, key: string, path: string, mtime: number): value is PersistedSegment {
  return value.version === 2 && value.modelKey === key && value.path === path && value.mtime === mtime
    && typeof value.title === "string" && typeof value.dimension === "number" && value.dimension >= 0
    && Array.isArray(value.chunks) && value.chunks.every((chunk) => Boolean(chunk)
      && typeof chunk.heading === "string" && typeof chunk.content === "string");
}

async function ensureDirectory(adapter: DataAdapter, path: string): Promise<void> { if (!await adapter.exists(path)) await adapter.mkdir(path); }
async function removeIfExists(adapter: DataAdapter, path: string): Promise<void> { if (await adapter.exists(path)) await adapter.remove(path); }
async function removeDirectoryIfExists(adapter: DataAdapter, path: string): Promise<void> { if (await adapter.exists(path)) await adapter.rmdir(path, true); }

function excerptFromChunk(chunk: SemanticChunk, maxChars = 240): string {
  const body = chunk.content.replace(/^标题：.*\n小节：.*\n\n/, "").replace(/\s+/g, " ").trim();
  return body.length > maxChars ? `${body.slice(0, maxChars).trimEnd()}…` : body;
}
function readTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map(normalizeTag).filter(Boolean);
  if (typeof value === "string") return value.split(/[,\s]+/).map(normalizeTag).filter(Boolean);
  return [];
}
function normalizeTag(value: string): string { return value.trim().replace(/^#/, "").toLocaleLowerCase(); }
function intersect(left: string[], right: string[]): string[] { const rightSet = new Set(right); return Array.from(new Set(left.filter((item) => rightSet.has(item)))); }
function scalar(value: unknown): string {
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]).trim() : "";
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}
