import { parseYaml, TFile } from "obsidian";
import type { Vault } from "obsidian";

const SKILL_ROOT = "skills";
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class SkillStore {
  constructor(private vault: Vault) {}

  async read(name: string): Promise<string | null> {
    const file = this.vault.getAbstractFileByPath(this.path(name));
    if (!file) return null;
    if (!(file instanceof TFile)) throw new Error(`Skill 路径被占用：${file.path}`);
    const content = (await this.vault.cachedRead(file)).replace(/\r\n/g, "\n");
    const header = /^(?:\uFEFF)?---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(content);
    if (!header) throw new Error(`${file.path} 缺少 YAML frontmatter。`);
    const metadata: unknown = parseYaml(header[1]);
    if (!metadata || typeof metadata !== "object" || !("name" in metadata) || metadata.name !== name
      || !("description" in metadata) || typeof metadata.description !== "string"
      || !metadata.description.trim() || metadata.description.length > 1024) {
      throw new Error(`${file.path} 需要匹配目录的 name 和有效的 description。`);
    }
    return content.slice(header[0].length).trim();
  }

  private path(name: string): string {
    if (name.length > 64 || !SKILL_NAME.test(name)) {
      throw new Error("Skill 名称请使用 1–64 个小写字母、数字或单个连字符，首尾须为字母或数字。");
    }
    return `${SKILL_ROOT}/${name}/SKILL.md`;
  }
}
