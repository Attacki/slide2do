# notes for `packages/agent/`

> 最后更新: 2026-07-21 — memory 系统接入主流程：AgentDeps 新增 instructionLoader/sessionManager 字段、Agent 异步 initialize() 注入 system_supplement + startSession、ReasoningLoopDeps 新增 onMessagePersisted 回调实现消息 fire-and-forget 持久化；桶文件导出 InstructionLoader / SessionStore / SessionRecovery / SessionCleaner / SessionManager 五件套

核心引擎：模型服务商无关的对话主循环、流式 IO 事件模型、记忆管理、三层配置、Provider 适配层、prompt 编排层。下文仅收录根文件与叶级子目录（`prompt/`、`provider/`）；`modules/`、`utils/` 为非叶级，各有独立笔记；`tests/` 由 Tester 维护，不在此记录（memory-system 任务 8 新增测试覆盖见末尾「测试覆盖」小节，仅本特性追溯使用）。

## 文件索引

### `reasoning-loop.ts`
- **用途**: ReAct 范式多轮循环编排器——「调 LLM → 有工具调用就执行 → 结果回填 → 下一轮；无工具调用即结束」，是核心循环本体
- **关键导出**: `ReasoningLoop` 类, `ReasoningLoopDeps` / `RunOptions` / `GroupedToolCalls` 接口, `groupToolCalls()` 纯函数
- **关键方法**: `run(userText, onEvent, options)` 驱动一次完整循环并返回终止原因；`getMode()`/`setMode(mode)` 管控运行模式（agent/ask/plan，仅实际变化时置 modeChanged）；`groupToolCalls()` 按 `mutates` 分读/写组；`buildMessages()` 委托 PromptComposer 拼装（装配时）或透传 memory 消息（未装配时兼容）；`buildModeReminder()` 按节奏产出 `kind:mode_reminder` 消息（首轮/模式切换完整、其余精简、agent 返回 null）；`streamOneRound()` 在 `buildMessages()` 之前调 `contextCompactor.runCompaction(memory)`（若注入）做原地压缩
- **依赖**: `ui-pattern.ts`, `provider/base.ts`, `utils/config/config-types.ts`, `modules/memory/memory-manger.ts`, `modules/tools/tool-executor.ts`, `modules/tools/tool-registry.ts`, `modules/tools/tool-call-accumulator.ts`, `prompt/prompt-composer.ts`, `modules/context/context-manger.ts`, `modules/context/context-compactor.ts`, `@wuzi/types`
- **消费者**: `agent.ts`, `index.ts`
- **注意**: 读类工具并发执行但按原始顺序回灌结果（事件确定性）；写类串行；ask/plan 只读模式拦截写类不执行仅回灌结构化结果（沿用 `plan_blocked` 事件，文案随模式生成）；模式提醒由 `buildModeReminder()` 产出 `kind:mode_reminder` 消息，节奏：首轮（roundInRun===1）或模式切换后（modeChanged）注入完整指令、其余轮次精简指令、agent 返回 null；`modeChanged` 在 setMode 实际切换时置 true、buildMessages 注入后置 false；`roundInRun` 每次 run 开始重置 0、每轮 +1；`buildMessages()` 装配 composer 时委托 `compose()` 输出「稳定 system → env_info → 历史（过滤旧稳定 system）→ mode_reminder」序列，未装配时直接透传 memory；env_info 由 ContextManager 在 run 开始时现取（会话内稳定、不入 memory）；双通道取消 = 外部 AbortSignal + 内置 timeoutMs；保证每个 assistant.tool_call 都有对应 tool 结果（取消/拦截也补结果），维持记忆不变量；usage 透传：`RoundResult.usage` 含 cacheReadInputTokens/cacheCreationInputTokens，run() 跨轮累积 input/output，cache 字段取首次非空值代表本次 run（同 run 内稳定 system+tools 不变、命中状态一致），最终 done 事件 usage 仅在 input/output 非零时构造，cache 字段按需展开；`contextCompactor` 注入后 `run` 方法开始时调 `reset()` 重置熔断状态（新 run 不继承上次失败计数），`streamOneRound` 在 buildMessages 之前 await `runCompaction(memory)`（异常已由 ContextCompactor 内部归一化为跳过本轮压缩，不向调用方抛出）

### `agent.ts`
- **用途**: 核心对话逻辑（领域模型），装配 provider/记忆/工具执行器/PromptComposer/ContextManager/ContextCompactor，将用户输入委托给 ReasoningLoop 驱动多轮循环
- **关键导出**: `Agent` 类, `AgentDeps` / `ProcessOptions` 接口
- **关键方法**: `processInput(input, onEvent, options)` 委托 ReactLoop 并透传取消信号；`getMemory()`；`clearContext()`；`getMode()`/`setMode(mode)`（命令 `/agent` `/ask` `/plan` 切换模式）；`getSessionId()` 返回会话标识；`compactContext()` 异步手动触发上下文压缩（`/compact` 入口，委托 `contextCompactor.forceCompact(memory)`，返回 `{ ok, message }` 由 AgentSession 推送提示）
- **依赖**: `ui-pattern.ts`, `modules/memory/memory-manger.ts`, `provider/base.ts`, `utils/config/config-types.ts`, `modules/tools/tool-executor.ts`, `reasoning-loop.ts`, `prompt/prompt-composer.ts`, `modules/context/context-manger.ts`, `modules/context/context-compactor.ts`, `@wuzi/types`
- **消费者**: `agent-session.ts`, `index.ts`, `app/`
- **注意**: `AgentDeps` 含可选 `composer?: PromptComposer` / `contextManager?: ContextManager` / `contextCompactor?: ContextCompactor` / `sessionId?: string`，装配后透传给 ReasoningLoop 启用结构化 prompt 编排、env_info 注入、自动上下文压缩；缺省时 ReasoningLoop 直接透传 memory 消息（兼容未改造场景）；`sessionId` 缺省由 Agent 内部用 `process.pid-${Date.now()}` 生成，用于 offloader 落盘目录隔离与压缩流程透传；`systemPrompt` 仍由 memory.setSystem() 写入首位（PromptComposer 会过滤旧稳定 system 避免重复）；`handleCommand` 保持同步，`/compact` 由 AgentSession 直接调 `agent.compactContext()` 异步处理（避免影响其他命令的同步语义）

### `agent-session.ts`
- **用途**: 会话协调器：对话循环生命周期管理 + slash 命令分发；持有每次请求的 AbortController 支持取消
- **关键导出**: `AgentSession` 类, `LoopCallbacks` 接口
- **关键方法**: `submit(input)` 分发 `/exit` `/clear` `/help` `/agent` `/ask` `/plan` `/compact` 并透传取消信号；`start()`/`stop()`（stop 会 abort 进行中请求）；`cancel()` 主动打断；`isRunning()`；静态 `helpText()`
- **依赖**: `agent.ts`, `ui-pattern.ts`, `utils/config/config-types.ts`
- **消费者**: 上层 `app/`
- **注意**: `/agent` `/ask` `/plan` 运行时**设定**运行模式（非 toggle），通过可选回调 `onModeChanged(mode)` 反馈状态；`/compact` 调 `agent.compactContext()` 后通过 `onStreamEvent` 推送 `loop_terminated`（reason='no_tool_call', rounds=0）+ `text_delta`（提示消息）+ `done`，保持事件流一致性供 UI 统一渲染

### `ui-pattern.ts`
- **用途**: 核心层与展示层之间的稳定 IO 契约，使 UI 可替换而不动核心逻辑
- **关键导出**: `MessageRole`, `MessageKind`, `ChatMessage`, `StreamEvent` 联合类型及各变体, `TerminationReason`, `UserInputEvent`（`SubmitInputEvent`/`CommandEvent`）
- **依赖**: 无项目内依赖（纯类型定义）
- **消费者**: `agent.ts`, `reasoning-loop.ts`, `agent-session.ts`, `provider/`, `agent-ui`/`agent-tui` 包
- **注意**: `StreamEvent` 现含 `user_message`/`tool_call_start`/`plan_blocked`/`final_answer`/`loop_terminated`；`CommandEvent.name` 含 `/agent` `/ask` `/plan`（模式切换）与 `/compact`（手动上下文压缩）；新增变体时需同步更新 provider 适配层与 UI 渲染层（TUI 用统一事件循环，未识别事件静默跳过）；`ChatMessage.kind`（可选，缺省视为 `user`）用于 prompt 编排层区分用户输入与系统注入的补充消息（env_info/mode_reminder/system_supplement），provider 按 kind 归入 system 段；`ChatMessage.compacted`（可选）标记该消息已被 offload 处理（由 SingleMessageCompactor 置 true，ContextCompactor 跳过避免重复处理）；`StreamDoneEvent.usage` 含 `cacheReadInputTokens`/`cacheCreationInputTokens`（Anthropic prompt caching 命中字段，OpenAI 侧缺省）

### `index.ts`
- **用途**: `@wuzi/core` 统一导出桶，对外暴露全部公共 API
- **关键导出**: IO 类型全集；Provider 工厂与实现；配置（含 `AgentMode`/`LoopConfig`/`DEFAULT_LOOP_CONFIG`/`DEFAULT_CONTEXT_CONFIG`/`ContextConfig`）；`ConversationMemory`；角色；`Agent`/`AgentSession`/`ReasoningLoop`/`groupToolCalls`；工具系统类型；上下文压缩六件套（`TokenCounter`/`ToolResultOffloader`/`SingleMessageCompactor`/`Summarizer`/`HistoryCompactor`/`ContextCompactor`）及相关纯函数与类型
- **依赖**: 几乎全部 agent 子模块 + `../agent-roles/roles-registry.ts`
- **消费者**: 所有通过 `@wuzi/core` 导入的消费方

## 子目录（各有独立笔记）
- `modules/` → `modules/note.md`
- `utils/`   → `utils/note.md`

## 叶级子目录（内容直接记于此）

### 子目录 prompt/
- `prompt-composer.ts` — 结构化 prompt 拼装器 `PromptComposer`：构造时持有角色稳定 system 段，`compose(messages, opts)` 按「稳定 system（可缓存）→ env_info（动态）→ 对话历史（过滤旧稳定 system）→ mode_reminder（按节奏）」顺序输出完整消息序列；`ComposeOptions` 含 envInfo/modeReminder 与节奏元数据（round/modeChanged/firstRound，节奏决策由 ReasoningLoop 完成）

### 子目录 provider/
- `base.ts` — Provider 统一接口：`ILLMProvider`、`StreamChatParams`、`StreamCallback`、`ProviderStreamEvent`（`done` 事件的 usage 含 `cacheReadInputTokens`/`cacheCreationInputTokens` 字段，供 prompt caching 命中观测）
- `client.ts` — Provider 工厂：`createProvider()` 按 protocol 选实现；`registerProvider()` 注册自定义后端
- `openai.ts` — OpenAI 兼容 SSE 流式实现（向 `/v1/chat/completions` 发起 `stream:true`）：按 `kind` 分流 system 消息——稳定段（无 kind）与动态段（env_info/mode_reminder/system_supplement）合并为单条 system 消息前置（稳定在前、动态在后，便于 OpenAI 侧前缀自动缓存命中），无 system 时不注入；user/assistant/tool 映射保持不变；`toOpenAIMessages()` 纯函数负责归并
- `anthropic.ts` — Anthropic SSE 流式实现（含 extended thinking + prompt caching）：system 字段以数组形式传递，按 `kind` 分流——稳定段（无 kind，角色 prompt）合并挂 `cache_control:{type:'ephemeral'}`（断点 1），动态段（`kind` 为 env_info/mode_reminder/system_supplement）合并不挂；tools 数组末尾工具挂 `cache_control`（断点 2，工具集稳定时缓存命中）；`AnthropicTool` 接口含可选 `cache_control`；无 system 消息时不挂 body.system（兼容）；SSE 解析 `message_start.message.usage`（input_tokens + cache_read/cache_creation）与 `message_delta.usage`（output_tokens 覆盖最新值），`buildUsage()` 构造 done 事件 usage（含 cache 字段），无 usage 时返回 undefined 兼容
- `openai-compatible.ts` — （空 / 待实现）