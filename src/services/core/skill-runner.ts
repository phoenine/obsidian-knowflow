import type { SkillStore } from "./skill-store";
import { readLegacyRepairSkill } from "../clipping/repair-skill";
import articleFreshness from "../../../skills/article-freshness/SKILL.md" with { type: "text" };
import articleQuiz from "../../../skills/article-quiz/SKILL.md" with { type: "text" };
import articleSummary from "../../../skills/article-summary/SKILL.md" with { type: "text" };
import articleSummaryQuality from "../../../skills/article-summary/references/output-quality.md" with { type: "text" };
import articleTranslation from "../../../skills/article-translation/SKILL.md" with { type: "text" };
import clippingUpdate from "../../../skills/clipping-update/SKILL.md" with { type: "text" };
import knowledgePoints from "../../../skills/knowledge-points/SKILL.md" with { type: "text" };
import obsidianMarkdown from "../../../skills/obsidian-markdown/SKILL.md" with { type: "text" };
import obsidianRenderIntegrity from "../../../skills/obsidian-render-integrity/SKILL.md" with { type: "text" };

const BUILTIN_SKILLS = {
  "clipping-update": [clippingUpdate, obsidianMarkdown, obsidianRenderIntegrity].map(skillBody).join("\n\n"),
  "article-summary": [articleSummary, articleSummaryQuality].map(skillBody).join("\n\n"),
  "article-translation": skillBody(articleTranslation),
  "knowledge-points": skillBody(knowledgePoints),
  "article-quiz": skillBody(articleQuiz),
  "article-freshness": skillBody(articleFreshness)
} as const;

export type SkillId = keyof typeof BUILTIN_SKILLS;

/** Resolves a skill once per run. The caller supplies the built-in handler and tool boundaries. */
export class SkillRunner {
  constructor(private store: SkillStore, private vault?: Parameters<typeof readLegacyRepairSkill>[0]) {}

  async run<T>(name: SkillId, execute: (instructions: string) => Promise<T>): Promise<T> {
    const custom = (await this.store.read(name))?.trim();
    if (name !== "clipping-update") return execute(custom || BUILTIN_SKILLS[name]);

    const legacy = custom || (await this.store.read("clipping-repair"))?.trim()
      || (this.vault ? await readLegacyRepairSkill(this.vault) : null);
    return execute([BUILTIN_SKILLS[name], legacy].filter(Boolean).join("\n\n"));
  }
}

function skillBody(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "").trim();
}
