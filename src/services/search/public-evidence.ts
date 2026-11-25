import { requestUrl } from "obsidian";
import type { SecretStorage } from "obsidian";
import { withTimeout } from "../ai/ai-transport";
import type { KnowFlowSettings } from "../../types";

export const DEEPSEEK_SEARCH_SECRET_ID = "knowflow-deepseek-search";
const DEEPSEEK_ORIGIN = "https://api.deepseek.com";
const SEARCH_TIMEOUT_MS = 20_000;
const RESULTS_PER_QUERY = 4;

export function resolveDeepSeekSearchKey(
  settings: KnowFlowSettings,
  secrets?: Pick<SecretStorage, "getSecret">
): string {
  const storedKey = secrets?.getSecret(DEEPSEEK_SEARCH_SECRET_ID)?.trim();
  if (storedKey) return storedKey;
  const officialModel = [
    settings.summaryModel, settings.pipelineModel, settings.chatModel,
    settings.knowledgePointsModel, settings.quizModel, settings.embeddingModel
  ].find((config) => config.runtime === "openai-compatible" && config.apiKey.trim()
    && [DEEPSEEK_ORIGIN, `${DEEPSEEK_ORIGIN}/v1`].includes(config.apiBaseUrl.trim().replace(/\/+$/, "")));
  return officialModel?.apiKey.trim() ?? "";
}

export interface PublicEvidence {
  id: number;
  title: string;
  url: string;
  date: string;
  excerpts: string[];
}

interface DeepSeekSearchResult {
  title?: string;
  url?: string;
  date?: string;
  content?: string;
}

type EvidenceCandidate = { title?: string; url: string; date?: string; excerpts: string[] };

export async function findPublicEvidence(queries: string[], apiKey: string): Promise<PublicEvidence[]> {
  const evidence = new Map<string, PublicEvidence>();
  for (const query of queries) {
    const results = await searchDeepSeek(query, apiKey);
    for (const result of results) {
      const { url } = result;
      const excerpts = result.excerpts.map((excerpt) => excerpt.slice(0, 2400));
      const previous = evidence.get(url);
      if (previous) {
        previous.excerpts = [...new Set([...previous.excerpts, ...excerpts])].slice(0, 5);
        continue;
      }
      const reportedDate = typeof result.date === "string" ? result.date.slice(0, 10) : "";
      evidence.set(url, {
        id: evidence.size + 1,
        title: typeof result.title === "string" ? result.title.slice(0, 200) : url,
        url,
        date: /^\d{4}-\d{2}-\d{2}$/.test(reportedDate) ? reportedDate : "",
        excerpts
      });
    }
  }
  return [...evidence.values()];
}

async function searchDeepSeek(query: string, apiKey: string): Promise<EvidenceCandidate[]> {
  const body = await requestDeepSeek<{ results?: DeepSeekSearchResult[] }>("search", apiKey, {
    query: Array.from(query.trim()).slice(0, 128).join(""),
    count: RESULTS_PER_QUERY, need_content: true
  });
  if (!Array.isArray(body?.results)) throw new Error("DeepSeek Search 没有返回有效的网页资料。");
  const results = body.results.slice(0, RESULTS_PER_QUERY).flatMap((result) => {
    const url = result && typeof result.url === "string" ? parseHttpUrl(result.url) : null;
    return url ? [{ ...result, url }] : [];
  });
  const candidates = results.flatMap((result) => {
    const content = typeof result.content === "string" ? result.content.trim() : "";
    return content ? [{ title: result.title, url: result.url, date: result.date, excerpts: [content] }] : [];
  });
  // A search summary is not a verbatim excerpt. Fetch one result only when
  // Search could not include page text for any candidate in this query.
  if (candidates.length || results.length === 0) return candidates;
  const [first] = results;
  const page = await requestDeepSeek<{ title?: string; content?: string }>("fetch", apiKey, { url: first.url });
  if (typeof page?.content !== "string" || !page.content.trim()) return [];
  return [{ title: page.title || first.title, url: first.url, date: first.date, excerpts: [page.content.trim()] }];
}

async function requestDeepSeek<T>(endpoint: "search" | "fetch", apiKey: string, body: object): Promise<T> {
  const response = await withTimeout(requestUrl({
    url: `${DEEPSEEK_ORIGIN}/v1/tools/${endpoint}`,
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    throw: false
  }), SEARCH_TIMEOUT_MS, "DeepSeek 获取公开资料超时。");
  if (response.status !== 200) {
    throw new Error(`DeepSeek ${endpoint === "search" ? "搜索" : "网页读取"}失败（HTTP ${response.status}）。`);
  }
  return response.json as T;
}

function parseHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || /[<>]/.test(url.href)) return null;
    return url.href;
  } catch {
    return null;
  }
}
