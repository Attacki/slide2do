# checklist.md — ReAct 循环引擎

> 所有条目可人工 / 命令行 / 脚本验证，禁止主观模糊描述。端到端项对齐 `tasks.md` 第 10 条。
> 验证说明：真实 LLM 多轮交互无法在无人值守下自动跑，采用「mock provider + 真实 ToolExecutor + 真实工具」的集成测试等价覆盖各行为路径（见 `packages/agent/tests/react-loop.test.ts`），并辅以 app 启动 smoke test。

## 类型与事件
- [x] `grep -rn "mutates" packages/agent-types/index.ts` 返回 2 条；`bun --check packages/agent/modules/tools/tool-registry.ts` 通过。
- [x] `packages/agent/ui-pattern.ts` 中 `StreamEvent` 包含 `user_message` / `tool_call_start` / `final_answer` / `plan_blocked` / `loop_terminated`（grep 计数 = 5）。
- [x] `packages/agent/ui-pattern.ts` 的 `CommandEvent` 的 `name` 联合类型包含 `'/plan'`（第 149 行命中）。

## 语法与单测
- [x] `bun --check packages/agent/react-loop.ts` 与 `bun --check packages/agent/base-agent.ts` 均无错误。
- [x] `bun test packages/agent/tests/react-loop.test.ts` 全部通过（11 pass），覆盖 5 个终止/行为分支：max_rounds 终止、no_tool_call 终止、外部 cancel 终止（预取消 + 中途取消）、内置 timeout 终止、plan-only 拦截写类并继续。

## 分组逻辑（纯函数）
- [x] 2 个读类工具调用 → 读组长度 = 2、写组长度 = 0（`groupToolCalls > all reads`）。
- [x] 1 读 1 写混合 → 顺序保持（reads=['1','3'], writes=['2']）；写类串行执行（plan-only/事件顺序测试佐证串行回灌）。
- [x] 含未知工具名的调用 → 不抛异常，未知项按读类归入并发组，执行器返回结构化 `unknown_tool` 错误（`tool-executor.test.ts` 佐证）。

## 端到端行为（对齐 tasks 第 10 条）
- [x] 多轮工具调用：事件顺序 `tool_call` → `tool_call_start` → `tool_result`，末轮 `final_answer` 收尾并伴随 `loop_terminated`（reason = `no_tool_call`）—— 由事件顺序测试 + no_tool_call 测试等价验证。
- [x] plan-only：写工具被拦截产生 `plan_blocked` 事件且未实际执行（写计数保持 0），循环继续并输出计划文本（`ReactLoop plan-only` 测试）。
- [x] 外部取消：预取消与中途取消均以 `loop_terminated`（reason = `cancelled`）终止，无未捕获异常（两条 cancelled 测试）。
- [x] 内置超时：`timeoutMs=50` + 200ms 耗时工具 → 以 `loop_terminated`（reason = `timeout`）终止，无悬挂 Promise/未捕获异常（timeout 测试）。
- [x] 运行时 `/plan` 切换：`togglePlanOnly()` 翻转状态，TUI 本地回显、AgentLoop `onPlanToggled` 反馈；app 启动 smoke test 通过（配置加载 + 6 工具注册 + TUI 渲染）。
