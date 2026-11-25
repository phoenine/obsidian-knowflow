import { Notice, TFile } from "obsidian";
import type { App } from "obsidian";
import type KnowFlowPlugin from "../../main";
import type { ChatMessage, ChatThread, ChatUsage, ViewContext } from "../../types";
import { prepareArticleForAi } from "../../services/clipping/managed-content";
import { parseArticleUpdateReply, parseFreshnessRequest, renderFreshnessApplied, renderFreshnessReview } from "../../services/chat/freshness-chat";
import type { FreshnessReview } from "../../services/learning/article-freshness";
import { resolveDeepSeekSearchKey } from "../../services/search/public-evidence";
import { t } from "../../i18n";

interface PendingFreshnessReview {
  file: TFile;
  review: FreshnessReview;
  messageId: string;
}

export class ChatController {
  activeThread: ChatThread | null = null;
  private pendingFreshness = new WeakMap<ChatThread, PendingFreshnessReview>();

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
      useVaultSearch?: boolean;
      contextPaths?: string[];
      replay?: boolean;
    }
  ): Promise<void> {
    if (!question) {
      new Notice(t("enterQuestion"));
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
      const result = handlers.replay ? null : await this.handleFreshness(question, thread, file, assistantMessage, () => {
        if (this.activeThread === thread) handlers.onContent(assistantMessage);
      }, (delta) => {
        assistantMessage.reasoning += delta;
        if (this.activeThread === thread) handlers.onReasoning(assistantMessage);
      });
      if (result !== null) {
        assistantMessage.content = result;
      } else {
        requestUsage = await this.answerQuestion(question, file, thread, assistantMessage, handlers);
      }
      assistantMessage.status = "done";
      assistantMessage.completedAt = new Date().toISOString();
      thread.usage = addChatUsage(thread.usage, requestUsage);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (assistantMessage.kind) assistantMessage.content = "";
      assistantMessage.status = "error";
      assistantMessage.error = message;
      assistantMessage.completedAt = new Date().toISOString();
      new Notice(t("chatFailed", { message }), 8000);
    }
    if (file && !assistantMessage.kind) {
      thread.filePath = file.path;
      thread.contextLabel = file.basename;
    }
    thread.updatedAt = assistantMessage.completedAt ?? new Date().toISOString();
    this.onStateChange();
  }

  private async answerQuestion(
    question: string,
    file: TFile | null,
    thread: ChatThread,
    assistantMessage: ChatMessage,
    handlers: {
      onContent: (message: ChatMessage) => void;
      onReasoning: (message: ChatMessage) => void;
      useVaultSearch?: boolean;
      contextPaths?: string[];
    }
  ): Promise<ChatUsage> {
    const content = file ? await this.app.vault.read(file) : "";
    let retrievedContext = "";
    if (handlers.useVaultSearch) {
      try {
        retrievedContext = await this.plugin.semanticIndex.searchContext(question, file?.path);
      } catch (error) {
        new Notice(t("vaultSearchUnavailable", { message: error instanceof Error ? error.message : String(error) }), 6000);
      }
    }
    const attachedContext = await this.loadAttachedContext(handlers.contextPaths ?? []);
    retrievedContext = [attachedContext, retrievedContext].filter(Boolean).join("\n\n");
    const searchKey = this.plugin.settings
      ? resolveDeepSeekSearchKey(this.plugin.settings, this.app.secretStorage)
      : "";
    const externalContext = searchKey && this.plugin.ai.externalContextForChat
      ? await this.plugin.ai.externalContextForChat(question, content, searchKey, () => {
        assistantMessage.content = t("searching");
        if (this.activeThread === thread) handlers.onContent(assistantMessage);
      })
      : "";
    assistantMessage.content = "";
    assistantMessage.status = "streaming";
    return this.plugin.ai.answerStream(
      thread.contextLabel,
      content,
      thread.messages.filter((message) => message.id !== assistantMessage.id),
      {
        onContent: (delta) => {
          assistantMessage.content += delta;
          assistantMessage.status = "streaming";
          if (this.activeThread === thread) handlers.onContent(assistantMessage);
        },
        onReasoning: (delta) => {
          assistantMessage.reasoning += delta;
          if (this.activeThread === thread) handlers.onReasoning(assistantMessage);
        },
        onUsage: () => {},
        retrievedContext,
        externalContext
      }
    );
  }

  private async handleFreshness(
    question: string,
    thread: ChatThread,
    file: TFile | null,
    message: ChatMessage,
    refreshMessage: () => void,
    onReasoning: (delta: string) => void
  ): Promise<string | null> {
    const request = parseFreshnessRequest(question);
    const pending = this.pendingFreshness.get(thread);
    const reviewIsCurrent = Boolean(pending && thread.messages.at(-3)?.id === pending.messageId);
    const reply = reviewIsCurrent && pending && file && pending.file === file && pending.review.path === file.path
      ? parseArticleUpdateReply(question) : null;
    if (!request && !reply) {
      if (pending) this.pendingFreshness.delete(thread);
      return null;
    }
    if (request?.kind === "classify" && (!file || !await this.plugin.ai.isFreshnessRequest(question))) return null;
    message.kind = "article-freshness";
    if (!file || file.extension !== "md" || file.path !== thread.filePath
      || this.app.vault.getAbstractFileByPath(file.path) !== file) {
      return t("openArticleFirst");
    }
    const progress = (stage: string, detail?: string) => {
      message.content = detail ? `${stage} ${detail}` : stage;
      refreshMessage();
    };
    if (reply === "decline") {
      this.pendingFreshness.delete(thread);
      return t("freshnessUnchanged");
    }
    if (reply === "accept" && pending) {
      return this.applyFreshnessUpdates(
        file, thread, pending.review,
        new Set(pending.review.updates.map((_, index) => index)),
        progress
      );
    }
    if (!request) return null;

    if (request.kind === "apply") {
      const pending = this.pendingFreshness.get(thread);
      if (!pending || pending.file !== file || pending.review.path !== thread.filePath) {
        return t("freshnessNoPending");
      }
      const { review } = pending;
      const selected = new Set(request.numbers === "all"
        ? review.updates.map((_, index) => index)
        : request.numbers.map((number) => number - 1));
      if ([...selected].some((index) => index < 0 || index >= review.updates.length)) {
        return t("freshnessBadIndex", { count: review.updates.length });
      }
      return this.applyFreshnessUpdates(file, thread, review, selected, progress);
    }

    this.pendingFreshness.delete(thread);
    progress(t("readingArticle"));
    const review = await this.plugin.freshness.check(
      file,
      this.plugin.settings.chatModel,
      resolveDeepSeekSearchKey(this.plugin.settings, this.app.secretStorage),
      progress,
      onReasoning
    );
    if (!review.updates.length || !thread.messages.includes(message)) return renderFreshnessReview(file.basename, review);
    this.pendingFreshness.set(thread, { file, review, messageId: message.id });
    return renderFreshnessReview(file.basename, review);
  }

  private async applyFreshnessUpdates(
    file: TFile,
    thread: ChatThread,
    review: FreshnessReview,
    selected: Set<number>,
    progress: (stage: string) => void
  ): Promise<string> {
    progress(t("updatingArticle"));
    await this.plugin.freshness.apply(file, review, selected);
    this.pendingFreshness.delete(thread);
    return renderFreshnessApplied(selected.size, review.updates.length - selected.size);
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
    if (this.pendingFreshness.get(thread)?.messageId === thread.messages[index + 1]?.id) {
      this.pendingFreshness.delete(thread);
    }
    thread.messages.splice(index, count);
    thread.updatedAt = new Date().toISOString();
    this.onStateChange();
  }

  async saveActiveThread(): Promise<void> {
    if (!this.activeThread || this.activeThread.messages.length === 0) {
      new Notice(t("nothingToSave"));
      return;
    }
    const path = await this.plugin.chatNotes.saveThread(this.activeThread);
    new Notice(t("chatSaved", { path }));
  }

  private async loadAttachedContext(paths: string[]): Promise<string> {
    const sections: string[] = [];
    let remaining = 10000;
    for (const path of paths) {
      if (remaining <= 0) break;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      let markdown = "";
      try {
        markdown = await this.app.vault.cachedRead(file);
      } catch {
        continue;
      }
      const content = prepareArticleForAi(markdown).slice(0, remaining);
      if (!content) continue;
      sections.push(`[手动关联来源: ${file.path}]\n${content}`);
      remaining -= content.length;
    }
    return sections.join("\n\n");
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
