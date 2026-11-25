import { Notice, type App, type TFile } from "obsidian";
import type KnowFlowPlugin from "../../main";
import { parseSummaryCallout, type SummaryText } from "../../services/learning/summary-notes";
import { t } from "../../i18n";

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
    if (!this.pending.has(file.path)) void this.refreshText(file);
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
    }
  ): Promise<void> {
    const path = file.path;
    if (this.pending.has(path) || (!force && this.getCachedText(file))) return;
    this.pending.add(path);
    this.errors.delete(path);
    this.clearStreaming(path);
    this.onStateChange(path);
    try {
      const content = await this.app.vault.read(file);
      if (!force) {
        const existing = parseSummaryCallout(content);
        if (existing) {
          this.cacheText(file, existing);
          return;
        }
      }
      const summary = await this.plugin.ai.summarizeStream(
        path,
        file.basename,
        content,
        ({ content: preview, reasoning }) => {
          this.streamingTexts.set(path, preview);
          this.streamingReasonings.set(path, reasoning);
          handlers.onDelta(preview, reasoning);
        }
      );
      await this.plugin.summaryNotes.applySummary(
        file,
        { summary: summary.summary, reason: summary.reason },
        undefined,
        path
      );
      this.cacheText(file, { summary: summary.summary, reason: summary.reason });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.errors.set(path, message);
      new Notice(t("summaryFailedNotice", { message }), 8000);
    } finally {
      this.clearStreaming(path);
      this.pending.delete(path);
      this.onStateChange(path);
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
