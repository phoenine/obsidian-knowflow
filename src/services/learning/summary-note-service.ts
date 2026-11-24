import type { App, TFile } from "obsidian";
import { applySummaryFrontmatter, type SummaryFrontmatterData } from "../clipping/frontmatter-rules";
import { NoteOperationCoordinator } from "../core/note-operation-coordinator";
import { parseSummaryCallout, upsertSummaryCallout, type SummaryText } from "./summary-notes";

/**
 * Bridges the pure summary-notes.ts/frontmatter-rules.ts markdown logic
 * with the vault. Unlike quizzes, a summary is written straight into the
 * source note's own body (as a collapsed callout) and frontmatter rather
 * than a separate note, so there's no index to maintain — the note itself
 * is the only thing to look up.
 */
export class SummaryNoteService {
  constructor(
    private app: App,
    private noteOperations: NoteOperationCoordinator
  ) {}

  /** Applies only the metadata fields supplied alongside the summary. */
  async applySummary(
    file: TFile,
    text: SummaryText,
    meta?: Partial<SummaryFrontmatterData>,
    path = file.path
  ): Promise<void> {
    await this.noteOperations.runExclusive(path, async () => {
      if (file.path !== path || this.app.vault.getAbstractFileByPath(path) !== file) {
        throw new Error("文章已移动或删除，请重新生成摘要。");
      }
      await this.app.vault.process(file, (current) => {
        const withFrontmatter = meta ? applySummaryFrontmatter(current, meta) : current;
        return upsertSummaryCallout(withFrontmatter, text);
      });
    });
  }

  async loadSummaryText(file: TFile): Promise<SummaryText | null> {
    const content = await this.app.vault.cachedRead(file);
    return parseSummaryCallout(content);
  }
}
