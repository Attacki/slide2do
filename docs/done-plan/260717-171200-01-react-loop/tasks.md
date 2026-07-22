# tasks.md — ReAct 循环引擎

## 任务清单

### 1. 类型层增加「副作用」标记
- **任务描述**：在 `@wuzi/types` 的 `Tool` 与 `ToolDefinition` 增加「是否产生副作用」布尔标记（写类为 true，缺省读类 false）；注册中心 `toDefinitions` 透传该标记。
- **影响文件**：`packages/agent-types/index.ts`、`packages/agent/modules/tools/tool-registry.ts`
- **依赖任务**：无
- **参考定位**：`tool-registry.ts` 的 `toDefinitions()`；`agent-types/index.ts` 的 `Tool` / `ToolDefinition`

### 2. 扩展事件模型与命令
- **任务描述**：扩展 `ui-pattern.ts` 的 `StreamEvent`，新增用户消息、工具调用开始、最终回复、plan 拦截、循环终止五类事件；扩展 `CommandEvent` 新增 `/plan` 运行时切换命令。
- **影响文件**：`packages/agent/ui-pattern.ts`
- **依赖任务**：无
- **参考定位**：`ui-pattern.ts` 的 `StreamEvent` 联合类型与 `CommandEvent`

### 3. 增加循环配置类型
- **任务描述**：在配置层新增循环配置结构（最大轮数、plan-only 开关、内置超时毫秒），并接入顶层配置；缺省值取合理下限，保证禁用态不破坏现有行为。
- **影响文件**：`packages/agent/utils/config/config-types.ts`
- **依赖任务**：无
- **参考定位**：`config-types.ts` 的 `AgentConfig` / `LLMConfig`

### 4. 实现 ReactLoop 编排器（核心）
- **任务描述**：新增 `react-loop.ts` 编排模块。驱动多轮：每轮调 provider → 累积文本 / 思考 / 工具调用 / done；本轮无工具调用即终止；否则按读 / 写分组执行（读并发、写串行），结果回灌记忆后进入下一轮。内置终止状态机（end_turn / no_tool_call / max_rounds / cancelled / timeout）、plan-only 写类拦截、外部 `AbortSignal` + 内置超时双通道取消。
- **影响文件**：`packages/agent/react-loop.ts`
- **依赖任务**：1、2、3
- **参考定位**：`base-agent.ts` 现有单轮 `processInput` 逻辑（累积 / 工具回灌）可复用抽离

### 5. 改造 BaseAgent 委托循环
- **任务描述**：将 `BaseAgent.processInput` 的单轮逻辑下沉为可复用步骤，提交的用户输入委托给 ReactLoop 执行；`BaseAgentDeps` 增加循环配置与取消信号；复用现有记忆与 `ToolExecutor`。
- **影响文件**：`packages/agent/base-agent.ts`
- **依赖任务**：4
- **参考定位**：`base-agent.ts` 的 `processInput` / `runTools` / `BaseAgentDeps`

### 6. 改造 AgentLoop 接入取消与运行时切换
- **任务描述**：`AgentLoop` 持有 `AbortController`，`/exit` 与 `stop` 触发 abort 并传入循环；处理 `/plan` 命令运行时切换 plan-only；将循环配置透传给 `BaseAgent` / ReactLoop。
- **影响文件**：`packages/agent/agent-loop.ts`
- **依赖任务**：4、5
- **参考定位**：`agent-loop.ts` 的 `submit` / `stop` / `LoopCallbacks`

### 7. 抽离工具分组纯函数并单测
- **任务描述**：将「按读 / 写标记对一轮工具调用分组」抽离为独立纯函数，配套单元测试覆盖：全读、全写、混合、含未知工具、顺序保持。
- **影响文件**：`packages/agent/react-loop.ts`、`packages/agent/tests/react-loop.test.ts`
- **依赖任务**：1
- **参考定位**：`TESTING.md` 4.1（可抽离函数须独立单测）

### 8. ReactLoop 状态机单元测试
- **任务描述**：用 mock provider 与 mock 执行器覆盖：max_rounds 终止、无工具调用终止、外部 cancel 终止、内置 timeout 终止、plan-only 拦截写类并继续。断言事件序列与终止原因正确、无未捕获异常。
- **影响文件**：`packages/agent/tests/react-loop.test.ts`
- **依赖任务**：4、7
- **参考定位**：`TESTING.md` 4.2（正常 / 边界 / 异常三态）

### 9. 接入主流程
- **任务描述**：在 `app/index.ts` 装配循环配置（从配置读取最大轮数 / plan-only / 超时）与取消信号，使端到端可运行；保持现有启动顺序与角色加载不变。
- **影响文件**：`app/index.ts`
- **依赖任务**：6
- **参考定位**：`ACTING.md` 4.5（改主循环）；`app/index.ts` 装配入口

### 10. 端到端验证
- **任务描述**：按 `checklist.md` 全部端到端项验证：多轮工具调用、读并发 / 写串行、plan-only 拦截、外部取消、内置超时，逐条对照勾选全绿方可终止。
- **影响文件**：`docs/current-plan/01-react-loop/checklist.md`
- **依赖任务**：9
- **参考定位**：`TESTING.md` 5（端到端验收对齐 checklist）

## Progress
- **当前任务**: (暂无，全部完成)
- **状态**: ✅ 全部完成
- **已完成**: 10 / 10
- **上次操作**: 2026-07-17T17:10 — 完成第2~10条：事件模型/循环配置/ReactLoop 编排器/BaseAgent 委托/AgentLoop 取消与 /plan/工具分组纯函数+单测(11 pass)/TUI 健壮事件消费/主流程接入；checklist 全绿；react-loop 单测 11 pass
- **阻塞原因**: (无)
- **备注**: 既有失败 `provider-tool-call.test.ts::Anthropic input_json_delta`（未触碰 anthropic.ts，属既有问题，与本计划无关）
