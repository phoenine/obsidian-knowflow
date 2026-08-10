import { TFile } from "obsidian";
import type { App } from "obsidian";
import { applyLearningCompletionFrontmatter } from "./frontmatter-rules";
import { NoteOperationCoordinator } from "./note-operation-coordinator";

export class ArticleLearningService {
  constructor(
    private app: App,
    private noteOperations: NoteOperationCoordinator
  ) {}

  async markComplete(file: TFile, learningDate: string): Promise<void> {
    await this.noteOperations.runExclusive(file.path, async () => {
      const content = await this.app.vault.read(file);
      const next = applyLearningCompletionFrontmatter(content, learningDate);
      if (next !== content) await this.app.vault.modify(file, next);
    });
  }
}
