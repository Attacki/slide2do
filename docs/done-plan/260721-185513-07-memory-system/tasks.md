# 07-memory-system — 任务清单

> 任务总量 8 条。前 6 条为模块实现，第 7 条接入主流程，第 8 条端到端验证 + note.md。

## 任务 1 — 新增 InstructionConfig / SessionConfig 类型与默认值

- **任务描述**: 在 `@wuzi/types` 新增 `InstructionConfig`（`maxIncludeDepth?`、`userLevelPath?`）与 `SessionConfig`（`enabled?`、`dir?`、`maxAgeDays?`、`timeGapMs?`、`tokenLimit?`）接口；在 `packages/agent/utils/config/config-types.ts` 的 `AgentConfig` 加 `instructions?` 与 `session?` 字段；导出 `DEFAULT_INSTRUCTION_CONFIG` 与 `DEFAULT_SESSION_CONFIG` 常量（缺省值见 spec）
- **影响文件**: `packages/agent-types/index.ts`、`packages/agent/utils/config/config-types.ts`
- **依赖任务**: 无
- **参考定位**: 现有 `ContextConfig` / `DEFAULT_CONTEXT_CONFIG` 风格

## 任务 2 — 实现 InstructionLoader 与 @include 展开

- **任务描述**: 新建 `packages/agent/modules/memory/instructions/instruction-loader.ts`。导出纯函数 `parseIncludeDirectives(content)` 返回 `{line, raw, path}[]`、`isPathSafe(resolved, rootDir)` 用 `path.resolve` + 严格 `startsWith(rootDir + path.sep)` 检查、`expandIncludes(content, basePath, depth, maxDepth, rootDir)` 递归展开（超深度保留原指令 + 警告注释、逃逸路径保留原指令 + 警告注释、文件不存在保留原指令 + 警告注释）。`InstructionLoader` 类构造接收 `{ projectDir, userLevelPath?, maxIncludeDepth? }`，`load()` 按「项目级 AGENTS.md（项目根）→ 用户级 AGENTS.md（userLevelPath）」顺序加载并合并（每层独立展开 @include，层间用分隔注释），返回拼装后的指令文本；任一层缺失跳过该层不报错
- **影响文件**: `packages/agent/modules/memory/instructions/instruction-loader.ts`（新增）、`packages/agent/tests/instruction-loader.test.ts`（新增）
- **依赖任务**: 任务 1
- **参考定位**: spec §设计骨架 模块层 instruction-loader 条目

## 任务 3 — 实现 SessionStore（JSONL append + 原子 meta）

- **任务描述**: 新建 `packages/agent/modules/memory/session/session-store.ts`。导出纯函数 `serializeMessage(msg)` 返回 JSON 字符串、`parseJsonlLine(line)` 返回 `{ok: boolean, value?: ChatMessage}`（解析失败 ok=false）。`SessionStore` 类构造接收 `{ baseDir }`，方法：`appendMessage(sessionId, msg)` 用 `fs.appendFile` 追加一行 JSON 到 `{baseDir}/{sessionId}.jsonl`、`readMessages(sessionId)` 逐行读取跳过坏行（坏行计数返回）、`writeMeta(sessionId, meta)` 用 temp + rename 原子写 `{baseDir}/{sessionId}.meta.json`、`readMeta(sessionId)`、`listMetas()` 扫目录下所有 `.meta.json`、`deleteSession(sessionId)` 同删 .jsonl 与 .meta.json。所有 IO 失败抛 Error 由上层归一化
- **影响文件**: `packages/agent/modules/memory/session/session-store.ts`（新增）、`packages/agent/tests/session-store.test.ts`（新增）、`.gitignore`（加 `.wuzi/sessions/`）
- **依赖任务**: 任务 1
- **参考定位**: spec §核心能力清单 第 4、5 条

## 任务 4 — 实现 SessionRecovery（四类异常处理）

- **任务描述**: 新建 `packages/agent/modules/memory/session/session-recovery.ts`。导出纯函数 `truncateToCompleteMessages(messages)`：从尾向前扫描，若末尾 assistant 含 `tool_calls` 但缺对应 `tool_result`，截断到该 assistant 之前；返回 `{ messages, truncated: boolean, truncatedCount: number }`。纯函数 `detectTimeGap(messages, thresholdMs)`：取最后一条消息的隐式时间戳（无时间戳字段时返回 null），与当前时间比对，超阈值返回提醒文案。`SessionRecovery` 类构造接收 `{ contextCompactor?, tokenCounter?, tokenLimit? }`，`recover(messages, opts)` 编排：①调 `truncateToCompleteMessages` 截断 ②若 token 估算超限且注入了 contextCompactor，调 `forceCompact`（异常归一化跳过）③调 `detectTimeGap`，超阈值时返回 `timeGapReminder` 文案。返回 `{ messages, warnings: string[], timeGapReminder?: string }`
- **影响文件**: `packages/agent/modules/memory/session/session-recovery.ts`（新增）、`packages/agent/tests/session-recovery.test.ts`（新增）
- **依赖任务**: 任务 1
- **参考定位**: spec §核心能力清单 第 6 条

## 任务 5 — 实现 SessionCleaner（30 天过期清理）

- **任务描述**: 新建 `packages/agent/modules/memory/session/session-cleaner.ts`。导出纯函数 `isExpired(meta, now, maxAgeDays)` 用 `now - meta.lastActiveAt > maxAgeDays * 86400000` 判定。`SessionCleaner` 类构造接收 `{ store, maxAgeDays? }`，`cleanExpired(now?)` 扫 `store.listMetas()`，对每条调 `isExpired`，命中则 `store.deleteSession(id)`，返回删除数；单条删除失败 warn 不阻塞其余
- **影响文件**: `packages/agent/modules/memory/session/session-cleaner.ts`（新增）、`packages/agent/tests/session-cleaner.test.ts`（新增）
- **依赖任务**: 任务 3
- **参考定位**: spec §核心能力清单 第 7 条

## 任务 6 — 实现 SessionManager 高层协调器

- **任务描述**: 替换空 `packages/agent/modules/memory/session/session-manger.ts`。`SessionManager` 类构造接收 `{ store, recovery?, cleaner? }`。方法：`startSession()` 生成 `{pid}-{ts}` 形式 ID 并写空 meta（title 用首条用户消息前 50 字符的占位 '新会话'，summary 空，messageCount 0，createdAt/lastActiveAt 当前时间）、`appendMessage(sessionId, msg)` 调 store.appendMessage + 异步更新 meta（title 首条 user 消息前 50 字符、summary 末条 assistant 消息前 200 字符、messageCount++、lastActiveAt 当前时间）、`loadSession(sessionId)` 调 store.readMessages + recovery.recover 返回 `{ messages, warnings, timeGapReminder? }`、`cleanupExpired()` 委托 cleaner。所有 IO 异常归一化 warn 不抛
- **影响文件**: `packages/agent/modules/memory/session/session-manger.ts`（替换空文件）、`packages/agent/tests/session-manager.test.ts`（新增）
- **依赖任务**: 任务 3、4、5
- **参考定位**: spec §设计骨架 模块层 session-manger 条目

## 任务 7 — 接入主流程（AgentDeps / Agent / app/index.ts / 桶文件导出）

- **任务描述**: `AgentDeps` 新增 `instructionLoader?: InstructionLoader` 与 `sessionManager?: SessionManager`。`Agent` 构造时若注入 instructionLoader：调 `load()` 拿到指令文本，构造 `kind:'system_supplement'` 系统消息追加到 memory 开头（system 之后、user 之前）。`Agent.processInput` 每轮 assistant 与 tool 消息产生后异步调 `sessionManager.appendMessage`（不阻塞主循环，失败 warn）。`app/index.ts` 装配：按 `config.instructions` 构造 InstructionLoader、按 `config.session` 构造 SessionStore + SessionRecovery（复用已注入的 contextCompactor / tokenCounter）+ SessionCleaner + SessionManager，启动后调 `sessionManager.cleanupExpired()` 再进 TUI。`packages/agent/index.ts` 桶文件导出全部新增类与类型
- **影响文件**: `packages/agent/agent.ts`、`app/index.ts`、`packages/agent/index.ts`
- **依赖任务**: 任务 2、6
- **参考定位**: spec §设计骨架 接入主流程节

## 任务 8 — 编写测试 + note.md 更新

- **任务描述**: 由 Tester 角色（此处 Orchestrator 直接执行以提效）编写并运行全量测试，覆盖 spec §版本完成标准 第 2~10 条；更新 `packages/agent/modules/memory/note.md`、`packages/agent/modules/memory/instructions/note.md`、`packages/agent/modules/memory/session/note.md`、`packages/agent/modules/note.md`、`packages/agent/note.md`、`packages/agent/tests/note.md`（若存在）；运行 `bun --check` 全量 + `bun test` 全量
- **影响文件**: `packages/agent/tests/memory-system-e2e.test.ts`（新增）、各 `note.md`
- **依赖任务**: 任务 1~7 全部完成
- **参考定位**: `checklist.md` 全部验收项
