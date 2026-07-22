# Spec — Agent 运行模式系统（agent / ask / plan）

## 背景
当前 ReactLoop 仅有 `planOnly` 布尔开关（`/plan` toggle）。存在两个缺陷：

1. **模型不知道自己的模式**：每轮发送给 LLM 的 messages 从不携带模式信息，模型不知道自己处于 plan-only，照常发起写类工具调用后被 `plan_blocked` 拦截，易陷入反复重试。
2. **退出 plan 缺少清晰控制**：只有单一 toggle，没有与"多模式切换"挂钩的明确出口。

## 目标
- 将 `planOnly` 布尔开关升级为**三态模式系统**：`agent` / `ask` / `plan`。
- 每轮调用 LLM 前，把"当前模式"指令**追加到 messages 的最后一条消息**，让模型明确自身模式与约束（agent 模式不注入，保持提示词干净）。
- 退出 plan/ask 通过切换模式实现：`/agent`、`/ask`、`/plan` 三条命令直接**设定**目标模式（非 toggle）。

## 模式定义
| 模式 | 写类工具 | 语义 | 注入指令 |
|------|---------|------|---------|
| `agent` | 允许 | 完整能力，自主读写执行任务（默认） | 不注入 |
| `ask`   | 拦截 | 只读问答/讨论，不改动工程 | 注入 ASK 指令 |
| `plan`  | 拦截 | 只读调研 + 产出待审批实施计划 | 注入 PLAN 指令 |

- 写类判定沿用 `Tool.mutates`；`ask` 与 `plan` 均拦截写类工具（`mode !== 'agent'`）。
- 拦截时沿用既有 `plan_blocked` 事件，但 `message` 文案随当前模式动态生成（提示切到 `/agent` 执行）。

## 注入方式（对应用户确认）
- 每轮 `streamOneRound` 前基于 `memory.getMessages()` 生成**副本**，将模式指令追加到副本**最后一条**消息的 `content` 末尾；**不写入记忆**，保证记忆干净、模式切换即时生效。
- `agent` 模式不注入。

## 核心改动点
- `config-types.ts`：新增 `AgentMode` 类型、`LoopConfig.mode` 字段；`DEFAULT_LOOP_CONFIG.mode = 'agent'`；保留 `planOnly` 作为已弃用兼容项（`planOnly:true` 映射为 `mode:'plan'`）。
- `react-loop.ts`：以 `mode` 取代 `planOnly`；新增 `getMode()/setMode()`；`buildMessages()` 注入模式指令；写类拦截条件改为 `mode !== 'agent'`。
- `ui-pattern.ts`：`CommandEvent.name` 增加 `/agent` `/ask`。
- `base-agent.ts`：以 `getMode()/setMode()` 取代 plan 系列方法；`handleCommand` 处理三命令。
- `agent-loop.ts`：分发 `/agent` `/ask` `/plan`；`onPlanToggled` 改为 `onModeChanged(mode)`；帮助文本更新。
- `index.ts`：导出 `AgentMode`。
- `app/index.ts` + TUI `coding/index.ts`：命令识别、模式本地回显、帮助文本更新。

## 非功能要求
- 记忆不变量不变：每个 `assistant.tool_call` 仍有对应 tool 结果。
- 模式注入为纯读副本操作，不污染 `ConversationMemory`。
- 向后兼容：旧配置 `loop.planOnly:true` 仍等价于 `mode:'plan'`。

## Out of Scope
- 具体权限规则/交互式授权（下次迭代）。
- 审批流自动执行计划（本次仅靠 `/agent` 手动切换进入执行）。
- 事件类型重命名（`plan_blocked` 保留，避免大范围 ripple）。

## 完成标准
- 三模式可通过命令切换并即时生效；`ask`/`plan` 拦截写类工具，`agent` 放行。
- 模型每轮收到当前模式指令（agent 除外），注入位置为 messages 最后一条。
- 单元测试覆盖：模式切换、按模式拦截、注入位置、向后兼容；agent+agent-tools 全量测试通过。
