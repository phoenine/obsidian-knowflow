import type { App, TFile } from "obsidian";
import { applyLearningCompletionFrontmatter } from "../clipping/frontmatter-rules";
import { NoteOperationCoordinator } from "../core/note-operation-coordinator";

export class ArticleLearningService {
  constructor(
    private app: App,
    private noteOperations: NoteOperationCoordinator
  ) {}

  async markComplete(file: TFile, learningDate: string): Promise<void> {
    await this.noteOperations.runExclusive(file.path, () =>
      this.app.vault.process(file, (current) => applyLearningCompletionFrontmatter(current, learningDate))
    );
  }
}
