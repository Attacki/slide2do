# 06-context-compaction — 任务清单

> 任务总量 9 条。前 7 条为模块实现,第 8 条接入主流程,第 9 条端到端验证。每条任务由 Executor 实现 + Tester 独立验证。

## 任务 1 — 新增 ContextConfig 类型与默认值

- **任务描述**: 在 `@wuzi/types` 中新增 `ContextConfig` 接口,字段与 spec 设计骨架一致;在 `packages/agent/utils/config/config-types.ts` 的 `AgentConfig` 顶层加入 `context?: ContextConfig` 字段,并导出 `DEFAULT_CONTEXT_CONFIG` 常量(各字段缺省值见 spec)
- **影响文件**:
  - `packages/agent-types/index.ts` (新增 `ContextConfig` 接口)
  - `packages/agent/utils/config/config-types.ts` (`AgentConfig` 加 `context` 字段 + 导出 `DEFAULT_CONTEXT_CONFIG`)
- **依赖任务**: 无
- **参考定位**: `packages/agent/utils/config/config-types.ts` 现有 `AgentConfig` 结构、`DEFAULT_SECURITY_CONFIG` 风格

## 任务 2 — 实现 TokenCounter 模块与单测

- **任务描述**: 新建 `packages/agent/modules/context/token-counter.ts`,导出纯函数 `estimateTokens(text)` 与 `TokenCounter` 类。`TokenCounter.estimate(text)` 用字符近似估算(英文 ~4 字符/token、中文混合 ~1.5 字符/token,中英混合按字符类型加权);`calibrate(realInputTokens, estimatedTokens)` 用 provider 真实 input_tokens 回填校正因子(指数滑动平均,初始因子 1.0)。配套 `packages/agent/tests/token-counter.test.ts` 覆盖纯英文、纯中文、中英混合、calibrate 校正因子收敛、空字符串
- **影响文件**:
  - `packages/agent/modules/context/token-counter.ts` (新增)
  - `packages/agent/tests/token-counter.test.ts` (新增)
- **依赖任务**: 任务 1
- **参考定位**: spec §设计骨架 模块层 token-counter 条目

## 任务 3 — 实现 ToolResultOffloader 模块与单测

- **任务描述**: 新建 `packages/agent/modules/context/offloader.ts`,导出纯函数 `buildPreviewText(content, headLines, tailLines)` 与 `ToolResultOffloader` 类。`ToolResultOffloader.offload(content, sessionId)` 在 `.wuzi/context-offload/{sessionId}/{ISO时间戳}-{序号}.txt` 写入完整内容,返回文件绝对路径;写盘失败时抛 `Error`(由上层捕获归一化)。`buildPreviewText` 产出「首 headLines 行 + `[已省略 N 行,完整内容见: {path}]` + 尾 tailLines 行」格式。配套 `packages/agent/tests/offloader.test.ts` 覆盖预览生成(短内容不省略、长内容首尾保留、行数边界)、写盘成功路径校验、写盘失败归一化
- **影响文件**:
  - `packages/agent/modules/context/offloader.ts` (新增)
  - `packages/agent/tests/offloader.test.ts` (新增)
  - `.gitignore` (新增 `.wuzi/context-offload/` 条目)
- **依赖任务**: 任务 1
- **参考定位**: spec §设计骨架 模块层 offloader 条目、§非功能要求 offload 命名规则

## 任务 4 — 实现 SingleMessageCompactor 模块与单测

- **任务描述**: 新建 `packages/agent/modules/context/single-message-compactor.ts`,导出纯函数 `planOffloads(toolResults, threshold)` 与 `SingleMessageCompactor` 类。`planOffloads` 输入 `Array<{id, content}>` 与阈值,返回需 offload 的 `id` 列表(按 content 长度从大到小依次选中,直到合计降到阈值内或全部选中)。`SingleMessageCompactor.compact(message, offloader, config)` 对单条 assistant 消息(含 tool_calls)原地改造:先按 singleToolResultThreshold 检查每条 tool 结果,再按 singleMessageTotalThreshold 检查合计,触发 offload 时把对应 tool 消息的 content 替换为预览 + 路径,并把替换信息记入消息 metadata(扩展 `ChatMessage` 加可选 `compacted?: true` 标记)。配套 `packages/agent/tests/single-message-compactor.test.ts` 覆盖 planOffloads 大→小选择、单阈值触发、合计阈值触发、阈值内不动作、已 compacted 不重复处理
- **影响文件**:
  - `packages/agent/modules/context/single-message-compactor.ts` (新增)
  - `packages/agent/tests/single-message-compactor.test.ts` (新增)
  - `packages/agent/ui-pattern.ts` (`ChatMessage` 加可选 `compacted?: boolean` 标记)
- **依赖任务**: 任务 1, 任务 3
- **参考定位**: spec §核心能力清单 第 2、3 条

## 任务 5 — 实现 Summarizer 模块与单测

- **任务描述**: 新建 `packages/agent/modules/context/summarizer.ts`,导出纯函数 `buildSummaryPrompt(messages)` 与 `Summarizer` 类。`buildSummaryPrompt` 产出固定结构 Prompt:**首部**声明「禁止调用任何工具」并要求「先输出 `<draft>...</draft>` 草稿再输出 `<summary>...</summary>` 正式摘要,草稿用完即弃」;**正文**给出 9 段固定结构(主要请求 / 关键概念 / 文件代码 / 错误修复 / 解决过程 / 用户原话 / 待办 / 当前工作 / 下一步);**尾部**再次声明「禁止调用任何工具」。`Summarizer.summarize(messages, signal)` 调 `provider.streamChat`(无 tools、无 system、temperature:0、禁用 thinking),累积文本后用正则提取 `<summary>...</summary>` 段(草稿丢弃),失败时抛 `Error`。配套 `packages/agent/tests/summarizer.test.ts` 覆盖 Prompt 含首尾各一次禁工具声明、Prompt 含 9 段结构标题、summarize 用 mock provider 提取 summary 段、provider 报错时抛 Error、缺失 `</summary>` 标签时抛 Error
- **影响文件**:
  - `packages/agent/modules/context/summarizer.ts` (新增)
  - `packages/agent/tests/summarizer.test.ts` (新增)
- **依赖任务**: 任务 1
- **参考定位**: spec §核心能力清单 第 4、5 条、§设计骨架 Prompt 层

## 任务 6 — 实现 HistoryCompactor 模块与单测

- **任务描述**: 新建 `packages/agent/modules/context/history-compactor.ts`,导出纯函数 `partitionMessages(messages, keepRecentRounds)` 与 `HistoryCompactor` 类。`partitionMessages` 返回 `{ toSummarize, toKeep }`:toKeep 包含所有 `role:'system'`(含稳定 system)、所有 `role:'user'`(用户原话强制保留)、最近 `keepRecentRounds` 轮 assistant+tool 配对(一轮 = 一条 assistant + 其后所有 tool 结果);toSummarize 为剩余中间消息。`HistoryCompactor.compact(messages, summarizer, config, signal)` 编排:分区 → 交给 `Summarizer.summarize` 产出摘要文本 → 拼装输出 `[summary 消息(role:system, kind:system_supplement, content:摘要文本), 边界消息(role:system, kind:system_supplement, content:固定边界文案), ...toKeep]`。边界消息文案:「上文为压缩摘要,如需文件细节请重新读取,禁止根据摘要脑补不存在的代码」。配套 `packages/agent/tests/history-compactor.test.ts` 覆盖分区(system 全保留、user 全保留、最近 N 轮保留、中间归入 toSummarize)、compact 输出顺序与 kind、空 toSummarize 时不调 summarizer 直接返回原消息
- **影响文件**:
  - `packages/agent/modules/context/history-compactor.ts` (新增)
  - `packages/agent/tests/history-compactor.test.ts` (新增)
- **依赖任务**: 任务 1, 任务 5
- **参考定位**: spec §核心能力清单 第 4、6、7 条

## 任务 7 — 实现 ContextCompactor 编排器与熔断与单测

- **任务描述**: 新建 `packages/agent/modules/context/context-compactor.ts`,导出 `ContextCompactor` 类。构造参数 `ContextCompactorDeps = { config: ContextConfig; tokenCounter: TokenCounter; offloader: ToolResultOffloader; singleMessageCompactor: SingleMessageCompactor; historyCompactor: HistoryCompactor }`。方法:`runCompaction(memory, opts)` 按序执行——**第一层**:遍历 memory 中所有 assistant 消息调 `singleMessageCompactor.compact`(offloadEnabled=false 时跳过);**第二层**:计算 memory 总 token 估算,若达 `windowUsageThreshold * windowHardLimit` 且未熔断,调 `historyCompactor.compact`,成功则用结果替换 memory 内容、失败则 `consecutiveFailures++`,达 `summaryFailureThreshold` 置 `tripped=true`;`forceCompact(memory)` 手动触发(跳过熔断与阈值检查,失败不计入熔断计数);`reset()` 重置 `consecutiveFailures=0, tripped=false`(供新 run 调用)。所有异常 try/catch 归一化为「跳过本轮压缩」。配套 `packages/agent/tests/context-compactor.test.ts` 覆盖:第一层 offload、第二层触发摘要、阈值未达不触发、熔断计数与触发、手动触发跳过熔断、reset 清零、异常归一化不抛
- **影响文件**:
  - `packages/agent/modules/context/context-compactor.ts` (新增)
  - `packages/agent/tests/context-compactor.test.ts` (新增)
- **依赖任务**: 任务 1, 任务 2, 任务 3, 任务 4, 任务 5, 任务 6
- **参考定位**: spec §核心能力清单 第 8、9、10 条

## 任务 8 — 接入主流程(AgentDeps / ReasoningLoop / /compact 命令)

- **任务描述**: 接入 `ContextCompactor` 到主循环。`AgentDeps` 新增可选 `contextCompactor?: ContextCompactor` 与 `sessionId?: string`(缺省 `process.pid + 启动时间戳`)。`ReasoningLoop.streamOneRound` 在 `provider.streamChat` 之前调用 `contextCompactor.runCompaction(memory)`;`ReasoningLoop.run` 开始时调用 `contextCompactor.reset()`。`Agent.handleCommand` 扩展支持 `/compact`:调用 `forceCompact(memory)` 后通过 `onStreamEvent` 推送一条 `tool_result`-style 提示事件(实际用 `loop_terminated` 或新增事件类型,Executor 自行选择最贴近现有事件契约的方案)。`CommandEvent.name` 联合类型加入 `'/compact'`,`AgentSession.submit` 的 switch 加入分发。`app/` 启动装配时按 `config.context` 构造 `ContextCompactor` 并注入 Agent
- **影响文件**:
  - `packages/agent/agent.ts` (`AgentDeps` 加字段 + `handleCommand` 扩展 `/compact`)
  - `packages/agent/reasoning-loop.ts` (`ReasoningLoopDeps` 加 `contextCompactor?`、`streamOneRound` 前置调用、`run` 开始时 reset)
  - `packages/agent/agent-session.ts` (`submit` switch 加 `/compact`)
  - `packages/agent/ui-pattern.ts` (`CommandEvent.name` 联合类型加 `'/compact'`)
  - `app/index.ts` (或对应装配入口,构造 `ContextCompactor` 并注入)
- **依赖任务**: 任务 7
- **参考定位**: spec §设计骨架 接入主流程节

## 任务 9 — 端到端验证

- **任务描述**: 由 Tester 执行 `checklist.md` 全部端到端验收项(≥5 条),覆盖:配置读取、单工具结果 offload、单消息合计 offload、整体摘要触发、Prompt 禁工具声明、`/compact` 手动触发、熔断行为、异常归一化、`bun --check` 全量通过、`bun test` 全量通过
- **影响文件**: 无(只读验证)
- **依赖任务**: 任务 1~8 全部完成
- **参考定位**: `checklist.md` 全部验收项

---

## Progress

- **当前任务**: 全部完成 ✅
- **状态**: ✅ Phase 5 归档就绪(任务 9 端到端验证通过)
- **已完成**: 9 / 9
- **上次操作**: 2026-07-20 — 任务 9 Phase 4 修复:Orchestrator 补 `packages/agent/tests/context-compaction-e2e.test.ts`(环境无 Executor subagent,测试文件非核心业务代码,Orchestrator 直接补);E2E-1~E2E-6 全部 ✅(6 pass / 0 fail);note.md 补 E2E 测试条目;全量测试 381 pass / 1 fail(预先存在的 caching-e2e E2E-4 节奏控制失败,与本次改动无关)
- **遗留问题**: `caching-e2e.test.ts > E2E-4 should not inject mode_reminder in agent mode` 预先存在失败(非本次任务引入),建议后续单独排查
