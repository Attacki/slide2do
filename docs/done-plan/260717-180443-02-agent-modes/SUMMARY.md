# SUMMARY — Agent 运行模式系统（agent / ask / plan）

## 完成概览
将原 `planOnly` 布尔开关升级为**三态运行模式系统**，并解决两个核心缺陷：
1. **模型不知道自己的模式** → 每轮把当前模式指令注入到发送给 LLM 的 messages 最后一条（agent 不注入）。
2. **退出 plan 缺少控制** → 通过 `/agent` `/ask` `/plan` 三命令直接**设定**模式，切到 agent/ask 即退出 plan。

## 模式定义
| 模式 | 写类工具 | 语义 | 注入 |
|------|---------|------|------|
| `agent` | 允许 | 完整读写执行（默认） | 无 |
| `ask` | 拦截 | 只读问答/讨论 | ASK 指令 |
| `plan` | 拦截 | 只读调研 + 产出待审批计划 | PLAN 指令 |

## 改动清单
- `packages/agent/utils/config/config-types.ts` — 新增 `AgentMode`；`LoopConfig.mode`；`DEFAULT_LOOP_CONFIG.mode='agent'`；`planOnly` 弃用兼容。
- `packages/agent/react-loop.ts` — `mode` 取代 `planOnly`；`getMode()/setMode()`；`buildMessages()` 注入模式指令到最后一条（纯副本，不污染记忆）；写类拦截条件 `mode!=='agent'`。
- `packages/agent/base-agent.ts` — `getMode()/setMode()`；`handleCommand` 处理三命令。
- `packages/agent/agent-loop.ts` — 分发 `/agent` `/ask` `/plan`；`onPlanToggled`→`onModeChanged(mode)`；帮助文本更新。
- `packages/agent/ui-pattern.ts` — `CommandEvent.name` 增加 `/agent` `/ask`。
- `packages/agent/index.ts` — 导出 `AgentMode`。
- `app/index.ts` — 启动按 `mode` 打印；`onModeChanged` 回调。
- `packages/agent-tui/coding/index.ts` — 命令识别、模式本地回显、帮助文本更新。
- `packages/agent/tests/react-loop.test.ts` — 更新 + 新增模式相关用例。
- note.md：`packages/agent/note.md`、`packages/agent/utils/note.md` 同步。

## 端到端验证
- `bun test packages/agent packages/agent-tools`：**48 pass / 0 fail**（含运行模式拦截/放行、planOnly 兼容、setMode 切换、注入位置与记忆纯净断言）。
- `bun --check` 全部改动生产文件通过；`read_lints` 无新增错误。

## 向后兼容
- 旧配置 `loop.planOnly:true` 仍等价 `mode:'plan'`。

## Out of Scope（下次迭代）
- 具体权限规则 / 交互式授权。
- 审批后自动执行计划（当前靠 `/agent` 手动切换进入执行）。
- `plan_blocked` 事件重命名（保留以避免大范围 ripple）。
