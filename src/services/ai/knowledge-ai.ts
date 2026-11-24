import type { AiModelConfig, KnowledgePointGroup } from "../../types";
import { AiTransport } from "./ai-transport";
import { normalizeKnowledgePointGroups } from "../learning/knowledge-points";
import { prepareArticleForAi } from "../clipping/managed-content";

interface KnowledgePointsResponse {
  groups: unknown[];
}

export class KnowledgeAi {
  constructor(private transport: AiTransport) {}

  async generateKnowledgePoints(config: AiModelConfig, title: string, content: string): Promise<KnowledgePointGroup[]> {
    const payload = await this.transport.requestJson<KnowledgePointsResponse>(config, [
      {
        role: "system",
        content: "按 Skill 提取文章知识点。只输出严格 JSON，不要输出 Markdown。"
      },
      {
        role: "user",
        content: JSON.stringify({
          articleTitle: title,
          article: prepareArticleForAi(content),
          requiredJsonShape: {
            groups: [{
              title: "分组标题",
              points: [{
                slug: "简短且稳定的英文 kebab-case 标识",
                title: "完整知识结论",
                type: "概念 | 机制 | 对比 | 流程 | 原则 | 实践",
                explanation: "核心解释",
                evidence: { section: "原文章节标题", excerpt: "原文逐字引用" },
                question: "开放式检验问题",
                relations: { dependsOn: ["其他知识点 slug"], extends: ["其他知识点 slug"] }
              }]
            }]
          }
        })
      }
    ]);
    const article = prepareArticleForAi(content);
    const groups = normalizeKnowledgePointGroups(payload)
      .map((group) => ({
        ...group,
        points: group.points.filter((point) => sourceContainsQuote(article, point.evidence.excerpt))
      }))
      .filter((group) => group.points.length > 0);
    const ids = new Set(groups.flatMap((group) => group.points).map((point) => point.id));
    for (const point of groups.flatMap((group) => group.points)) {
      point.relations.dependsOn = point.relations.dependsOn.filter((id) => id !== point.id && ids.has(id));
      point.relations.extends = point.relations.extends.filter((id) => id !== point.id && ids.has(id));
    }
    if (groups.flatMap((group) => group.points).length === 0) {
      throw new Error("AI did not return valid knowledge points.");
    }
    return groups;
  }
}

function sourceContainsQuote(content: string, quote: string): boolean {
  const normalizedQuote = normalizeSourceText(quote);
  return normalizedQuote.length >= 4 && normalizeSourceText(content).includes(normalizedQuote);
}

function normalizeSourceText(value: string): string {
  return value
    .replace(/[`*_~=<>{}\[\]()#>|]/g, "")
    .replace(/\s+/g, "")
    .toLocaleLowerCase();
}
