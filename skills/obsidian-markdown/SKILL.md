---
name: obsidian-markdown
description: 为剪藏整理提供 Obsidian Markdown 结构及语法约束。
---

# Obsidian Markdown

- 按 [阅读结构](references/reading-structure.md) 为原文选择标题、段落、列表、对比表或分组列表，让读者可以定位、连续阅读、比较和复制。保留现有有效的结构与内容关系。
- 文件顶部使用一段 YAML Frontmatter，属性与正文分开。保留作者、来源链接和用户已有属性。日期使用实际日期或空值，列表属性使用 YAML 列表。
- 标题层级沿文章结构递进。段落、标题、图注和围栏保留明确边界。保护 Obsidian 的 `[[链接]]`、`![[嵌入]]`、Callout、注释、数学块及 Mermaid。
- 代码和提示词使用配对围栏。语言明确时标注语言，可复制的自然语言使用 `text`，保留原有文本和段落边界。
