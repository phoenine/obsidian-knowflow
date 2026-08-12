import { Notice, TFile } from "obsidian";
import type { App } from "obsidian";
import type KnowFlowPlugin from "../../main";
import type { NoteSummary } from "../../types";
import type { SummaryText } from "../../services/learning/summary-notes";

interface CachedSummaryText {
  mtime: number;
  text: SummaryText | null;
}

export class SummaryController {
  private pending = new Set<string>();
  private errors = new Map<string, string>();
  private streamingTexts = new Map<string, string>();
  private streamingReasonings = new Map<string, string>();
  private textCache = new WeakMap<TFile, CachedSummaryText>();
  private textLoads = new WeakMap<TFile, Promise<SummaryText | null>>();

  constructor(
    private app: App,
    private plugin: KnowFlowPlugin,
    private onStateChange: (filePath: string) => void
  ) {}

  isPending(filePath: string): boolean {
    return this.pending.has(filePath);
  }

  getError(filePath: string): string | undefined {
    return this.errors.get(filePath);
  }

  getStreamingText(filePath: string): string | undefined {
    return this.streamingTexts.get(filePath);
  }

  getStreamingReasoning(filePath: string): string | undefined {
    return this.streamingReasonings.get(filePath);
  }

  getSummaryText(file: TFile): SummaryText | null | undefined {
    const cached = this.getCachedText(file);
    if (cached !== undefined) return cached;
    void this.refreshText(file);
    return undefined;
  }

  cacheText(file: TFile, text: SummaryText | null): void {
    this.textCache.set(file, { mtime: file.stat.mtime, text });
  }

  async ensureSummary(
    file: TFile,
    force: boolean,
    handlers: {
      onDelta: (visible: string, reasoning: string) => void;
      onSuccess: (summary: NoteSummary) => void;
    }
  ): Promise<void> {
    if (this.pending.has(file.path)) return;
    if (!force && await this.readText(file)) return;
    this.pending.add(file.path);
    this.errors.delete(file.path);
    this.clearStreaming(file.path);
    this.onStateChange(file.path);
    try {
      const content = await this.app.vault.read(file);
      const summary = await this.plugin.ai.summarizeStream(
        file.path,
        file.basename,
        content,
        this.plugin.settings.defaultArticleCategory,
        ({ content: fullText, reasoning }) => {
          const visible = extractVisibleText(fullText);
          this.streamingTexts.set(file.path, visible);
          this.streamingReasonings.set(file.path, reasoning);
          handlers.onDelta(visible, reasoning);
        }
      );
      await this.plugin.summaryNotes.applySummary(
        file,
        { summary: summary.summary, reason: summary.reason },
        {
          description: summary.briefDescription,
          readingValue: summary.readingValue,
          category: summary.category,
          tags: summary.tags
        }
      );
      this.cacheText(file, { summary: summary.summary, reason: summary.reason });
      handlers.onSuccess(summary);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.errors.set(file.path, message);
      new Notice(`KnowFlow summary failed: ${message}`, 8000);
    } finally {
      this.clearStreaming(file.path);
      this.pending.delete(file.path);
      this.onStateChange(file.path);
    }
  }

  private getCachedText(file: TFile): SummaryText | null | undefined {
    const cached = this.textCache.get(file);
    return cached?.mtime === file.stat.mtime ? cached.text : undefined;
  }

  private readText(file: TFile): Promise<SummaryText | null> {
    const cached = this.getCachedText(file);
    if (cached !== undefined) return Promise.resolve(cached);
    const pending = this.textLoads.get(file);
    if (pending) return pending;
    const mtime = file.stat.mtime;
    const load = this.plugin.summaryNotes.loadSummaryText(file)
      .then((text) => {
        this.textCache.set(file, { mtime, text });
        return text;
      })
      .finally(() => this.textLoads.delete(file));
    this.textLoads.set(file, load);
    return load;
  }

  private async refreshText(file: TFile): Promise<void> {
    await this.readText(file);
    this.onStateChange(file.path);
  }

  private clearStreaming(filePath: string): void {
    this.streamingTexts.delete(filePath);
    this.streamingReasonings.delete(filePath);
  }
}

function extractVisibleText(raw: string): string {
  if (!raw) return "";
  return raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/[{}\[\]]/g, "\n")
    .replace(/"\w+":\s*"/g, "")
    .replace(/",?\s*$/gm, "")
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, "\"")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
