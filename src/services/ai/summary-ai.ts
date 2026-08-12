import type { NoteSummary } from "../../types";
import { ARTICLE_CATEGORIES } from "../clipping/clipping-pipeline";
import type { ChatRequestMessage } from "../chat/chat-context";
import { prepareArticleForAi } from "../clipping/managed-content";

export interface SummaryResponse {
  briefDescription: string;
  summary: string;
  readingValue: number;
  recommendedAction: NoteSummary["recommendedAction"];
  category: string;
  reason: string;
  tags: string[];
}

export function buildSummaryMessages(title: string, content: string, fallbackCategory: string): ChatRequestMessage[] {
  return [
    {
      role: "system",
      content: [
        "你是 KnowFlow 的 Obsidian Clipping 分析器。",
        "必须基于文章语义判断，不允许用文章长度或关键词粗略猜测。",
        "KnowFlow 的目标不是把所有文章都变成学习材料，而是帮助用户决定是否值得投入学习时间。",
        "你需要输出严格 JSON，不要输出 markdown。",
        "阅读价值必须是 1-5 的整数：1=低价值或广告，2=浅层资讯，3=普通教程/观点，4=深入技术文章/系统分析，5=长期参考资料。",
        "阅读价值 1：过时教程、纯广告、无实质内容新闻、低质量项目列表、当前环境无法复用的材料。",
        "阅读价值 2：浅层功能介绍、营销软文、资讯合集、每个条目只有短介绍的周刊/月刊。",
        "阅读价值 3：有实操细节的教程，或有观点但深度一般的分析。",
        "阅读价值 4：有原理解释、工程经验、代码示例或可复现方法的深度文章。",
        "阅读价值 5：系统性知识、长期参考、可反复查阅的高密度资料。",
        "推荐动作只能是 skip、skim、deep_learn、keep_reference。",
        "推荐动作含义：skip=不建议学习；skim=快速阅读即可；deep_learn=值得深入学习并出题；keep_reference=长期保存为参考资料。",
        `建议目录必须从这些目录中选择：${ARTICLE_CATEGORIES.join("、")}。不确定时选择 ${fallbackCategory}。`,
        "`briefDescription` 用于写入 Frontmatter 的简要描述，只能是 1 到 2 句文章概括。",
        "`summary` 用于侧边栏 AI Summary，必须是结构化 Markdown 文本，不要写成和 briefDescription 一样的一段话。",
        "`summary` 必须包含两个小节：`核心观点` 和 `章节梳理`。",
        "`核心观点` 使用 2 到 4 条无序列表；`章节梳理` 使用有序列表，逐条说明文章各章节或主要部分讲了什么。",
        "`summary` 总长度建议 180 到 360 个中文字符，便于右侧栏快速扫描。",
        "tags 只给主题标签，不要给来源平台标签；不要编造文章没有覆盖的主题。",
        "tags 必须遵守 Obsidian 标签语法：每个标签内部不允许有空格，多词标签使用连字符连接。"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        title,
        fallbackCategory,
        article: buildAnalysisExcerpt(content),
        requiredJsonShape: {
          briefDescription: "1 到 2 句文章概括，用于 Frontmatter 简要描述",
          summary: "结构化 Markdown：包含 核心观点 bullet list 和 章节梳理 ordered list",
          readingValue: "1-5 integer",
          recommendedAction: "skip | skim | deep_learn | keep_reference",
          category: ARTICLE_CATEGORIES,
          reason: "一句话说明阅读价值和推荐动作的理由",
          tags: ["2-6 个中文或英文主题标签"]
        }
      })
    }
  ];
}

export function normalizeSummaryResponse(
  value: SummaryResponse,
  fallbackCategory: string
): Omit<NoteSummary, "filePath" | "title"> {
  const readingValue = Number.isInteger(value.readingValue)
    ? Math.min(5, Math.max(1, value.readingValue))
    : 3;
  const category = ARTICLE_CATEGORIES.includes(value.category) ? value.category : fallbackCategory;
  const recommendedAction = ["skip", "skim", "deep_learn", "keep_reference"].includes(value.recommendedAction)
    ? value.recommendedAction
    : readingValue >= 4 ? "deep_learn" : readingValue >= 3 ? "skim" : "skip";
  const summary = normalizeStructuredSummary(value.summary);

  return {
    briefDescription: typeof value.briefDescription === "string" && value.briefDescription.trim()
      ? value.briefDescription.replace(/\n/g, " ").trim()
      : deriveBriefDescription(summary),
    summary,
    readingValue,
    recommendedAction,
    category,
    reason: typeof value.reason === "string" ? value.reason.trim() : "",
    tags: Array.isArray(value.tags)
      ? Array.from(new Set(value.tags.map(normalizeObsidianTag).filter(Boolean))).slice(0, 6)
      : []
  };
}

function normalizeObsidianTag(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/^#+/, "").replace(/\s+/g, "-");
}

function normalizeStructuredSummary(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "AI 未返回有效摘要。";
  const normalized = value.trim();
  if (/核心观点|章节梳理|^\s*[-*]\s+|^\s*\d+\.\s+/m.test(normalized)) return normalized;
  return `核心观点\n- ${normalized}\n\n章节梳理\n1. 文章围绕主题展开，当前模型未返回分章节结构。`;
}

function deriveBriefDescription(summary: string): string {
  return summary
    .replace(/^#+\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160) || "AI 未返回简要描述。";
}

function buildAnalysisExcerpt(content: string): string {
  const article = prepareArticleForAi(content);
  if (article.length <= 9000) return article;
  const headings = article
    .split("\n")
    .filter((line) => /^#{2,4}\s+\S/.test(line.trim()))
    .slice(0, 40)
    .join("\n");
  const sections = article
    .split(/\n(?=#{2,3}\s+)/)
    .slice(0, 8)
    .map((section) => section.trim().slice(0, 650))
    .join("\n\n");
  return [
    article.slice(0, 2800),
    headings ? `\n\n## 文章标题骨架\n${headings}` : "",
    sections ? `\n\n## 章节抽样\n${sections}` : "",
    `\n\n## 文章结尾\n${article.slice(-1600)}`
  ].join("").slice(0, 11000);
}
