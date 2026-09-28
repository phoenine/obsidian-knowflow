import type { ChatMessage as StoredChatMessage } from "../../types";
import { prepareArticleForAi } from "../clipping/managed-content";

export type ChatRequestMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

const CHAT_ARTICLE_CHARS = 12000;
const CHAT_HISTORY_CHARS = 12000;
const CHAT_MESSAGE_CHARS = 6000;

export function buildChatRequestMessages(
  contextLabel: string,
  articleContent: string,
  history: StoredChatMessage[],
  retrievedContext = ""
): ChatRequestMessage[] {
  const article = prepareArticleForAi(articleContent).slice(0, CHAT_ARTICLE_CHARS);
  return [
    {
      role: "system",
      content: [
        "你是 KnowFlow 的 Obsidian 学习助手。围绕用户当前笔记回答，明确区分文章内容和你的推断。",
        `当前上下文：${contextLabel}`,
        `当前文章：\n${article}`,
        ...(retrievedContext
          ? ["以下内容来自 Vault Search，只能作为带来源的补充材料，不要把它误称为当前文章内容：", retrievedContext]
          : [])
      ].join("\n\n")
    },
    ...selectRecentHistory(history)
  ];
}

function selectRecentHistory(history: StoredChatMessage[]): ChatRequestMessage[] {
  const eligible = history
    .filter((message) => message.role === "user" || (message.role === "assistant" && message.status === "done" && message.content))
    .map((message): ChatRequestMessage => ({
      role: message.role,
      content: message.content.slice(0, CHAT_MESSAGE_CHARS)
    }));
  const selected: ChatRequestMessage[] = [];
  let chars = 0;
  for (let index = eligible.length - 1; index >= 0; index -= 1) {
    const message = eligible[index];
    if (selected.length > 0 && chars + message.content.length > CHAT_HISTORY_CHARS) break;
    selected.push(message);
    chars += message.content.length;
  }
  selected.reverse();
  while (selected[0]?.role === "assistant") selected.shift();
  return selected;
}
