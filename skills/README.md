# KnowFlow 内置 Skills

每项执行规则保存在 `<名称>/SKILL.md`。构建时随插件打包，由 `SkillRunner` 读取。剪藏整理用 `clipping-update`，并加载两份共用的格式和渲染约束。

`clipping-update/references/` 存放候选判断、笔记属性和写入检查。插件在 `src/services/clipping/` 先恢复能确定的排版，再把带行号的正文交给模型判断标题结构。需要确认的代码候选单独分批发送，每批最多 4 条。[写入前检查](clipping-update/references/output-checks.md) 记录由 TypeScript 执行的检查及保守处理边界。代码行号、标题语义和翻译由对应 Skill 指导模型判断。侧边栏只有一个整理按钮，不展示这些内部步骤。

剪藏工作流参考 DeepSeek Harness 的项目级 `clipping-update` 和 `obsidian-render-integrity`。Obsidian 语法约束参考 [Obsidian 官方 Markdown Skill](https://github.com/obsidianmd/obsidian-skills/tree/b110b2f/plugins/obsidian/skills/obsidian-markdown)。这里把与剪藏有关的规则改写成 KnowFlow 的执行约束，文件读写、候选定位和结构校验由插件负责。

Vault 根目录的 `skills/<名称>/SKILL.md` 会替换同名内置 Skill。`clipping-update` 是例外：内置整理规则、Obsidian 语法和渲染约束始终生效，Vault 中的 `skills/clipping-update/SKILL.md` 追加在后面。没有这份文件时，才依次使用旧的 `skills/clipping-repair/SKILL.md` 或 `skills/clipping-repair.md`。
