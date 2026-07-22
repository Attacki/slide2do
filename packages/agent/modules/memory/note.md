# notes for `packages/agent/modules/memory/`

> 最后更新: 2026-07-21 — memory 系统接入主流程：新增 instructions/ 子目录与 InstructionLoader；session/ 下补齐 SessionStore / SessionRecovery / SessionCleaner / SessionManager 四件套，覆盖 JSONL 持久化 + 异常恢复 + 过期清理 + 生命周期协调

对话记忆模块。`memory-manger.ts` 是进程内对话记忆；`instructions/` 与 `session/` 为叶级子目录，文件条目直接记于此（同时各自另存一份 note.md 作更详细笔记，互不冲突）。

## 文件索引

### `memory-manger.ts`
- **用途**: 进程内多轮对话记忆，按轮次累积 user/assistant 消息并提供清空能力
- **关键导出**: `ConversationMemory` 类
- **关键方法**: `getMessages()` 取完整上下文（含 system）；`append(msg)` 追加；`clear()` 仅保留 system；`reset()` 全清；`setSystem(content)` 去重置 system
- **依赖**: `../../ui-pattern.ts` (`ChatMessage`)
- **消费者**: `agent.ts`, `reasoning-loop.ts`, `session-recovery.ts`（构造临时 memory 调 forceCompact）, `context-compactor.ts`
- **注意**: `clear()` 保留 system 消息，`reset()` 连 system 一起清空，二者语义不同

## 叶级子目录（内容直接记于此；详细笔记见各子目录 note.md）

### 子目录 instructions/
- `instruction-loader.ts` — 项目指令文件多层级加载器 `InstructionLoader`：按「项目级（{projectDir}/AGENTS.md）→ 用户级（userLevelPath，缺省 ~/.wuzi/AGENTS.md）」顺序加载并合并，高优先级排前让 LLM 优先遵循；支持 `@include ./relative/path.md` 语法内联引用其他文件；嵌套深度上限保护（缺省 3）+ 路径逃逸拦截（用 `path.relative` 跨平台判定）；纯函数 `parseIncludeDirectives` / `isPathSafe` / `expandIncludes` 解耦 IO 便于单测；所有 IO 异常归一化为「跳过该层 / 该指令」，不向调用方抛出。详细笔记见 `instructions/note.md`

### 子目录 session/
- `session-store.ts` — 会话 JSONL 持久化与 meta 文件管理 `SessionStore`：appendFile 追加单行 JSON（O(1) append、崩溃只丢最后一行）、readMessages 逐行解析跳过坏行 + 计 badLineCount、writeMeta 用 temp + rename 原子写、listMetas 扫 `.meta.json`、deleteSession 同删 .jsonl 与 .meta.json + 清残留 .tmp；纯函数 `serializeMessage` / `parseJsonlLine`
- `session-recovery.ts` — 会话恢复异常处理编排器 `SessionRecovery`：编排「截断未配对 tool_use → token 超限压缩（注入 contextCompactor 时）→ 时间跨度提醒」三步；纯函数 `truncateToCompleteMessages`（从尾向前找未配对 assistant 截断到其之前）/ `detectTimeGap`（超阈值返回人类可读文案）；所有步骤异常归一化为 warn 不抛
- `session-cleaner.ts` — 过期会话清理 `SessionCleaner`：扫 `store.listMetas()`、命中过期（`lastActiveAt` 超 `maxAgeDays * 86400000`）调 `store.deleteSession(id)`、单条失败 warn 不阻塞其余；纯函数 `isExpired`；常量 `ONE_DAY_MS` 导出
- `session-manger.ts` — 会话生命周期协调器 `SessionManager`：编排 store + recovery + cleaner，对外暴露 `startSession()` / `appendMessage(id, msg)` / `loadSession(id)` / `cleanupExpired()` 四方法；startSession 写空 meta、appendMessage 调 store + 异步更新 meta（title 首条 user 前 50 字符、summary 末条 assistant 前 200 字符、messageCount++、lastActiveAt 当前时间）、loadSession 调 readMessages + recovery.recover；纯函数 `computeMetaUpdate`。详细笔记见 `session/note.md`
