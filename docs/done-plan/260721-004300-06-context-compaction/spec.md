# 06-context-compaction

## 背景

Agent 主循环（`ReasoningLoop`）每轮调用 LLM 都把 `ConversationMemory` 的全部消息序列透传给 provider，没有任何对上下文长度的治理：

- **工具结果是 token 消耗大头**：单次 `read_file` / `search_content` 可能返回数万字符，累积几轮就吃满窗口；这些结果在后续轮次里几乎不需要被逐字引用，但占用一直存在。
- **用户原始消息被淹没**：当前记忆层无差别堆积，模型在长对话中容易丢失用户的真实意图与原话。
- **无兜底机制**：窗口逼近上限时既没有自动压缩，也没有手动触发入口，最终只会在 provider 侧报 `context_length_exceeded` 中断循环。
- **现有 `ContextManager`**（`modules/context/context-manger.ts`）只负责收集 cwd/OS/时间等环境信息产出 `kind:'env_info'` 消息，与本次「对话上下文压缩」职责完全不同，需在本功能中扩展 `context/` 目录定位为「上下文管理总集（环境信息 + 压缩）」。

## 目标用户

- **角色 / Agent 开发者**：通过 `ContextConfig` 调整压缩阈值与策略，无需改主循环代码即可控制 token 预算
- **终端用户**：长对话自动维持上下文长度在窗口内；可用 `/compact` 命令手动触发压缩；不会被脑补的代码细节误导

## 核心能力清单

1. **Token 估算**：字符近似估算（英文 ~4 字符/token、中文混合 ~1.5 字符/token），首次调用后用 provider 返回的真实 `usage.inputTokens` 回填校准后续估算
2. **第一层预防 · 单工具结果 offload**：单条 tool 消息长度超阈值时把完整内容写到磁盘，对话里只留预览（首尾各 N 行 + 省略提示）与文件路径
3. **第一层预防 · 单消息合计大小控制**：单条 assistant 消息内多个 tool 结果合计超阈值时，按「从大到小」依次 offload，直到合计降到阈值内
4. **第二层兜底 · 结构化摘要**：整体对话逼近窗口上限时，调 LLM 生成多段固定结构摘要（主要请求 / 关键概念 / 文件代码 / 错误修复 / 解决过程 / 用户原话 / 待办 / 当前工作 / 下一步）替换中间历史
5. **摘要 Prompt 安全约束**：摘要 Prompt 首尾各强调一次「禁止调用任何工具」；要求先输出分析草稿再写正式摘要，草稿用完即弃
6. **边界消息**：压缩后附加一条 `kind:'system_supplement'` 边界消息，提示模型如需文件细节请重新读取，禁止根据摘要脑补代码
7. **保留策略**：摘要替换时保留 system prompt + 所有 `role:'user'` 原文（用户原话强制保留）+ 最近 N 轮 assistant/tool 配对，仅中间历史被摘要替换
8. **手动触发**：新增 `/compact` 命令手动触发第二层压缩
9. **熔断**：摘要连续失败超阈值次后停止自动触发，手动触发仍可用（手动触发不计入熔断计数）
10. **API 请求前双层执行**：每轮 LLM 调用前按顺序执行——先轻量预防（管单条消息大小，不调 LLM），再昂贵兜底（管累积历史长度，调 LLM）

## 非功能要求

- 压缩流程对主循环非阻塞：offload 与摘要失败均归一化为结构化错误并跳过本轮压缩，绝不抛异常中断 `ReasoningLoop`
- 摘要调用复用 `AgentDeps.provider`，沿用当前 `LLMConfig`（不引入单独摘要模型配置），`temperature: 0`、禁用 thinking、不带 tools
- 熔断状态会话内有效，新 run 不继承（避免一次失败永久禁用）
- offload 文件按会话隔离，命名带时间戳与序号，跨会话保留供回溯，目录加入 `.gitignore`
- 配置三层合并语义与 `LLMConfig` 一致：高层级覆盖低层级同名字段
- 不污染核心引擎：压缩代码全部放在 `packages/agent/modules/context/`，通过依赖注入与 `ReasoningLoop` 解耦

## 设计骨架

### 配置层

`AgentConfig.context: ContextConfig`（与 `loop` / `security` / `mcp` 平级）：

- **开关**：`compactionEnabled`（缺省 true）、`offloadEnabled`（缺省 true）
- **阈值**：
  - `singleToolResultThreshold`（单条 tool 结果字符数，超则 offload）
  - `singleMessageTotalThreshold`（单 assistant 消息内所有 tool 结果合计字符数，超则按大→小依次 offload）
  - `windowUsageThreshold`（窗口占用百分比，0~1，达则触发摘要兜底）
  - `windowHardLimit`（窗口硬上限字符数，触发摘要时的目标保留量按此回退）
- **保留策略**：`keepRecentRounds`（保留最近 N 轮 assistant/tool 配对，缺省 4）
- **摘要**：`summaryMaxTokens`（摘要输出 token 上限，约束草稿+正文总长）
- **熔断**：`summaryFailureThreshold`（连续失败上限，缺省 3）

### 模块层（`packages/agent/modules/context/`）

- **`token-counter.ts`** — `TokenCounter` 类：`estimate(text)` 字符近似估算；`calibrate(usage)` 用 provider 真实 input_tokens 回填校正因子；纯函数 `estimateTokens(text)` 供无状态调用
- **`offloader.ts`** — `ToolResultOffloader` 类：`offload(content, sessionId)` 写盘返回路径；`buildPreview(content)` 产出首尾预览；纯函数 `buildPreviewText(content, lines)` 可单测
- **`single-message-compactor.ts`** — `SingleMessageCompactor` 类：对单条 assistant 消息（含多个 tool 结果）执行阈值检查 + 按大→小 offload；纯函数 `planOffloads(messages, threshold)` 返回需 offload 的 tool_call_id 列表
- **`summarizer.ts`** — `Summarizer` 类：`summarize(messages, signal)` 调 provider 产出结构化摘要；内部产出「草稿+正文」两段，仅返回正文；Prompt 首尾各一次禁用工具声明；纯函数 `buildSummaryPrompt(messages)` 可单测
- **`history-compactor.ts`** — `HistoryCompactor` 类：`compact(messages, opts)` 编排——计算保留边界（system + 所有 user + 最近 N 轮）→ 把中间历史交给 Summarizer → 拼装 `[summary 消息, 边界消息, 保留消息]`；纯函数 `partitionMessages(messages, keepRecent)` 返回 `{ toSummarize, toKeep }`
- **`context-compactor.ts`** — `ContextCompactor` 类（编排器）：`runCompaction(memory, opts)` 按序执行两层；维护 `consecutiveFailures` 计数与 `tripped` 熔断标志；`forceCompact(memory)` 手动触发（跳过熔断）；`reset()` 新 run 调用重置熔断

### 接入主流程

- `AgentDeps` 新增可选 `contextCompactor?: ContextCompactor`、`sessionId?: string`
- `ReasoningLoop.streamOneRound` 在调 `provider.streamChat` 前先调用 `contextCompactor.runCompaction(memory)`，对 memory 做原地压缩
- `Agent.handleCommand` 新增 `/compact`：调用 `contextCompactor.forceCompact(memory)` 后通过 `onStreamEvent` 推送一条 `system_supplement` 提示事件
- `CommandEvent.name` 类型扩展加入 `'/compact'`

### Prompt 层

摘要请求构造一条独立 `messages: [{role:'user', content: buildSummaryPrompt(history)}]`，不带 system（prompt 内已含角色定义）、不带 tools。Provider 适配层对「无 tools 的 streamChat 调用」必须保证不挂 `tools` 字段（已有行为，本功能复用）。

## Out of Scope

- **不实现跨会话持久化压缩状态**：熔断计数、offload 索引只在会话内有效
- **不实现向量检索 / RAG 式召回**：offload 文件只通过路径引用，不建立检索索引
- **不实现对话历史磁盘持久化**：`ConversationMemory` 仍是内存版，压缩只作用于内存
- **不实现多模型路由**：摘要复用主 provider，不引入「便宜模型做摘要」配置
- **不做 token 精确计算**：不引入 tiktoken 等依赖，字符近似 + usage 回填即可
- **不动态调整 `keepRecentRounds`**：保留轮数固定，不根据剩余预算自适应
- **不改 `PromptComposer` 的拼装顺序**：边界消息作为 `kind:'system_supplement'` 经现有通道注入
- **不实现 offload 文件自动清理**：跨会话保留，由用户手动清理或后续任务处理
- **不处理 `extended thinking` 字段的压缩**：thinking 字段维持现状，不进入摘要范围

## 版本完成标准

1. `AgentConfig.context` 配置项可被读取，缺省值与本文档一致
2. 单条 tool 结果超阈值时被 offload 到 `.wuzi/context-offload/{sessionId}/{ts}-{n}.txt`，对话里替换为首尾预览 + 文件路径
3. 单条 assistant 消息内多个 tool 结果合计超阈值时，按大→小依次 offload 直至达标
4. 整体对话使用率达 `windowUsageThreshold` 时自动触发摘要，中间历史被替换为一条结构化摘要消息 + 一条边界消息
5. 摘要 Prompt 含首尾各一次「禁止调用任何工具」声明，且要求先输出草稿再写正文（草稿不返回）
6. `/compact` 命令可手动触发摘要；摘要连续失败达 `summaryFailureThreshold` 次后停止自动触发，手动触发仍可用
7. 每轮 LLM 调用前按序执行两层压缩：先单消息预防（不调 LLM），再历史兜底（调 LLM）
8. 压缩流程任何异常（写盘失败 / 摘要 LLM 报错）均归一化为跳过本轮压缩，不中断主循环
9. 单元测试覆盖：TokenCounter 估算与回填、Offloader 写盘与预览、SingleMessageCompactor 计划、Summarizer Prompt 构造、HistoryCompactor 分区、ContextCompactor 熔断
10. 端到端：构造超长 tool 结果 + 多轮对话，触发第一层 offload 与第二层摘要，验证 memory 体积下降、对话流不中断、边界消息正确注入
