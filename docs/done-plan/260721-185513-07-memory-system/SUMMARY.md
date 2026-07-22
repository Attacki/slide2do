# 07-memory-system 完成摘要

- **完成时间**: 2026-07-21 18:55
- **归档编号**: 260721-185513
- **涉及包**: `@wuzi/types`、`@wuzi/core`（`packages/agent`）、`app`
- **验证模式**: harness（executor/tester 分离，本会话续作任务 8 + Phase 5 归档）

## 实现功能总览

### 新增功能

1. **配置层**：`AgentConfig.instructions: InstructionConfig`（`maxIncludeDepth:3` / `userLevelPath:'~/.wuzi/AGENTS.md'`）+ `AgentConfig.session: SessionConfig`（`enabled:true` / `maxAgeDays:30` / `timeGapMs:3600000` / `dir?` / `tokenLimit?`），与 `loop` / `security` / `mcp` / `context` 平级
2. **InstructionLoader**（`packages/agent/modules/memory/instructions/instruction-loader.ts`）：项目指令文件（AGENTS.md）多层级加载器，按「项目级（{projectDir}/AGENTS.md）→ 用户级（userLevelPath）」顺序加载并合并，高优先级排前让 LLM 优先遵循；支持 `@include ./relative/path.md` 语法内联引用其他文件；嵌套深度上限保护（缺省 3）+ 路径逃逸拦截（用 `path.relative` 跨平台判定，Windows 跨盘符识别）；纯函数 `parseIncludeDirectives` / `isPathSafe` / `expandIncludes` 解耦 IO 便于单测；所有 IO 异常归一化为「跳过该层 / 该指令」不向调用方抛出
3. **SessionStore**（`packages/agent/modules/memory/session/session-store.ts`）：会话 JSONL 持久化与 meta 文件管理。appendFile 追加单行 JSON（O(1) append、崩溃只丢最后一行）、readMessages 逐行解析跳过坏行 + 计 badLineCount、writeMeta 用 temp + rename 原子写、listMetas 扫 `.meta.json` 不扫整个 JSONL、deleteSession 同删 .jsonl 与 .meta.json + 清残留 .tmp；纯函数 `serializeMessage` / `parseJsonlLine`
4. **SessionRecovery**（`packages/agent/modules/memory/session/session-recovery.ts`）：会话恢复异常处理编排器。编排「① 截断未配对 tool_use → ② token 超限压缩（注入 contextCompactor 时调 forceCompact）→ ③ 时间跨度提醒」三步；纯函数 `truncateToCompleteMessages`（从尾向前找未配对 assistant 截断到其之前）/ `detectTimeGap`（超阈值返回人类可读文案「距上次活跃已过去 X 小时 Y 分钟」）；所有步骤异常归一化为 warn 不抛
5. **SessionCleaner**（`packages/agent/modules/memory/session/session-cleaner.ts`）：过期会话清理。扫 `store.listMetas()`、命中过期（`lastActiveAt` 超 `maxAgeDays * 86400000`，默认 30 天）调 `store.deleteSession(id)`、单条删除失败 warn 不阻塞其余；纯函数 `isExpired`；常量 `ONE_DAY_MS` 导出
6. **SessionManager**（`packages/agent/modules/memory/session/session-manger.ts`）：会话生命周期协调器。编排 store + recovery + cleaner，对外暴露 `startSession(id?)` / `appendMessage(id, msg)` / `loadSession(id)` / `cleanupExpired()` 四方法；startSession 写空 meta（可选 id 参数复用 Agent 已生成 sessionId）、appendMessage 调 store + 异步更新 meta（title 首条 user 前 50 字符、summary 末条 assistant 前 200 字符、messageCount++、lastActiveAt 当前时间）、loadSession 调 readMessages + recovery.recover 返回 `{messages, warnings, timeGapReminder?, badLineCount, meta}`；纯函数 `computeMetaUpdate`
7. **主流程接入**：
   - `AgentDeps` 加 `instructionLoader?` + `sessionManager?` 可选注入
   - `ReasoningLoopDeps` 加 `onMessagePersisted?` 回调；ReasoningLoop 在 3 处 `memory.append()` 后调用（user / assistant / tool 结果）
   - `Agent` 异步初始化模式：构造时启动 `initPromise`（启动会话存档 + 加载指令文件），`processInput` 第一次调用前 `await initPromise`，保证首条 user 消息之前指令已注入；`persistMessage(msg)` 回调方法 fire-and-forget 调 `sessionManager.appendMessage`
   - `app/index.ts` 装配 InstructionLoader（项目级 {cwd}/AGENTS.md + 用户级 ~/.wuzi/AGENTS.md）+ SessionStore（{cwd}/.wuzi/sessions/）+ SessionRecovery（复用 contextCompactor + tokenCounter）+ SessionCleaner（30 天）+ SessionManager，启动后调 `sessionManager.cleanupExpired()`，受 `sessionConfig.enabled` 控制
   - 桶文件 `packages/agent/index.ts` 导出全部新类与纯函数、配置默认值

### 修改内容

1. **`packages/agent-types/index.ts`**：新增 `InstructionConfig` / `SessionConfig` / `SessionMeta` 接口
2. **`packages/agent/utils/config/config-types.ts`**：`AgentConfig` 新增 `instructions?: InstructionConfig` + `session?: SessionConfig` 字段；导出 `DEFAULT_INSTRUCTION_CONFIG` / `DEFAULT_SESSION_CONFIG`
3. **`packages/agent/agent.ts`**：`AgentDeps` 加 `instructionLoader?` / `sessionManager?`；`Agent` 加 `initPromise` 异步初始化 + `persistMessage` 回调；`sessionId` 改为可变以支持 startSession 回传；`processInput` 开头 `await this.initPromise`
4. **`packages/agent/reasoning-loop.ts`**：`ReasoningLoopDeps` 加 `onMessagePersisted?`；3 处 `memory.append()` 后调用回调
5. **`packages/agent/index.ts`**：桶文件导出 InstructionLoader / SessionStore / SessionRecovery / SessionCleaner / SessionManager 及相关类型与纯函数、配置默认值
6. **`app/index.ts`**：装配五件套（InstructionLoader + SessionStore + SessionRecovery + SessionCleaner + SessionManager）+ 启动后 cleanupExpired + Agent 注入
7. **`.gitignore`**：新增 `.wuzi/sessions/` 条目
8. **`packages/agent/modules/memory/note.md`**：加 instructions/ 与 session/ 叶级子目录文件索引
9. **`packages/agent/modules/memory/instructions/note.md`**：新建，记录 InstructionLoader
10. **`packages/agent/modules/memory/session/note.md`**：新建，记录 session 四件套
11. **`packages/agent/modules/note.md`**：更新 memory/ 子目录说明加入 instructions/ 引用
12. **`packages/agent/note.md`**：更新最后更新说明 + 末尾加测试覆盖小节（6 个新增测试文件，标注为 memory-system 特性追溯的 NOTE.md §8 例外）

## 端到端验证结论

- checklist 共 36 条验收项（C1.1~C10.11 + E2E-1~E2E-5），全部通过
- `bun --check`：10 个新增 / 修改的 `.ts` 实现文件均通过（exit 0）
- `bun test packages/agent/`：519 pass / 2 skip / 0 fail，共 521 测试（38 个测试文件）
- 新增测试覆盖：instruction-loader（31）+ session-store（21）+ session-recovery（23）+ session-cleaner（16）+ session-manager（31）+ memory-system-e2e（9）= **共 131 个新测试用例，全部通过**

### E2E 用例覆盖

- **E2E-1** 项目根 AGENTS.md 存在时，构造 Agent（注入 InstructionLoader），用空文本触发 initPromise，验证 `agent.getMemory()` 首条 system 之后存在 `kind:'system_supplement'` 系统消息，content 含 AGENTS.md 文本
- **E2E-2** AGENTS.md 含 `@include ./docs/NOTE.md` 时，指令文本中含 NOTE.md 文件内容（即被展开）；含 `@include ../../../etc/passwd` 时原文本保留 + 警告注释（含「逃逸」字样）
- **E2E-3** 构造对话末尾 assistant 含 tool_calls 但无对应 tool_result，调 `SessionRecovery.recover` 后 messages 截断到该 assistant 之前，warnings 含「截断」说明
- **E2E-4** 构造两个会话：一个 `lastActiveAt` 31 天前、一个 1 天前，调 `SessionCleaner.cleanExpired` 后 31 天前的会话 .jsonl 与 .meta.json 均被删除，1 天前的保留，返回删除数 = 1
- **E2E-5** `SessionManager.startSession` + 多次 `appendMessage` 后，`loadSession` 能拿回全部消息；meta 文件 messageCount 与实际消息数一致；末尾未配对 tool_use 时截断且 messageCount 反映写入数（含被截断的）

## 关键设计决策

1. **fire-and-forget 持久化模式**：ReasoningLoop 在每次 `memory.append` 后调 `onMessagePersisted` 回调，Agent.persistMessage 内部用 `void sessionManager.appendMessage(...)` 不 await，异步不阻塞主循环；异常由 SessionManager 内部归一化 warn
2. **异步初始化时序**：Agent 构造时启动 `initPromise`（加载指令 + 启动会话存档），`processInput` 第一次调用前 `await initPromise`，保证首条 user 消息之前指令已注入
3. **sessionId 复用**：`SessionManager.startSession(id?)` 改为接受可选 id 参数，Agent 传入自己生成的 sessionId，startSession 回传相同 id，避免双重 ID 生成
4. **JSONL 追加写入**：每条消息 serializeMessage + '\n' 后 appendFile 单次写入；大多数 OS 上 appendFile 是原子单次写入，崩溃时至多丢最后一行
5. **meta 原子写**：temp + rename 模式，rename 在同分区下原子，崩溃时保留旧 meta 或新 meta 之一，不会半写
6. **路径逃逸检查**：用 `path.relative(rootDir, resolved)` 跨平台判定，相对路径以 `..` 开头或为绝对路径（Windows 跨盘符）视为逃逸
7. **@include 嵌套深度保护**：递归深度 ≥ maxDepth（缺省 3）时停止展开，保留原指令文本 + 警告注释
8. **异常归一化策略**：所有 IO 异常归一化为 console.warn 不阻塞主循环，调用方拿到「跳过该步」的语义而非抛错
9. **配置三层结构遵循**：项目级 AGENTS.md > 用户级 ~/.wuzi/AGENTS.md，高优先级排前让 LLM 优先遵循
10. **sessionId 格式**：`{pid}-{ts}` 形式，避免多进程冲突

## 遗留问题

- **未做 Phase 3 提交**：前序会话因上下文丢失未执行 Phase 3 任务级 commit，所有改动仍在工作区。用户可决定是否一次性提交或拆分为任务级提交
- **C8.3 与 NOTE.md §8 的冲突**：`packages/agent/note.md` 末尾新增「测试覆盖」小节列出 6 个新增测试文件，违反 NOTE.md §8「不记录测试相关内容」的一般原则；已在该小节顶部明确标注为「memory-system 特性追溯使用」的例外，仅保留至本特性归档；后续特性不应延续此模式
- **token 压缩步骤的 tokenLimit 配置**：`SessionRecovery` 的 token 压缩步骤需要 `contextCompactor` + `tokenCounter` + `tokenLimit` 三件套齐全才生效；当前 `app/index.ts` 装配时 `tokenLimit` 来自 `config.session?.tokenLimit`（缺省 undefined），即默认不启用 token 压缩，需要用户在 config.yaml 显式配置 `session.tokenLimit` 才生效
- **不实现跨进程会话锁**：多进程并发写同一 sessionId 的 JSONL 可能产生交错行；当前设计假设单进程独占会话，未实现文件锁
- **不实现会话搜索**：`SessionStore.listMetas` 仅返回 meta 列表，未实现按 title/summary 全文搜索；如需搜索能力需另起任务

## 归档位置

`docs/done-plan/260721-185513-07-memory-system/`
