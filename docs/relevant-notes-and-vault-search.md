# Relevant Notes 与 Vault Search 设计

## 目标

KnowFlow 在不依赖 Jev、Miyo 或外部向量数据库的前提下，为当前文章提供两种共享同一索引的能力：

- **Relevant Notes**：从当前文章发现相关文章。
- **Vault Search**：Chat 发送问题前检索相关文章片段，并把有来源标记的片段加入模型上下文。

这两个入口只读取 Vault，不自动把推荐关系写回 Markdown。用户仍然决定是否打开、引用或链接相关文章。

## 用户界面

### Relevant Notes

- Clipping 页面放在「分类与移动」卡片下方。
- Article Detail 页面放在 AI Summary 下方。
- 默认展示前 5 篇，包含标题、路径、匹配片段及关联原因。
- 点击结果直接打开原文；索引未建立时提供「建立索引」入口。

### Vault Search

Chat composer 使用数据库图标作为开关：

- 关闭：Chat 只携带当前文章。
- 开启：使用用户问题检索索引，最多加入 5 个相关片段。
- 索引不可用时不伪装成已启用，而是提示用户先配置 embedding 模型并建立索引。

索引建立、重建和清理属于 Settings → Data，不由 Chat 开关隐式执行。

## 索引与检索

1. 只索引 Settings → Basic 中 `Articles folder` 所配置目录下的 Markdown；默认值是 `Articles/`，不作为固定路径。
2. Settings → Data 的 `Excluded folders` 可排除无需检索的子目录。简单目录名（如 `assets`）匹配任意层级；带路径的规则（如 `Reference/assets`）只匹配对应子树。
3. 去除 KnowFlow 管理的摘要、Quiz、Knowledge Map 等派生内容。
4. 按 Markdown 标题和段落切块；超长块继续按字符边界切分。
5. 通过独立的 Embedding model 配置调用 OpenAI-compatible `/embeddings`。
6. 将 chunk 文本、向量、文件路径、标题、mtime 和模型签名写入插件目录下的独立 `semantic-index.json`。
7. 使用精确余弦相似度检索。个人 Vault 的首版不引入 ANN 或向量数据库；有性能证据后再升级。
8. Relevant Notes 按文章聚合 chunk 命中，取每篇文章最高分，并补充分类、标签、出链和反链原因。
9. Chat 按 chunk 返回结果，明确附带来源路径，避免把检索内容伪装成当前文章原文。

## 生命周期

- 文章目录、排除目录、embedding 模型、Base URL 或 runtime 改变时，旧索引视为不兼容，需要重建。
- 配置的文章目录内文件修改或创建后，已存在的索引会防抖增量更新；其他目录不会触发语义索引任务。
- 文件重命名时删除旧路径并索引新路径。
- 文件或文件夹删除时同步移除对应索引项。
- 索引文件与常规设置、学习状态分开，避免放大 `data.json` 的读写竞争。

## 隐私与失败策略

- 本地 Ollama/LM Studio 可让文本不离开设备。
- Cloud embedding 会把待索引文章分块发送到用户配置的服务，设置页必须明确提示。
- 检索或索引失败不阻断文章整理、Quiz 或普通 Chat；相关卡片展示错误，Vault Search 自动停止本次增强。
- 不自动降级到其他云服务，也不调用聊天模型模拟 embedding。

## 验收标准

- 未配置 embedding 时，原有功能无回归，Relevant Notes 给出明确空状态。
- 建立索引后，Clipping 与 Article Detail 都能展示相关文章并打开原文。
- Vault Search 开启后，Chat system context 包含有来源标记的检索片段；关闭时不包含。
- 修改、重命名和删除文章后不会继续返回已失效路径。
- embedding 模型切换后不会混用不同维度或不同模型生成的向量。

