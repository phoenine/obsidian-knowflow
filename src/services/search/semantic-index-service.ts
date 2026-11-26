import { normalizePath, TFile } from "obsidian";
import type { App, DataAdapter } from "obsidian";
import type { AiModelConfig, KnowFlowSettings, RelatedNote, SemanticIndexStats } from "../../types";
import { EmbeddingTransport } from "../ai/embedding-transport";
import { rankRelevantNotes, type SemanticNoteMatch } from "./relevant-notes";
import {
  chunkArticle, chunkArticleSummary, isMarkdownInFolder, normalizeEmbedding,
  pickArticlePassage, searchSemanticChunks, SUMMARY_INDEX_SOURCE, type SemanticChunk
} from "./semantic-search";

interface PersistedShardRecord {
  id: string;
  revision: string;
  articles: number;
  chunks: number;
  byteLength: number;
}

interface PersistedSemanticIndexV3 {
  version: 3;
  modelKey: string;
  updatedAt: string;
  generation: string;
  dimension: number;
  shards: PersistedShardRecord[];
}

interface PersistedShardArticle {
  path: string;
  title: string;
  mtime: number;
  chunkStart: number;
  chunkCount: number;
  vectorOffsetBytes: number;
  vectorLengthBytes: number;
  chunks: Array<{ heading: string; content: string }>;
}

interface PersistedShard {
  version: 3;
  modelKey: string;
  generation: string;
  shardId: string;
  revision: string;
  dimension: number;
  articles: PersistedShardArticle[];
}

interface BuildPointer {
  version: 3;
  modelKey: string;
  generation: string;
  shards: PersistedShardRecord[];
}

interface ShardArticle {
  path: string;
  title: string;
  mtime: number;
  chunks: SemanticChunk[];
}

interface LoadedShard {
  record: PersistedShardRecord;
  articles: ShardArticle[];
}

interface ShardUpdate {
  previous?: PersistedShardRecord;
  next?: PersistedShardRecord;
}

const SHARD_COUNT = 128;
const EMBEDDING_BATCH_SIZE = 16;
const EMPTY_INDEX: PersistedSemanticIndexV3 = {
  version: 3, modelKey: "", updatedAt: "", generation: "", dimension: 0, shards: []
};

/** Owns the fixed-shard semantic index and exact in-memory cosine retrieval. */
export class SemanticIndexService {
  private data: PersistedSemanticIndexV3 = cloneEmptyIndex();
  private chunks: SemanticChunk[] = [];
  private chunksLoaded = false;
  private loadPromise: Promise<void> | null = null;
  private building = false;
  private saveQueue: Promise<void> = Promise.resolve();
  private mutationQueue: Promise<void> = Promise.resolve();
  private unhealthyShards = new Map<string, number>();
  private readonly storageRoot: string;
  private readonly buildPointerPath: string;

  constructor(
    private app: App,
    private settings: KnowFlowSettings,
    private indexPath: string,
    private transport = new EmbeddingTransport()
  ) {
    const base = indexPath.replace(/\.json$/i, "");
    this.storageRoot = normalizePath(`${base}-v3`);
    this.buildPointerPath = normalizePath(`${base}-build.json`);
  }

  async load(): Promise<void> {
    this.resetLoadedChunks();
    this.data = cloneEmptyIndex();
    this.unhealthyShards.clear();
    try {
      if (!await this.app.vault.adapter.exists(this.indexPath)) return;
      const parsed = JSON.parse(await this.app.vault.adapter.read(this.indexPath)) as Partial<PersistedSemanticIndexV3>;
      if (!isManifestV3(parsed)) return;
      this.data = parsed;
      await Promise.all(parsed.shards.map(async (record) => {
        const { meta, binary } = this.shardPaths(parsed.generation, record);
        if (!await this.app.vault.adapter.exists(meta) || !await this.app.vault.adapter.exists(binary)) this.markUnhealthy(record);
      }));
    } catch {
      this.data = cloneEmptyIndex();
    }
  }

  updateSettings(settings: KnowFlowSettings): void { this.settings = settings; }
  isBuilding(): boolean { return this.building; }
  hasCompatibleIndex(): boolean { return Boolean(this.data.generation) && this.isCompatible(); }
  isReady(): boolean {
    return this.isCompatible() && this.data.shards.some((record) => record.chunks > 0 && !this.unhealthyShards.has(record.id));
  }

  getStats(): SemanticIndexStats {
    const unavailableFiles = Array.from(this.unhealthyShards.values()).reduce((total, count) => total + count, 0);
    const chunks = this.data.shards.reduce((total, shard) => total + shard.chunks, 0);
    return {
      files: this.data.modelKey.includes(`|source:${SUMMARY_INDEX_SOURCE}|`)
        ? chunks : this.data.shards.reduce((total, shard) => total + shard.articles, 0),
      chunks,
      model: this.data.modelKey ? this.data.modelKey.split("|").slice(-1)[0] ?? "" : "",
      updatedAt: this.data.updatedAt,
      compatible: this.isCompatible(),
      degraded: this.unhealthyShards.size > 0,
      unhealthyShards: this.unhealthyShards.size,
      unavailableFiles
    };
  }

  async rebuild(onProgress?: (indexed: number, total: number) => void): Promise<SemanticIndexStats> {
    this.assertEnabled();
    if (this.building) throw new Error("Semantic index is already building.");
    this.building = true;
    try {
      return await this.enqueueMutation(() => this.rebuildNow(onProgress));
    } finally {
      this.building = false;
    }
  }

  private async rebuildNow(onProgress?: (indexed: number, total: number) => void): Promise<SemanticIndexStats> {
    this.assertEnabled();
    const files = this.getArticleFiles().sort((left, right) => left.path.localeCompare(right.path));
    const grouped = groupFilesByShard(files);
    const key = currentModelKey(this.settings);
    const model = { ...this.settings.embeddingModel };
    const build = await this.getOrCreateBuild(key);
    const completed = new Map(build.shards.map((record) => [record.id, record]));
    const records: PersistedShardRecord[] = [];
    let dimension = 0;
    let indexed = 0;

    for (const [shardId, shardFiles] of grouped) {
      const saved = completed.get(shardId);
      const loaded = saved ? await this.loadShard(build.generation, saved, key) : null;
      if (loaded && shardMatchesFiles(loaded, shardFiles)) {
        const loadedDimension = loaded.articles.flatMap((article) => article.chunks)[0]?.embedding.length ?? 0;
        dimension = mergeDimension(dimension, loadedDimension);
        records.push(saved!);
        indexed += shardFiles.length;
        onProgress?.(indexed, files.length);
        continue;
      }
      if (saved) await this.removeShardFiles(build.generation, saved);

      const articles: ShardArticle[] = [];
      for (const file of shardFiles) {
        const path = file.path;
        const mtime = file.stat.mtime;
        const chunks = await this.embedFile(file, [], model);
        if (file.path !== path || this.app.vault.getAbstractFileByPath(path) !== file) {
          indexed += 1;
          onProgress?.(indexed, files.length);
          continue;
        }
        dimension = mergeDimension(dimension, chunks[0]?.embedding.length ?? 0);
        articles.push({
          path,
          title: file.basename,
          mtime,
          chunks: chunks.map((chunk) => chunk.mtime === mtime ? chunk : { ...chunk, mtime })
        });
        indexed += 1;
        onProgress?.(indexed, files.length);
      }
      const record = await this.writeShard(build.generation, shardId, key, articles, dimension);
      records.push(record);
      await this.app.vault.adapter.write(this.buildPointerPath, JSON.stringify({
        version: 3, modelKey: key, generation: build.generation,
        shards: records.slice().sort((left, right) => left.id.localeCompare(right.id))
      } satisfies BuildPointer));
    }

    if (currentModelKey(this.settings) !== key) throw new Error("索引配置在构建期间已更改，请重新构建。");
    const previousGeneration = this.data.generation;
    const next: PersistedSemanticIndexV3 = {
      version: 3,
      modelKey: key,
      updatedAt: new Date().toISOString(),
      generation: build.generation,
      dimension,
      shards: records.sort((left, right) => left.id.localeCompare(right.id))
    };
    await this.saveManifest(next);
    this.data = next;
    this.unhealthyShards.clear();
    this.resetLoadedChunks();
    await removeIfExists(this.app.vault.adapter, this.buildPointerPath);
    if (previousGeneration && previousGeneration !== build.generation) {
      await removeDirectoryIfExists(this.app.vault.adapter, this.generationPath(previousGeneration));
    }
    return this.getStats();
  }

  refreshFile(file: TFile): Promise<void> { return this.enqueueMutation(() => this.refreshFileNow(file)); }

  private async refreshFileNow(file: TFile): Promise<void> {
    if (!this.data.generation || !this.isCompatible()) return;
    if (!this.isArticle(file)) return this.removePathNow(file.path);
    const model = { ...this.settings.embeddingModel };
    const { path } = file;
    const { mtime } = file.stat;
    const shardId = shardIdForPath(path);
    const loaded = await this.loadActiveShard(shardId);
    const previous = loaded.articles.find((article) => article.path === path);
    const chunks = await this.embedFile(file, previous?.chunks, model);
    if (chunks.length === 0 && !previous?.chunks.length) return;
    this.assertDimension(chunks);
    if (file.path !== path || file.stat.mtime !== mtime) return;
    if (this.app.vault.getAbstractFileByPath(path) !== file) return this.removePathNow(path);
    const articles = loaded.articles.filter((article) => article.path !== path);
    articles.push({ path, title: file.basename, mtime, chunks });
    await this.replaceShards(new Map([[shardId, { previous: loaded.record, articles }]]));
  }

  removePath(path: string): Promise<void> { return this.enqueueMutation(() => this.removePathNow(path)); }

  private async removePathNow(path: string): Promise<void> {
    if (!this.data.generation) return;
    const shardId = shardIdForPath(path);
    const record = this.findShard(shardId);
    if (!record) return;
    const loaded = await this.requireShard(record);
    if (!loaded.articles.some((article) => article.path === path)) return;
    await this.replaceShards(new Map([[
      shardId,
      { previous: record, articles: loaded.articles.filter((article) => article.path !== path) }
    ]]));
  }

  removeFolder(folderPath: string): Promise<void> { return this.enqueueMutation(() => this.removeFolderNow(folderPath)); }

  private async removeFolderNow(folderPath: string): Promise<void> {
    const prefix = `${folderPath.replace(/\/$/, "")}/`;
    const updates = new Map<string, { previous?: PersistedShardRecord; articles: ShardArticle[] }>();
    for (const record of this.data.shards) {
      const metadata = await this.readShardMetadata(this.data.generation, record, this.data.modelKey);
      if (!metadata?.articles.some((article) => article.path.startsWith(prefix))) continue;
      const loaded = await this.requireShard(record);
      updates.set(record.id, { previous: record, articles: loaded.articles.filter((article) => !article.path.startsWith(prefix)) });
    }
    await this.replaceShards(updates);
  }

  migratePath(oldPath: string, newPath: string): Promise<void> {
    return this.enqueueMutation(() => this.migratePathNow(oldPath, newPath));
  }

  private async migratePathNow(oldPath: string, newPath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(newPath);
    const oldRecord = this.findShard(shardIdForPath(oldPath));
    if (!oldRecord) {
      if (file instanceof TFile && this.isArticle(file)) await this.refreshFileNow(file);
      return;
    }
    await this.migratePaths(new Map([[oldPath, newPath]]));
  }

  migrateFolder(oldFolder: string, newFolder: string): Promise<void> {
    return this.enqueueMutation(() => this.migrateFolderNow(oldFolder, newFolder));
  }

  private async migrateFolderNow(oldFolder: string, newFolder: string): Promise<void> {
    const oldPrefix = `${oldFolder.replace(/\/$/, "")}/`;
    const newPrefix = `${newFolder.replace(/\/$/, "")}/`;
    const paths = new Map<string, string>();
    for (const record of this.data.shards) {
      const metadata = await this.readShardMetadata(this.data.generation, record, this.data.modelKey);
      for (const article of metadata?.articles ?? []) {
        if (article.path.startsWith(oldPrefix)) paths.set(article.path, `${newPrefix}${article.path.slice(oldPrefix.length)}`);
      }
    }
    await this.migratePaths(paths);
  }

  clear(): Promise<void> { return this.enqueueMutation(() => this.clearNow()); }

  private async clearNow(): Promise<void> {
    const activeGeneration = this.data.generation;
    const build = await this.readBuildPointer();
    this.data = cloneEmptyIndex();
    this.unhealthyShards.clear();
    this.resetLoadedChunks();
    await removeIfExists(this.app.vault.adapter, this.indexPath);
    await removeIfExists(this.app.vault.adapter, this.buildPointerPath);
    if (activeGeneration) await removeDirectoryIfExists(this.app.vault.adapter, this.generationPath(activeGeneration));
    if (build?.generation && build.generation !== activeGeneration) {
      await removeDirectoryIfExists(this.app.vault.adapter, this.generationPath(build.generation));
    }
  }

  async findRelated(file: TFile, limit = 5): Promise<RelatedNote[]> {
    if (limit <= 0) return [];
    let matches: SemanticNoteMatch[] = [];
    if (this.isReady()) {
      try {
        await this.ensureChunksLoaded();
        const indexedSource = this.chunks.filter((chunk) => chunk.path === file.path);
        const sourceChunks = indexedSource.length > 0 && indexedSource[0].mtime === file.stat.mtime
          ? indexedSource : await this.embedFile(file, indexedSource);
        this.assertDimension(sourceChunks);
        matches = searchSemanticChunks(
          this.chunks, sourceChunks.map((chunk) => chunk.embedding), Math.max(40, limit * 12), file.path
        ).map(({ chunk, score }) => ({ path: chunk.path, similarity: score }));
      } catch {
        matches = [];
      }
    }
    return rankRelevantNotes(this.app, file, matches, this.settings, limit);
  }

  async searchContext(query: string, excludedPath?: string, limit = 5): Promise<string> {
    if (!this.isReady() || !query.trim()) return "";
    await this.ensureChunksLoaded();
    const [raw] = await this.transport.embed(this.settings.embeddingModel, [query.trim()]);
    const embedding = normalizeEmbedding(raw);
    this.assertDimension([{ embedding }]);
    const hits = searchSemanticChunks(this.chunks, [embedding], limit * 2, excludedPath);
    const passages: string[] = [];
    for (const hit of hits) {
      const file = this.app.vault.getAbstractFileByPath(hit.chunk.path);
      if (!(file instanceof TFile)) continue;
      const markdown = await this.app.vault.cachedRead(file);
      const passage = pickArticlePassage(chunkArticle(file.path, file.basename, markdown, file.stat.mtime), query);
      if (!passage) continue;
      passages.push([
        `[检索来源 ${passages.length + 1}: ${passage.path}${passage.heading ? ` > ${passage.heading}` : ""}]`,
        excerptFromChunk(passage, 1200)
      ].join("\n"));
      if (passages.length >= limit) break;
    }
    return passages.join("\n\n");
  }

  private async embedFile(file: TFile, indexed: SemanticChunk[] = [], model = { ...this.settings.embeddingModel }): Promise<SemanticChunk[]> {
    const mtime = file.stat.mtime;
    const markdown = await this.app.vault.cachedRead(file);
    const chunks = chunkArticleSummary(file.path, file.basename, markdown, mtime);
    if (chunks.length === indexed.length && chunks.every((chunk, index) => chunk.content === indexed[index].content)) {
      return chunks.map((chunk, index) => ({ ...chunk, embedding: indexed[index].embedding }));
    }
    for (let start = 0; start < chunks.length; start += EMBEDDING_BATCH_SIZE) {
      const batch = chunks.slice(start, start + EMBEDDING_BATCH_SIZE);
      const vectors = await this.transport.embed(model, batch.map((chunk) => chunk.content));
      if (vectors.length !== batch.length) throw new Error("Embedding endpoint returned an unexpected number of vectors.");
      vectors.forEach((vector, index) => { batch[index].embedding = normalizeEmbedding(vector); });
    }
    return chunks;
  }

  private async ensureChunksLoaded(): Promise<void> {
    if (this.chunksLoaded) return;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      const chunks: SemanticChunk[] = [];
      for (const record of this.data.shards) {
        const loaded = await this.loadShard(this.data.generation, record, this.data.modelKey);
        if (!loaded) {
          this.markUnhealthy(record);
          continue;
        }
        const loadedDimension = loaded.articles.find((article) => article.chunks.length > 0)?.chunks[0].embedding.length ?? 0;
        if (record.chunks > 0 && loadedDimension !== this.data.dimension) {
          this.markUnhealthy(record);
          continue;
        }
        this.unhealthyShards.delete(record.id);
        for (const article of loaded.articles) chunks.push(...article.chunks);
      }
      this.chunks = chunks;
      this.chunksLoaded = true;
    })();
    try { await this.loadPromise; } finally { this.loadPromise = null; }
  }

  private async getOrCreateBuild(key: string): Promise<BuildPointer> {
    const existing = await this.readBuildPointer();
    if (existing?.generation === this.data.generation) {
      await removeIfExists(this.app.vault.adapter, this.buildPointerPath);
    } else if (existing?.modelKey === key && await this.app.vault.adapter.exists(this.generationPath(existing.generation))) {
      return existing;
    } else if (existing?.generation) {
      await removeDirectoryIfExists(this.app.vault.adapter, this.generationPath(existing.generation));
    }
    const pointer: BuildPointer = { version: 3, modelKey: key, generation: createGenerationId(), shards: [] };
    await ensureDirectory(this.app.vault.adapter, this.storageRoot);
    await ensureDirectory(this.app.vault.adapter, this.generationPath(pointer.generation));
    await this.app.vault.adapter.write(this.buildPointerPath, JSON.stringify(pointer));
    return pointer;
  }

  private async readBuildPointer(): Promise<BuildPointer | null> {
    try {
      if (!await this.app.vault.adapter.exists(this.buildPointerPath)) return null;
      const value = JSON.parse(await this.app.vault.adapter.read(this.buildPointerPath)) as Partial<BuildPointer>;
      return isBuildPointer(value) ? value : null;
    } catch { return null; }
  }

  private async writeShard(
    generation: string,
    shardId: string,
    key: string,
    inputArticles: ShardArticle[],
    expectedDimension: number
  ): Promise<PersistedShardRecord> {
    const articles = inputArticles.slice().sort((left, right) => left.path.localeCompare(right.path));
    const firstChunk = articles.find((article) => article.chunks.length > 0)?.chunks[0];
    const dimension = firstChunk?.embedding.length ?? expectedDimension;
    if (dimension > 0 && expectedDimension > 0 && dimension !== expectedDimension) {
      throw new Error("Embedding endpoint changed vector dimensions while building the index.");
    }
    for (const article of articles) this.assertArticleDimension(article, dimension);
    const revision = createRevisionId();
    const totalChunks = articles.reduce((total, article) => total + article.chunks.length, 0);
    const vectors = new Float32Array(totalChunks * dimension);
    let chunkStart = 0;
    const persistedArticles: PersistedShardArticle[] = articles.map((article) => {
      article.chunks.forEach((chunk, index) => vectors.set(chunk.embedding, (chunkStart + index) * dimension));
      const persisted: PersistedShardArticle = {
        path: article.path,
        title: article.title,
        mtime: article.mtime,
        chunkStart,
        chunkCount: article.chunks.length,
        vectorOffsetBytes: chunkStart * dimension * Float32Array.BYTES_PER_ELEMENT,
        vectorLengthBytes: article.chunks.length * dimension * Float32Array.BYTES_PER_ELEMENT,
        chunks: article.chunks.map((chunk) => ({ heading: chunk.heading, content: chunk.content }))
      };
      chunkStart += article.chunks.length;
      return persisted;
    });
    const shard: PersistedShard = {
      version: 3, modelKey: key, generation, shardId, revision, dimension, articles: persistedArticles
    };
    const record: PersistedShardRecord = {
      id: shardId, revision, articles: articles.length, chunks: totalChunks, byteLength: vectors.byteLength
    };
    const { meta, binary } = this.shardPaths(generation, record);
    await this.app.vault.adapter.write(meta, JSON.stringify(shard));
    await this.app.vault.adapter.writeBinary(binary, vectors.buffer);
    try {
      const written = await this.app.vault.adapter.readBinary(binary);
      if (written.byteLength !== record.byteLength) throw new Error(`Semantic shard ${shardId} failed binary length verification.`);
    } catch (error) {
      await Promise.allSettled([removeIfExists(this.app.vault.adapter, meta), removeIfExists(this.app.vault.adapter, binary)]);
      throw error;
    }
    return record;
  }

  private async loadShard(generation: string, record: PersistedShardRecord, key: string): Promise<LoadedShard | null> {
    try {
      const shard = await this.readShardMetadata(generation, record, key);
      if (!shard) return null;
      const { binary } = this.shardPaths(generation, record);
      if (!await this.app.vault.adapter.exists(binary)) return null;
      const buffer = await this.app.vault.adapter.readBinary(binary);
      if (buffer.byteLength !== record.byteLength || buffer.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) return null;
      const vectors = new Float32Array(buffer);
      if (vectors.length !== record.chunks * shard.dimension) return null;
      const articles: ShardArticle[] = shard.articles.map((article) => ({
        path: article.path,
        title: article.title,
        mtime: article.mtime,
        chunks: article.chunks.map((chunk, index) => ({
          id: `${article.path}#${index}`,
          path: article.path,
          title: article.title,
          heading: chunk.heading,
          content: chunk.content,
          embedding: vectors.subarray((article.chunkStart + index) * shard.dimension, (article.chunkStart + index + 1) * shard.dimension),
          mtime: article.mtime
        }))
      }));
      return { record, articles };
    } catch { return null; }
  }

  private async readShardMetadata(generation: string, record: PersistedShardRecord, key: string): Promise<PersistedShard | null> {
    try {
      const { meta } = this.shardPaths(generation, record);
      if (!await this.app.vault.adapter.exists(meta)) return null;
      const shard = JSON.parse(await this.app.vault.adapter.read(meta)) as Partial<PersistedShard>;
      return isShardV3(shard, generation, record, key) ? shard : null;
    } catch { return null; }
  }

  private async loadActiveShard(shardId: string): Promise<{ record?: PersistedShardRecord; articles: ShardArticle[] }> {
    const record = this.findShard(shardId);
    if (!record) return { articles: [] };
    const loaded = await this.requireShard(record);
    return { record, articles: loaded.articles };
  }

  private async requireShard(record: PersistedShardRecord): Promise<LoadedShard> {
    const loaded = await this.loadShard(this.data.generation, record, this.data.modelKey);
    const loadedDimension = loaded?.articles.find((article) => article.chunks.length > 0)?.chunks[0].embedding.length ?? 0;
    if (loaded && (record.chunks === 0 || loadedDimension === this.data.dimension)) {
      this.unhealthyShards.delete(record.id);
      return loaded;
    }
    this.markUnhealthy(record);
    throw new Error(`Semantic index shard ${record.id} is damaged or missing. Rebuild the semantic index to repair it.`);
  }

  private async replaceShards(replacements: Map<string, { previous?: PersistedShardRecord; articles: ShardArticle[] }>): Promise<void> {
    if (replacements.size === 0) return;
    const updates = new Map<string, ShardUpdate>();
    let dimension = this.data.dimension;
    try {
      for (const [shardId, replacement] of replacements) {
        const firstChunk = replacement.articles.find((article) => article.chunks.length)?.chunks[0];
        dimension = mergeDimension(dimension, firstChunk?.embedding.length ?? 0);
        const next = replacement.articles.length > 0
          ? await this.writeShard(this.data.generation, shardId, this.data.modelKey, replacement.articles, dimension)
          : undefined;
        updates.set(shardId, { previous: replacement.previous, next });
      }
      await this.commitShardUpdates(updates, dimension);
    } catch (error) {
      await Promise.allSettled(Array.from(updates.values()).flatMap((update) =>
        update.next ? [this.removeShardFiles(this.data.generation, update.next)] : []
      ));
      throw error;
    }
  }

  private async commitShardUpdates(updates: Map<string, ShardUpdate>, dimension: number): Promise<void> {
    const nextRecords = this.data.shards.filter((record) => !updates.has(record.id));
    for (const update of updates.values()) if (update.next) nextRecords.push(update.next);
    const next: PersistedSemanticIndexV3 = {
      ...this.data,
      dimension,
      updatedAt: new Date().toISOString(),
      shards: nextRecords.sort((left, right) => left.id.localeCompare(right.id))
    };
    await this.saveManifest(next);
    this.data = next;
    this.resetLoadedChunks();
    for (const [shardId, update] of updates) {
      this.unhealthyShards.delete(shardId);
      if (update.previous && update.previous.revision !== update.next?.revision) {
        await Promise.allSettled([this.removeShardFiles(this.data.generation, update.previous)]);
      }
    }
  }

  private async migratePaths(paths: Map<string, string>): Promise<void> {
    if (paths.size === 0) return;
    const touchedIds = new Set<string>();
    for (const [oldPath, newPath] of paths) {
      touchedIds.add(shardIdForPath(oldPath));
      if (isMarkdownInFolder({ path: newPath, extension: "md" }, this.settings.articlesFolder, this.settings.semanticIndexExcludeFolders)) {
        touchedIds.add(shardIdForPath(newPath));
      }
    }
    const loadedById = new Map<string, { record?: PersistedShardRecord; articles: ShardArticle[] }>();
    for (const shardId of touchedIds) loadedById.set(shardId, await this.loadActiveShard(shardId));

    const moved: ShardArticle[] = [];
    for (const [oldPath, newPath] of paths) {
      const source = loadedById.get(shardIdForPath(oldPath));
      const article = source?.articles.find((item) => item.path === oldPath);
      if (!article) continue;
      source!.articles = source!.articles.filter((item) => item.path !== oldPath);
      const target = this.app.vault.getAbstractFileByPath(newPath);
      if (!(target instanceof TFile) || !this.isArticle(target)) continue;
      moved.push({
        path: newPath,
        title: target.basename,
        mtime: target.stat.mtime,
        chunks: article.chunks.map((chunk, index) => ({
          ...chunk, id: `${newPath}#${index}`, path: newPath, title: target.basename, mtime: target.stat.mtime
        }))
      });
    }
    for (const article of moved) {
      const target = loadedById.get(shardIdForPath(article.path))!;
      target.articles = target.articles.filter((item) => item.path !== article.path).concat(article);
    }
    const replacements = new Map<string, { previous?: PersistedShardRecord; articles: ShardArticle[] }>();
    for (const [shardId, loaded] of loadedById) {
      replacements.set(shardId, { previous: loaded.record, articles: loaded.articles });
    }
    await this.replaceShards(replacements);
  }

  private findShard(shardId: string): PersistedShardRecord | undefined { return this.data.shards.find((record) => record.id === shardId); }

  private enqueueMutation<T>(work: () => Promise<T>): Promise<T> {
    const task = this.mutationQueue.then(work);
    this.mutationQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  private shardPaths(generation: string, record: Pick<PersistedShardRecord, "id" | "revision">): { meta: string; binary: string } {
    const base = `${this.generationPath(generation)}/shard-${record.id}-${record.revision}`;
    return { meta: normalizePath(`${base}.json`), binary: normalizePath(`${base}.bin`) };
  }

  private generationPath(generation: string): string { return normalizePath(`${this.storageRoot}/${generation}`); }
  private getArticleFiles(): TFile[] { return this.app.vault.getMarkdownFiles().filter((file) => this.isArticle(file)); }
  private isArticle(file: TFile): boolean { return isMarkdownInFolder(file, this.settings.articlesFolder, this.settings.semanticIndexExcludeFolders); }
  private markUnhealthy(record: PersistedShardRecord): void {
    this.unhealthyShards.set(record.id, this.data.modelKey.includes(`|source:${SUMMARY_INDEX_SOURCE}|`) ? record.chunks : record.articles);
  }
  private resetLoadedChunks(): void { this.chunks = []; this.chunksLoaded = false; this.loadPromise = null; }

  private assertArticleDimension(article: ShardArticle, dimension: number): void {
    if (article.chunks.some((chunk) => chunk.embedding.length !== dimension)) throw new Error("Embedding endpoint returned inconsistent dimensions.");
  }

  private assertDimension(chunks: Array<{ embedding: Float32Array }>): void {
    const dimension = chunks[0]?.embedding.length ?? 0;
    if (dimension > 0 && this.data.dimension > 0 && dimension !== this.data.dimension) {
      throw new Error("Embedding dimensions no longer match the saved index. Rebuild the semantic index.");
    }
    if (chunks.some((chunk) => chunk.embedding.length !== dimension)) throw new Error("Embedding endpoint returned inconsistent dimensions.");
  }

  private isCompatible(): boolean { return this.settings.embeddingModel.runtime !== "disabled" && this.data.modelKey === currentModelKey(this.settings); }
  private assertEnabled(): void { if (this.settings.embeddingModel.runtime === "disabled") throw new Error("请先在 AI Models 中配置 Embedding model。"); }

  private saveManifest(snapshot: PersistedSemanticIndexV3): Promise<void> {
    const content = JSON.stringify(snapshot);
    const task = this.saveQueue.then(() => this.app.vault.adapter.write(normalizePath(this.indexPath), content));
    this.saveQueue = task.catch(() => {});
    return task;
  }

  private async removeShardFiles(generation: string, record: PersistedShardRecord): Promise<void> {
    const { meta, binary } = this.shardPaths(generation, record);
    await Promise.all([removeIfExists(this.app.vault.adapter, meta), removeIfExists(this.app.vault.adapter, binary)]);
  }
}

function currentModelKey(settings: KnowFlowSettings): string {
  const scope = settings.articlesFolder.trim().replace(/^\/+|\/+$/g, "");
  const excluded = settings.semanticIndexExcludeFolders.map((folder) => folder.trim()).filter(Boolean).sort().join(",");
  return `${scope}|exclude:${excluded}|dims:0|shards:${SHARD_COUNT}|source:${SUMMARY_INDEX_SOURCE}|${modelKey(settings.embeddingModel)}`;
}

function modelKey(config: AiModelConfig): string { return `${config.runtime}|${config.apiBaseUrl.trim().replace(/\/+$/g, "")}|${config.model.trim()}`; }
function cloneEmptyIndex(): PersistedSemanticIndexV3 { return { ...EMPTY_INDEX, shards: [] }; }
function createGenerationId(): string { return `gen-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`; }
function createRevisionId(): string { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }

function shardIdForPath(path: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < path.length; index += 1) {
    hash ^= path.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return String((hash >>> 0) % SHARD_COUNT).padStart(3, "0");
}

function groupFilesByShard(files: TFile[]): Array<[string, TFile[]]> {
  const grouped = new Map<string, TFile[]>();
  for (const file of files) {
    const id = shardIdForPath(file.path);
    grouped.set(id, [...(grouped.get(id) ?? []), file]);
  }
  return Array.from(grouped.entries()).sort(([left], [right]) => left.localeCompare(right));
}

function mergeDimension(current: number, candidate: number): number {
  if (candidate === 0) return current;
  if (current > 0 && current !== candidate) throw new Error("Embedding endpoint changed vector dimensions while building the index.");
  return candidate;
}

function shardMatchesFiles(shard: LoadedShard, files: TFile[]): boolean {
  if (shard.articles.length !== files.length) return false;
  const expected = new Map(files.map((file) => [file.path, file.stat.mtime]));
  return shard.articles.every((article) => expected.get(article.path) === article.mtime);
}

function isManifestV3(value: Partial<PersistedSemanticIndexV3>): value is PersistedSemanticIndexV3 {
  return value.version === 3 && typeof value.modelKey === "string" && typeof value.updatedAt === "string"
    && typeof value.generation === "string" && isNonNegativeInteger(value.dimension) && Array.isArray(value.shards)
    && value.shards.every(isShardRecord);
}

function isBuildPointer(value: Partial<BuildPointer>): value is BuildPointer {
  return value.version === 3 && typeof value.modelKey === "string" && typeof value.generation === "string"
    && Array.isArray(value.shards) && value.shards.every(isShardRecord);
}

function isShardRecord(value: unknown): value is PersistedShardRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<PersistedShardRecord>;
  return typeof record.id === "string" && typeof record.revision === "string"
    && isNonNegativeInteger(record.articles) && isNonNegativeInteger(record.chunks) && isNonNegativeInteger(record.byteLength);
}

function isShardV3(value: Partial<PersistedShard>, generation: string, record: PersistedShardRecord, key: string): value is PersistedShard {
  if (value.version !== 3 || value.modelKey !== key || value.generation !== generation
    || value.shardId !== record.id || value.revision !== record.revision
    || !isNonNegativeInteger(value.dimension) || !Array.isArray(value.articles)
    || value.articles.length !== record.articles
    || record.byteLength !== record.chunks * value.dimension * Float32Array.BYTES_PER_ELEMENT) return false;
  let expectedStart = 0;
  for (const article of value.articles) {
    if (!article || typeof article.path !== "string" || typeof article.title !== "string" || typeof article.mtime !== "number"
      || article.chunkStart !== expectedStart || !isNonNegativeInteger(article.chunkCount)
      || article.vectorOffsetBytes !== article.chunkStart * value.dimension * Float32Array.BYTES_PER_ELEMENT
      || article.vectorLengthBytes !== article.chunkCount * value.dimension * Float32Array.BYTES_PER_ELEMENT
      || !Array.isArray(article.chunks) || article.chunks.length !== article.chunkCount
      || !article.chunks.every((chunk) => Boolean(chunk) && typeof chunk.heading === "string" && typeof chunk.content === "string")) return false;
    expectedStart += article.chunkCount;
  }
  return expectedStart === record.chunks;
}

function isNonNegativeInteger(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value >= 0; }
async function ensureDirectory(adapter: DataAdapter, path: string): Promise<void> { if (!await adapter.exists(path)) await adapter.mkdir(path); }
async function removeIfExists(adapter: DataAdapter, path: string): Promise<void> { if (await adapter.exists(path)) await adapter.remove(path); }
async function removeDirectoryIfExists(adapter: DataAdapter, path: string): Promise<void> { if (await adapter.exists(path)) await adapter.rmdir(path, true); }

function excerptFromChunk(chunk: SemanticChunk, maxChars = 240): string {
  const body = chunk.content.replace(/^标题：.*\n小节：.*\n\n/, "").replace(/\s+/g, " ").trim();
  return body.length > maxChars ? `${body.slice(0, maxChars).trimEnd()}…` : body;
}
