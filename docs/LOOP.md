# LOOP.md — 任务开发闭环

用户给出开发意图后进入闭环。**核心原则：自主循环执行，无需中途确认。** 完成一条任务并验证通过后自动选取下一条，直到全部完成才汇报。

## 目录模型

```
docs/
├── current-plan/{功能名}/   ← agent 唯一读写区
└── done-plan/{yyMMdd-HHmmss}-{功能名}/   ← 完工归档（只写）
```

## 分级触发（决定走哪条路径）

| 规模 | 判据 | 流程 |
|------|------|------|
| **简单** | ≤3 个已有文件 + 无新增文件 + 不改公共接口 | Orchestrator 直接改 + 自验收 → 提交。无 subagent |
| **中等** | 单功能点，超出简单判据 | Orchestrator 直接改 → spawn Tester 写测试+验证 → 提交 |
| **复杂** | 多功能点 / 跨包 / 新增公共接口 | Phase 0 产出四文档 → 三角色完整流程 |

> 简单/中等模式不产出 spec/tasks/checklist，但提交仍用 `type(scope): 摘要` 格式。

## 三角色（仅复杂模式强制）

| 角色 | 担任 | 职责 | 不可见 |
|------|------|------|--------|
| **Orchestrator** | 主 agent | 调度、派发、判定 Phase、归档 | — |
| **Executor** | subagent | 按 `ACTING.md` 实现**业务代码**（不写测试） | Tester 推理；其他任务 |
| **Tester** | subagent | 按 `TESTING.md` **编写测试用例并独立验证** | **Executor 推理、对话历史、自验收理由** |

**隔离红线**：Tester prompt 只能含「客观 diff + spec/checklist 契约」，严禁夹带 Executor 思考链。Tester 产出的测试用例是客观产物（非推理），可作为复现依据回传 Executor。Orchestrator 自身不得直接写业务代码（复杂模式下）、不得自行判定测试通过。

## 状态机（复杂模式）

```
Phase 0: 准备  ──→ 产出 spec.md + tasks.md + checklist.md + progress.md
       │
       ▼
┌────────────── 🔁 自主循环 ──────────────┐
│  P1: 执行 → Executor 返回 diff + 自验收  │
│       │                                 │
│       ▼                                 │
│  P2: 验证 → Tester 写测试 + 返回报告     │
│    ╱      ╲                             │
│   ✅       ❌                           │
│   ╱         ╲                           │
│ P3: 提交   P4: 修复（≤3 次）→ 回 P1     │
│   ╱                                      │
│ 取下一任务 → 回 P1                       │
└──────────────────────────────────────────┘
       │ 无剩余任务
       ▼
Phase 5: 归档 → 移到 done-plan/ + 生成 SUMMARY.md + 报告用户
```

**停止条件**：连续失败 3 次 / 需用户决策 → 阻塞暂停；全部完成 → Phase 5 后终止。

## 会话恢复

新会话启动 → 读 `current-plan/*/progress.md`：
- **状态 ✅ / 无记录** → 全新开始或归档完成，正常进入下一步。
- **状态 🔄 进行中** → 运行 `git status` + `git diff`，对照 progress.md 的「当前任务」判断是否需补完。diff 已覆盖验收项 → 直接验证；diff 不完整 → spawn Executor 续作；无 diff → 重新执行。
- **状态 🚫 阻塞** → 向用户报告阻塞原因后再询问。

> `git diff` 是事实来源，progress.md 仅在 Phase 边界更新。无关改动（用户手动编辑的文档等）不得混入本任务 commit。

## Phase 0 — 准备

由 Orchestrator 与用户对话产出四文档（见 `PLANNING.md`）。tasks.md 所有任务初始 `⏳ 待开始`，progress.md 初始指向第一条。选取第一条标记 `🔄 进行中` → 进入 Phase 1。

## Phase 1 — 执行（Executor）

Orchestrator 选取当前 `🔄 进行中` 任务，从 tasks.md/spec.md/checklist.md 提取相关章节，按 `ACTING.md` 派发模板 spawn Executor。Executor 返回「修改文件列表 + diff 摘要 + 自验收 + 阻塞标记」，Orchestrator 只保留产物不保留推理。更新 progress.md → 进入 Phase 2。

> Executor 只实现业务代码，不写测试用例。若 Executor 自检发现需补测试 → 标记阻塞，由 Orchestrator 直接转 Phase 2 让 Tester 处理。

## Phase 2 — 验证（Tester）

Orchestrator 收集隔离输入（spec + checklist + 任务描述 + git diff + 文件路径），剔除 Executor 推理，spawn Tester。Tester 基于 diff + spec **编写测试用例**并运行，返回结构化报告（格式见 `TESTING.md`）：
- ✅ 全部通过 → 标记任务 `✅ 完成`，更新 progress.md → Phase 3
- ❌ 存在失败 → 更新 progress.md → Phase 4

Tester 判定是最终权威，Orchestrator 不得覆盖。

## Phase 3 — 提交并下一任务

Orchestrator 直接执行（git 提交是调度层操作）：
1. `git add` 仅暂存本任务涉及的文件 + 测试文件 + 对应 note.md
2. `git commit -m "type(scope): 摘要"`（英文 ≤72 字符）
3. 更新 progress.md
4. 有剩余任务 → 选取下一条标记 `🔄 进行中` → **自动回 Phase 1**；无剩余 → **自动进 Phase 5**

> 关键：第 4 步是循环引擎，必须自主推进，不停下等用户说「继续」。

## Phase 4 — 修复

依据 Tester「失败诊断」分类：
- **代码缺陷**（业务代码不符合测试期望）→ spawn 新 Executor（同任务重试），传入 Tester 报告 + 测试用例 + diff + 任务 → 回 Phase 1
- **测试本身问题**（Tester 在 spawn 内可多轮调整测试用例，无需 Executor 介入；若已退出 spawn 则重新 spawn Tester 调整测试）
- **计划缺陷** → 回 Phase 0 与用户确认后修订契约
- **需用户决策** → 标记 `🚫 阻塞` → 暂停 → 向用户求助

重试上限 3 次，每次 spawn 新 subagent 不复用上下文。

## Phase 5 — 归档

全部任务 `✅ 完成` 后自动执行：
1. 在 plan 目录生成 `SUMMARY.md`（完成时间、涉及包、功能总览、端到端结论、遗留问题）
2. 整个目录从 `current-plan/` 移动到 `done-plan/{yyMMdd-HHmmss}-{功能名}/`
3. 向用户输出完成报告 → LOOP 终止

## 自主循环行为

| 场景 | 行为 |
|------|------|
| 任务间切换 | 自动选取下一条 `⏳` 任务 |
| 验证通过 | 自动提交并继续 |
| 验证失败 | 自动进 Phase 4（上限 3 次） |
| 遇阻塞 | 立即报告用户并暂停 |
| 全部完成 | 自动归档并报告 |
| 用户主动打断 | 尊重打断，更新 progress.md 后暂停 |

> 🚀 一句话：用户说一次需求，Orchestrator 自主调度到全部通过，中间不出声，除非炸了。

## 反模式（核心红线）

- ❌ 跳过 PLANNING 直接改代码（复杂模式）
- ❌ 一次执行多条任务 / 跨任务操作
- ❌ Orchestrator 自己写业务代码或自判定测试通过（复杂模式）
- ❌ Executor 编写测试用例（那是 Tester 的职责）
- ❌ 把 Executor 推理转发给 Tester（违反隔离红线）
- ❌ Tester 覆盖事实 / Orchestrator 覆盖 Tester 判定
- ❌ 同任务无限重试（上限 3 次）
- ❌ 忘记更新 progress.md（导致会话恢复失效）
- ❌ 任务完成后停下等用户确认（必须自动继续）
- ❌ 阻塞时臆测用户决策
