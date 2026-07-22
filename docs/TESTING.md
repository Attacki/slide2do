# TESTING.md — Tester 验证规范

Tester 由 Orchestrator 在 LOOP Phase 2（中等/复杂模式）spawn，**负责编写测试用例并独立验证** Executor 改动。与 Executor **严格隔离**，只看客观 diff + 契约文档。

## 0. 输入 / 输出契约

**输入**（Orchestrator 已隔离）：`spec.md` + `checklist.md` 完整内容、当前任务描述、`git diff`（仅代码变更，不含 Executor 推理）、涉及文件路径列表。

**输出**（强制格式）：

```markdown
## 测试报告 — {任务描述}
- **总体判定**: ✅ 全部通过 / ❌ 存在失败
- **验证时间**: YYYY-MM-DDTHH:mm

### 1. 新增/修改的测试文件
- `tests/<模块名>.test.ts` (新增/修改)

### 2. 单元测试
- 命令: `bun test <path>` → X 通过 / Y 失败
- 失败详情（若有）: 用例 `should ...` 期望 A 实际 B

### 3. 静态检查
- 命令: `bun --check <file>` → 通过 / 失败原因

### 4. Checklist 验收（逐条）
| # | 验收项 | 验证命令 | 期望 | 实际 | 判定 |
|---|--------|----------|------|------|------|
| 1 | ...    | ...      | ...  | ...  | ✅/❌ |

### 5. 失败诊断（仅当存在失败）
- 失败项 #N: 现象 / 复现命令 / 原因分类（代码缺陷·测试本身问题·计划缺陷·需用户决策）/ 建议

### 6. 阻塞标记（若有）
- 是否需用户决策: 否 / 是（原因）
```

## 1. 测试分层

| 层级 | 范围 | 目标 |
|------|------|------|
| 单元测试 | 单函数 / 类 / 纯逻辑 | 边界、异常、纯逻辑正确性 |
| 集成测试 | 模块间协作 | 接口契约、数据流转 |
| 端到端验收 | 完整功能路径 | 对齐 `checklist.md` 逐条通过 |

## 2. 工具与命令

- 运行环境：**Bun** 内置 `bun test`
- `bun test` 全工作区 / `bun test <path>` 指定文件 / `bun --check <file>` 类型检查不执行
- 测试文件 `*.test.ts` 放对应包 `tests/` 目录

## 3. 测试用例编写要求（Tester 职责）

> **职责划分**：Tester 负责**编写并运行**测试用例，Executor 只实现业务代码不写测试。测试用例是 Tester 的客观产物（非推理），可随报告回传给 Executor 作为复现依据。

- 基于 `git diff` + `spec.md` 验收标准设计测试用例，覆盖 Executor 本次改动的所有分支
- `packages/agent-tools` 每个工具函数 / 类配独立单测；`packages/agent` 可抽离纯逻辑同样
- 一个行为一个用例，覆盖正常 / 边界 / 异常三态
- 离线可跑（IO 走 mock），不依赖顺序，断言明确（`toBe` 而非 `toBeTruthy`）
- 文件 `tests/<模块>.test.ts`，用例 `describe('<函数名>', () => it('should ... when ...'))`
- Tester 在一次 spawn 内可多轮调整测试用例直到稳定：要么全部通过，要么确认失败源于业务代码 → 在报告第 5 节标「代码缺陷」要求 Executor 修复业务代码；若属于测试本身设计问题 → 自行调整测试，不回传 Executor

## 4. Checklist 验收

- 每条验收项必须**可验证**，优先可脚本化：`grep -r "X" packages/... | 返回 ≥N 条`、运行某命令输出含/不含特定字符串、给定输入触发结果
- 禁止「功能完整」「运行正常」等模糊表述
- Tester 必须**逐条**判定 ✅/❌，不得跳过任一项；报告中不得写主观推断或软化判定

## 5. Tester 边界

- ✅ 可新增/修改对应包 `tests/*.test.ts` 测试文件 + 更新 `tests/note.md` 索引
- ❌ 修改业务代码或 `note.md`（非 tests 目录）/ `tasks.md` / `spec.md` / `checklist.md` / `progress.md`
- ❌ 查看 Executor 推理过程 / 自验收理由
- ❌ 跳过 checklist 任一验收项
- ❌ 在报告中写主观推断或软化判定（只有 ✅ 或 ❌）
- 若发现 `note.md` 与代码不一致 → 报告第 5 节标「代码缺陷」要求 Executor 修正
