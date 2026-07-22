# 06-context-compaction 完成摘要

- **完成时间**: 2026-07-20 22:20
- **归档编号**: 260721-004300
- **涉及包**: `@wuzi/types`、`@wuzi/core`、`app`
- **验证模式**: harness（executor/tester 分离）+ Orchestrator 补 E2E（环境无 subagent 时）

## 批量提交历史

| 序号 | Commit | 任务 | Scope | Tester 判定 |
|------|--------|------|-------|-------------|
| 1 | `90625f9` | 定义 ContextConfig 类型与 DEFAULT_CONTEXT_CONFIG | types / config | ✅ 通过 |
| 2 | `13d10c6` | 实现 TokenCounter（字符近似估算 + calibrate 校正） | core / context | ✅ 通过 |
| 3 | `c26afd3` | 实现 ToolResultOffloader（写盘 + 预览） | core / context | ✅ 通过 |
| 4 | `f887021` | 实现 SingleMessageCompactor（单条/合计阈值 offload） | core / context | ✅ 通过 |
| 5 | `cbbdc40` | 实现 Summarizer（结构化摘要 + 草稿丢弃） | core / context | ✅ 通过 |
| 6 | `e2aeae3` | 实现 HistoryCompactor（分区 + 边界消息） | core / context | ✅ 通过 |
| 7 | `e863887` | 实现 ContextCompactor 编排器（两层 + 熔断） | core / context | ✅ 通过 |
| 8 | `021093c` | 接入主流程（AgentDeps / ReasoningLoop / /compact 命令） | agent / app | ✅ 通过 |
| 9 | `6546536` | 端到端验证（E2E-1 ~ E2E-6） | test | ✅ 通过（6/6 E2E） |

## 实现功能总览

### 新增功能

1. **配置层**：`AgentConfig.context: ContextConfig`（与 `loop` / `security` / `mcp` 平级），含 `compactionEnabled` / `offloadEnabled` / `singleToolResultThreshold(8000)` / `singleMessageTotalThreshold(20000)` / `windowUsageThreshold(0.8)` / `windowHardLimit(160000)` / `keepRecentRounds(4)` / `summaryMaxTokens(2000)` / `summaryFailureThreshold(3)` 九字段
2. **TokenCounter**（`packages/agent/modules/context/token-counter.ts`）：`estimateTokens(text)` 纯函数 + `TokenCounter` 类，按字符类型加权估算（英文 ~4 字符/token、中文 ~1.5 字符/token），`calibrate(realInputTokens, estimatedTokens)` 用指数滑动平均回填校正因子
3. **ToolResultOffloader**（`packages/agent/modules/context/offloader.ts`）：`buildPreviewText(content, headLines, tailLines)` 纯函数 + `ToolResultOffloader.offload(content, sessionId)`，写盘路径 `.wuzi/context-offload/{sessionId}/{ISO时间戳}-{序号}.txt`，返回绝对路径；写盘失败抛 `Error`
4. **SingleMessageCompactor**（`packages/agent/modules/context/single-message-compactor.ts`）：`planOffloads(toolResults, threshold)` 纯函数（按 content 长度大→小依次选中）+ `SingleMessageCompactor.compact(message, offloader, config)`，对 assistant 消息内 tool 结果先按单阈值再按合计阈值 offload，命中后 content 替换为预览+路径，消息打 `compacted: true` 标记幂等
5. **Summarizer**（`packages/agent/modules/context/summarizer.ts`）：`buildSummaryPrompt(messages)` 纯函数产出固定 9 段结构 Prompt（主要请求 / 关键概念 / 文件代码 / 错误修复 / 解决过程 / 用户原话 / 待办 / 当前工作 / 下一步），首尾各一次「禁止调用任何工具」声明；`Summarizer.summarize(messages, signal)` 调 `provider.streamChat`（无 tools、无 system、temperature:0、禁用 thinking），提取 `<summary>...</summary>` 段丢弃 `<draft>`，标签缺失或 provider 报错均抛 `Error`
6. **HistoryCompactor**（`packages/agent/modules/context/history-compactor.ts`）：`partitionMessages(messages, keepRecentRounds)` 纯函数，system 全保留 + user 全保留 + 最近 N 轮 assistant+tool 保留，其余归 toSummarize；`HistoryCompactor.compact` 拼装 `[summary 消息, 边界消息, ...toKeep]`，summary/边界消息均 `role:'system', kind:'system_supplement'`，边界文案「禁止根据摘要脑补 / 请重新读取」；toSummarize 为空时不调 summarizer 直接返回原消息
7. **ContextCompactor**（`packages/agent/modules/context/context-compactor.ts`）：编排器，`runCompaction(memory, opts)` 按序执行两层——第一层遍历 assistant 调 SingleMessageCompactor（offloadEnabled=false 时跳过），第二层 memory 总 token 估算 ≥ `windowUsageThreshold * windowHardLimit` 且未熔断时调 HistoryCompactor；`forceCompact(memory)` 手动触发跳过熔断与阈值、失败不计入；`reset()` 清零计数；所有异常 try/catch 归一化为「跳过本轮压缩」不向 ReasoningLoop 抛
8. **主流程接入**：`AgentDeps.contextCompactor?` + `sessionId?` 可选注入；`ReasoningLoop.streamOneRound` 在 `provider.streamChat` 前调 `runCompaction`；`ReasoningLoop.run` 开始时调 `reset()`；`AgentSession.submit` switch 加 `case '/compact'` 分支调 `forceCompact`；`CommandEvent.name` 联合类型含 `'/compact'`；`app/index.ts` 按 `config.context` 构造 ContextCompactor 注入

### 修改内容

1. **`packages/agent-types/index.ts`**：新增 `ContextConfig` 接口
2. **`packages/agent/utils/config/config-types.ts`**：`AgentConfig` 新增 `context?: ContextConfig` 字段 + 导出 `DEFAULT_CONTEXT_CONFIG`
3. **`packages/agent/ui-pattern.ts`**：`ChatMessage` 加 `compacted?: boolean`；`CommandEvent.name` 联合类型加 `'/compact'`
4. **`packages/agent/agent.ts`**：`AgentDeps` 加 `contextCompactor?` / `sessionId?`
5. **`packages/agent/reasoning-loop.ts`**：`ReasoningLoopDeps` 加 `contextCompactor?`；`streamOneRound` 前置 `runCompaction`；`run` 开始时 `reset()`
6. **`packages/agent/agent-session.ts`**：`submit` switch 加 `/compact` 分支
7. **`app/index.ts`**：按 `config.context` 构造 `ContextCompactor` 并通过 `AgentDeps.contextCompactor` 注入
8. **`.gitignore`**：新增 `.wuzi/context-offload/` 条目

## 端到端验证结论

- checklist 共 47 条验收项（C1.1~C11.14 + E2E-1~E2E-6），全部通过。
- `bun --check`：所有新增 / 修改的 `.ts` 实现文件均通过。
- `bun test packages/agent/`：381 通过 / 1 预存失败（`caching-e2e.test.ts > E2E-4 should not inject mode_reminder in agent mode`，stash 验证确认与本次改动无关，属 prompt-composer / reasoning-loop 模块的预存问题）
- 新增测试覆盖：token-counter + offloader + single-message-compactor + summarizer + history-compactor + context-compactor + context-compaction-e2e（E2E-1~E2E-6）= **共 60+ 个测试用例，全部通过**

### E2E 用例覆盖

- **E2E-1** 单条 tool 结果 > 8000 字符 → offload 写盘 + 预览替换
- **E2E-2** 单 assistant 含 3 个 tool 结果（5000/6000/10000，合计 21000 > 20000）→ 大→小 offload 至合计 ≤ 阈值
- **E2E-3** 总长 > 128000 字符 → summary + 边界 + 保留消息拼装，summary kind=system_supplement
- **E2E-4** summarizer 连续失败 3 次 → `tripped: true`，第 4 次自动不触发；`forceCompact` 仍触发
- **E2E-5** `/compact` 命令 → `forceCompact` 调用，memory 长度下降
- **E2E-6** 摘要 LLM 调用入参 `tools` 字段为 `undefined`（不挂工具定义）

## 遗留问题

- `caching-e2e.test.ts > E2E-4 should not inject mode_reminder in agent mode` 预存失败，建议另起任务排查 `prompt-composer.ts` / `reasoning-loop.ts` 的 agent 模式 mode_reminder 注入逻辑（与 context compaction 改动无关，本次未触碰）
- 熔断状态仅会话内有效，新 run 不继承（按 Out of Scope 设计，避免一次失败永久禁用）
- 不实现跨会话持久化压缩状态、向量检索 / RAG 式召回、对话历史磁盘持久化、多模型路由（按 Out of Scope 设计）

## 归档位置

`docs/done-plan/260721-004300-06-context-compaction/`
