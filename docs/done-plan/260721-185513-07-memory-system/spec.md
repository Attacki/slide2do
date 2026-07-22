# 07-memory-system

## 背景

当前 `ConversationMemory` 仅在进程内累积消息，无持久化、无项目指令自动注入、无会话恢复异常处理。用户每次启动都是全新会话，长对话上下文丢失；项目根目录已有 `AGENTS.md` 但未自动加载。需补齐「项目指令自动注入 + 会话存档与恢复 + 过期清理」三层记忆能力。

## 目标用户

- **角色 / Agent 开发者**：通过 `InstructionConfig` / `SessionConfig` 调整路径与阈值，无需改主循环
- **终端用户**：新会话启动自动读取项目指令；会话存档可恢复；超 30 天未活跃会话自动清理

## 核心能力清单

1. **项目指令自动注入**：新会话启动时自动读取项目根 `AGENTS.md`，作为独立 `kind:'system_supplement'` 系统消息注入对话开头
2. **多层优先级**：项目级 `AGENTS.md`（项目根） > 用户级 `AGENTS.md`（`~/.wuzi/AGENTS.md`），高优先级排前面让 LLM 优先遵循
3. **@include 模块化引用**：支持 `@include ./relative/path.md` 语法引用其他文件；嵌套深度上限 3；解析后路径必须落在所属层级根目录内，逃逸路径整条拦截并以原文本保留 + 警告注释
4. **会话 JSONL 持久化**：会话存档目录与项目级 config.yaml 同位置（`.wuzi/sessions/`），每会话一个 `{id}.jsonl` 追加写入（O(1) append、崩溃只丢最后一行、坏行可跳过）
5. **会话 meta 文件**：每会话另存 `{id}.meta.json`，含 ID/标题/摘要/消息数/创建时间/最后活跃时间；列表展示无需扫整个 JSONL；meta 写入用 temp + rename 原子替换
6. **会话恢复四类异常处理**：①解析失败的行跳过继续 ②`tool_use` 未配 `tool_result` 时截断到最后完整位置 ③token 超限时先触发一次压缩（复用 ContextCompactor）④距上次活跃超阈值（默认 1 小时）插入时间跨度提醒消息
7. **过期会话自动清理**：agent 启动后扫描 sessions 目录，删除 `lastActiveAt` 超 30 天的会话（.jsonl + .meta.json 同删）

## 非功能要求

- 所有 memory 模块代码放 `packages/agent/modules/memory/`，通过依赖注入与 Agent 解耦
- 指令加载与 session 持久化失败均归一化为「跳过 + warn」，绝不中断主循环
- session 文件 IO 用 `node:fs/promises`，meta 写入用 temp + rename 原子替换
- @include 路径解析用 `path.resolve` + `startsWith` 检查逃逸；相对路径以所属层级根目录为基准
- 配置三层合并语义与 `LLMConfig` 一致：高层级覆盖低层级同名字段
- session 存档目录加入 `.gitignore`

## 设计骨架

### 配置层

`AgentConfig.instructions?: InstructionConfig` 与 `AgentConfig.session?: SessionConfig`（与 `loop` / `security` / `context` 平级）：

- `InstructionConfig`: `maxIncludeDepth?`（缺省 3）、`userLevelPath?`（缺省 `~/.wuzi/AGENTS.md`）
- `SessionConfig`: `enabled?`（缺省 true）、`dir?`（缺省 `{projectDir}/.wuzi/sessions`）、`maxAgeDays?`（缺省 30）、`timeGapMs?`（缺省 3600000 = 1h）、`tokenLimit?`（缺省复用 context.windowHardLimit）

### 模块层（`packages/agent/modules/memory/`）

- **`instructions/instruction-loader.ts`** — `InstructionLoader` 类：`load()` 按「项目级 → 用户级」顺序加载并合并；纯函数 `expandIncludes(content, basePath, depth, maxDepth, rootDir)` 递归展开 @include；纯函数 `parseIncludeDirectives(content)` 提取指令列表；纯函数 `isPathSafe(resolved, rootDir)` 检查逃逸
- **`session/session-store.ts`** — `SessionStore` 类：`appendMessage(id, msg)` 追加 JSONL、`readMessages(id)` 逐行解析跳坏行、`writeMeta(id, meta)` 原子写、`readMeta(id)`、`listMetas()`、`deleteSession(id)`；纯函数 `parseJsonlLine(line)` 返回 `{ok, value?}`、`serializeMessage(msg)` 序列化
- **`session/session-recovery.ts`** — `SessionRecovery` 类：`recover(messages, opts)` 返回 `{ messages, warnings, timeGapReminder? }`；纯函数 `truncateToCompleteMessages(messages)` 截断无配对 tool_result 的尾部、`detectTimeGap(messages, thresholdMs)` 计算时间跨度
- **`session/session-cleaner.ts`** — `SessionCleaner` 类：`cleanExpired(maxAgeDays)` 返回删除数；纯函数 `isExpired(meta, now, maxAgeDays)` 判定
- **`session/session-manger.ts`** — `SessionManager` 类（替换空文件）：编排 store + recovery + cleaner；`startSession()` 生成 ID、`appendMessage(id, msg)` 持久化 + 更新 meta、`loadSession(id)` 恢复、`cleanupExpired()` 委托 cleaner

### 接入主流程

- `AgentDeps` 新增可选 `instructionLoader?: InstructionLoader` 与 `sessionManager?: SessionManager`
- `Agent` 构造时若注入 `instructionLoader`：调 `load()` 拿到指令文本，作为 `kind:'system_supplement'` 系统消息追加到 memory 开头（system 之后、user 之前）
- `Agent.processInput` 每轮 assistant 与 tool 消息产生后异步写入 sessionStore（不阻塞主循环，失败归一化 warn）
- `app/index.ts` 启动时构造全部组件并注入 Agent；启动后调 `sessionManager.cleanupExpired()` 再进 TUI

## Out of Scope

- 不实现跨会话摘要累积（每次新会话从空白开始，仅恢复指定 sessionId）
- 不实现 session 列表 UI 命令（meta 文件已就绪，UI 层后续接入）
- 不实现多模型路由（指令加载与 session 持久化不调 LLM，仅 token 压缩复用现有 ContextCompactor）
- 不实现会话压缩状态磁盘持久化（熔断计数仍会话内有效）
- 不实现 @include 的 glob 通配（仅支持单文件路径）
- 不实现 session 加密（明文 JSONL，敏感信息由用户在 AGENTS.md 自行规避）

## 版本完成标准

1. `AgentConfig.instructions` / `AgentConfig.session` 配置项可被读取，缺省值与本文档一致
2. 项目根 `AGENTS.md` 存在时新会话启动自动注入为 `kind:'system_supplement'` 系统消息，位于稳定 system 之后、user 输入之前
3. `@include ./relative.md` 引用的文件内容被内联展开；嵌套深度超 3 时停止展开并保留原指令文本 + 警告注释
4. 解析后路径逃逸所属层级根目录时整条 @include 拦截，原文本保留 + 警告注释
5. 用户级 `~/.wuzi/AGENTS.md` 存在时按「项目级 → 用户级」顺序拼接
6. 每条消息产生后追加到 `.wuzi/sessions/{id}.jsonl`，崩溃只丢最后一行不完整数据
7. `.wuzi/sessions/{id}.meta.json` 含 ID/标题/摘要/消息数/创建时间/最后活跃时间，meta 写入用 temp + rename
8. 会话恢复时：解析失败的行跳过、tool_use 无 tool_result 截断、token 超限触发压缩、距上次活跃超 1h 插入时间跨度提醒
9. agent 启动后扫描 sessions 目录，删除 `lastActiveAt` 超 30 天的会话（.jsonl + .meta.json 同删）
10. 单元测试覆盖：InstructionLoader（含 @include / 路径逃逸 / 嵌套深度）、SessionStore（追加/读/原子 meta/坏行跳过）、SessionRecovery（四类异常）、SessionCleaner（过期判定）、SessionManager（编排）
