# 06-context-compaction — 验收清单

> 所有条目客观可校验:命令行 / 脚本 / 测试用例。模糊描述一律禁止。默认值见各条目。

## 一、配置层

- [ ] **C1.1** `packages/agent-types/index.ts` 中存在 `export interface ContextConfig`,字段含:`compactionEnabled` / `offloadEnabled` / `singleToolResultThreshold` / `singleMessageTotalThreshold` / `windowUsageThreshold` / `windowHardLimit` / `keepRecentRounds` / `summaryMaxTokens` / `summaryFailureThreshold`(全部可选)
  - 验证: `grep -n "interface ContextConfig" packages/agent-types/index.ts` 返回 ≥1 条
- [ ] **C1.2** `packages/agent/utils/config/config-types.ts` 导出 `DEFAULT_CONTEXT_CONFIG`,缺省值严格为:`{ compactionEnabled: true, offloadEnabled: true, singleToolResultThreshold: 8000, singleMessageTotalThreshold: 20000, windowUsageThreshold: 0.8, windowHardLimit: 160000, keepRecentRounds: 4, summaryMaxTokens: 2000, summaryFailureThreshold: 3 }`
  - 验证: `grep -n "DEFAULT_CONTEXT_CONFIG" packages/agent/utils/config/config-types.ts` 返回 ≥1 条,且 `bun test` 中存在断言用例比对全部字段值
- [ ] **C1.3** `AgentConfig` 接口含 `context?: ContextConfig` 字段
  - 验证: `grep -n "context?: ContextConfig" packages/agent/utils/config/config-types.ts` 返回 ≥1 条

## 二、TokenCounter

- [ ] **C2.1** 纯函数 `estimateTokens(text)` 存在并导出
  - 验证: `grep -n "export function estimateTokens\|export const estimateTokens" packages/agent/modules/context/token-counter.ts` 返回 ≥1 条
- [ ] **C2.2** `estimateTokens('')` 严格返回 `0`
  - 验证: `bun test packages/agent/tests/token-counter.test.ts` 含该断言且通过
- [ ] **C2.3** 100 个 ASCII 字符估算约 25 tokens(±5);100 个中文字符估算约 67 tokens(±10)
  - 验证: `bun test packages/agent/tests/token-counter.test.ts` 含中英分支断言且通过
- [ ] **C2.4** `TokenCounter` 类含 `estimate(text)` 与 `calibrate(realInputTokens, estimatedTokens)` 方法;`calibrate` 后续 `estimate` 结果趋近真实值(构造 real=200/estimated=100 调用一次,再估算同长文本应 ≥100)
  - 验证: `bun test packages/agent/tests/token-counter.test.ts` 含 calibrate 用例且通过

## 三、ToolResultOffloader

- [ ] **C3.1** 纯函数 `buildPreviewText(content, headLines, tailLines)` 存在并导出
  - 验证: `grep -n "export function buildPreviewText\|export const buildPreviewText" packages/agent/modules/context/offloader.ts` 返回 ≥1 条
- [ ] **C3.2** 内容 ≤ `headLines + tailLines` 行时,`buildPreviewText` 返回原文不含「已省略」字样;内容更长时返回「首 headLines 行 + `[已省略 N 行,完整内容见: {path}]` + 尾 tailLines 行」
  - 验证: `bun test packages/agent/tests/offloader.test.ts` 含短/长内容两用例且通过
- [ ] **C3.3** `ToolResultOffloader.offload(content, sessionId)` 写入路径形如 `.wuzi/context-offload/{sessionId}/{ISO时间戳}-{序号}.txt`,返回绝对路径;文件内容与传入 `content` 完全一致
  - 验证: `bun test packages/agent/tests/offloader.test.ts` 含写盘 + 读回比对用例且通过
- [ ] **C3.4** 写盘失败(如目标目录不可写)时 `offload` 抛 `Error`,错误信息含原始失败原因
  - 验证: `bun test packages/agent/tests/offloader.test.ts` 含 mock 不可写目录用例且通过
- [ ] **C3.5** `.gitignore` 文件含 `.wuzi/context-offload/` 条目
  - 验证: `grep -n ".wuzi/context-offload" .gitignore` 返回 ≥1 条

## 四、SingleMessageCompactor

- [ ] **C4.1** 纯函数 `planOffloads(toolResults, threshold)` 存在并导出
  - 验证: `grep -n "export function planOffloads\|export const planOffloads" packages/agent/modules/context/single-message-compactor.ts` 返回 ≥1 条
- [ ] **C4.2** `planOffloads` 按 content 长度从大到小依次选中,直到合计 ≤ threshold 或全部选中;返回的 id 列表顺序与选中顺序一致
  - 验证: `bun test packages/agent/tests/single-message-compactor.test.ts` 含大→小选择用例且通过
- [ ] **C4.3** `ChatMessage` 接口含可选 `compacted?: boolean` 字段
  - 验证: `grep -n "compacted?" packages/agent/ui-pattern.ts` 返回 ≥1 条
- [ ] **C4.4** `SingleMessageCompactor.compact` 对已标记 `compacted: true` 的消息不重复处理(直接返回)
  - 验证: `bun test packages/agent/tests/single-message-compactor.test.ts` 含幂等用例且通过
- [ ] **C4.5** 单条 tool 结果长度 > `singleToolResultThreshold`(8000)时被 offload,content 替换为预览+路径,`compacted` 置 true
  - 验证: `bun test packages/agent/tests/single-message-compactor.test.ts` 含单阈值触发用例且通过
- [ ] **C4.6** 单 assistant 消息内多 tool 结果合计 > `singleMessageTotalThreshold`(20000)且单条均未超单阈值时,按大→小依次 offload 直至合计 ≤ 阈值
  - 验证: `bun test packages/agent/tests/single-message-compactor.test.ts` 含合计阈值触发用例且通过

## 五、Summarizer

- [ ] **C5.1** 纯函数 `buildSummaryPrompt(messages)` 存在并导出
  - 验证: `grep -n "export function buildSummaryPrompt\|export const buildSummaryPrompt" packages/agent/modules/context/summarizer.ts` 返回 ≥1 条
- [ ] **C5.2** `buildSummaryPrompt` 输出文本中,字符串「禁止调用任何工具」(或等价英文 `DO NOT call any tools`)至少出现 2 次(首尾各一次)
  - 验证: `bun test packages/agent/tests/summarizer.test.ts` 含首尾声明计数断言且通过
- [ ] **C5.3** `buildSummaryPrompt` 输出含 9 段固定结构标题:主要请求、关键概念、文件代码、错误修复、解决过程、用户原话、待办、当前工作、下一步(可中英文,语义等价)
  - 验证: `bun test packages/agent/tests/summarizer.test.ts` 含 9 段标题存在性断言且通过
- [ ] **C5.4** `buildSummaryPrompt` 输出含 `<draft>` 与 `<summary>` 标签要求声明,且要求草稿用完即弃
  - 验证: `bun test packages/agent/tests/summarizer.test.ts` 含 draft/summary 标签与「弃」语义断言且通过
- [ ] **C5.5** `Summarizer.summarize(messages, signal)` 调 `provider.streamChat` 时,`StreamChatParams.tools` 为 `undefined`(不挂 tools 字段)、`config.thinking` 为 `false` 或缺省
  - 验证: `bun test packages/agent/tests/summarizer.test.ts` 含 mock provider 入参校验用例且通过
- [ ] **C5.6** provider 流式返回含 `<draft>xxx</draft><summary>yyy</summary>` 时,`summarize` 仅返回 `yyy`,草稿被丢弃
  - 验证: `bun test packages/agent/tests/summarizer.test.ts` 含 draft 丢弃用例且通过
- [ ] **C5.7** provider 流式返回缺失 `</summary>` 闭合标签时,`summarize` 抛 `Error`
  - 验证: `bun test packages/agent/tests/summarizer.test.ts` 含标签缺失用例且通过
- [ ] **C5.8** provider 报错(streamChat reject)时,`summarize` 抛 `Error`,错误信息含原始错误
  - 验证: `bun test packages/agent/tests/summarizer.test.ts` 含 provider 报错用例且通过

## 六、HistoryCompactor

- [ ] **C6.1** 纯函数 `partitionMessages(messages, keepRecentRounds)` 存在并导出,返回 `{ toSummarize, toKeep }` 结构
  - 验证: `grep -n "export function partitionMessages\|export const partitionMessages" packages/agent/modules/context/history-compactor.ts` 返回 ≥1 条
- [ ] **C6.2** `partitionMessages` 把所有 `role:'system'` 消息归入 `toKeep`(无论 kind)
  - 验证: `bun test packages/agent/tests/history-compactor.test.ts` 含 system 保留用例且通过
- [ ] **C6.3** `partitionMessages` 把所有 `role:'user'` 消息归入 `toKeep`(用户原话强制保留)
  - 验证: `bun test packages/agent/tests/history-compactor.test.ts` 含 user 保留用例且通过
- [ ] **C6.4** `partitionMessages` 把「最近 `keepRecentRounds` 轮 assistant+其后所有 tool 结果」归入 `toKeep`(一轮 = 一条 assistant + 其后连续的 tool 消息),其余中间历史归入 `toSummarize`
  - 验证: `bun test packages/agent/tests/history-compactor.test.ts` 含多轮分区用例且通过
- [ ] **C6.5** `HistoryCompactor.compact` 输出顺序为 `[summary 消息, 边界消息, ...toKeep]`;summary 消息与边界消息均 `role:'system', kind:'system_supplement'`
  - 验证: `bun test packages/agent/tests/history-compactor.test.ts` 含输出顺序与 kind 断言用例且通过
- [ ] **C6.6** 边界消息 content 含字符串「禁止根据摘要脑补」与「请重新读取」(语义等价可)
  - 验证: `bun test packages/agent/tests/history-compactor.test.ts` 含边界文案断言用例且通过
- [ ] **C6.7** `toSummarize` 为空时,`compact` 不调 `Summarizer.summarize`,直接返回原 messages(不注入 summary/边界消息)
  - 验证: `bun test packages/agent/tests/history-compactor.test.ts` 含空 toSummarize 用例且通过

## 七、ContextCompactor

- [ ] **C7.1** `ContextCompactor` 类含 `runCompaction(memory, opts)` / `forceCompact(memory)` / `reset()` 三个公开方法
  - 验证: `grep -nE "runCompaction|forceCompact|reset\(" packages/agent/modules/context/context-compactor.ts` 返回 ≥3 条
- [ ] **C7.2** `runCompaction` 第一层遍历 memory 中所有 assistant 消息调 `singleMessageCompactor.compact`;`offloadEnabled: false` 时跳过第一层
  - 验证: `bun test packages/agent/tests/context-compactor.test.ts` 含 offload 触发与禁用跳过两用例且通过
- [ ] **C7.3** `runCompaction` 第二层在 memory 总 token 估算 ≥ `windowUsageThreshold * windowHardLimit`(默认 0.8 * 160000 = 128000)时触发 `historyCompactor.compact`
  - 验证: `bun test packages/agent/tests/context-compactor.test.ts` 含阈值触发用例且通过
- [ ] **C7.4** 阈值未达时第二层不触发(不调 summarizer)
  - 验证: `bun test packages/agent/tests/context-compactor.test.ts` 含未达阈值不调用例且通过
- [ ] **C7.5** 摘要连续失败达 `summaryFailureThreshold`(默认 3)次后,`tripped` 置 true,后续 `runCompaction` 自动触发被跳过
  - 验证: `bun test packages/agent/tests/context-compactor.test.ts` 含熔断触发用例且通过
- [ ] **C7.6** `forceCompact` 跳过熔断与阈值检查,即使 `tripped: true` 也执行摘要;失败不计入 `consecutiveFailures`
  - 验证: `bun test packages/agent/tests/context-compactor.test.ts` 含手动触发跳过熔断用例且通过
- [ ] **C7.7** `reset()` 把 `consecutiveFailures` 清零、`tripped` 置 false
  - 验证: `bun test packages/agent/tests/context-compactor.test.ts` 含 reset 用例且通过
- [ ] **C7.8** `runCompaction` 内任何异常(offload 抛错 / summarizer 抛错 / historyCompactor 抛错)被 try/catch 归一化为「跳过本轮压缩」,不向 `ReasoningLoop` 抛出
  - 验证: `bun test packages/agent/tests/context-compactor.test.ts` 含异常归一化用例且通过

## 八、主流程接入

- [ ] **C8.1** `AgentDeps` 接口含 `contextCompactor?: ContextCompactor` 与 `sessionId?: string` 字段
  - 验证: `grep -nE "contextCompactor\?|sessionId\?" packages/agent/agent.ts` 返回 ≥2 条
- [ ] **C8.2** `ReasoningLoopDeps` 接口含 `contextCompactor?: ContextCompactor` 字段
  - 验证: `grep -n "contextCompactor\?" packages/agent/reasoning-loop.ts` 返回 ≥1 条
- [ ] **C8.3** `ReasoningLoop.streamOneRound` 在调用 `provider.streamChat` 之前调用 `contextCompactor.runCompaction`
  - 验证: `grep -n "runCompaction" packages/agent/reasoning-loop.ts` 返回 ≥1 条,且代码位置在 `streamChat` 调用之前(Read 文件确认)
- [ ] **C8.4** `ReasoningLoop.run` 方法开始时调用 `contextCompactor.reset()`(若装配了 contextCompactor)
  - 验证: `grep -n "contextCompactor.*reset\|\.reset()" packages/agent/reasoning-loop.ts` 返回 ≥1 条
- [ ] **C8.5** `CommandEvent.name` 联合类型含 `'/compact'`
  - 验证: `grep -n "'/compact'" packages/agent/ui-pattern.ts` 返回 ≥1 条
- [ ] **C8.6** `AgentSession.submit` 的 switch 含 `case '/compact'` 分支(或等价分发逻辑)
  - 验证: `grep -n "'/compact'" packages/agent/agent-session.ts` 返回 ≥1 条
- [ ] **C8.7** `app/index.ts`(或启动装配入口)按 `config.context` 构造 `ContextCompactor` 并通过 `AgentDeps.contextCompactor` 注入
  - 验证: `grep -rn "new ContextCompactor" app/ packages/agent/` 返回 ≥1 条;`grep -rn "contextCompactor" app/index.ts` 返回 ≥1 条

## 九、note.md 更新

- [ ] **C9.1** `packages/agent/modules/note.md` 的 `### 子目录 context/` 小节已更新,列出全部新增文件(token-counter.ts / offloader.ts / single-message-compactor.ts / summarizer.ts / history-compactor.ts / context-compactor.ts)及其一句话用途
  - 验证: `grep -nE "token-counter|offloader|single-message-compactor|summarizer|history-compactor|context-compactor" packages/agent/modules/note.md` 返回 ≥6 条
- [ ] **C9.2** `packages/agent/note.md` 的 tests 小节已加入新增测试文件条目(token-counter.test.ts / offloader.test.ts / single-message-compactor.test.ts / summarizer.test.ts / history-compactor.test.ts / context-compactor.test.ts)
  - 验证: `grep -nE "token-counter.test|offloader.test|single-message-compactor.test|summarizer.test|history-compactor.test|context-compactor.test" packages/agent/note.md` 返回 ≥6 条

## 十、端到端验收(≥5 条,对齐 tasks 任务 9)

- [ ] **E2E-1** 构造单条 tool 结果长度 > 8000 字符的对话,运行触发 `runCompaction` 后:`memory.getMessages()` 中对应 tool 消息 content 不再含原始长文本,含「已省略」与文件路径;`.wuzi/context-offload/{sessionId}/` 目录下存在对应 `.txt` 文件且内容与原始 tool 结果一致
  - 验证: `bun test packages/agent/tests/` 中存在命名为 `context-compaction-e2e.test.ts` 或在 `context-compactor.test.ts` 内含 E2E-1 用例且通过
- [ ] **E2E-2** 构造一条 assistant 消息含 3 个 tool 结果(分别为 5000/6000/10000 字符,合计 21000 > 20000),运行 `runCompaction` 后:10000 与 6000 两条被 offload(从大到小依次选中,合计降至 5000 ≤ 20000),5000 字符那条保留原文
  - 验证: `bun test packages/agent/tests/` 含 E2E-2 用例且通过
- [ ] **E2E-3** 构造总长度 > 128000 字符的对话(超过 `windowUsageThreshold * windowHardLimit`),运行 `runCompaction` 后:`memory.getMessages()` 中间历史被替换为一条 summary 消息 + 一条边界消息 + 保留消息(system + 所有 user + 最近 4 轮 assistant+tool);summary 消息 `kind: 'system_supplement'`,边界消息含「禁止根据摘要脑补」
  - 验证: `bun test packages/agent/tests/` 含 E2E-3 用例且通过
- [ ] **E2E-4** mock provider 让 `summarize` 连续失败 3 次,第 4 次 `runCompaction` 调用即使对话超阈值也不触发 summarizer(`tripped: true`);改用 `forceCompact` 调用则仍触发 summarizer
  - 验证: `bun test packages/agent/tests/` 含 E2E-4 用例且通过
- [ ] **E2E-5** `/compact` 命令通过 `AgentSession.submit({type:'command', name:'/compact'})` 提交后,`forceCompact` 被调用且 memory 被压缩(长度下降)
  - 验证: `bun test packages/agent/tests/` 含 E2E-5 用例且通过;`grep -n "'/compact'" packages/agent/agent-session.ts` 返回 ≥1 条
- [ ] **E2E-6** 摘要 LLM 调用入参 `tools` 字段为 `undefined`(不挂工具定义),保证模型无法调用工具
  - 验证: `bun test packages/agent/tests/` 含 E2E-6 mock provider 入参校验用例且通过

## 十一、静态检查与全量测试

- [ ] **C11.1** `bun --check packages/agent/modules/context/token-counter.ts` 通过(无类型错误)
- [ ] **C11.2** `bun --check packages/agent/modules/context/offloader.ts` 通过
- [ ] **C11.3** `bun --check packages/agent/modules/context/single-message-compactor.ts` 通过
- [ ] **C11.4** `bun --check packages/agent/modules/context/summarizer.ts` 通过
- [ ] **C11.5** `bun --check packages/agent/modules/context/history-compactor.ts` 通过
- [ ] **C11.6** `bun --check packages/agent/modules/context/context-compactor.ts` 通过
- [ ] **C11.7** `bun --check packages/agent/agent.ts` 通过
- [ ] **C11.8** `bun --check packages/agent/reasoning-loop.ts` 通过
- [ ] **C11.9** `bun --check packages/agent/agent-session.ts` 通过
- [ ] **C11.10** `bun --check packages/agent/ui-pattern.ts` 通过
- [ ] **C11.11** `bun --check packages/agent/utils/config/config-types.ts` 通过
- [ ] **C11.12** `bun --check packages/agent-types/index.ts` 通过
- [ ] **C11.13** `bun test packages/agent/` 全量通过(含原有测试 + 新增 6 个测试文件,0 失败)
- [ ] **C11.14** `bun test packages/agent-types/` 全量通过(若该包有测试)
