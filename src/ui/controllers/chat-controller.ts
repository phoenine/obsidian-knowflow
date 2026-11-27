import { Notice, TFile } from "obsidian";
import type { App } from "obsidian";
import type KnowFlowPlugin from "../../main";
import type { ChatMessage, ChatThread, ChatUsage, ViewContext } from "../../types";
import { prepareArticleForAi } from "../../services/clipping/managed-content";
import { freshnessSelectionMatches, parseArticleUpdateReply, parseFreshnessRequest, renderFreshnessApplied, renderFreshnessCommit, renderFreshnessReview } from "../../services/chat/freshness-chat";
import { locateCodeBlocks, parseCodeFormatApply, parseCodeFormatRequest, renderCodeFormatReview } from "../../services/chat/code-format-chat";
import { chatEdits, isArticleEditRequest, isEditOfferAccepted, renderArticleEditResult, renderArticleEditReview } from "../../services/chat/article-edit-chat";
import { commitNoteEdits, type EditItem } from "../../services/core/note-edits";
import type { FreshnessReview } from "../../services/learning/article-freshness";
import { applyFormattingEdits, batchFormattingCandidates, planCodeFormatting, sameCodeIgnoringComments, type FormattingCandidate, type FormattingDecision } from "../../services/clipping/formatting-candidates";
import { resolveDeepSeekSearchKey } from "../../services/search/public-evidence";
import { t } from "../../i18n";

interface PendingFreshnessReview {
  file: TFile;
  review: FreshnessReview;
  messageId: string;
  selected: number[];
}

interface PendingCodeFormat {
  file: TFile;
  /** Note text when the preview was built. The write is refused if it changed. */
  snapshot: string;
  candidates: FormattingCandidate[];
  items: Array<{ decision: FormattingDecision; section: string; language: string; content: string }>;
  warnings: string[];
  messageId: string;
}

interface PendingArticleEdit {
  file: TFile;
  items: EditItem[];
  messageId: string;
}

export class ChatController {
  activeThread: ChatThread | null = null;
  private pendingFreshness = new WeakMap<ChatThread, PendingFreshnessReview>();
  private pendingCodeFormat = new WeakMap<ChatThread, PendingCodeFormat>();
  private pendingArticleEdit = new WeakMap<ChatThread, PendingArticleEdit>();
  /** An answer that ends by asking whether to put it into the article. */
  private pendingEditOffer = new WeakMap<ChatThread, string>();

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
      const refreshMessage = () => {
        if (this.activeThread === thread) handlers.onContent(assistantMessage);
      };
      const result = handlers.replay ? null
        : (await this.handleFreshness(question, thread, file, assistantMessage, refreshMessage, (delta) => {
          appendReasoning(assistantMessage, delta);
          if (this.activeThread === thread) handlers.onReasoning(assistantMessage);
        })) ?? await this.handleCodeFormat(question, thread, file, assistantMessage, refreshMessage)
          ?? await this.handleArticleEdit(question, thread, file, assistantMessage, refreshMessage, (delta) => {
            appendReasoning(assistantMessage, delta);
            if (this.activeThread === thread) handlers.onReasoning(assistantMessage);
          });
      if (result !== null) {
        assistantMessage.content = result;
      } else {
        requestUsage = await this.answerQuestion(question, file, thread, assistantMessage, handlers);
        if (this.pendingEditOffer.get(thread) === assistantMessage.id) {
          assistantMessage.content = `${assistantMessage.content.trimEnd()}\n\n${t("articleEditOffer")}`;
        }
      }
      assistantMessage.status = "done";
      assistantMessage.completedAt = new Date().toISOString();
      thread.usage = addChatUsage(thread.usage, requestUsage);
    } catch (error) {
      if (this.pendingEditOffer.get(thread) === assistantMessage.id) this.pendingEditOffer.delete(thread);
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
    const searchKey = this.plugin.settings?.deepseekSearchEnabled === true
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
          appendReasoning(assistantMessage, delta);
          if (this.activeThread === thread) handlers.onReasoning(assistantMessage);
        },
        onUsage: () => {},
        retrievedContext,
        externalContext
      }
    );
  }

  /** Empty when DeepSeek Search is off. A missing key is an error only when the user turned search on. */
  private freshnessSearchKey(): string {
    if (this.plugin.settings?.deepseekSearchEnabled !== true) return "";
    const key = resolveDeepSeekSearchKey(this.plugin.settings, this.app.secretStorage);
    if (!key.trim()) throw new Error(t("deepseekSearchRequired"));
    return key;
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
    const previous = this.pendingFreshness.get(thread);
    const pending = previous && file && previous.file === file && previous.review.path === file.path
      && thread.messages.at(-3)?.id === previous.messageId ? previous : undefined;
    if (previous && !pending) this.pendingFreshness.delete(thread);
    const reply = pending ? parseArticleUpdateReply(question) : null;
    // "应用全部" / "应用第 1 个" may be meant for a code-format or article-edit preview.
    // Let that handler take it before this one marks the message as an article-freshness message.
    if (request?.kind === "apply" && !pending && (this.codeFormatReviewIsCurrent(thread, file) || this.articleEditReviewIsCurrent(thread, file))) return null;
    if ((!request && !reply) || request?.kind === "classify") {
      if (pending) this.pendingFreshness.delete(thread);
      if (!request || !file || isArticleEditRequest(question) || !await this.plugin.ai.isFreshnessRequest(question)) return null;
    }
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
      if (!pending.selected.length) {
        this.pendingFreshness.set(thread, { ...pending, messageId: message.id });
        return t("freshnessSelectFirst");
      }
      return this.applyFreshnessUpdates(file, thread, pending.review, new Set(pending.selected), message, progress);
    }
    if (!request) return null;

    if (request.kind === "apply") {
      if (!pending) return t("freshnessNoPending");
      const { review } = pending;
      const indexes = request.numbers === "all"
        ? review.updates.map((_, index) => index)
        : [...new Set(request.numbers)].map((number) => number - 1);
      if (indexes.some((index) => index < 0 || index >= review.updates.length)) {
        this.pendingFreshness.set(thread, { ...pending, selected: [], messageId: message.id });
        return t("freshnessBadIndex", { count: review.updates.length });
      }
      const chosen = review.updates[indexes[0]];
      if (request.label && (indexes.length !== 1 || !chosen || !freshnessSelectionMatches(chosen.action, chosen.status, request.label))) {
        this.pendingFreshness.set(thread, { ...pending, selected: [], messageId: message.id });
        return t("freshnessPickMismatch", { n: indexes[0] + 1, label: request.label });
      }
      this.pendingFreshness.set(thread, { ...pending, selected: indexes, messageId: message.id });
      if (indexes.length === 1 && chosen) {
        return t("freshnessPick", { n: indexes[0] + 1, label: `${chosen.action} · ${chosen.status}` });
      }
      return t("freshnessPickMany", { list: indexes.map((index) => index + 1).join("、") });
    }

    this.pendingFreshness.delete(thread);
    progress(t("readingArticle"));
    const review = await this.plugin.freshness.check(
      file,
      this.plugin.settings.chatModel,
      this.freshnessSearchKey(),
      progress,
      onReasoning
    );
    if (!review.updates.length || !thread.messages.includes(message)) return renderFreshnessReview(file.basename, review);
    this.pendingFreshness.set(thread, { file, review, messageId: message.id, selected: review.updates.map((_, index) => index) });
    return renderFreshnessReview(file.basename, review);
  }

  freshnessSelection(thread: ChatThread, message: ChatMessage): { count: number; selected: readonly number[] } | undefined {
    const pending = this.pendingFreshness.get(thread);
    if (!pending || this.activeThread !== thread || thread.messages.at(-1) !== message || pending.messageId !== message.id) return;
    return { count: pending.review.updates.length, selected: pending.selected };
  }

  selectFreshnessItems(thread: ChatThread, message: ChatMessage, indexes: number[]): boolean {
    const pending = this.pendingFreshness.get(thread);
    if (!pending || !this.freshnessSelection(thread, message) || indexes.some((index) => !pending.review.updates[index])) return false;
    pending.selected = indexes;
    return indexes.length > 0;
  }

  /**
   * Buttons for a review that is waiting for a reply. The button text is sent
   * as the reply, so it goes through the same parser as typed text.
   * Only the last message can offer buttons; anything said after it closes them.
   */
  replyChoices(thread: ChatThread, message: ChatMessage): Array<{ label: string; reply: string }> {
    if (thread.messages.at(-1) !== message) return [];
    if (this.pendingEditOffer.get(thread) === message.id) {
      return [
        { label: t("articleEditOfferChoice"), reply: "写进文章" },
        { label: t("freshnessKeepChoice"), reply: "不用" }
      ];
    }
    const freshness = this.pendingFreshness.get(thread);
    if (freshness?.messageId === message.id) {
      return [
        { label: t("freshnessUpdateChoice"), reply: "更新" },
        { label: t("freshnessKeepChoice"), reply: "不用" }
      ];
    }
    const pending = this.pendingCodeFormat.get(thread);
    if (pending?.messageId === message.id || this.pendingArticleEdit.get(thread)?.messageId === message.id) {
      return [
        { label: t("freshnessUpdateChoice"), reply: "更新" },
        { label: t("freshnessKeepChoice"), reply: "不用" }
      ];
    }
    return [];
  }

  /** A preview is waiting for the reply to come right after it. */
  private codeFormatReviewIsCurrent(thread: ChatThread, file: TFile | null): boolean {
    const pending = this.pendingCodeFormat.get(thread);
    return Boolean(pending && file && pending.file === file && thread.messages.at(-3)?.id === pending.messageId);
  }

  private async applyFreshnessUpdates(
    file: TFile,
    thread: ChatThread,
    review: FreshnessReview,
    selected: Set<number>,
    message: ChatMessage,
    progress: (stage: string) => void
  ): Promise<string> {
    progress(t("updatingArticle"));
    const result = await this.plugin.freshness.apply(file, review, selected);
    const unselected = review.updates.filter((_, index) => !selected.has(index));
    if (!result || !Array.isArray(result.skipped)) {
      this.pendingFreshness.delete(thread);
      return renderFreshnessApplied(selected.size, unselected.length);
    }
    const summary = renderFreshnessCommit(result.written, result.skipped, unselected.length);
    if (!unselected.length) {
      this.pendingFreshness.delete(thread);
      return summary;
    }
    const next = { ...review, updates: unselected };
    this.pendingFreshness.set(thread, { file, review: next, messageId: message.id, selected: unselected.map((_, index) => index) });
    return [summary, renderFreshnessReview(file.basename, next)].join("\n\n");
  }

  /**
   * "格式化第 2.4 节的代码块" / "格式化文章中的代码块": the model checks only the named
   * blocks, and nothing is written until the user confirms in the same chat.
   */
  private async handleCodeFormat(
    question: string,
    thread: ChatThread,
    file: TFile | null,
    message: ChatMessage,
    refreshMessage: () => void
  ): Promise<string | null> {
    const pending = this.pendingCodeFormat.get(thread);
    const reviewIsCurrent = this.codeFormatReviewIsCurrent(thread, file);
    const reply = reviewIsCurrent ? parseArticleUpdateReply(question) : null;
    const chosen = reviewIsCurrent ? parseCodeFormatApply(question) : null;
    const scope = parseCodeFormatRequest(question);
    if (!scope && !reply && !chosen) {
      if (pending) this.pendingCodeFormat.delete(thread);
      return null;
    }

    const progress = (stage: string) => {
      message.content = stage;
      refreshMessage();
    };
    if (reply === "decline" && pending) {
      this.pendingCodeFormat.delete(thread);
      return t("freshnessUnchanged");
    }
    if (reply === "accept" && pending) {
      return this.applyCodeFormat(thread, pending, new Set(pending.items.map((_, index) => index)), progress);
    }
    if (chosen && pending) {
      const numbers = chosen === "all" ? pending.items.map((_, index) => index) : chosen.map((number) => number - 1);
      if (numbers.some((index) => index < 0 || index >= pending.items.length)) {
        return t("codeFormatBadNumber", { count: pending.items.length });
      }
      return this.applyCodeFormat(thread, pending, new Set(numbers), progress);
    }
    if (!scope) return null;

    this.pendingCodeFormat.delete(thread);
    if (!file || file.extension !== "md" || file.path !== thread.filePath
      || this.app.vault.getAbstractFileByPath(file.path) !== file) {
      return t("openArticleFirst");
    }
    const content = await this.app.vault.read(file);
    const located = locateCodeBlocks(content, scope);
    if (located.error === "section") return t("codeFormatNoSection", { section: scope.section ?? "" });
    if (located.error === "index") return t("codeFormatNoIndex", { index: scope.index ?? 0 });
    if (!located.blocks.length) return t("codeFormatEmpty");

    const candidates = located.blocks.map(({ candidate }) => candidate);
    const comments = Boolean(scope.comments);
    progress(t("codeFormatChecking", { count: candidates.length }));
    const { local: decisions, model } = comments ? { local: [], model: candidates } : planCodeFormatting(candidates);
    let failedBlocks = 0;
    for (const batch of batchFormattingCandidates(model, { maxChars: 8000, maxItems: 10 })) {
      try {
        decisions.push(...await this.plugin.ai.confirmFormatting(batch, "", comments ? "code-chat-comments" : "code-chat"));
      } catch {
        // One failed batch leaves those blocks unchanged. Blocks from other batches can still be previewed.
        failedBlocks += batch.length;
      }
    }

    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const requested: FormattingDecision[] = [];
    const proposed = new Set<string>();
    for (const decision of decisions) {
      if (decision.action !== "reformat-code") continue;
      const candidate = byId.get(decision.id);
      if (!candidate) continue;
      proposed.add(decision.id);
      if (typeof decision.content !== "string") continue;
      if (comments && !sameCodeIgnoringComments(candidate.content, decision.content)) continue;
      requested.push(decision);
    }
    const { reformats } = applyFormattingEdits(content, candidates, requested, { trustReformat: comments });
    const items: PendingCodeFormat["items"] = [];
    for (const { candidate, section } of located.blocks) {
      const restored = reformats.get(candidate.id);
      if (!restored) continue;
      const { body, language } = restored;
      const decision: FormattingDecision = { id: candidate.id, action: "reformat-code", language, content: body };
      proposed.delete(candidate.id);
      items.push({ decision, section, language, content: body });
    }
    const warnings = [
      failedBlocks ? t("codeFormatBatchFailed", { count: failedBlocks }) : "",
      proposed.size ? t("codeFormatRejected", { count: proposed.size }) : ""
    ].filter(Boolean);
    if (!items.length) return warnings.join("\n\n") || t(comments ? "codeFormatNoComment" : "codeFormatNone");

    this.pendingCodeFormat.set(thread, { file, snapshot: content, candidates, items, warnings, messageId: message.id });
    const preview = renderCodeFormatReview(items.map(({ section, language, content: body }) => ({ section, language, content: body })));
    return [...warnings, preview].join("\n\n");
  }

  private async applyCodeFormat(
    thread: ChatThread,
    pending: PendingCodeFormat,
    selected: Set<number>,
    progress: (stage: string) => void
  ): Promise<string> {
    this.pendingCodeFormat.delete(thread);
    if (await this.app.vault.read(pending.file) !== pending.snapshot) return t("codeFormatChanged");
    const decisions = pending.items.filter((_, index) => selected.has(index)).map((item) => item.decision);
    const edited = applyFormattingEdits(pending.snapshot, pending.candidates, decisions, { trustReformat: true });
    progress(t("updatingArticle"));
    await this.app.vault.process(pending.file, (latest) => {
      if (latest !== pending.snapshot) throw new Error(t("codeFormatChanged"));
      return edited.content;
    });
    return [t("codeFormatApplied", { count: edited.applied }), ...pending.warnings].join("\n\n");
  }

  /** The last ordinary answer. Reports and previews are not article text. */
  private previousAnswer(thread: ChatThread, currentMessageId: string): string {
    const offer = t("articleEditOffer");
    for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
      const item = thread.messages[index];
      if (item.id === currentMessageId || item.role !== "assistant") continue;
      if (item.status !== "done" || item.kind || !item.content.trim()) return "";
      const content = item.content.trimEnd();
      return content.endsWith(offer) ? content.slice(0, -offer.length).trimEnd() : content;
    }
    return "";
  }

  private canEdit(thread: ChatThread, file: TFile | null): boolean {
    return Boolean(file && file.extension === "md" && file.path === thread.filePath
      && this.app.vault.getAbstractFileByPath(file.path) === file);
  }

  /** A preview is waiting for the reply to come right after it. */
  private articleEditReviewIsCurrent(thread: ChatThread, file: TFile | null): boolean {
    const pending = this.pendingArticleEdit.get(thread);
    return Boolean(pending && file && pending.file === file && thread.messages.at(-3)?.id === pending.messageId);
  }

  /**
   * "把开头那段改短" / "删掉最后一句": the model returns exact replacements,
   * and nothing is written until the user confirms in the same chat.
   */
  private async handleArticleEdit(
    question: string,
    thread: ChatThread,
    file: TFile | null,
    message: ChatMessage,
    refreshMessage: () => void,
    onReasoning: (delta: string) => void
  ): Promise<string | null> {
    const pending = this.pendingArticleEdit.get(thread);
    const reviewIsCurrent = this.articleEditReviewIsCurrent(thread, file);
    const reply = reviewIsCurrent ? parseArticleUpdateReply(question) : null;
    const chosen = reviewIsCurrent ? parseCodeFormatApply(question) : null;
    const offered = this.pendingEditOffer.get(thread);
    const offerIsCurrent = Boolean(offered && thread.messages.at(-3)?.id === offered);
    this.pendingEditOffer.delete(thread);
    let instruction = question;
    if (offerIsCurrent && parseArticleUpdateReply(question) === "decline") {
      message.kind = "article-edit";
      return t("freshnessUnchanged");
    }
    let request = isArticleEditRequest(question);
    if (offerIsCurrent && (isEditOfferAccepted(question) || parseArticleUpdateReply(question) === "accept")) {
      instruction = "把上一轮回答中的内容补充到文章里。";
      request = true;
    }
    if (!request && !reply && !chosen) {
      if (pending) this.pendingArticleEdit.delete(thread);
      const intent = this.canEdit(thread, file) && this.plugin.ai.classifyArticleEdit
        ? await this.plugin.ai.classifyArticleEdit(question, this.previousAnswer(thread, message.id))
        : "none";
      if (intent === "ask") this.pendingEditOffer.set(thread, message.id);
      if (intent !== "edit") return null;
      request = true;
    }

    message.kind = "article-edit";
    if (!file || file.extension !== "md" || file.path !== thread.filePath
      || this.app.vault.getAbstractFileByPath(file.path) !== file) {
      return t("editArticleFirst");
    }
    const progress = (stage: string) => {
      message.content = stage;
      refreshMessage();
    };
    if ((reply === "decline" || reply === "accept" || chosen) && pending) {
      if (reply === "decline") {
        this.pendingArticleEdit.delete(thread);
        return t("articleEditStopped");
      }
      if (reply === "accept") {
        return this.applyArticleEdit(thread, pending, new Set(pending.items.map((_, index) => index)), message, progress);
      }
      const numbers = chosen === "all" ? pending.items.map((_, index) => index) : (chosen ?? []).map((number) => number - 1);
      if (numbers.some((index) => index < 0 || index >= pending.items.length)) {
        return t("articleEditBadNumber", { count: pending.items.length });
      }
      return this.applyArticleEdit(thread, pending, new Set(numbers), message, progress);
    }
    if (!request) return t("articleEditNone");

    this.pendingArticleEdit.delete(thread);
    progress(t("readingArticle"));
    const content = await this.app.vault.read(file);
    const proposal = await this.plugin.ai.proposeArticleEdits(
      instruction,
      content,
      onReasoning,
      this.previousAnswer(thread, message.id)
    );
    if (!proposal.edits) return t("articleEditInvalid");
    const prepared = chatEdits(content, proposal.edits);
    if (!prepared.items.length) {
      if (!prepared.rejected.length) return t("articleEditNone");
      if (proposal.truncated && prepared.rejected.some((item) => item.reason === "missing")) return t("articleEditMissingLong");
      const reason = prepared.rejected[0]?.reason;
      if (reason === "ambiguous") return t("articleEditAmbiguous");
      if (reason === "span") return t("articleEditSpan");
      if (reason === "protected") return t("articleEditReasonProtected");
      return t("articleEditMissing");
    }
    this.pendingArticleEdit.set(thread, { file, items: prepared.items, messageId: message.id });
    return renderArticleEditReview(prepared.items);
  }

  private async applyArticleEdit(
    thread: ChatThread,
    pending: PendingArticleEdit,
    selected: Set<number>,
    message: ChatMessage,
    progress: (stage: string) => void
  ): Promise<string> {
    progress(t("updatingArticle"));
    let commit = commitNoteEdits("", [], selected);
    await this.app.vault.process(pending.file, (latest) => {
      commit = commitNoteEdits(latest, pending.items, selected);
      return commit.content;
    });
    const finished = new Set([...commit.written, ...commit.skipped.map((skip) => skip.index)]);
    const remaining = pending.items.filter((_, index) => !finished.has(index));
    if (remaining.length) this.pendingArticleEdit.set(thread, { file: pending.file, items: remaining, messageId: message.id });
    else this.pendingArticleEdit.delete(thread);
    return renderArticleEditResult(commit, remaining);
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
    if (this.pendingCodeFormat.get(thread)?.messageId === thread.messages[index + 1]?.id) {
      this.pendingCodeFormat.delete(thread);
    }
    if (this.pendingArticleEdit.get(thread)?.messageId === thread.messages[index + 1]?.id) {
      this.pendingArticleEdit.delete(thread);
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

const REASONING_TAIL = 160;

/** The thinking line only shows its tail. Keeping the whole trace makes every token rewrite a huge string. */
function appendReasoning(message: ChatMessage, delta: string): void {
  if (!delta) return;
  if (delta.length >= REASONING_TAIL) {
    message.reasoning = delta.slice(-REASONING_TAIL);
    return;
  }
  const overflow = message.reasoning.length + delta.length - REASONING_TAIL;
  message.reasoning = overflow > 0 ? message.reasoning.slice(overflow) + delta : message.reasoning + delta;
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
