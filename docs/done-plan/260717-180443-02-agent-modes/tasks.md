# Tasks — Agent 运行模式系统

> 一轮 = Phase 0→1→2→3→(4)→循环。每 Phase 结束更新末尾 `## Progress`。

1. **配置层引入模式** — `config-types.ts`
   - 新增 `AgentMode = 'agent' | 'ask' | 'plan'`。
   - `LoopConfig` 增加 `mode?: AgentMode`；`planOnly` 标注弃用（兼容）。
   - `DEFAULT_LOOP_CONFIG` 增加 `mode: 'agent'`。

2. **ReactLoop 模式状态机** — `react-loop.ts`
   - 私有字段 `mode: AgentMode` 取代 `planOnly`；构造函数解析（含 `planOnly` 兼容映射）。
   - `getMode()` / `setMode(mode)`（移除 isPlanOnly/setPlanOnly/togglePlanOnly）。
   - `modeDirective()` 生成 ASK/PLAN 指令文本；`buildMessages()` 注入到副本最后一条。
   - `streamOneRound` 改用 `buildMessages()`；写类拦截条件改 `mode !== 'agent'`，`plan_blocked` 文案随模式生成。

3. **BaseAgent 委托** — `base-agent.ts`
   - 以 `getMode()/setMode()` 取代 plan 方法；`handleCommand` 处理 `/agent` `/ask` `/plan`。

4. **AgentLoop 命令分发** — `agent-loop.ts`
   - 分发 `/agent` `/ask` `/plan` → `setMode` + `onModeChanged(mode)` 回调（取代 `onPlanToggled`）。
   - 帮助文本加入三模式命令。

5. **类型/事件与出口** — `ui-pattern.ts` + `index.ts`
   - `CommandEvent.name` 增加 `/agent` `/ask`。
   - `index.ts` 导出 `AgentMode`。

6. **TUI 与 app 接线** — `agent-tui/coding/index.ts` + `app/index.ts`
   - TUI 命令识别 `/agent` `/ask` `/plan`，本地模式状态与回显，帮助文本更新。
   - app 启动日志改为按 mode 打印；`onModeChanged` 回调。

7. **测试与验证** — `tests/react-loop.test.ts`
   - 更新原 plan-only 用例为 `mode:'plan'`；新增：ask 拦截写类、agent 放行写类、注入位置断言、`planOnly` 兼容映射、setMode 切换。
   - `bun --check` + `bun test packages/agent packages/agent-tools` 全绿；对照 checklist。

## Progress
- ✅ 全部完成 7/7（含测试 48 pass / 0 fail）
