import type { AiModelConfig } from "../../types";
import { AiTransport } from "./ai-transport";
import { batchFormattingCandidates, preferTextLanguage } from "../clipping/formatting-candidates";
import type { FormattingCandidate, FormattingDecision } from "../clipping/formatting-candidates";
import { batchTranslationCandidates } from "../clipping/translation-candidates";
import type { TranslationCandidate, TranslationDecision } from "../clipping/translation-candidates";

interface FormattingResponse {
  decisions: FormattingDecision[];
}

interface TranslationResponse {
  translations: TranslationDecision[];
}

export class RepairAi {
  private skillText = "";

  constructor(private transport: AiTransport) {}

  setSkill(skill: string): void {
    this.skillText = skill;
  }

  async analyzeHeadingCandidates(
    config: AiModelConfig,
    title: string,
    candidates: FormattingCandidate[]
  ): Promise<FormattingDecision[]> {
    return this.analyzeFormattingBatches(config, candidates, "标题判断", (batch) => [
      {
        role: "system",
        content: this.withSkill([
          "你是 KnowFlow 的文章标题分类器。只判断候选文本是否为文章小节标题。",
          "不确定时返回 keep，不要强行标记。",
          "确认为标题时返回 heading + H2/H3/H4。",
          "禁止将纯数字、纯标点或空洞文本判为标题。候选已由程序清洗，可直接判断语义。",
          "要求输出严格 JSON。"
        ])
      },
      {
        role: "user",
        content: JSON.stringify({
          title,
          candidates: batch.map(({ id, content, analysisContent, before, after }) => ({
            id,
            content: analysisContent ?? content,
            before,
            after
          })),
          requiredJsonShape: {
            decisions: [{ id: "候选 id", action: "keep | heading", level: "仅 heading：2 | 3 | 4" }]
          }
        })
      }
    ]);
  }

  async analyzePossibleCodeCandidates(
    config: AiModelConfig,
    title: string,
    candidates: FormattingCandidate[]
  ): Promise<FormattingDecision[]> {
    return this.analyzeFormattingBatches(config, candidates, "未围栏代码判断", (batch) => [
      {
        role: "system",
        content: this.withSkill([
          "你是 KnowFlow 的代码块分类器。只判断候选文本是否为未围栏代码（无 ``` 包裹）。",
          "确认为代码时返回 wrap-code + 语言标识（如 python/typescript/bash）。",
          "语言不确认时用 text；Markdown 片段用 markdown。禁止猜测编程语言。",
          "流程示意、箭头链、纯中文说明、非代码文本 → keep（不要 wrap-code）。",
          "不是代码时返回 keep。",
          "要求输出严格 JSON。"
        ])
      },
      {
        role: "user",
        content: JSON.stringify({
          title,
          candidates: batch.map(({ id, content, before, after }) => ({ id, content, before, after })),
          requiredJsonShape: {
            decisions: [{ id: "候选 id", action: "keep | wrap-code", language: "仅 wrap-code：编程语言或 text/markdown" }]
          }
        })
      }
    ]);
  }

  async analyzeFencedCodeCandidates(
    config: AiModelConfig,
    title: string,
    candidates: FormattingCandidate[]
  ): Promise<FormattingDecision[]> {
    return this.analyzeFormattingBatches(config, candidates, "代码围栏语言判断", (batch) => [
      {
        role: "system",
        content: this.withSkill([
          "你是 KnowFlow 的代码围栏修复器。处理已有 ``` 包裹的代码块。",
          "语言规则：能明确识别则返回准确语言（python/javascript/bash/sql/yaml 等）；",
          "不确认时用 text；Markdown 片段用 markdown。禁止猜测编程语言。",
          "流程示意、箭头链、纯中文说明 → language 必须为 text。",
          "若 needsReformat 为 true，或缩进/换行明显被剪藏挤坏（如 `cmd \\  --flag` 同行粘连）：",
          "返回 reformat-code，并给出修复后的 content（不含围栏、保留原意与逻辑、只修格式与缩进）。",
          "仅需改语言、正文完好：返回 set-code-language。",
          "无需修改：返回 keep。",
          "要求输出严格 JSON。"
        ])
      },
      {
        role: "user",
        content: JSON.stringify({
          title,
          candidates: batch.map(({ id, content, fenceLanguage, needsReformat }) => ({
            id,
            content,
            fenceLanguage: fenceLanguage || "",
            needsReformat: Boolean(needsReformat)
          })),
          requiredJsonShape: {
            decisions: [{
              id: "候选 id",
              action: "keep | set-code-language | reformat-code",
              language: "语言标识；不确认时 text 或 markdown",
              content: "仅 reformat-code：修复后的代码正文，不含围栏"
            }]
          }
        })
      }
    ]);
  }

  async translateEnglishParagraphs(
    config: AiModelConfig,
    title: string,
    candidates: TranslationCandidate[]
  ): Promise<TranslationDecision[]> {
    if (candidates.length === 0) return [];
    const batches = batchTranslationCandidates(candidates);
    const translations: TranslationDecision[] = [];
    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      try {
        const payload = await this.transport.requestJson<TranslationResponse>(config, [
          {
            role: "system",
            content: [
              "你是专业的英译中编辑。把每个英文段落准确、自然地翻译成简体中文。",
              "必须完整保留原意、专有名词、数字、URL、Markdown 链接和行内代码，不添加解释、标题或“翻译”标签。",
              "只返回单行译文，不要添加括号、换行、列表符号、序号、任务框或 HTML 注释；这些 Markdown 结构由程序保留。",
              "每个输入 id 必须返回且只能返回一次；不得合并、拆分或遗漏段落。",
              "只输出严格 JSON，不要输出 Markdown 围栏。"
            ].join("\n")
          },
          {
            role: "user",
            content: JSON.stringify({
              title,
              paragraphs: batch.map((candidate) => ({ id: candidate.id, text: candidate.content })),
              requiredJsonShape: {
                translations: [{ id: "translation-1", translation: "对应的简体中文翻译" }]
              }
            })
          }
        ]);
        const normalized = normalizeTranslationResponse(payload, batch);
        const returnedIds = new Set(normalized.map((translation) => translation.id));
        if (returnedIds.size !== batch.length || batch.some((candidate) => !returnedIds.has(candidate.id))) {
          throw new Error("模型未返回全部段落的有效中文翻译。");
        }
        translations.push(...normalized);
      } catch (error) {
        throw new Error(
          `英文翻译批次 ${index + 1}/${batches.length} 处理失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return translations;
  }

  private async analyzeFormattingBatches(
    config: AiModelConfig,
    candidates: FormattingCandidate[],
    label: string,
    buildMessages: (batch: FormattingCandidate[]) => Array<{ role: "system" | "user"; content: string }>
  ): Promise<FormattingDecision[]> {
    if (candidates.length === 0) return [];
    const batches = batchFormattingCandidates(candidates);
    const decisions: FormattingDecision[] = [];
    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      try {
        const payload = await this.transport.requestJson<FormattingResponse>(config, buildMessages(batch));
        decisions.push(...normalizeFormattingDecisions(payload, batch));
      } catch (error) {
        throw new Error(
          `${label}批次 ${index + 1}/${batches.length} 失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return decisions;
  }

  private withSkill(lines: string[]): string {
    return (this.skillText ? `${this.skillText}\n\n` : "") + lines.join("\n");
  }
}

function normalizeFormattingDecisions(
  value: FormattingResponse,
  candidates: FormattingCandidate[]
): FormattingDecision[] {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const decisions = Array.isArray(value.decisions) ? value.decisions : [];
  return decisions.flatMap((decision): FormattingDecision[] => {
    const candidate = byId.get(decision.id);
    if (!candidate || typeof decision.action !== "string") return [];
    if (decision.action === "keep") return [{ id: decision.id, action: "keep" }];
    if (candidate.type === "possible-heading" && decision.action === "heading") {
      const level = decision.level === 3 || decision.level === 4 ? decision.level : 2;
      return [{ id: decision.id, action: "heading", level }];
    }
    if (candidate.type === "possible-code" && decision.action === "wrap-code") {
      return [{ id: decision.id, action: "wrap-code", language: resolveDecisionLanguage(decision.language, candidate.content) }];
    }
    if (candidate.type === "fenced-code" && decision.action === "set-code-language") {
      return [{ id: decision.id, action: "set-code-language", language: resolveDecisionLanguage(decision.language, candidate.content) }];
    }
    if (candidate.type === "fenced-code" && decision.action === "reformat-code") {
      const content = typeof decision.content === "string"
        ? decision.content.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "")
        : "";
      if (!content || /```/.test(content)) return [];
      return [{
        id: decision.id,
        action: "reformat-code",
        language: resolveDecisionLanguage(decision.language, content),
        content
      }];
    }
    return [];
  });
}

function resolveDecisionLanguage(value: unknown, body: string): string {
  if (preferTextLanguage(body)) return "text";
  return normalizeLanguageName(value) || "text";
}

function normalizeTranslationResponse(
  value: TranslationResponse,
  candidates: TranslationCandidate[]
): TranslationDecision[] {
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const translations = Array.isArray(value.translations) ? value.translations : [];
  return translations.flatMap((translation) =>
    candidateIds.has(translation.id)
      && typeof translation.translation === "string"
      && /[\u3400-\u9fff]/.test(translation.translation)
      && !/[\r\n]/.test(translation.translation)
      && !translation.translation.includes("<!-- knowflow-translation -->")
      && !/```|~~~/.test(translation.translation)
      ? [{ id: translation.id, translation: translation.translation.trim() }]
      : []
  );
}

function normalizeLanguageName(value: unknown): string {
  if (typeof value !== "string") return "";
  const language = value.trim().toLowerCase();
  return /^[a-z0-9_+-]{1,24}$/.test(language) ? language : "";
}
