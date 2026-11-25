import type { TFile, Vault } from "obsidian";
import type { AiModelConfig } from "../../types";
import { AiTransport } from "../ai/ai-transport";
import { prepareArticleForAi } from "../clipping/managed-content";
import { splitArticleSections } from "./article-sections";
import type { NoteOperationCoordinator } from "../core/note-operation-coordinator";
import type { SkillRunner } from "../core/skill-runner";
import { findPublicEvidence, type PublicEvidence } from "../search/public-evidence";

const SECTION_BATCH_CHARS = 12_000;
const SEARCH_BUDGET = 12;
const SEARCH_CONCURRENCY = 4;
type ResearchStage = "阅读全文" | "检索证据" | "判断并生成更新";

export const KNOWLEDGE_STATUSES = [
  "仍然成立", "只需换例子", "条件变了", "已经失效",
  "有更合适的做法", "原文有误", "证据不足", "缺少重要知识"
] as const;
export type KnowledgeStatus = typeof KNOWLEDGE_STATUSES[number];
export type UpdateAction = "修正" | "替换" | "补充" | "删除";

export interface FreshnessSource {
  title: string;
  url: string;
  date: string;
  quote: string;
}

export interface FreshnessUpdate {
  status: KnowledgeStatus;
  action: UpdateAction;
  section: string;
  before: string;
  after: string;
  reason: string;
  source: FreshnessSource;
}

export interface FreshnessReview {
  path: string;
  original: string;
  checkedOn: string;
  verdict: string;
  coreConclusion: string;
  incomplete: string[];
  updates: FreshnessUpdate[];
  held: Array<{ section: string; text: string }>;
  unverified: Array<{ section: string; text: string; reason: string }>;
}

interface Claim {
  quote: string;
  section: string;
  query: string;
}

interface Analysis {
  purpose: string;
  coreConclusion: string;
  claims: Claim[];
  discoveryQueries: string[];
}

export class ArticleFreshness {
  constructor(
    private vault: Vault,
    private skills: SkillRunner,
    private operations: NoteOperationCoordinator
  ) {}

  async check(
    file: TFile,
    model: AiModelConfig,
    searchKey: string,
    onStage?: (stage: ResearchStage, detail?: string) => void,
    onReasoning?: (delta: string) => void
  ): Promise<FreshnessReview> {
    if (file.extension !== "md") throw new Error("时效检查仅适用于 Markdown 笔记。");
    if (!searchKey.trim()) {
      throw new Error("请在 KnowFlow → AI Models 配置 DeepSeek Search 密钥或官方 DeepSeek 模型密钥。");
    }
    return this.skills.run("article-freshness", async (instructions) => {
      const original = await this.vault.read(file);
      const article = prepareArticleForAi(original);
      if (!article) throw new Error("当前文章没有可以检查的正文。");
      const checkedOn = window.moment().format("YYYY-MM-DD");
      const transport = new AiTransport(instructions);
      const prose = articleProse(article);

      let noted = false;
      const note = onReasoning ? (delta: string): void => {
        if (!delta) return;
        noted = true;
        onReasoning(delta);
      } : undefined;
      const analysis = await this.analyze(transport, model, file.basename, article, prose, (detail) => onStage?.("阅读全文", detail), note);
      const queries = uniqueQueries([...analysis.discoveryQueries, ...analysis.claims.map((claim) => claim.query)]);
      const searched = queries.slice(0, SEARCH_BUDGET);
      const pending = new Set(queries.slice(SEARCH_BUDGET));
      onStage?.("检索证据");
      const evidence = new Map<string, PublicEvidence[]>();
      let nextSourceId = 1;
      let finished = 0;
      const foundGroups = await mapPool(searched, SEARCH_CONCURRENCY, async (query) => {
        const found = await findPublicEvidence([query], searchKey);
        finished += 1;
        onStage?.("检索证据", `${finished}/${searched.length}`);
        return found;
      });
      for (const [index, query] of searched.entries()) {
        evidence.set(query, foundGroups[index].map((item) => ({ ...item, id: nextSourceId++ })));
      }

      const covered = analysis.claims.filter((claim) => evidence.has(claim.query));
      const incomplete = [...new Set(analysis.claims.filter((claim) => pending.has(claim.query)).map((claim) => claim.section))];
      const review: FreshnessReview = {
        path: file.path, original, checkedOn, coreConclusion: analysis.coreConclusion,
        verdict: "", incomplete, updates: [], held: [], unverified: []
      };
      for (const claim of analysis.claims) {
        if (!pending.has(claim.query)) continue;
        review.unverified.push({ section: claim.section, text: claim.quote, reason: "检索预算已用完，此章尚未完成。" });
      }
      if (!covered.length && !analysis.discoveryQueries.some((query) => evidence.has(query))) {
        review.verdict = analysis.claims.length || analysis.discoveryQueries.length ? "暂时无法判断" : "暂无需要检查的高风险说法";
        return review;
      }

      onStage?.("判断并生成更新");
      if (noted) note?.("\n\n");
      const sources = [...evidence.values()].flat();
      const judged = await this.judge(transport, model, checkedOn, analysis, covered, evidence, note);
      this.acceptJudgment(review, judged, prose, sources, incomplete);
      return review;
    });
  }

  async apply(file: TFile, review: FreshnessReview, selected: ReadonlySet<number>): Promise<void> {
    const updates = review.updates.filter((_, index) => selected.has(index));
    if (updates.length === 0) throw new Error("请选择要应用的更新。");
    await this.operations.runExclusive(review.path, async () => {
      if (file.path !== review.path || this.vault.getAbstractFileByPath(review.path) !== file) {
        throw new Error("文章已移动或删除，请重新检查。");
      }
      await this.vault.process(file, (current) => {
        if (file.path !== review.path || current !== review.original) {
          throw new Error("文章已修改或移动，请重新检查后再应用。");
        }
        return applyUpdates(current, updates, review.checkedOn);
      });
    });
  }

  private async analyze(
    transport: AiTransport,
    model: AiModelConfig,
    title: string,
    article: string,
    prose: string,
    onProgress?: (detail?: string) => void,
    onReasoning?: (delta: string) => void
  ): Promise<Analysis> {
    const claims: Claim[] = [];
    let purpose = "";
    let coreConclusion = "";
    const discoveryQueries: string[] = [];
    const batches = sectionBatches(article);
    for (const [index, batch] of batches.entries()) {
      onProgress?.(batches.length > 1 ? `${index + 1}/${batches.length}` : undefined);
      if (index > 0) onReasoning?.("\n\n");
      const payload = await transport.requestJson<Analysis>(model, [{
        role: "system",
        content: [
          "按 Skill 做全文分析。理解这一批正文的目的、核心观点和知识边界。",
          "提取所有具有实质性时效风险的说法，包括技术能力、限制、适用边界、方案优劣和行业判断。不要只找带有「目前、最新、唯一」的句子。原理、公式和历史叙述默认不提取。",
          "quote 必须是这一批正文中的连续原文。合并重复说法。没有符合条件的说法就返回空数组，不要凑数。",
          "query 是验证这句说法的检索词，discoveryQueries 是发现该主题遗漏进展的检索词，各不超过 80 字，不要使用固定模板。只输出 JSON。"
        ].join("\n")
      }, {
        role: "user",
        content: JSON.stringify({
          title, section: batch.title, article: batch.text,
          responseShape: {
            purpose: "", coreConclusion: "", domains: ["领域"],
            claims: [{ quote: "", section: "", query: "" }],
            discoveryQueries: [""]
          }
        })
      }], { onReasoning });
      if (!payload || !Array.isArray(payload.claims)) throw new Error("模型未返回有效的知识检查结果。");
      if (!purpose && typeof payload.purpose === "string") purpose = payload.purpose.slice(0, 300);
      if (!coreConclusion && typeof payload.coreConclusion === "string") coreConclusion = payload.coreConclusion.slice(0, 300);
      for (const item of payload.claims) {
        const quote = typeof item?.quote === "string" ? item.quote.trim() : "";
        const query = cleanQuery(item?.query);
        if (quote.length < 4 || quote.length > 500 || !prose.includes(quote) || !query) continue;
        if (claims.some((claim) => claim.quote === quote)) continue;
        claims.push({ quote, section: sectionOf(article, quote), query });
      }
      if (Array.isArray(payload.discoveryQueries)) {
        for (const query of payload.discoveryQueries) {
          const cleaned = cleanQuery(query);
          if (cleaned && !discoveryQueries.includes(cleaned)) discoveryQueries.push(cleaned);
        }
      }
    }
    return { purpose, coreConclusion, claims, discoveryQueries: discoveryQueries.slice(0, 2) };
  }

  private async judge(
    transport: AiTransport,
    model: AiModelConfig,
    checkedOn: string,
    analysis: Analysis,
    claims: Claim[],
    evidence: Map<string, PublicEvidence[]>,
    onReasoning?: (delta: string) => void
  ): Promise<{ coreStillHolds?: unknown; items?: unknown }> {
    const sources = [...evidence.values()].flat();
    return transport.requestJson(model, [{
      role: "system",
      content: [
        "按 Skill 逐条判断，并生成可写入文章的更新。材料不足时判为证据不足。",
        "没有反驳不代表仍然成立，没有支持不代表已经失效。新技术出现不代表旧技术失效。无法确认发表当时的情况时，不要区分已经失效和原文有误。",
        "缺少的重要知识必须扣住文章目的。用补充，before 填正文中已有的插入位置原文，after 填新增段落。",
        "证据引用必须是指定来源片段中的连续原文。性能、倍数和成本要核对条件是否一致。证据冲突且无法解释时判为证据不足。只输出 JSON。"
      ].join("\n")
    }, {
      role: "user",
      content: JSON.stringify({
        checkedOn,
        purpose: analysis.purpose,
        coreConclusion: analysis.coreConclusion,
        claims: claims.map((claim) => ({ ...claim, sources: evidence.get(claim.query) ?? [] })),
        discovery: analysis.discoveryQueries.flatMap((query) => evidence.get(query) ?? []),
        sources,
        responseShape: {
          coreStillHolds: true,
          items: [{
            quote: "", section: "", status: KNOWLEDGE_STATUSES.join(" | "),
            action: "保留 | 修正 | 替换 | 补充 | 删除",
            before: "", after: "", reason: "", sourceId: 1, evidenceQuote: ""
          }]
        }
      })
    }], { onReasoning });
  }

  private acceptJudgment(
    review: FreshnessReview,
    judged: { coreStillHolds?: unknown; items?: unknown },
    prose: string,
    sources: PublicEvidence[],
    incomplete: string[]
  ): void {
    if (!Array.isArray(judged.items)) throw new Error("模型未返回有效的知识判断。");
    for (const item of judged.items) {
      const record = item as {
        quote?: unknown; section?: unknown; status?: unknown; action?: unknown;
        before?: unknown; after?: unknown; reason?: unknown; sourceId?: unknown; evidenceQuote?: unknown;
      };
      const status = KNOWLEDGE_STATUSES.find((candidate) => candidate === record.status);
      if (!status) continue;
      const quote = typeof record.quote === "string" ? record.quote.trim() : "";
      const before = typeof record.before === "string" ? record.before.trim() : "";
      const after = typeof record.after === "string" ? record.after.trim() : "";
      const reason = typeof record.reason === "string" ? record.reason.trim().slice(0, 500) : "";
      const section = typeof record.section === "string" && record.section.trim() ? record.section.trim() : "正文";
      const source = citedSource(sources, record);
      if (status === "仍然成立" && quote && located(prose, quote)) {
        review.held.push({ section, text: quote });
        continue;
      }
      if (status === "证据不足") {
        review.unverified.push({ section, text: quote || before, reason: reason || "证据不足。" });
        continue;
      }
      const action = actionFor(status, record.action);
      const anchor = status === "缺少重要知识" ? before : quote || before;
      if (!action || !reason || !source || !anchor || !located(prose, anchor)) continue;
      if (action !== "删除" && !after) continue;
      if (action !== "补充" && anchor !== (quote || before)) continue;
      if ((action === "修正" || action === "替换") && !hasSupportedNumericChanges(anchor, after, source.quote)) continue;
      review.updates.push({ status, action, section, before: anchor, after, reason, source });
    }
    review.verdict = verdictOf(review, judged.coreStillHolds, incomplete);
  }
}

async function mapPool<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const run = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

function sectionBatches(article: string): Array<{ title: string; text: string }> {
  const sections = splitArticleSections(article);
  if (!sections.length) return [{ title: "正文", text: article }];
  const batches: Array<{ title: string; text: string }> = [];
  let title = sections[0].title;
  let text = "";
  for (const section of sections) {
    const piece = `## ${section.title}\n${section.content}`;
    if (text && text.length + piece.length > SECTION_BATCH_CHARS) {
      batches.push({ title, text });
      title = section.title;
      text = piece;
    } else {
      text += (text ? "\n\n" : "") + piece;
    }
  }
  if (text) batches.push({ title, text });
  return batches;
}

function sectionOf(article: string, quote: string): string {
  for (const section of splitArticleSections(article)) {
    if (`${section.title}\n${section.content}`.includes(quote)) return section.title;
  }
  return "正文";
}

function located(content: string, text: string): boolean {
  const start = content.indexOf(text);
  if (start < 0 || start !== content.lastIndexOf(text)) return false;
  const word = /[A-Za-z0-9]/;
  const endsWithWord = word.test(text.at(-1) ?? "");
  return !(word.test(text[0]) && word.test(content.charAt(start - 1)))
    && !(endsWithWord && word.test(content.charAt(start + text.length)));
}

function articleProse(article: string): string {
  return article.replace(/```[\s\S]*?```/g, "\n").replace(/~~~[\s\S]*?~~~/g, "\n");
}

function cleanQuery(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, 80);
}

function uniqueQueries(queries: string[]): string[] {
  return [...new Set(queries.filter(Boolean))];
}

function actionFor(status: KnowledgeStatus, value: unknown): UpdateAction | null {
  const allowed: Record<KnowledgeStatus, UpdateAction[]> = {
    "仍然成立": [],
    "只需换例子": ["替换"],
    "条件变了": ["补充"],
    "已经失效": ["修正", "删除"],
    "有更合适的做法": ["补充", "替换"],
    "原文有误": ["修正"],
    "证据不足": [],
    "缺少重要知识": ["补充"]
  };
  const choices = allowed[status];
  if (choices.includes(value as UpdateAction)) return value as UpdateAction;
  return choices[0] ?? null;
}

function citedSource(sources: PublicEvidence[], item: { sourceId?: unknown; evidenceQuote?: unknown }): FreshnessSource | undefined {
  const quote = item.evidenceQuote;
  if (typeof quote !== "string" || quote.trim().length < 8 || quote.length > 600) return undefined;
  const source = sources.find((candidate) => candidate.id === item.sourceId && candidate.excerpts.some((excerpt) => excerpt.includes(quote)));
  return source ? { title: source.title, url: source.url, date: source.date, quote } : undefined;
}

function hasSupportedNumericChanges(before: string, after: string, evidence: string): boolean {
  const values = (text: string) => new Set(text.replace(/(\d),(?=\d{3}(?:\D|$))/g, "$1").match(/[+-]?\d+(?:\.\d+)*%?/g) ?? []);
  const original = values(before);
  const cited = values(evidence);
  return [...values(after)].every((number) => original.has(number) || cited.has(number));
}

function verdictOf(review: FreshnessReview, coreStillHolds: unknown, incomplete: string[]): string {
  if (incomplete.length || review.unverified.some((item) => item.reason.includes("尚未完成"))) return "暂时无法判断";
  if (coreStillHolds === false) return "核心结论需要重新审视";
  if (review.updates.length) return "局部内容需要更新";
  if (review.held.length) return "未发现明显过时内容";
  if (!review.unverified.length) return "暂无需要检查的高风险说法";
  return "暂时无法判断";
}

function applyUpdates(content: string, updates: FreshnessUpdate[], checkedOn: string): string {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const spans = updates.map((update) => {
    const start = content.indexOf(update.before);
    if (start < 0 || start !== content.lastIndexOf(update.before)) {
      throw new Error("文章已修改或移动，请重新检查后再应用。");
    }
    const note = `${newline}${newline}${knowledgeNote(update, checkedOn, newline)}`;
    if (update.action === "补充") {
      const at = paragraphBreak(content, start, newline);
      return { start: at, end: at, text: note };
    }
    const matched = start + update.before.length;
    const end = paragraphBreak(content, matched, newline);
    const punctuation = /^[。！？.!?]/.test(content.slice(matched)) ? content.slice(matched, matched + 1) : "";
    const between = content.slice(matched + punctuation.length, end);
    const text = update.action === "删除"
      ? `${between}${note}`
      : `${emphasizeArticleProse(update.after)}${punctuation}${between}${note}`;
    return { start, end, text };
  }).sort((left, right) => right.start - left.start);
  let updated = content;
  for (const span of spans) updated = updated.slice(0, span.start) + span.text + updated.slice(span.end);
  return updated;
}

function emphasizeArticleProse(value: string): string {
  const text = value.replace(/\s+/g, " ").trim().replace(/^#+\s*/, "");
  const marked = text.replace(/「([^」]+)」/g, "**$1**");
  const sentences = marked.split(/(?<=[。！？])\s*/).filter(Boolean);
  if (sentences.length >= 2 && !sentences[0].includes("**")) sentences[0] = `**${sentences[0]}**`;
  return sentences.join("");
}

function paragraphBreak(content: string, from: number, newline: string): number {
  const at = content.indexOf(newline + newline, from);
  return at < 0 ? content.length : at;
}

function knowledgeNote(update: FreshnessUpdate, checkedOn: string, newline: string): string {
  const lines = [`> [!note] KnowFlow 知识更新 · ${checkedOn}`];
  const body = update.action === "删除"
    ? [`**已删除**　${update.before}`]
    : update.action === "补充"
      ? emphasizeArticleProse(update.after).split(/\r?\n/)
      : ["*原文已按依据更新。*"];
  for (const line of body) lines.push(line.trim() ? `> ${line.trim()}` : ">");
  lines.push(">", `> *依据*：「${update.source.quote.replace(/\s+/g, " ").trim()}」 <${update.source.url}>`);
  return lines.join(newline);
}
