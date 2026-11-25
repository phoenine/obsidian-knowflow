import type { SecretStorage } from "obsidian";
import type { KnowFlowSettings } from "../../types";

export const MODEL_SECRET_IDS = {
  summaryModel: "knowflow-summary-model",
  taskModel: "knowflow-task-model",
  chatModel: "knowflow-chat-model",
  embeddingModel: "knowflow-embedding-model"
} as const;

export type ModelConfigKey = keyof typeof MODEL_SECRET_IDS;

const MODEL_KEYS = Object.keys(MODEL_SECRET_IDS) as ModelConfigKey[];
const STORED_MODEL_KEYS = [...MODEL_KEYS, "pipelineModel", "knowledgePointsModel", "knowledgeMapModel", "quizModel"];

export function loadModelCredentials(settings: KnowFlowSettings, secrets: Pick<SecretStorage, "getSecret" | "setSecret">): void {
  for (const key of MODEL_KEYS) {
    const config = settings[key];
    const id = MODEL_SECRET_IDS[key];
    const stored = secrets.getSecret(id);
    const legacy = config.apiKey.trim();
    if (stored !== null) {
      config.apiKey = stored;
    } else if (legacy) {
      secrets.setSecret(id, legacy);
      config.apiKey = legacy;
    }
  }
}

export function withoutPlaintextModelKeys(root: Record<string, unknown>): Record<string, unknown> {
  // Some older saves kept the original flat settings beside the new settings object.
  const cleaned = stripKeys(root);
  if (!isRecord(root.settings)) return cleaned;
  const settings = stripKeys(root.settings);
  return settings === root.settings ? cleaned : { ...cleaned, settings };
}

function stripKeys(record: Record<string, unknown>): Record<string, unknown> {
  const { apiKey, ...cleaned } = record;
  let changed = "apiKey" in record;
  for (const key of STORED_MODEL_KEYS) {
    const config = record[key];
    if (!isRecord(config) || !("apiKey" in config)) continue;
    const { apiKey, ...model } = config;
    cleaned[key] = model;
    changed = true;
  }
  return changed ? cleaned : record;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
