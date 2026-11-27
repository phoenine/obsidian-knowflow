import type { TFile, Vault } from "obsidian";
import type { AiModelConfig } from "../../types";
import { AiTransport, EmptyAiResponseError, InvalidAiJsonError } from "../ai/ai-transport";
import { prepareArticleForAi } from "../clipping/managed-content";
import { splitArticleSections } from "./article-sections";
import type { NoteOperationCoordinator } from "../core/note-operation-coordinator";
import type { SkillRunner } from "../core/skill-runner";
import { findPublicEvidence, type PublicEvidence } from "../search/public-evidence";
import { anchorContext, commitNoteEdits, type EditItem, type NoteEdit } from "../core/note-edits";

const SECTION_BATCH_CHARS = 12_000;
const JUDGE_BATCH_CHARS = 12_000;
const JUDGE_EXCERPT_CHARS = 2400;
const DISCOVERY_CONTEXT_CHARS = 1800;
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

interface DiscoveryQuery {
  query: string;
  anchors: string[];
}

interface Analysis {
  purpose: string;
  coreConclusion: string;
  coreClaimQuote: string;
  claims: Claim[];
  discovery: DiscoveryQuery[];
}

interface Judgment {
  coreStillHolds?: unknown;
  items?: unknown;
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
      const queries = uniqueQueries([...analysis.discovery.map(({ query }) => query), ...analysis.claims.map((claim) => claim.query)]);
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

      // A query only counts as covered when it returned sources; an empty result is not evidence either way.
      const hasSources = (query: string): boolean => (evidence.get(query)?.length ?? 0) > 0;
      const covered = analysis.claims.filter((claim) => hasSources(claim.query));
      const incomplete = [...new Set(analysis.claims.filter((claim) => pending.has(claim.query)).map((claim) => claim.section))];
      const review: FreshnessReview = {
        path: file.path, original, checkedOn, coreConclusion: analysis.coreConclusion,
        verdict: "", incomplete, updates: [], held: [], unverified: []
      };
      for (const claim of analysis.claims) {
        if (pending.has(claim.query)) {
          review.unverified.push({ section: claim.section, text: claim.quote, reason: "检索预算已用完，此章尚未完成。" });
        } else if (!hasSources(claim.query)) {
          review.unverified.push({ section: claim.section, text: claim.quote, reason: "没有检索到可核对的公开资料。" });
        }
      }
      const discoveries: DiscoveryQuery[] = [];
      for (const discovery of analysis.discovery) {
        if (!hasSources(discovery.query)) continue;
        if (discovery.anchors.length) {
          discoveries.push(discovery);
        } else {
          review.unverified.push({ section: "正文", text: "补充检索", reason: "没有找到可用于补充的正文锚点，本次判断尚未完成。" });
        }
      }
      if (!covered.length && !discoveries.length) {
        review.verdict = analysis.claims.length || analysis.discovery.length ? "暂时无法判断" : "暂无需要检查的高风险说法";
        return review;
      }

      onStage?.("判断并生成更新");
      if (noted) note?.("\n\n");
      const coreClaimQuote = covered.some((claim) => claim.quote === analysis.coreClaimQuote) ? analysis.coreClaimQuote : "";
      const batches = packJudgmentBatches(covered, discoveries, evidence, { ...analysis, coreClaimQuote }, checkedOn);
      let coreStillHolds: unknown = true;
      for (const [index, batch] of batches.entries()) {
        if (index > 0) note?.("\n\n");
        const judged = batch.content.length <= JUDGE_BATCH_CHARS
          ? await this.judge(transport, model, batch.content, note)
          : undefined;
        if (!judged || !Array.isArray(judged.items)) {
          const unfinished = batch.claims.length ? batch.claims : [{ section: "正文", quote: "补充检索" }];
          for (const claim of unfinished) {
            review.unverified.push({ section: claim.section, text: claim.quote, reason: "这一批判断没有返回可用结果，此章尚未完成。" });
          }
          continue;
        }
        this.acceptJudgment(review, judged.items, prose, batch.sources);
        if (batch.claims.some((claim) => claim.quote === coreClaimQuote)) coreStillHolds = judged.coreStillHolds;
      }
      review.verdict = verdictOf(review, coreStillHolds, incomplete, coreClaimQuote);
      return review;
    });
  }

  async apply(
    file: TFile,
    review: FreshnessReview,
    selected: ReadonlySet<number>
  ): Promise<{ written: number; skipped: Array<{ index: number; reason: string }> }> {
    if ([...selected].every((index) => !review.updates[index])) throw new Error("请选择要应用的更新。");
    return this.operations.runExclusive(review.path, async () => {
      if (file.path !== review.path || this.vault.getAbstractFileByPath(review.path) !== file) {
        throw new Error("文章已移动或删除，请重新检查。");
      }
      let written = 0;
      let skipped: Array<{ index: number; reason: string }> = [];
      await this.vault.process(file, (current) => {
        const items = freshnessItems(review.original, review.updates, review.checkedOn);
        const commit = commitNoteEdits(current, items, selected);
        written = commit.written.length;
        skipped = commit.skipped.map((skip) => ({ index: skip.index, reason: skip.reason }));
        return commit.content;
      });
      return { written, skipped };
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
    let coreClaimQuote = "";
    const discovery: DiscoveryQuery[] = [];
    const batches = sectionBatches(article);
    for (const [index, batch] of batches.entries()) {
      onProgress?.(batches.length > 1 ? `${index + 1}/${batches.length}` : undefined);
      if (index > 0) onReasoning?.("\n\n");
      const payload = await transport.requestJson<Omit<Analysis, "discovery"> & { discoveryQueries?: unknown }>(model, [{
        role: "system",
        content: [
          "按 Skill 做全文分析。理解这一批正文的目的、核心观点和知识边界。",
          "提取所有具有实质性时效风险的说法，包括技术能力、限制、适用边界、方案优劣和行业判断。不要只找带有「目前、最新、唯一」的句子。原理、公式和历史叙述默认不提取。",
          "quote 必须是这一批正文中的连续原文。合并重复说法。没有符合条件的说法就返回空数组，不要凑数。",
          "只有某条 claims.quote 直接支撑 coreConclusion 时，才把该条原文填入 coreClaimQuote。核心结论没有对应的待核验说法时留空。",
          "query 是验证这句说法的检索词，discoveryQueries 是发现该主题遗漏进展的检索词，各不超过 80 字，不要使用固定模板。只输出 JSON。"
        ].join("\n")
      }, {
        role: "user",
        content: JSON.stringify({
          title, section: batch.title, article: batch.text,
          responseShape: {
            purpose: "", coreConclusion: "", coreClaimQuote: "", domains: ["领域"],
            claims: [{ quote: "", section: "", query: "" }],
            discoveryQueries: [""]
          }
        })
      }], { onReasoning });
      if (!payload || !Array.isArray(payload.claims)) throw new Error("模型未返回有效的知识检查结果。");
      if (!purpose && typeof payload.purpose === "string") purpose = payload.purpose.slice(0, 300);
      if (!coreConclusion && typeof payload.coreConclusion === "string" && payload.coreConclusion.trim()) {
        coreConclusion = payload.coreConclusion.slice(0, 300);
        coreClaimQuote = typeof payload.coreClaimQuote === "string" ? payload.coreClaimQuote.trim() : "";
      }
      for (const item of payload.claims) {
        const quote = typeof item?.quote === "string" ? item.quote.trim() : "";
        const query = cleanQuery(item?.query);
        if (quote.length < 4 || quote.length > 500 || !prose.includes(quote) || !query) continue;
        if (claims.some((claim) => claim.quote === quote)) continue;
        claims.push({ quote, section: sectionOf(article, quote), query });
      }
      if (discovery.length < 2 && Array.isArray(payload.discoveryQueries)) {
        let anchors: string[] | undefined;
        for (const query of payload.discoveryQueries) {
          const cleaned = cleanQuery(query);
          if (!cleaned || discovery.some((item) => item.query === cleaned)) continue;
          anchors ??= discoveryAnchors(batch.text, prose);
          discovery.push({ query: cleaned, anchors });
          if (discovery.length === 2) break;
        }
      }
    }
    return { purpose, coreConclusion, coreClaimQuote, claims, discovery };
  }

  private async judge(
    transport: AiTransport,
    model: AiModelConfig,
    content: string,
    onReasoning?: (delta: string) => void
  ): Promise<Judgment | undefined> {
    try {
      return await transport.requestJson<Judgment>(model, [{
        role: "system",
        content: [
          "按 Skill 逐条判断，并生成可写入文章的更新。材料不足时判为证据不足。",
          "没有反驳不代表仍然成立，没有支持不代表已经失效。新技术出现不代表旧技术失效。无法确认发表当时的情况时，不要区分已经失效和原文有误。",
          "缺少的重要知识必须扣住文章目的。用补充，before 从该检索的 anchors 中选一段原文，after 填新增段落。",
          "每项的 sourceIds 指向 sources 中的证据。证据引用必须是指定来源片段中的连续原文。性能、倍数和成本要核对条件是否一致。证据冲突且无法解释时判为证据不足。只输出 JSON。"
        ].join("\n")
      }, { role: "user", content }], { onReasoning });
    } catch (error) {
      if (error instanceof InvalidAiJsonError || error instanceof EmptyAiResponseError) return undefined;
      throw error;
    }
  }

  private acceptJudgment(
    review: FreshnessReview,
    items: unknown[],
    prose: string,
    sources: PublicEvidence[]
  ): void {
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
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
        if (source) review.held.push({ section, text: quote });
        else if (!review.unverified.some((entry) => entry.text === quote)) {
          review.unverified.push({ section, text: quote, reason: "没有可以核对的引用依据。" });
        }
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

function discoveryAnchors(section: string, prose: string): string[] {
  const anchors: string[] = [];
  for (const paragraph of articleProse(section).split(/\n[ \t]*\n+/)) {
    for (const rawLine of paragraph.split("\n")) {
      const line = rawLine.trim();
      if (!line || /^#{1,6}\s/.test(line)) continue;
      const anchor = line.length <= 240 ? line : line.slice(0, 240).replace(/[A-Za-z0-9]+$/, "").trimEnd();
      if (!anchor || !located(prose, anchor) || anchors.includes(anchor)) continue;
      if (JSON.stringify([...anchors, anchor]).length > DISCOVERY_CONTEXT_CHARS) return anchors;
      anchors.push(anchor);
      break;
    }
  }
  return anchors;
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

function verdictOf(review: FreshnessReview, coreStillHolds: unknown, incomplete: string[], coreClaimQuote: string): string {
  if (incomplete.length || review.unverified.some((item) => item.reason.includes("尚未完成"))) return "暂时无法判断";
  // The model's own "core no longer holds" flag is not enough: it must be backed by an accepted update that
  // says the content is outdated or wrong, and that update already carries a checked source.
  const invalidated = review.updates.some((item) =>
    item.before === coreClaimQuote && (item.status === "已经失效" || item.status === "原文有误"));
  if (coreStillHolds === false && invalidated) return "核心结论需要重新审视";
  if (review.updates.length) return "局部内容需要更新";
  if (review.unverified.length) return "暂时无法判断";
  if (review.held.length) return "未发现明显过时内容";
  return "暂无需要检查的高风险说法";
}

function freshnessItems(original: string, updates: FreshnessUpdate[], checkedOn: string): EditItem[] {
  return updates.map((update) => {
    const edits = freshnessEdits(original, update, checkedOn);
    return edits ? { edits } : { edits: [], skip: "missing" };
  });
}

function freshnessEdits(original: string, update: FreshnessUpdate, checkedOn: string): NoteEdit[] | null {
  const context = anchorContext(original, update.before);
  if (typeof context === "string") return null;
  const paragraph = context.paragraph;
  const callout: NoteEdit = {
    op: "insert",
    anchor: update.before,
    at: "after",
    text: knowledgeNote(update, checkedOn, "\n"),
    paragraph,
    stack: true
  };
  if (update.action === "补充") return [callout];
  let anchor = update.before;
  let text = update.action === "删除" ? "" : emphasizeArticleProse(update.after);
  if (update.action !== "删除") {
    const punctuation = /^[。！？.!?]/.test(context.next) ? context.next : "";
    if (punctuation && typeof anchorContext(original, anchor + punctuation) !== "string") {
      anchor += punctuation;
      if (text && !/[。！？.!?](?:\*\*)?$/.test(text)) text += punctuation;
    }
  }
  const body: NoteEdit = update.action === "删除"
    ? { op: "delete", anchor: update.before, paragraph }
    : { op: "replace", anchor, text, paragraph };
  return [body, callout];
}

interface JudgmentBatch {
  claims: Claim[];
  discovery: DiscoveryQuery[];
}

interface JudgmentRequest {
  claims: Claim[];
  content: string;
  sources: PublicEvidence[];
}

function judgmentRequest(
  checkedOn: string,
  analysis: Pick<Analysis, "purpose" | "coreConclusion" | "coreClaimQuote">,
  batch: JudgmentBatch,
  evidence: Map<string, PublicEvidence[]>,
  excerptLimit = JUDGE_EXCERPT_CHARS
): JudgmentRequest {
  const sourcesById = new Map<number, PublicEvidence>();
  const sourceIds = (query: string): number[] => (evidence.get(query) ?? []).map((source) => {
    if (!sourcesById.has(source.id)) {
      sourcesById.set(source.id, {
        ...source,
        excerpts: source.excerpts.map((excerpt) => excerpt.slice(0, excerptLimit))
      });
    }
    return source.id;
  });
  const claims = batch.claims.map(({ quote, section, query }) => ({
    quote, section: section.slice(0, 200), query, sourceIds: sourceIds(query)
  }));
  const discovery = batch.discovery.map((entry) => ({ ...entry, sourceIds: sourceIds(entry.query) }));
  const sources = [...sourcesById.values()];
  const content = JSON.stringify({
    checkedOn,
    purpose: analysis.purpose,
    coreConclusion: analysis.coreConclusion,
    coreClaimQuote: analysis.coreClaimQuote,
    claims,
    discovery,
    sources: sources.map(({ id, title, date, excerpts }) => ({ id, title: title.slice(0, 200), date, excerpts })),
    responseShape: {
      coreStillHolds: true,
      items: [{
        quote: "", section: "", status: KNOWLEDGE_STATUSES.join(" | "),
        action: "保留 | 修正 | 替换 | 补充 | 删除",
        before: "", after: "", reason: "", sourceId: 1, evidenceQuote: ""
      }]
    }
  });
  return { claims: batch.claims, content, sources };
}

function packJudgmentBatches(
  claims: Claim[],
  discovery: DiscoveryQuery[],
  evidence: Map<string, PublicEvidence[]>,
  analysis: Analysis,
  checkedOn: string
): JudgmentRequest[] {
  const pieces: JudgmentBatch[] = [
    ...claims.map((claim) => ({ claims: [claim], discovery: [] })),
    ...discovery.map((entry) => ({ claims: [], discovery: [entry] }))
  ];
  const batches: JudgmentRequest[] = [];
  let current: JudgmentBatch = { claims: [], discovery: [] };
  let prepared: JudgmentRequest | undefined;
  for (const piece of pieces) {
    const next = {
      claims: [...current.claims, ...piece.claims],
      discovery: [...current.discovery, ...piece.discovery]
    };
    const combined = judgmentRequest(checkedOn, analysis, next, evidence);
    if (combined.content.length <= JUDGE_BATCH_CHARS) {
      current = next;
      prepared = combined;
      continue;
    }
    if (prepared) batches.push(prepared);
    current = piece;
    prepared = judgmentRequest(checkedOn, analysis, piece, evidence);
    for (let limit = JUDGE_EXCERPT_CHARS; prepared.content.length > JUDGE_BATCH_CHARS && limit > 0;) {
      limit = Math.floor(limit / 2);
      prepared = judgmentRequest(checkedOn, analysis, piece, evidence, limit);
    }
  }
  if (prepared) batches.push(prepared);
  return batches;
}

function emphasizeArticleProse(value: string): string {
  const text = value.replace(/\s+/g, " ").trim().replace(/^#+\s*/, "");
  const marked = text.replace(/「([^」]+)」/g, "**$1**");
  const sentences = marked.match(/[^。！？]*[。！？]|[^。！？]+$/g)?.map((sentence) => sentence.trimStart()) ?? [];
  if (sentences.length >= 2 && !sentences[0].includes("**")) sentences[0] = `**${sentences[0]}**`;
  return sentences.join("");
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
