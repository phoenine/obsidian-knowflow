import { normalizePath } from "obsidian";
import type { App } from "obsidian";
import type { ChatThread } from "../../types";
import { protectedLineIndices, protectedRanges } from "../clipping/protected-markdown";

const FRESHNESS_MARKER = "<!-- knowflow-chat:article-freshness -->";

export class ChatNoteService {
  constructor(private app: App, private folder: string) {}

  updateFolder(path: string): void {
    this.folder = path;
  }

  async saveThread(thread: ChatThread): Promise<string> {
    const folder = normalizePath(this.folder);
    if (!(await this.app.vault.adapter.exists(folder))) {
      await this.app.vault.createFolder(folder);
    }
    const timestamp = window.moment().format("YYYYMMDD_HHmmss");
    const base = sanitizeFileName(thread.contextLabel || "Chat");
    let path = normalizePath(`${folder}/${base}@${timestamp}.md`);
    let suffix = 2;
    while (await this.app.vault.adapter.exists(path)) {
      path = normalizePath(`${folder}/${base}@${timestamp}_${suffix}.md`);
      suffix += 1;
    }
    await this.app.vault.create(path, renderThread(thread));
    return path;
  }

  async listThreads(): Promise<ChatThread[]> {
    const folder = normalizePath(this.folder);
    const prefix = `${folder}/`;
    const threads: ChatThread[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(prefix)) continue;
      const thread = parseThread(await this.app.vault.cachedRead(file), file.path);
      if (thread) threads.push(thread);
    }
    return threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}

export function renderThread(thread: ChatThread): string {
  const createdAt = new Date(thread.createdAt).getTime();
  const updatedAt = new Date(thread.updatedAt).getTime();
  let turnMarker = 1;
  while (thread.messages.some((message) => message.content.includes(`<!-- knowflow-turn-${turnMarker}`))) turnMarker += 1;
  const lines = [
    "---",
    `epoch: ${Number.isFinite(createdAt) ? createdAt : Date.now()}`,
    "modelKey: KnowFlow",
    `topic: ${yamlScalar(thread.contextLabel || "KnowFlow Chat")}`,
    `knowflowTurnMarker: ${turnMarker}`,
    `knowflowContext: ${yamlScalar(thread.filePath ?? "")}`,
    "tags:",
    "  - copilot-conversation",
    `lastAccessedAt: ${Number.isFinite(updatedAt) ? updatedAt : Date.now()}`,
    "---",
    ""
  ];
  for (const message of thread.messages) {
    const kind = message.kind === "article-freshness" ? ":article-freshness" : "";
    lines.push(`<!-- knowflow-turn-${turnMarker}${kind} -->`);
    lines.push(`**${message.role === "user" ? "user" : "ai"}**: ${message.role === "user" ? message.content.trim() : ""}`);
    lines.push("");
    if (message.role === "assistant") {
      lines.push(message.content.trim());
      lines.push("");
    }
    if (thread.filePath) {
      lines.push(`[Context: Notes: ${thread.filePath}]`);
      lines.push("");
    }
    lines.push(`[Timestamp: ${formatTimestamp(message.completedAt ?? message.createdAt)}]`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function parseThread(markdown: string, sourcePath = ""): ChatThread | null {
  const frontmatter = parseSimpleFrontmatter(markdown);
  const topic = frontmatter.topic || sourcePath.split("/").at(-1)?.replace(/@\d{8}_\d{6}(?:_\d+)?\.md$/, "") || "";
  const epoch = toEpoch(frontmatter.epoch);
  const lastAccessedAt = toEpoch(frontmatter.lastAccessedAt);
  const body = stripFrontmatter(markdown).replace(/\r\n/g, "\n");
  const marker = frontmatter.knowflowTurnMarker;
  const messages = marker && /^\d+$/.test(marker) ? parseSavedMessages(body, marker) : parseCopilotMessages(body);
  if (!topic && messages.length === 0) return null;
  const createdAt = new Date(epoch ?? messageEpoch(messages[0]) ?? Date.now()).toISOString();
  const updatedAt = new Date(lastAccessedAt ?? messageEpoch(messages.at(-1)) ?? epoch ?? Date.now()).toISOString();
  const filePath = frontmatter.knowflowContext === undefined
    ? parseContextPath(body) : unquoteYaml(frontmatter.knowflowContext) || null;
  return {
    id: sourcePath || `chat-${epoch ?? Date.now()}`,
    sourceMode: filePath ? "article-detail" : "empty",
    filePath,
    contextLabel: unquoteYaml(topic),
    messages,
    createdAt,
    updatedAt,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimated: true }
  };
}

function sanitizeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "Chat";
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  const pad = (number: number): string => String(number).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function parseSavedMessages(body: string, marker: string): ChatThread["messages"] {
  const turns = [...body.matchAll(new RegExp(`^<!-- knowflow-turn-${marker}(:article-freshness)? -->$`, "gm"))];
  return turns.flatMap((turn, index) => {
    const start = (turn.index ?? 0) + turn[0].length;
    const block = body.slice(start, turns[index + 1]?.index).trim();
    return parseMessage(block, index, turn[1] ? "article-freshness" : undefined);
  });
}

function parseCopilotMessages(body: string): ChatThread["messages"] {
  const lines = body.split("\n");
  const protectedLines = protectedLineIndices(protectedRanges(lines));
  const starts = lines.flatMap((line, index) => /^\*\*(user|ai)\*\*:/.test(line) && !protectedLines.has(index) ? [index] : []);
  return starts.flatMap((start, index) => parseMessage(lines.slice(start, starts[index + 1]).join("\n"), index, undefined, true));
}

function parseMessage(block: string, index: number, kind?: "article-freshness", legacy = false): ChatThread["messages"] {
  const header = /^\*\*(user|ai)\*\*:[ \t]*/.exec(block);
  if (!header) return [];
  const role = header[1] === "user" ? "user" : "assistant";
  const payload = block.slice(header[0].length);
  const footer = /(?:^|\n)(?:\[Context: (?:Notes|Files): [^\n]*\]\n\n)?\[Timestamp: ([^\n\]]+)\]\s*$/i.exec(payload);
  let content = payload.slice(0, footer?.index).trim();
  if (legacy && role === "assistant" && content.startsWith(FRESHNESS_MARKER)) {
    kind = "article-freshness";
    content = content.slice(FRESHNESS_MARKER.length).trimStart();
  }
  const createdAt = parseTimestamp(footer?.[1])?.toISOString() ?? new Date().toISOString();
  return [{
    id: `message-${index}-${new Date(createdAt).getTime()}`,
    role,
    content,
    reasoning: "",
    createdAt,
    completedAt: role === "assistant" ? createdAt : undefined,
    status: "done",
    kind
  }];
}

function parseSimpleFrontmatter(markdown: string): Record<string, string> {
  const match = /^---\s*\n([\s\S]*?)\n---/.exec(markdown.replace(/\r\n/g, "\n"));
  if (!match) return {};
  const values: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (field) values[field[1]] = field[2].trim();
  }
  return values;
}

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "");
}

function parseContextPath(markdown: string): string | null {
  const lines = markdown.split("\n");
  const protectedLines = protectedLineIndices(protectedRanges(lines));
  for (const [index, line] of lines.entries()) {
    if (protectedLines.has(index)) continue;
    const match = /^\[Context:\s*(?:Notes|Files):\s*([^\]]+?\.md)\s*\]$/i.exec(line);
    if (match) return match[1].trim();
  }
  return null;
}

function parseTimestamp(value: string | undefined): Date | null {
  if (!value) return null;
  const normalized = value.replace(
    /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/,
    "$1-$2-$3T$4:$5:$6"
  );
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toEpoch(value: string | undefined): number | null {
  const epoch = Number(value);
  return Number.isFinite(epoch) && epoch > 0 ? epoch : null;
}

function messageEpoch(message: ChatThread["messages"][number] | undefined): number | null {
  if (!message) return null;
  const epoch = new Date(message.completedAt ?? message.createdAt).getTime();
  return Number.isNaN(epoch) ? null : epoch;
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function unquoteYaml(value: string): string {
  try {
    return value.startsWith('"') ? JSON.parse(value) as string : value;
  } catch {
    return value.replace(/^['"]|['"]$/g, "");
  }
}
