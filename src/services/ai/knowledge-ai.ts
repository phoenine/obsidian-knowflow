import type { AiModelConfig, KnowledgePointGroup } from "../../types";
import { AiTransport } from "./ai-transport";
import { normalizeKnowledgePointGroups } from "../learning/knowledge-points";
import { prepareArticleForAi } from "../clipping/managed-content";

interface KnowledgeMapResponse {
  diagramType: "radar" | "timeline" | "mindmap";
  mermaid: string;
}

interface KnowledgePointsResponse {
  groups: unknown[];
}

export class KnowledgeAi {
  constructor(private transport: AiTransport) {}

  async generateKnowledgePoints(config: AiModelConfig, title: string, content: string): Promise<KnowledgePointGroup[]> {
    const payload = await this.transport.requestJson<KnowledgePointsResponse>(config, [
      {
        role: "system",
        content: [
          "你是 KnowFlow 的文章知识点提取器。只提取文章中可解释、可追溯、可检验的核心知识，不要把目录、背景信息或宽泛主题当作知识点。",
          "每个 title 必须是一句完整、可判断真假的结论，不得只写名词或章节标题。",
          "type 只能是：概念、机制、对比、流程、原则、实践。",
          "explanation 用 1-2 段解释结论成立的原因和作用，不重复大段原文。",
          "evidence.section 必须对应文章中的章节标题；evidence.excerpt 必须逐字引用文章中的关键依据，不得编造。",
          "question 是一个开放式理解检验问题，不是选择题。",
          "relations 只在关系明确时填写；dependsOn 和 extends 使用目标知识点的 slug。",
          "将知识点组织为 2-5 个有意义的分组，每组标题采用『关注边界 · 主题』或同等清晰的结构。",
          "每篇文章提取 4-12 个核心知识点。只输出严格 JSON，不要输出 Markdown。"
        ].join("\n")
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

  async generateKnowledgeMap(config: AiModelConfig, title: string, content: string): Promise<string> {
    const payload = await this.transport.requestJson<KnowledgeMapResponse>(config, [
      {
        role: "system",
        content: [
          "你是 KnowFlow 的文章知识骨架设计器。完整理解文章后生成一张适合 Obsidian 的 Mermaid 图。",
          "自动选择图形：叙事、因果链、多线论述默认使用 radar；明确时间演进且只有 2-4 个短阶段时使用 timeline；纯分类或层级结构才使用 mindmap。",
          "radar 使用 graph LR 的 hub-and-spoke：中心节点必须使用显式 ID H((\"中心主题\"))，连接 3-4 个阶段节点，详情节点用虚线连接。",
          "radar 的阶段节点使用红、橙、紫、绿四色；详情节点使用同色系浅色。",
          "详情节点用有序短句和 <br/> 换行，数字后不能有空格，例如 1.发现；不要使用 HTML div。",
          "timeline 最多 4 段；4 段时每段不超过 15 个中文字符，3 段时不超过 25 个中文字符；不使用 <br/> 或内部箭头。",
          "mindmap 只保留清晰的分类层级，避免层级过深和长句。",
          "节点文字必须简洁；引号使用『』，括号使用「」；所有被连接或 style 引用的节点都必须有显式 ID。",
          "style 只能使用 fill、stroke、color、stroke-width、stroke-dasharray，禁止 text-align。",
          "只输出严格 JSON，不要输出 Markdown 围栏、标题或解释。"
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          title,
          article: prepareArticleForAi(content),
          requiredJsonShape: {
            diagramType: "radar | timeline | mindmap",
            mermaid: "完整 Mermaid 源码，不含 ```mermaid 围栏"
          }
        })
      }
    ]);
    return normalizeKnowledgeMapResponse(payload);
  }
}

function normalizeKnowledgeMapResponse(value: KnowledgeMapResponse): string {
  if (typeof value.mermaid !== "string" || !value.mermaid.trim()) {
    throw new Error("AI did not return Mermaid source.");
  }
  const mermaid = value.mermaid
    .trim()
    .replace(/^```(?:mermaid)?\s*\n([\s\S]*?)\n```$/i, "$1")
    .trim();
  if (!/^(?:graph\s+(?:LR|TB)|timeline|mindmap)\b/.test(mermaid)) {
    throw new Error("AI returned an unsupported Mermaid diagram type.");
  }
  if (/<div\b|text-align\s*:/i.test(mermaid)) {
    throw new Error("AI returned Mermaid syntax that is unstable in Obsidian.");
  }
  return mermaid;
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
