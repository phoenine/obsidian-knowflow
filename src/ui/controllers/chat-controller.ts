import { Notice, TFile } from "obsidian";
import type { App } from "obsidian";
import type KnowFlowPlugin from "../../main";
import type { ChatMessage, ChatThread, ChatUsage, ViewContext } from "../../types";

export class ChatController {
  activeThread: ChatThread | null = null;

  constructor(
    private app: App,
    private plugin: KnowFlowPlugin,
    private onStateChange: () => void
  ) {}

  getUsage(): ChatUsage {
    return this.activeThread?.usage ?? emptyChatUsage();
  }

  isSending(): boolean {
    return this.activeThread?.messages.some((message) =>
      message.role === "assistant" && (message.status === "pending" || message.status === "streaming")
    ) ?? false;
  }

  async submit(
    question: string,
    context: ViewContext,
    file: TFile | null,
    handlers: {
      onStart: () => void;
      onContent: (message: ChatMessage) => void;
      onReasoning: (message: ChatMessage) => void;
    }
  ): Promise<void> {
    if (!question) {
      new Notice("Enter a question first");
      return;
    }
    if (this.isSending()) return;
    const now = new Date().toISOString();
    const thread = this.activeThread ?? createChatThread(context, file, now);
    const userMessage = createChatMessage("user", question, now, "done");
    const assistantMessage = createChatMessage("assistant", "", now, "pending");
    thread.messages.push(userMessage, assistantMessage);
    thread.updatedAt = now;
    this.activeThread = thread;
    handlers.onStart();
    this.onStateChange();

    let requestUsage = emptyChatUsage();
    try {
      const content = file ? await this.app.vault.read(file) : "";
      assistantMessage.status = "streaming";
      requestUsage = await this.plugin.ai.answerStream(
        thread.contextLabel,
        content,
        thread.messages.filter((message) => message.id !== assistantMessage.id),
        {
          onContent: (delta) => {
            assistantMessage.content += delta;
            assistantMessage.status = "streaming";
            handlers.onContent(assistantMessage);
          },
          onReasoning: (delta) => {
            assistantMessage.reasoning += delta;
            handlers.onReasoning(assistantMessage);
          },
          onUsage: (usage) => {
            requestUsage = usage;
          }
        }
      );
      assistantMessage.status = "done";
      assistantMessage.completedAt = new Date().toISOString();
      thread.usage = addChatUsage(thread.usage, requestUsage);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assistantMessage.status = "error";
      assistantMessage.error = message;
      assistantMessage.completedAt = new Date().toISOString();
      new Notice(`KnowFlow chat failed: ${message}`, 8000);
    }
    if (file) {
      thread.filePath = file.path;
      thread.contextLabel = file.basename;
    }
    thread.updatedAt = assistantMessage.completedAt ?? new Date().toISOString();
    this.onStateChange();
  }

  findPreviousUserMessage(thread: ChatThread, assistantId: string): ChatMessage | null {
    const index = thread.messages.findIndex((message) => message.id === assistantId);
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (thread.messages[cursor].role === "user") return thread.messages[cursor];
    }
    return null;
  }

  deleteTurn(thread: ChatThread, userMessageId: string): void {
    const index = thread.messages.findIndex((message) => message.id === userMessageId);
    if (index < 0) return;
    const count = thread.messages[index + 1]?.role === "assistant" ? 2 : 1;
    thread.messages.splice(index, count);
    thread.updatedAt = new Date().toISOString();
    this.onStateChange();
  }

  async saveActiveThread(): Promise<void> {
    if (!this.activeThread || this.activeThread.messages.length === 0) {
      new Notice("当前没有可保存的对话。");
      return;
    }
    const path = await this.plugin.chatNotes.saveThread(this.activeThread);
    new Notice(`Chat 已保存到 ${path}`);
  }
}

function createChatThread(context: ViewContext, file: TFile | null, now: string): ChatThread {
  return {
    id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sourceMode: context.mode,
    filePath: file?.path ?? null,
    contextLabel: file?.basename ?? "Current",
    messages: [],
    createdAt: now,
    updatedAt: now,
    usage: emptyChatUsage()
  };
}

function createChatMessage(
  role: ChatMessage["role"],
  content: string,
  now: string,
  status: ChatMessage["status"]
): ChatMessage {
  return {
    id: `message-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    reasoning: "",
    createdAt: now,
    status
  };
}

function emptyChatUsage(): ChatUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimated: false };
}

function addChatUsage(current: ChatUsage, next: ChatUsage): ChatUsage {
  return {
    promptTokens: current.promptTokens + next.promptTokens,
    completionTokens: current.completionTokens + next.completionTokens,
    totalTokens: current.totalTokens + next.totalTokens,
    estimated: current.estimated || next.estimated
  };
}
