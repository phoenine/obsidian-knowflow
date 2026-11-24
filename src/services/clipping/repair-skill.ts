import { TFile } from "obsidian";
import type { Vault } from "obsidian";

/**
 * Load user skill file from vault (if it exists), return content or null.
 */
export async function readLegacyRepairSkill(vault: Vault): Promise<string | null> {
  const file = vault.getAbstractFileByPath("skills/clipping-repair.md");
  if (!(file instanceof TFile)) return null;
  const content = (await vault.cachedRead(file)).replace(/\r\n/g, "\n");
  const sections = [...content.matchAll(/^(允许|禁止)[ \t]*[:：][ \t]*\n((?:(?!^(?:允许|禁止)[ \t]*[:：])[^\n]+\n?)*)/gm)];
  return sections.map((section) => `${section[1]}：\n${section[2].trim()}`).join("\n\n");
}
