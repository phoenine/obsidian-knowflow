# KnowFlow 产品说明

本文描述当前插件的实现。早期方案里的 React 界面、SQLite 和把 Quiz 当数据库，都没有进入现在的插件。

## 1. 定位

KnowFlow 是 Obsidian 插件，把 Vault 里的网页剪藏和文章整理成可以学习、测验和复习的笔记。

```text
Clipping → 整理 → 总结 → 知识点 → Quiz → 学习状态 → 每日复习
```

插件负责校验和写入。模型返回结构化结果，不直接改文件。

## 2. 规则从哪里来

具名 Skill 有六份：`clipping-update`、`article-summary`、`article-translation`、`knowledge-points`、`article-quiz`、`article-freshness`。构建时随插件打包。

Vault 根目录的 `skills/<名称>/SKILL.md` 会替换同名内置规则。`clipping-update` 例外：内置整理规则，加上 `obsidian-markdown` 和 `obsidian-render-integrity`，始终生效；Vault 中的同名文件追加在后面。没有这份文件时，才使用旧的 `skills/clipping-repair/SKILL.md` 或 `skills/clipping-repair.md`。

文章问答没有单独的 Skill，提示词在 `src/services/chat/chat-context.ts`。相关文章和 Vault Search 由检索代码完成，不经过 Skill。

## 3. 目录和数据

默认目录可以在 Settings → Basic 修改：

```text
Clippings/                  # 剪藏入口
Articles/                   # 长期文章库，可按分类建子目录
Archives/                   # 每篇文章一份 Markdown Quiz
copilot-conversations/      # 用户主动保存的对话
Template/article.md         # Frontmatter 参考模板
```

学习状态、复习计划和插件设置写在 `.obsidian/plugins/knowflow/data.json`。API Key 也在这个文件里。Quiz、摘要和知识更新写在笔记里，不进数据库。

语义索引用独立的小型清单和 128 个分片，只覆盖已有 AI 摘要的文章。设计见 [Relevant Notes 与 Vault Search](relevant-notes-and-vault-search.md)。

## 4. 整理

用户在剪藏或文章页点击整理，或运行 `KnowFlow: Process current clipping`。侧边栏只有一个整理按钮，不展示内部步骤。按钮状态是整理中、已整理或错误。

内部依次处理文章样式、标题结构、代码块、图片、翻译和 Frontmatter。插件先恢复能确定的排版，例如提示词围栏、脱落列表和表格分隔线，并清理网页水印。

模型根据带行号的正文判断标题结构，插件核对后应用。代码候选单独分批确认，每批最多 4 条。某一批没有可用结果时，该批保留原文，其他批次继续。插件也会尝试恢复已引用但失效的图片。

整理时，代码、公式、独立链接、元信息和摘要以外的正文段落交给模型。整段中文跳过，整段非中文译成简体中文，译文跟在原段后面。已有围栏、wikilink、embed 和 callout 在整理时保持不动。

Frontmatter 按模板补全空字段。简要描述、阅读价值、分类和标签在每次整理时由摘要模型重写。模型没有返回结果时，已有简要描述保留。用户选择分类后，文件才移动到 `Articles/<分类>/`。

自动整理、自动摘要和自动 Quiz 尚未放进设置。

## 5. 学习材料

摘要写入笔记顶部的 `> [!summary]- AI 摘要`。阅读价值和分类写入 Frontmatter。模型没有返回摘要时，用相同输入重试一次。

知识点、整理和 Quiz 共用 Task model，按组保存知识点，并保留能在原文中对上的证据。界面入口叫「知识点」。已有的 Knowledge Points、Pipeline 或 Quiz model 会在读取时迁到 Task model，优先沿用原来的 Pipeline model。

Quiz 是 Markdown，保存在 `Archives/`，并在原文保留索引。支持旧的分组题号，以及 Frontmatter 里指向原文的相对链接。

## 6. 对话和知识检查

对话默认收在底部。打开后可以提问、收起并保留草稿。历史对话只显示主动保存到 `copilot-conversations/` 的会话。

回答先依据当前笔记。笔记没写、但对理解有必要的判断，用自己的话补上并标明是补充。例子和类比只在概念抽象或容易误解时出现。笔记缺少会变化的专业事实时，才用 DeepSeek Search 检索公开资料，并在回答里带来源标题。

在文章对话里发送「检查当前文章是否过时」后，模型按章节阅读，并先依据自身知识判断。能判断的说法给出可确认的更新；拿不准的只列出来，不挡住已经能改的条目。设置里打开 DeepSeek Search 后，这些更新仍然保留，并额外检索拿不准的说法和可能遗漏的进展。建议默认全选，可以逐项勾选。点「更新」只写入已选建议，点「不用」保持原文。普通对话里的「好」不会写入。聊天里直接改正文不依赖这项检索。证据不足时说明原文先不改，不把它说成无需更新。没有网页来源的更新标注写明依据来自模型自身知识。增加的内容插在对应章节，用 `> [!note] KnowFlow 知识更新` 标出。「检查并更新」同样先列出建议，确认后才写入。确认时按锚点重新定位：锚点仍须唯一，所在段落须与预览时一致。正文改动和知识更新标注一起写入；对不上或互相重叠的条目跳过，其余照常写入。报告不展示全文结论，也不列出未完成章节。

时效判断按输入预算分批。补充检索会附上对应正文的锚点。部分判断结果无法解析时，报告提示检查尚未完成，已经核对的建议仍可确认。回复普通问答后，本轮时效预览结束。

在对话中明确要求修改当前文章，例如「把开头那段改短」「在正文补几个示例」或「格式化第二节的代码块」，插件校验后当轮写入并报告结果。只询问概念或解释时直接回答。「这篇内容有点少」之类的讨论先给出补充建议和草稿，点「更新」后才写入。明确要求先看改动时展示预览，用「更新」确认或「不用」放弃。对不上原文、同一段出现多次、几处修改重叠，或插入位置所在段落已经变化时，跳过对应条目。标题编号留给 Obsidian 的自动编号插件。

## 7. 复习和相关文章

Task Overview 在打开 Articles 根目录或分类目录时出现。它展示当天的新文章任务、今日复习、本周趋势和分类统计。每日复习题库是全局的，不随当前分类缩小。

只有已经学习且有有效 Quiz 的文章进入复习。新学文章从第二天开始。优先级是错题、未做题、到期的正确题。正确题冷却 7 天。开始答题后当天试卷锁定。

Relevant Notes 最多五篇，合并语义匹配和标题术语，共同标签只参与排序。Vault Search 是对话里的独立开关，关闭时只使用当前文章和手动附加的笔记。

## 8. 界面和命令

侧边栏按当前文件切换：剪藏页、文章页、任务总览、空状态。文章页可以进入知识点、Quiz 作答和结果。界面用 Obsidian DOM 绘制，没有单独的前端框架。Basic 里可以切换简体中文和 English。笔记字段、模型回复和已经写入的内容不随界面语言改变。

命令只有三条：

- `KnowFlow: Open sidebar`
- `KnowFlow: Process current clipping`
- `KnowFlow: Refresh sidebar`

模型可以分别配置摘要、知识点、整理、Chat、Quiz 和 embedding。运行时支持 OpenAI-compatible、Ollama、LM Studio 和 Disabled。DeepSeek Search 可以使用官方模型密钥，也可以配置独立密钥。

## 9. 尚未开放

- 自动整理新剪藏
- 整理后自动生成摘要
- 自动生成 Quiz

文件或文件夹重命名时，插件迁移已记录的文章、Quiz 和每日复习路径。
