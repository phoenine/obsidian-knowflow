import { requestUrl } from "obsidian";
import type { AiModelConfig } from "../../types";
import { withTimeout } from "./ai-transport";

const EMBEDDING_TIMEOUT_MS = 360000;

interface EmbeddingResponse {
  data?: Array<{ embedding?: unknown; index?: unknown }>;
}

/** Calls an OpenAI-compatible embeddings endpoint and validates vector shape. */
export class EmbeddingTransport {
  async embed(config: AiModelConfig, inputs: string[]): Promise<number[][]> {
    if (inputs.length === 0) return [];
    assertEmbeddingConfig(config);
    const baseUrl = config.apiBaseUrl.trim().replace(/\/+$/g, "");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json"
    };
    if (config.apiKey.trim()) headers.Authorization = `Bearer ${config.apiKey.trim()}`;

    const response = await withTimeout(
      requestUrl({
        url: `${baseUrl}/embeddings`,
        method: "POST",
        headers,
        body: JSON.stringify({ model: config.model, input: inputs }),
        throw: false
      }),
      EMBEDDING_TIMEOUT_MS,
      `Embedding request timed out after ${EMBEDDING_TIMEOUT_MS / 1000}s. Check that ${baseUrl} is reachable.`
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Embedding request failed: ${response.text?.slice(0, 220) || `HTTP ${response.status}`}`);
    }

    const payload = response.json as EmbeddingResponse;
    const rows = Array.isArray(payload?.data) ? [...payload.data] : [];
    rows.sort((left, right) => Number(left.index ?? 0) - Number(right.index ?? 0));
    const vectors = rows.map((row) => {
      if (!Array.isArray(row.embedding)) return [];
      if (!row.embedding.every((value) => typeof value === "number" && Number.isFinite(value))) return [];
      return row.embedding as number[];
    });
    if (vectors.length !== inputs.length || vectors.some((vector) => vector.length === 0)) {
      throw new Error(`Embedding endpoint returned ${vectors.length} valid rows for ${inputs.length} inputs.`);
    }
    const dimension = vectors[0].length;
    if (vectors.some((vector) => vector.length !== dimension)) {
      throw new Error("Embedding endpoint returned vectors with inconsistent dimensions.");
    }
    return vectors;
  }
}

function assertEmbeddingConfig(config: AiModelConfig): void {
  if (config.runtime === "disabled") throw new Error("Embedding model is disabled.");
  if (!config.apiBaseUrl.trim()) throw new Error("Embedding API Base URL is required.");
  if (!config.model.trim()) throw new Error("Embedding model ID is required.");
}
