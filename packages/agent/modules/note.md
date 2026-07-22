# notes for `packages/agent/modules/`

> 最后更新: 2026-07-21 — memory/ 下新增 instructions/ 子目录（InstructionLoader）+ session/ 补齐四件套（SessionStore / SessionRecovery / SessionCleaner / SessionManager），memory 系统接入主流程

智能体功能模块集合。本目录为非叶级：`memory/` 下还有 `instructions/` 与 `session/` 两个子目录，故 `memory/` 单独成篇；其余 10 个子目录均为叶级，内容直接记于此。

## 子目录（各有独立笔记）
- `memory/` → `memory/note.md`（其下 `instructions/` 与 `session/` 由 memory/note.md 索引）

## 叶级子目录（内容直接记于此）

### 子目录 context/
- `context-manger.ts` — 运行时环境信息收集器 `ContextManager`：收集 cwd/platform/arch 基础字段，`toMessage()` 产出 `kind:'env_info'` 的系统级补充消息；`registerField(name, provider)` 预留自定义扩展点（如 Git 状态/技术栈），provider 支持同步/异步，单个失败不阻塞其余字段，按注册顺序串行采集
- `token-counter.ts` — 字符近似 token 估算 `TokenCounter`：ASCII 字符按 4 字符/token、非 ASCII 按 1.5 字符/token 加权累加；`calibrate(realInputTokens, estimatedTokens)` 用指数滑动平均（α=0.5）回填校正因子，使后续估算逐步趋近真实值；纯函数 `estimateTokens` 可独立使用
- `offloader.ts` — 超长 tool 结果磁盘卸载 `ToolResultOffloader`：`offload(content, sessionId)` 按 `{baseDir}/{sessionId}/{ISO时间戳}-{序号}.txt` 写盘并返回绝对路径；`buildPreviewText(content, headLines, tailLines, path?)` 纯函数产出首尾预览+省略提示；写盘失败抛错由上层归一化
- `single-message-compactor.ts` — 单条 assistant 消息压缩器 `SingleMessageCompactor`：协调单条阈值（content.length > singleToolResultThreshold）+ 合计阈值（planOffloads 按大→小 offload 到合计 ≤ 阈值），对超长 tool 结果调 offloader 写盘 + 用 buildPreviewText 替换 content、置 `compacted:true`；幂等（已 compacted 直接返回）；单条失败不阻塞其他条目
- `summarizer.ts` — 整体历史摘要器 `Summarizer`：复用 `ILLMProvider` 与当前 `LLMConfig`，内部强制 `thinking:false`、不挂 `tools`（确保只输出文本）；`buildSummaryPrompt` 纯函数构造「禁止调用工具」双声明 + 9 段固定结构标题 + 草稿/正文格式；流式累积后用非贪婪正则提取 `<summary>...</summary>` 段；signal abort / 流错误 / 缺闭合标签均抛错由上层归一化
- `history-compactor.ts` — 历史压缩编排器 `HistoryCompactor`：`partitionMessages` 纯函数按轮次（一条 assistant + 其后连续 tool）从后往前数 keepRecentRounds 轮入 toKeep，system/user 始终入 toKeep，其余入 toSummarize；`compact` 调 summarizer 产出摘要后用 `[summary 消息, 边界消息, ...toKeep]` 替换原对话；toSummarize 为空时直接原样返回（幂等）；边界消息含「禁止根据摘要脑补」语义
- `context-compactor.ts` — 上下文压缩编排器 `ContextCompactor`：串联两层压缩与熔断机制，对 `ConversationMemory` 执行原地压缩；第一层（预防，不调 LLM）调 `SingleMessageCompactor` 对超长 tool 结果 offload；第二层（兜底，调 LLM）当总 token ≥ `windowUsageThreshold * windowHardLimit` 时调 `HistoryCompactor` 摘要替换；`runCompaction` 按序执行两层、异常归一化为跳过本轮、连续失败达 `summaryFailureThreshold` 触发熔断；`forceCompact` 跳过熔断与阈值手动触发；`reset` 重置熔断状态供新 run 调用

### 子目录 tools/
- `tool-registry.ts` — 工具注册中心 `ToolRegistry`：register/get/has/list；`toDefinitions()` 输出中立格式并透传 `mutates`（读/写分类，供 ReactLoop 分组）
- `tool-executor.ts` — 工具执行器 `ToolExecutor`：单次调用超时约束、异常/未知工具归一化为结构化 `ToolResult`（永不抛出）
- `tool-call-accumulator.ts` — 流式工具调用碎片累加器 `ToolCallAccumulator` + `parseToolArguments()`（拼接并解析 JSON 参数）

### 子目录 mcp/
- `mcp-registry.ts` — （空 / 待实现）

### 子目录 graph-agents/
- `agent-teams.ts` — （空 / 待实现）

### 子目录 hooks/
- `agent-hooks.ts` — （空 / 待实现）

### 子目录 security/
- `authentic.ts` — （空 / 待实现）

### 子目录 skills/
- `skill-registry.ts` — （空 / 待实现）

### 子目录 slash-command/
- `index.ts` — （空 / 待实现）

### 子目录 sub-agents/
- `index.ts` — （空 / 待实现）
- `work-tree.ts` — （空 / 待实现）
