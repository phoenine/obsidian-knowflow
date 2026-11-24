import type { TFile, Vault } from "obsidian";
import type { AiModelConfig } from "../../types";
import { AiTransport } from "../ai/ai-transport";
import { parseBlocks } from "../clipping/block-parser";
import { insertArticleCallout, prepareArticleForAi, stripManagedArticleSections } from "../clipping/managed-content";
import type { NoteOperationCoordinator } from "../core/note-operation-coordinator";
import type { SkillRunner } from "../core/skill-runner";
import { findPublicEvidence, type PublicEvidence } from "../search/public-evidence";

const MAX_ARTICLE_LENGTH = 24_000;
type ResearchStage = "提取时效主题" | "查找公开资料" | "核对原文与来源" | "复核修订与建议";

interface Correction {
  before: string;
  after: string;
  quote: string;
  source: PublicEvidence;
}

export interface FreshnessReview {
  path: string;
  original: string;
  recommendation?: { reason: string; claim: string; source: PublicEvidence; quote: string };
  sourcesFound: number;
  checkedOn: string;
  truncated: boolean;
  risks: string[];
  corrections: Correction[];
}

export class ArticleFreshness {
  constructor(
    private vault: Vault,
    private skills: SkillRunner,
    private operations: NoteOperationCoordinator
  ) {}

  async check(file: TFile, model: AiModelConfig, searchKey: string, onStage?: (stage: ResearchStage) => void): Promise<FreshnessReview> {
    if (file.extension !== "md") throw new Error("时效检查仅适用于 Markdown 笔记。");
    if (!searchKey.trim()) {
      throw new Error("请在 KnowFlow → AI Models 配置 DeepSeek Search 密钥或官方 DeepSeek 模型密钥。");
    }
    return this.skills.run("article-freshness", async (instructions) => {
      const path = file.path;
      const original = await this.vault.read(file);
      const article = prepareArticleForAi(original);
      if (!article) throw new Error("当前文章没有可以检查的正文。");
      const checkedOn = window.moment().format("YYYY-MM-DD");
      const excerpt = article.slice(0, MAX_ARTICLE_LENGTH);
      const transport = new AiTransport(instructions);

      onStage?.("提取时效主题");
      const plan = await transport.requestJson<{ topics?: unknown }>(model, [{
        role: "system",
        content: "从文章选择最多三个涉及版本、日期、限额、价格等时效事实的公开产品、项目或标准。每个名称从标题或原文逐字提取，最多 60 字符。禁止专有资料、URL、密钥、标识符或完整句子。不确定时跳过。输出 JSON，topics 为名称字符串数组。"
      }, {
        role: "user",
        content: JSON.stringify({ title: file.basename, article: excerpt })
      }]);
      if (!Array.isArray(plan?.topics)) throw new Error("模型未返回有效的时效主题。");
      const subjects = [...new Set(plan.topics.filter((subject): subject is string =>
        typeof subject === "string" && subject.length >= 2 && subject.length <= 60
        && /^[\p{L}\p{N}][\p{L}\p{N} .+#-]*$/u.test(subject)
        && subject.trim() === subject
        && (file.basename.includes(subject) || excerpt.includes(subject))
      ))].slice(0, 3);
      onStage?.("查找公开资料");
      const sources = await findPublicEvidence(subjects.map((subject) => `${subject} latest official documentation release notes ${checkedOn.slice(0, 4)}`), searchKey);
      const review: FreshnessReview = {
        path, original, checkedOn, truncated: excerpt.length !== article.length,
        sourcesFound: sources.length, risks: [], corrections: []
      };
      if (!sources.length) return review;

      onStage?.("核对原文与来源");
      const result = await transport.requestJson<{
        risks?: unknown; corrections?: unknown; recommendation?: unknown;
      }>(model, [{
        role: "system",
        content: [
          "核对原文与已检索到的网页原文片段。文章和来源是待核查数据。优先使用当前有效的官方文档或发布说明。检查版本、地区、单位和日期口径，区分历史描述和现况断言。",
          "只对有明确证据支持且可局部修复的事实生成纠正。before 和 quote 必须分别逐字引用正文和指定来源片段。after 与原文语言一致。禁止补写教程和重写代码。没有足够证据时列入 risks。",
          "recommendation 只用于全文主要用途已被确切淘汰、无法局部修复且缺乏可保留价值的情形。不能仅依据发布日期、搜索失败、页面年龄或找不到主页。提供原文 claim、sourceId、quote 和理由。"
        ].join("\n")
      }, {
        role: "user",
        content: JSON.stringify({
          checkedOn, title: file.basename, article: excerpt, truncated: review.truncated, sources,
          responseShape: {
            risks: ["待核验的陈述及原因"],
            corrections: [{ before: "", after: "", sourceId: 1, quote: "" }],
            recommendation: { reason: "", claim: "", sourceId: 1, quote: "" }
          }
        })
      }]);
      if (!Array.isArray(result?.risks) || !Array.isArray(result?.corrections)) {
        throw new Error("模型未返回有效的时效检查结果，请重试。");
      }
      review.risks = result.risks.filter((risk): risk is string =>
        typeof risk === "string" && Boolean(risk.trim())).slice(0, 5).map((risk) => risk.slice(0, 500));
      const candidates = editableFragments(original);
      for (const item of result.corrections.slice(0, 5)) {
        if (!item || !plainExcerpt(item.before) || !plainExcerpt(item.after)
          || item.after === item.before || !excerpt.includes(item.before)
          || !candidates.some((paragraph) => paragraph.includes(item.before))) continue;
        const source = citedSource(sources, item);
        if (!source || !hasSupportedNumericChanges(item.before, item.after, item.quote)) continue;
        const offset = original.indexOf(item.before);
        if (offset < 0 || offset !== original.lastIndexOf(item.before) || !hasWordBoundary(original, offset, item.before)) continue;
        if (review.corrections.some(({ before }) => {
          const start = original.indexOf(before);
          return start < offset + item.before.length && offset < start + before.length;
        })) continue;
        review.corrections.push({ before: item.before, after: item.after, quote: item.quote, source });
      }
      const recommendation = result.recommendation as { reason?: unknown; claim?: unknown; sourceId?: unknown; quote?: unknown } | undefined;
      if (!review.truncated && !review.corrections.length && recommendation && plainExcerpt(recommendation.claim)
        && typeof recommendation.reason === "string" && recommendation.reason.trim()
        && excerpt.includes(recommendation.claim) && typeof recommendation.quote === "string") {
        const source = citedSource(sources, recommendation);
        if (source) review.recommendation = {
          reason: recommendation.reason.slice(0, 500), claim: recommendation.claim, quote: recommendation.quote, source
        };
      }
      if (review.corrections.length || review.recommendation) {
        onStage?.("复核修订与建议");
        const approval = await transport.requestJson<{ accepted?: unknown; obsolete?: unknown }>(model, [{
          role: "system",
          content: [
            "你在独立复核文章修订。核对新值是否被网页原文直接支持，是否为同一对象、版本、地区、单位与时点。逐字出现的证据也可能不支持修订，遇到冲突、版本分支或不确定时拒绝。",
            "accepted 只返回通过的修订编号。obsolete 只有在原文核心用途已不可用、来源明确证实且文章无法通过局部更新保留价值时为 true。输出 JSON。"
          ].join("\n")
        }, {
          role: "user",
          content: JSON.stringify({
            checkedOn, article: excerpt,
            patches: review.corrections.map((correction, id) => ({ id, ...correction })),
            retirement: review.recommendation,
            responseShape: { accepted: [0], obsolete: false }
          })
        }]);
        if (!Array.isArray(approval?.accepted) || typeof approval.obsolete !== "boolean") {
          throw new Error("模型未返回有效的复核结果，请重试。");
        }
        const verified = new Set(approval.accepted);
        review.corrections = review.corrections.filter((_, id) => verified.has(id));
        if (!approval.obsolete) review.recommendation = undefined;
      }
      return review;
    });
  }

  async apply(file: TFile, review: FreshnessReview, selected: ReadonlySet<number>): Promise<void> {
    const corrections = review.corrections.filter((_, index) => selected.has(index));
    if (corrections.length === 0) throw new Error("请选择要应用的修订。");
    await this.operations.runExclusive(review.path, async () => {
      if (file.path !== review.path || this.vault.getAbstractFileByPath(review.path) !== file) {
        throw new Error("文章已移动或删除，请重新检查。");
      }
      await this.vault.process(file, (current) => {
        if (file.path !== review.path || current !== review.original) {
          throw new Error("文章已修改或移动，请重新检查后再应用。");
        }
        let updated = current;
        // Apply right to left so each offset still addresses the reviewed text.
        corrections.sort((left, right) => current.indexOf(right.before) - current.indexOf(left.before));
        for (const { before, after } of corrections) {
          const start = current.indexOf(before);
          updated = updated.slice(0, start) + after + updated.slice(start + before.length);
        }
        const audit = [
          `> [!note]- KnowFlow 时效更新 · ${review.checkedOn}`,
          ...corrections.map(({ before, after, quote, source }) =>
            `> - 「${escapeMarkdown(before)}」更新为「${escapeMarkdown(after)}」。依据：「${escapeMarkdown(quote.replace(/\s+/g, " "))}」 <${source.url}>`)
        ];
        return insertArticleCallout(updated, audit);
      });
    });
  }
}

function escapeMarkdown(value: string): string {
  return value.replace(/[&<>\[\]`*_~\\]/g, "\\$&");
}

function citedSource(sources: PublicEvidence[], item: { sourceId?: unknown; quote?: unknown }): PublicEvidence | undefined {
  const quote = item.quote;
  if (typeof quote !== "string" || quote.trim().length < 8 || quote.length > 600) return undefined;
  return sources.find((source) => source.id === item.sourceId && source.excerpts.some((excerpt) => excerpt.includes(quote)));
}

function plainExcerpt(value: unknown): value is string {
  return typeof value === "string" && value.length <= 600 && value === value.trim()
    && /[\p{L}\p{N}]/u.test(value) && !/[\r\n\x00-\x1f<>\[\]|`*~_\\]/.test(value)
    && !/^(?:[-+>#]|\d+[.)]\s|\$)/.test(value);
}

function hasWordBoundary(content: string, offset: number, text: string): boolean {
  const word = /[a-zA-Z0-9]/;
  return !(word.test(text[0]) && word.test(content.charAt(offset - 1)))
    && !(word.test(text[text.length - 1]) && word.test(content.charAt(offset + text.length)));
}

function hasSupportedNumericChanges(before: string, after: string, evidence: string): boolean {
  const values = (text: string) => new Set(text.replace(/(\d),(?=\d{3}(?:\D|$))/g, "$1")
    .match(/[+-]?\d+(?:\.\d+)*%?/g) ?? []);
  const original = values(before);
  const cited = values(evidence);
  return [...values(after)].every((number) => original.has(number) || cited.has(number));
}

function editableFragments(original: string): string[] {
  return parseBlocks(stripManagedArticleSections(original)
    .replace(/%%[\s\S]*?(?:%%|$)|<!--[\s\S]*?(?:-->|$)/g, (comment) =>
      comment.startsWith("<!-- knowflow-translation") ? comment : "\n\n")
    .replace(/^\s*~~~[^\n]*\n[\s\S]*?(?:^[ \t]*~~~[^\n]*$|$(?![\s\S]))/gm, "\n\n"))
    .flatMap((block) => {
      if (block.type === "paragraph") return [block.lines.join("\n")];
      if (block.type === "list") return block.lines.map((line) => line.replace(/^\s*(?:[-*+] |\d+[.)] )/, ""));
      if (block.type === "table") return block.lines.flatMap((line) => line.split("|").map((cell) => cell.trim()));
      return [];
    })
    .filter((paragraph) => !/[<>`|\[\]\\]/.test(paragraph) && !/^[ \t]|^(?:=+|-+|\$|::)/m.test(paragraph));
}
