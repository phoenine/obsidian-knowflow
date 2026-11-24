import type { AiModelConfig } from "../../types";
import { AiTransport } from "./ai-transport";
import { batchTranslationCandidates } from "../clipping/translation-candidates";
import type { TranslationCandidate, TranslationDecision } from "../clipping/translation-candidates";

interface TranslationResponse {
  translations: TranslationDecision[];
}

export class RepairAi {
  constructor(private transport: AiTransport) {}

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
              "每个输入 id 必须返回且只能返回一次；不得合并、拆分或遗漏段落。",
              "只输出严格 JSON，不要输出 Markdown 围栏。"
            ].filter(Boolean).join("\n")
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
        translations.push(...normalized);
      } catch (error) {
        throw new Error(
          `英文翻译批次 ${index + 1}/${batches.length} 处理失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return translations;
  }
}

function normalizeTranslationResponse(
  value: unknown,
  candidates: TranslationCandidate[]
): TranslationDecision[] {
  if (!value || typeof value !== "object" || !("translations" in value) || !Array.isArray(value.translations)) {
    throw new Error("翻译响应格式错误：translations 必须为数组。");
  }
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<string>();
  const errors: string[] = [];
  const normalized: TranslationDecision[] = [];
  for (const [index, item] of value.translations.entries()) {
    if (!item || typeof item !== "object" || typeof item.id !== "string") {
      errors.push(`第 ${index + 1} 项缺少有效 id`);
      continue;
    }
    const candidate = byId.get(item.id);
    if (!candidate) {
      errors.push(`未知 id：${item.id.slice(0, 80)}`);
      continue;
    }
    if (seen.has(item.id)) {
      errors.push(describeTranslationCandidate(candidate, "重复返回"));
      continue;
    }
    seen.add(item.id);
    const reason = invalidTranslationReason(item.translation);
    if (reason) errors.push(describeTranslationCandidate(candidate, reason));
    else normalized.push({ id: item.id, translation: (item.translation as string).trim() });
  }
  for (const candidate of candidates) {
    if (!seen.has(candidate.id)) errors.push(describeTranslationCandidate(candidate, "未返回译文"));
  }
  if (errors.length > 0) {
    const details = errors.slice(0, 5).join("；");
    throw new Error(`翻译响应校验失败（${errors.length} 处）：${details}${errors.length > 5 ? "；其余省略" : ""}`);
  }
  return normalized;
}

function describeTranslationCandidate(candidate: TranslationCandidate, reason: string): string {
  return `${candidate.id}：${reason}（原文：${candidate.content.replace(/\s+/g, " ").slice(0, 60)}）`;
}

function invalidTranslationReason(value: unknown): string | null {
  if (typeof value !== "string") return "translation 必须为字符串";
  if (!value.trim()) return "译文为空";
  if (value.trim().length > 12000) return "译文过长（超过 12000 字符）";
  if (!/[\u3400-\u9fff]/.test(value)) return "译文不含中文";
  if (/[\r\n]/.test(value)) return "译文包含换行";
  if (value.includes("<!-- knowflow-translation -->")) return "译文包含内部标记";
  if (/```|~~~/.test(value)) return "译文包含代码围栏";
  return null;
}
