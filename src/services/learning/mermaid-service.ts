import { Notice, TFile } from "obsidian";
import type { App } from "obsidian";
import type { AiService } from "../ai/ai-service";
import { NoteOperationCoordinator } from "../core/note-operation-coordinator";
import { findSummaryCalloutEndIndex } from "./summary-notes";

export class MermaidService {
  constructor(
    private app: App,
    private ai: AiService,
    private noteOperations: NoteOperationCoordinator
  ) {}

  async generateForFile(file: TFile): Promise<void> {
    const content = await this.app.vault.read(file);
    const mermaid = await this.ai.generateKnowledgeMap(file.basename, content);
    await this.noteOperations.runExclusive(file.path, async () => {
      const current = await this.app.vault.read(file);
      const nextContent = upsertKnowledgeMap(current, mermaid);
      if (nextContent !== current) await this.app.vault.modify(file, nextContent);
    });
    new Notice("KnowFlow: Mermaid knowledge map inserted");
  }
}

function upsertKnowledgeMap(content: string, mermaid: string): string {
  const block = `## Knowledge Map\n\n\`\`\`mermaid\n${mermaid}\n\`\`\``;
  const normalized = content.replace(/\r\n/g, "\n");
  const sectionPattern = /^## (?:Knowledge Map|知识骨架)\s*\n[\s\S]*?(?=^##\s|(?![\s\S]))/mi;

  if (sectionPattern.test(normalized)) {
    return `${normalized.trimEnd().replace(sectionPattern, block)}\n`;
  }

  const summaryEnd = findSummaryCalloutEndIndex(normalized);
  if (summaryEnd !== null) {
    const before = normalized.slice(0, summaryEnd).replace(/\n+$/, "");
    const after = normalized.slice(summaryEnd).replace(/^\n+/, "");
    return after ? `${before}\n\n${block}\n\n${after}\n` : `${before}\n\n${block}\n`;
  }

  const firstSection = /^##\s+/m.exec(normalized);
  if (firstSection?.index !== undefined) {
    const before = normalized.slice(0, firstSection.index).replace(/\n+$/, "");
    const after = normalized.slice(firstSection.index).replace(/^\n+/, "");
    return before ? `${before}\n\n${block}\n\n${after}\n` : `${block}\n\n${after}\n`;
  }

  return `${normalized.trimEnd()}\n\n${block}\n`;
}
