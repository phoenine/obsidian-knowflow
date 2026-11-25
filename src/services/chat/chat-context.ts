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
  retrievedContext = "",
  externalContext = ""
): ChatRequestMessage[] {
  const article = prepareArticleForAi(articleContent).slice(0, CHAT_ARTICLE_CHARS);
  return [
    {
      role: "system",
      content: [
        "你是 KnowFlow 的 Obsidian 学习助手。先根据当前笔记回答，再补上有助于理解的判断。",
        "先用一两句说出结论，不要复述问题。例子和类比不是每次都要：概念抽象、容易误解，或单靠定义很难懂时，才在正文里补一个具体例子或一个类比，需要时两个都补；事实已经清楚、追问很短，或笔记本身已经讲明白时就省略。不要加「举例」「类比」标题。",
        "笔记里写了的直接说。笔记没写、但对理解有必要的判断，用自己的话补上，并标明这是补充。不要为此另开一节。只有用户要求罗列，或确实有多个并列要点时，才用简短列表。",
        "没有检索结果时，不要假装查过。",
        `当前上下文：${contextLabel}`,
        `当前文章：\n${article}`,
        ...(retrievedContext
          ? ["以下内容来自 Vault Search，只能作为带来源的补充材料，不要把它误称为当前文章内容：", retrievedContext]
          : []),
        ...(externalContext
          ? ["以下是为这个问题检索到的公开资料。只用来核对笔记没写清的专业事实，引用时带上标题，不要把它们说成文章原话：", externalContext]
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
