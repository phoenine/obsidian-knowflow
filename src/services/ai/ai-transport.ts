import { requestUrl } from "obsidian";
import type { AiModelConfig, ChatUsage } from "../../types";
import type { ChatRequestMessage } from "../chat/chat-context";
import { estimateChatUsage, parseChatStreamData } from "../chat/chat-stream";

const REQUEST_TIMEOUT_MS = 360000;

export class AiTransport {
  async requestJson<T>(config: AiModelConfig, messages: ChatRequestMessage[]): Promise<T> {
    const text = await this.requestText(config, messages, true);
    try {
      return parseJsonResponse<T>(text);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} Raw response: ${text.slice(0, 500)}`);
    }
  }

  async requestText(config: AiModelConfig, messages: ChatRequestMessage[], json = false): Promise<string> {
    assertModelConfig(config);
    const baseUrl = config.apiBaseUrl.trim().replace(/\/+$/g, "");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json"
    };
    if (config.apiKey.trim()) headers.Authorization = `Bearer ${config.apiKey.trim()}`;

    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      temperature: 0.2
    };
    if (json) {
      body.response_format = config.runtime === "openai-compatible"
        ? { type: "json_object" }
        : {
            type: "json_schema",
            json_schema: {
              name: "response",
              strict: false,
              schema: { type: "object" }
            }
          };
    }

    const response = await withTimeout(
      requestUrl({
        url: `${baseUrl}/chat/completions`,
        method: "POST",
        headers,
        body: JSON.stringify(body),
        throw: false
      }),
      REQUEST_TIMEOUT_MS,
      `AI request timed out after ${REQUEST_TIMEOUT_MS / 1000}s. Check that ${baseUrl} is reachable.`
    );

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`AI request failed: ${response.text?.slice(0, 220) || `HTTP ${response.status}`}`);
    }
    const content = response.json?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("AI response did not contain message content.");
    }
    return content.trim();
  }

  async requestTextStream(
    config: AiModelConfig,
    messages: ChatRequestMessage[],
    handlers: {
      onContent: (delta: string) => void;
      onReasoning: (delta: string) => void;
      onUsage: (usage: ChatUsage) => void;
    }
  ): Promise<ChatUsage> {
    assertModelConfig(config);
    const baseUrl = config.apiBaseUrl.trim().replace(/\/+$/g, "");
    const controller = new AbortController();
    let timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const resetTimer = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    };
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream"
    };
    if (config.apiKey.trim()) headers.Authorization = `Bearer ${config.apiKey.trim()}`;

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: 0.2,
          stream: true,
          stream_options: { include_usage: true }
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`AI stream failed: ${(await response.text()).slice(0, 220) || `HTTP ${response.status}`}`);
      }
      if (!response.body) throw new Error("AI stream did not return a response body.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let answer = "";
      let usage: ChatUsage | null = null;
      let done = false;

      const consume = (data: string): void => {
        if (!data) return;
        const delta = parseChatStreamData(data);
        if (delta.done) done = true;
        if (delta.reasoning) handlers.onReasoning(delta.reasoning);
        if (delta.content) {
          answer += delta.content;
          handlers.onContent(delta.content);
        }
        if (delta.usage) {
          usage = delta.usage;
          handlers.onUsage(usage);
        }
      };

      while (!done) {
        const chunk = await reader.read();
        resetTimer();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          for (const line of event.split("\n")) {
            if (line.startsWith("data:")) consume(line.slice(5).trim());
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
      if (buffer.trim()) {
        for (const line of buffer.split("\n")) {
          if (line.startsWith("data:")) consume(line.slice(5).trim());
        }
      }
      if (!answer.trim()) throw new Error("AI stream completed without answer content.");
      const finalUsage = usage ?? estimateChatUsage(messages, answer);
      handlers.onUsage(finalUsage);
      return finalUsage;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`AI stream timed out after ${REQUEST_TIMEOUT_MS / 1000}s without data.`);
      }
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }
}

function assertModelConfig(config: AiModelConfig): void {
  if (config.runtime === "disabled") {
    throw new Error("AI model is disabled. Configure the model in KnowFlow settings.");
  }
  if (!config.apiBaseUrl.trim()) {
    throw new Error("AI Base URL is missing. Configure the model in KnowFlow settings.");
  }
  if (!config.model.trim()) {
    throw new Error("AI Model ID is missing. Configure the model in KnowFlow settings.");
  }
  if (config.runtime === "openai-compatible" && !config.apiKey.trim()) {
    throw new Error("API Key is missing for Cloud runtime.");
  }
}

export function parseJsonResponse<T>(text: string): T {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const raw = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(raw) as T;
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1)) as T;
    throw new Error("AI response was not valid JSON.");
  }
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
