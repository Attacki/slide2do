# notes for `packages/agent/modules/memory/session/`

> 最后更新: 2026-07-21 — 新增 session 四件套：SessionStore（JSONL 持久化）+ SessionRecovery（异常恢复）+ SessionCleaner（过期清理）+ SessionManager（生命周期协调）

会话存档与恢复模块。文件布局：`{baseDir}/{sessionId}.jsonl`（消息流，每行一条 ChatMessage JSON）+ `{baseDir}/{sessionId}.meta.json`（元信息）。
默认位置与 config.yaml 同目录：`{cwd}/.wuzi/sessions/`（已在 `.gitignore` 排除）。

## 文件索引

### `session-store.ts`
- **用途**: JSONL 追加写入 + meta 原子写管理
- **关键导出**:
  - 类 `SessionStore`：构造 `{ baseDir }`；`appendMessage(id, msg)` / `readMessages(id) → { messages, badLineCount }` / `writeMeta(id, meta)` / `readMeta(id)` / `listMetas()` / `deleteSession(id)` / `jsonlPath(id)` / `metaPath(id)`
  - 纯函数 `serializeMessage(msg)`：序列化为单行 JSON（不含换行）
  - 纯函数 `parseJsonlLine(line)`：返回 `{ ok, value? }`，非法 JSON 不抛错
- **设计原则**: 追加 O(1)（appendFile）；崩溃只丢最后一行；恢复时坏行可跳过；meta 原子写（temp + rename）
- **空行处理**: 空行与纯空白行静默跳过不计坏行；含内容但解析失败的行计入 badLineCount
- **依赖**: `node:fs/promises` (appendFile/readFile/writeFile/readdir/unlink/rename/mkdir), `node:fs` (existsSync), `node:path`, `node:crypto` (randomBytes 用于 tmp 文件名)
- **消费者**: `SessionRecovery`（读 messages）、`SessionCleaner`（listMetas + deleteSession）、`SessionManager`（编排）
- **注意**: `readMessages` 文件不存在返回空列表 + badLineCount=0（视为新会话）；`deleteSession` 单文件删除失败不阻塞另一文件，残留 `.tmp` 文件清理

### `session-recovery.ts`
- **用途**: 会话恢复异常处理编排器
- **关键导出**:
  - 类 `SessionRecovery`：构造 `{ contextCompactor?, tokenCounter?, tokenLimit? }`；`recover(messages, opts) → { messages, warnings, timeGapReminder? }`
  - 纯函数 `truncateToCompleteMessages(messages) → { messages, truncated, truncatedCount }`
  - 纯函数 `detectTimeGap(lastActiveAt, now, thresholdMs) → string | null`
- **编排顺序**: ① 截断末尾未配对 tool_use → ② token 超限压缩（构造临时 ConversationMemory 调 ContextCompactor.forceCompact）→ ③ 时间跨度提醒
- **截断规则**: 从尾向前找第一个「有 tool_calls 但其所有 id 没有对应 tool_result」的 assistant，截断到该 assistant 之前（不含）；末尾 assistant 配对完整则不截断
- **时间跨度提醒**: 阈值缺省 1 小时；超阈值返回 `[会话恢复提醒] 距上次活跃已过去 X。` 文案
- **依赖**: `../memory-manger.ts` (ConversationMemory), `../../context/context-compactor.ts`, `../../context/token-counter.ts`, `../../../ui-pattern.ts`
- **消费者**: `SessionManager.loadSession`
- **注意**: 所有步骤异常归一化为 warn 不抛；`canCompact()` 三件套齐全且 tokenLimit > 0 才执行第二步

### `session-cleaner.ts`
- **用途**: 过期会话自动清理
- **关键导出**:
  - 类 `SessionCleaner`：构造 `{ store, maxAgeDays? }`（缺省 30）；`cleanExpired(now?) → { deletedCount, skippedCount, warnings }`
  - 纯函数 `isExpired(meta, now, maxAgeDays?) → boolean`
  - 常量 `ONE_DAY_MS = 86400000`
- **判定规则**: `now - meta.lastActiveAt > maxAgeDays * ONE_DAY_MS`（严格大于，等于不过期）
- **失败处理**: listMetas 失败 warn 跳过；单条 deleteSession 失败 warn 不阻塞其余
- **依赖**: `./session-store.ts`, `@wuzi/types` (SessionMeta)
- **消费者**: `SessionManager.cleanupExpired`
- **注意**: 非有限时间戳 / 负 maxAgeDays 一律返回 false（保守不清理）

### `session-manger.ts`
- **用途**: 会话生命周期高层协调器（编排 Store + Recovery + Cleaner）
- **关键导出**:
  - 类 `SessionManager`：构造 `{ store, recovery?, cleaner?, now?, generateId? }`；方法 `startSession(id?)` / `appendMessage(id, msg)` / `loadSession(id) → LoadSessionResult` / `cleanupExpired()`
  - 纯函数 `computeMetaUpdate(old, sessionId, msg, ts) → SessionMeta`：处理 title（首条 user 前 50 字符）/ summary（末条 assistant 前 200 字符）/ messageCount++ / lastActiveAt 更新
  - 类型 `SessionManagerOptions` / `LoadSessionResult`（透传 RecoveryResult + badLineCount + meta）
  - 常量：`TITLE_MAX_CHARS=50` / `SUMMARY_MAX_CHARS=200` / `DEFAULT_TITLE='新会话'`
- **startSession 行为**: 生成 `{pid}-{ts}` 形式 ID 并写空 meta（接受可选 id 参数复用外层 sessionId）
- **appendMessage 行为**: 调 store.appendMessage + 读旧 meta → computeMetaUpdate → 原子写新 meta；任一步 IO 异常 warn 不阻塞
- **loadSession 行为**: 读 messages + meta → 调 recovery.recover（若注入）→ 合并 badLineCount 警告 + 返回 `{ messages, warnings, timeGapReminder?, badLineCount, meta }`
- **cleanupExpired 行为**: 委托 cleaner.cleanExpired(now)；未注入 cleaner 时抛错
- **依赖**: `./session-store.ts`, `./session-recovery.ts`, `./session-cleaner.ts`, `../../../ui-pattern.ts`, `@wuzi/types`
- **消费者**: `agent.ts`（注入 deps.sessionManager，构造时调 startSession，通过 onMessagePersisted 回调持久化每条消息）；`app/index.ts`（装配 + 启动后 cleanupExpired）
- **注意**: `computeMetaUpdate` 是纯函数便于单测；`messageCount++` 对所有 role 生效；`title` 仅在首条 user 且旧 title 为 DEFAULT_TITLE 时更新；`summary` 在每条 assistant 时更新（覆盖旧值）
