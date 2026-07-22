# 04-security-defense — 任务清单

共 12 条任务，按依赖顺序执行。每条任务标注「描述 / 影响文件 / 依赖 / 参考定位」。末尾两条固定为「接入主流程」与「端到端验证」。

---

### 任务 1: 定义 security 共享类型

- **描述**: 在 `@wuzi/types` 新增 `PermissionMode`/`RuleAction`/`SecurityRule`/`SecurityConfig`/`HitlRequest`/`HitlResponse`/`HitlChoice` 类型；扩展 `ToolContext` 增加可选 `askUser?: (req: HitlRequest) => Promise<HitlResponse>` 回调字段
- **影响文件**: `packages/agent-types/index.ts`
- **依赖任务**: 无
- **参考定位**: `packages/agent-types/index.ts` 现有 `ToolContext` 定义

### 任务 2: 扩展 AgentConfig 增加 security 字段

- **描述**: 在 `config-types.ts` 新增 `SecurityConfig` 类型定义；`AgentConfig` 增加可选 `security?: SecurityConfig` 字段；保持向后兼容（缺省不影响现有行为）；`DEFAULT_SECURITY_CONFIG` 常量提供默认值（default 档 + sandbox=[cwd, projectDir]）
- **影响文件**: `packages/agent/utils/config/config-types.ts`
- **依赖任务**: 任务 1
- **参考定位**: `config-types.ts` 现有 `AgentConfig`、`DEFAULT_LOOP_CONFIG`

### 任务 3: 实现 glob 模式匹配工具

- **描述**: 在 `packages/agent/modules/security/glob-match.ts` 实现轻量 glob→regex 转换与匹配函数（支持 `*`/`**`/`?`/`{a,b}`，不支持 `[]` 字符类以保持简单）；导出 `globToRegex(pattern: string): RegExp` 与 `matchGlob(str: string, pattern: string): boolean`；配套单测覆盖正常 / 边界 / 异常
- **影响文件**: `packages/agent/modules/security/glob-match.ts`, `packages/agent/tests/glob-match.test.ts`
- **依赖任务**: 无
- **参考定位**: 无

### 任务 4: 实现危险命令黑名单

- **描述**: 在 `blacklist.ts` 实现 shell / git / file 三类危险模式匹配器；每条模式带 `category`（shell/git/file）与 `reason` 文案；导出 `matchBlacklist(toolName: string, args: Record<string, unknown>): BlacklistHit | null`；配套单测覆盖三类各 ≥3 正向命中 + ≥2 反向不命中
- **影响文件**: `packages/agent/modules/security/blacklist.ts`, `packages/agent/tests/blacklist.test.ts`
- **依赖任务**: 任务 3
- **参考定位**: spec「核心能力清单」第 1 条、checklist「默认值与阈值」黑名单模式表

### 任务 5: 实现路径沙箱

- **描述**: 在 `sandbox.ts` 实现路径包含判定：导出 `isPathAllowed(target: string, cwd: string, allowedDirs: string[]): boolean` 与 `checkSandbox(toolName: string, args: Record<string, unknown>, ctx: ToolContext, allowedDirs: string[]): SandboxViolation | null`；处理 `..` 越界、绝对路径解析、跨平台分隔符；配套单测覆盖沙箱内允许 / 沙箱外拒绝 / `..`越界 / 符号链接规范化 至少 4 用例
- **影响文件**: `packages/agent/modules/security/sandbox.ts`, `packages/agent/tests/sandbox.test.ts`
- **依赖任务**: 无
- **参考定位**: spec「核心能力清单」第 2 条

### 任务 6: 实现规则匹配引擎

- **描述**: 在 `rules.ts` 实现规则集匹配：导出 `matchRules(call: ToolCall, layers: { session: SecurityRule[]; project: SecurityRule[]; global: SecurityRule[] }): RuleHit | null`；按 session > project > global 优先级遍历，同优先级按声明顺序，首条命中返回 `{ rule, action, source }`；支持工具名通配 `*`；参数 pattern 用 glob-match；配套单测覆盖优先级、通配、首条命中、无命中 至少 5 用例
- **影响文件**: `packages/agent/modules/security/rules.ts`, `packages/agent/tests/rules.test.ts`
- **依赖任务**: 任务 1, 任务 3
- **参考定位**: spec「核心能力清单」第 3、6 条

### 任务 7: 实现权限档位兜底策略

- **描述**: 在 `policy.ts` 实现 strict/default/permissive 三档兜底：导出 `fallbackDecision(toolName: string, mode: PermissionMode, tools: Tool[]): 'allow' | 'deny' | 'ask'`；档位矩阵见 checklist；判定写类用 `Tool.mutates === true`；配套单测覆盖三档 × 读类/写类 至少 6 用例
- **影响文件**: `packages/agent/modules/security/policy.ts`, `packages/agent/tests/policy.test.ts`
- **依赖任务**: 任务 1
- **参考定位**: spec「核心能力清单」第 4 条、checklist「档位兜底矩阵」

### 任务 8: 实现规则持久化存储

- **描述**: 在 `rule-store.ts` 实现规则读写：导出 `RuleStore` 类，构造时传入 config-paths 解析出的 global/project 路径；`loadRules(): { global: SecurityRule[]; project: SecurityRule[] }` 从两层 config.yaml 的 security.rules 段读取；`saveRuleToProject(rule)` / `saveRuleToGlobal(rule)` 增量写入对应文件（保留其它字段）；session 级规则由 SecurityGate 内存维护；配套单测 mock fs 覆盖加载合并 / 项目级写入 / 全局写入 至少 4 用例
- **影响文件**: `packages/agent/modules/security/rule-store.ts`, `packages/agent/tests/rule-store.test.ts`
- **依赖任务**: 任务 1, 任务 2
- **参考定位**: `packages/agent/utils/config/config-loader.ts`、`config-paths.ts`

### 任务 9: 实现 SecurityGate 主类

- **描述**: 在 `security-gate.ts` 实现 `SecurityGate` 类：构造接收 `{ ruleStore, mode, sandbox, tools }`；`check(call: ToolCall, ctx: ToolContext): Promise<SecurityDecision>` 串联 blacklist → sandbox → rules → policy → HITL 决策流；`addSessionRule(rule)` 维护会话规则；HITL 通过 `ctx.askUser` 交互，按 `scope` 落盘 / 入会话 / 仅本次；返回 `SecurityDecision = { decision: 'allow'|'deny', reason: string, layer: string }`；配套单测 mock askUser 覆盖黑名单拒绝 / 沙箱拒绝 / 规则命中 allow / HITL once / HITL session / HITL permanent / HITL deny 至少 10 用例
- **影响文件**: `packages/agent/modules/security/security-gate.ts`, `packages/agent/tests/security-gate.test.ts`
- **依赖任务**: 任务 4, 5, 6, 7, 8
- **参考定位**: spec「设计骨架」

### 任务 10: 接入 ToolExecutor

- **描述**: 在 `tool-executor.ts` 的 `executeCall` 中，于 `tool.execute()` 调用前插入 `SecurityGate.check`；`deny` 则直接返回结构化拒绝 `ToolResult`（`ok:false, error:'denied_by_security', content:reason, meta:{layer, reason}}`），不执行底层工具；`ToolExecutor` 构造函数增加可选 `securityGate?: SecurityGate` 参数；无 gate 时保持原有行为（向后兼容）
- **影响文件**: `packages/agent/modules/tools/tool-executor.ts`
- **依赖任务**: 任务 9
- **参考定位**: `tool-executor.ts` 现有 `executeCall`

### 任务 11: 接入主流程（app 启动装配）

- **描述**: 在 `app/index.ts` 启动流程中：从合并后的 AgentConfig 读取 `security` 段 → 构造 `RuleStore` 与 `SecurityGate` → 构造带 `askUser` 回调的 `ToolContext` → 注入 `ToolExecutor`；`askUser` 回调对接现有 TUI input 层（`packages/agent-tui/utils/input.ts`），渲染 `HitlRequest` 并收集 `HitlResponse`；缺省 security 配置时使用 `DEFAULT_SECURITY_CONFIG`
- **影响文件**: `app/index.ts`, `packages/agent-tui/utils/input.ts`（如需新增询问渲染）
- **依赖任务**: 任务 10
- **参考定位**: `app/index.ts` 现有启动流程

### 任务 12: 端到端验证

- **描述**: 由 Tester 执行 `checklist.md` 全部端到端验收项；覆盖黑名单拦截（shell + git）、沙箱越界、规则优先级 session>project>global、三档模式兜底、HITL 三种 scope、永久规则落盘、ToolExecutor 集成拒绝、向后兼容；全绿方可终止 LOOP
- **影响文件**: 无（验证任务）
- **依赖任务**: 任务 11
- **参考定位**: `checklist.md`

---

## Progress

- **当前任务**: 第12条 — 端到端验证 ✅ 完成
- **状态**: ✅ 全部完成
- **已完成**: 12 / 12
- **上次操作**: 2026-07-18T16:00 — 任务12 ✅（Tester 端到端验收 22/22 全部通过；全量回归 215 pass / 0 fail / 2 skip）
- **阻塞原因**: (无)
- **下一步**: Phase C 归档 — 生成 SUMMARY.md + 迁移至 done-plan/
