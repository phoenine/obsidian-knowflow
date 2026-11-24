# KnowFlow 内置 Skills

每项执行规则保存在 `<名称>/SKILL.md`。构建时随插件打包，由 `SkillRunner` 读取。剪藏整理用 `clipping-update`，并加载两份共用的格式和渲染约束。

`clipping-update/references/` 存放候选判断、笔记属性和写入检查。插件先用脚本处理能确定的结构，再把拿不准的标题和代码分批交给模型。[写入前检查](clipping-update/references/output-checks.md) 记录由 TypeScript 执行的检查及保守处理边界。

`clipping-update/scripts/` 存放随插件构建的确定性辅助脚本，包括固定提示词围栏和失效远程图片恢复。代码行号、标题语义和翻译由对应 Skill 指导模型判断。卡片显示文章样式梳理、格式化代码块、整理图片、英文翻译和补全 Frontmatter。

剪藏工作流参考 DeepSeek Harness 的项目级 `clipping-update` 和 `obsidian-render-integrity`。Obsidian 语法约束参考 [Obsidian 官方 Markdown Skill](https://github.com/obsidianmd/obsidian-skills/tree/b110b2f/plugins/obsidian/skills/obsidian-markdown)。这里把与剪藏有关的规则改写成 KnowFlow 的执行约束，文件读写、候选定位和结构校验由插件负责。

Vault 中已有的 `skills/clipping-update/SKILL.md`，以及旧的 `skills/clipping-repair/SKILL.md` 或 `skills/clipping-repair.md`，可以继续补充剪藏规则。插件优先读取新路径，其次依次使用旧路径。内置语法和渲染约束始终生效。
