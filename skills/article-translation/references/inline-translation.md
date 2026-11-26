# 译文插入格式

## 模型输出

按候选 ID 返回 `translations`，每个候选对应一条单行译文。`translation` 只写译文，保留句内标点、链接和行内代码。译文省略外层括号、列表符号、序号、任务框、注释和「翻译」标签。

```json
{
  "translations": [
    { "id": "translation-1", "translation": "让故障显式可见。" },
    { "id": "translation-2", "action": "skip" }
  ]
}
```

整段是中文、或已经带着中文译文的候选返回 `{ "id": "...", "action": "skip" }`，不写译文。每个候选 ID 只返回一次。

## 笔记中的结果

插件保留英文原文。普通段落在最后一行的行末追加 `（译文）`，多行段落只追加一次。列表和任务项在原行末尾追加，原有缩进、列表序号和任务状态由原行继承。插件最后追加 `<!-- knowflow-translation -->`，用来识别已翻译的段落。

```markdown
Make failures explicit.（让故障显式可见。） <!-- knowflow-translation -->

1. Keep recovery safe to repeat.（确保恢复操作可以安全地重复执行。） <!-- knowflow-translation -->
```
