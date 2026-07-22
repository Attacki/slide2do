# ACTING.md — Executor 执行规范

Executor 由 Orchestrator 在复杂模式下 spawn，负责单条任务的**业务代码**改动。最终验收权属于 Tester，Executor 不得自我宣告完成。

> **职责边界**：Executor 只写业务代码，**不写测试用例**。测试用例由 Tester 编写并运行（见 `TESTING.md`）。Executor 自检仅做类型检查与行为验证，不跑 `bun test`。

## 0. 输入 / 输出契约

**输入**（Orchestrator 在 prompt 中提供）：任务描述、影响文件、spec 验收标准、checklist 相关项；重试时附上一次 Tester 报告 + 当前 git diff；中断续作时附现有 diff 要求补全。

**输出**（返回给 Orchestrator）：

```markdown
## Executor 产出 — {任务描述}
### 1. 修改文件列表
- `packages/xxx/yyy.ts` (新增/修改/删除)
### 2. git diff 摘要
- {一句话概括每处改动，不含推理}
### 3. 阻塞标记（若有）
- 需用户决策: 否 / 是（原因）
- 需计划修订: 否 / 是（原因）
```

## 1. 技术栈

- **零构建**：Bun 直接运行 `.ts`，`tsconfig.json` 配 `noEmit: true`
- **monorepo**：Bun workspaces，`import '@wuzi/xxx'` 解析到对应包 `index.ts`
- **入口**：`bun start`（生产）/ `bun dev`（热重载），统一从 `app/index.ts` 启动

## 2. 包地图

| 包 | 路径 | 何时改 |
|----|------|--------|
| `@wuzi/types` | `packages/agent-types/` | 新增共享 interface/type |
| `@wuzi/core` | `packages/agent/` | 主循环 / Provider / 记忆 / 配置 / 工具执行 |
| `@wuzi/roles` | `packages/agent-roles/` | 角色 prompt + 注册中心 |
| `@wuzi/tools` | `packages/agent-tools/` | 内置工具集 |
| `@wuzi/tui` | `packages/agent-tui/` | 终端 UI |
| `@wuzi/mcp` | `packages/agent-mcp/` | MCP 服务 |
| `@wuzi/skills` | `packages/agent-skills/` | agent 预制能力 |
| `@wuzi/agent` | `app/` | CLI 入口 + 启动流程 |

> 新增类型 → `@wuzi/types`；新增工具 → `@wuzi/tools`；新增 Provider → `@wuzi/core/provider/`；不知道放哪 → 先查对应包的 `note.md`。

## 3. 常见改动流程

| 场景 | 关键步骤 | 自检命令 |
|------|----------|----------|
| 新增内置工具 | `packages/agent-tools/<name>/index.ts` 导出 ToolDefinition + handler → 桶文件导出 → 更新 note.md | `bun --check packages/agent-tools/` |
| 新增 Provider | `packages/agent/provider/<name>.ts` 实现 `ILLMProvider` → `client.ts` 的 `registerProvider()` 注册 → 更新 note.md | `bun --check packages/agent/` |
| 新增角色 | `packages/agent-roles/<role>/` 含 `index.ts` + `system-prompt.md` → `roles-registry.ts` 注册 → 更新 note.md | `bun start` 确认可加载 |
| 新增类型 | `packages/agent-types/index.ts` 加 interface/type → 检查所有消费者 | `bun --check <每个依赖该类型的文件>` |
| 改核心主循环 | 改 `packages/agent/` 下文件 → 严禁角色/Provider 硬编码进主循环 | `bun --check packages/agent/ && bun start` |

## 4. 跨包依赖

- 内部包引用：`import { X } from '@wuzi/core'`，由 `bun.lock` workspaces 解析
- 仅允许 `packages/agent-*` 依赖 `@wuzi/types`；`app/` 依赖所有核心包
- **禁止循环依赖**：`@wuzi/core` ↔ `@wuzi/tools` 互引不行，通过接口解耦
- 修改公共接口（`@wuzi/types` 或某包 `index.ts` 导出）→ 执行 `bun --check` 全量检查消费者

## 5. note.md 联动

修改任何文件后按 `docs/NOTE.md` 增量更新对应目录的 `note.md`，只增/删/改本次涉及条目。`tests/` 目录的 `note.md` 由 Tester 维护，Executor 不动。

## 6. 阻塞上报

遇到以下情况在产出第 3 节标记阻塞并停止：自检连续 3 次未通过、需人工决策（密钥/选型/设计取舍）、发现计划外跨包影响、Tester 报告标注「需用户决策」。
