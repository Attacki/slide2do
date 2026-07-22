# 07-memory-system — 验收清单

> 所有条目客观可校验：命令行 / 脚本 / 测试用例。模糊描述一律禁止。

## 一、配置层

- [ ] **C1.1** `packages/agent-types/index.ts` 含 `export interface InstructionConfig`（字段 `maxIncludeDepth?` / `userLevelPath?`）与 `export interface SessionConfig`（字段 `enabled?` / `dir?` / `maxAgeDays?` / `timeGapMs?` / `tokenLimit?`）
  - 验证: `grep -nE "interface InstructionConfig|interface SessionConfig" packages/agent-types/index.ts` 返回 ≥2 条
- [ ] **C1.2** `packages/agent/utils/config/config-types.ts` 导出 `DEFAULT_INSTRUCTION_CONFIG`（`{ maxIncludeDepth: 3, userLevelPath: '~/.wuzi/AGENTS.md' }`）与 `DEFAULT_SESSION_CONFIG`（`{ enabled: true, dir: undefined, maxAgeDays: 30, timeGapMs: 3600000, tokenLimit: undefined }`）
  - 验证: `grep -nE "DEFAULT_INSTRUCTION_CONFIG|DEFAULT_SESSION_CONFIG" packages/agent/utils/config/config-types.ts` 返回 ≥2 条
- [ ] **C1.3** `AgentConfig` 接口含 `instructions?: InstructionConfig` 与 `session?: SessionConfig` 字段
  - 验证: `grep -nE "instructions\?:|session\?: ContextConfig|session\?: SessionConfig" packages/agent/utils/config/config-types.ts` 返回 ≥2 条

## 二、InstructionLoader

- [ ] **C2.1** 纯函数 `parseIncludeDirectives(content)` 存在并导出
  - 验证: `grep -n "export function parseIncludeDirectives\|export const parseIncludeDirectives" packages/agent/modules/memory/instructions/instruction-loader.ts` 返回 ≥1 条
- [ ] **C2.2** 纯函数 `isPathSafe(resolved, rootDir)` 存在并导出；逃逸路径返回 false
  - 验证: `bun test packages/agent/tests/instruction-loader.test.ts` 含路径逃逸用例且通过
- [ ] **C2.3** 纯函数 `expandIncludes(content, basePath, depth, maxDepth, rootDir)` 存在并导出
  - 验证: `grep -n "export function expandIncludes\|export const expandIncludes" packages/agent/modules/memory/instructions/instruction-loader.ts` 返回 ≥1 条
- [ ] **C2.4** `@include ./relative.md` 指令被展开为被引用文件内容；嵌套深度超 `maxIncludeDepth`（默认 3）时停止展开并保留原指令文本 + 警告注释
  - 验证: `bun test packages/agent/tests/instruction-loader.test.ts` 含嵌套深度用例且通过
- [ ] **C2.5** 解析后路径逃逸所属层级根目录时整条 @include 拦截，原文本保留 + 警告注释（含「逃逸」或「escape」字样）
  - 验证: `bun test packages/agent/tests/instruction-loader.test.ts` 含逃逸拦截用例且通过
- [ ] **C2.6** 被引用文件不存在时保留原指令文本 + 警告注释（含「不存在」或「not found」字样）
  - 验证: `bun test packages/agent/tests/instruction-loader.test.ts` 含文件缺失用例且通过
- [ ] **C2.7** `InstructionLoader.load()` 按「项目级 → 用户级」顺序拼接；两层间有分隔注释；任一层缺失跳过该层不报错
  - 验证: `bun test packages/agent/tests/instruction-loader.test.ts` 含多层拼接用例且通过

## 三、SessionStore

- [ ] **C3.1** 纯函数 `serializeMessage(msg)` 与 `parseJsonlLine(line)` 存在并导出
  - 验证: `grep -nE "export function serializeMessage|export const serializeMessage|export function parseJsonlLine|export const parseJsonlLine" packages/agent/modules/memory/session/session-store.ts` 返回 ≥2 条
- [ ] **C3.2** `parseJsonlLine` 对合法 JSON 行返回 `{ok:true, value:msg}`；对非法 JSON 行返回 `{ok:false}` 不抛
  - 验证: `bun test packages/agent/tests/session-store.test.ts` 含合法/非法两用例且通过
- [ ] **C3.3** `SessionStore.appendMessage(sessionId, msg)` 追加一行 JSON 到 `{baseDir}/{sessionId}.jsonl`；多次调用产生多行
  - 验证: `bun test packages/agent/tests/session-store.test.ts` 含追加用例且通过
- [ ] **C3.4** `SessionStore.readMessages(sessionId)` 逐行解析跳过坏行；返回 `{ messages, badLineCount }`
  - 验证: `bun test packages/agent/tests/session-store.test.ts` 含坏行跳过用例且通过
- [ ] **C3.5** `SessionStore.writeMeta(sessionId, meta)` 用 temp + rename 原子写 `{baseDir}/{sessionId}.meta.json`；`readMeta` 可读回
  - 验证: `bun test packages/agent/tests/session-store.test.ts` 含原子写读回用例且通过
- [ ] **C3.6** `SessionStore.listMetas()` 扫目录下所有 `.meta.json` 返回数组；`deleteSession(sessionId)` 同删 .jsonl 与 .meta.json
  - 验证: `bun test packages/agent/tests/session-store.test.ts` 含列表 + 删除用例且通过
- [ ] **C3.7** `.gitignore` 含 `.wuzi/sessions/` 条目
  - 验证: `grep -n ".wuzi/sessions" .gitignore` 返回 ≥1 条

## 四、SessionRecovery

- [ ] **C4.1** 纯函数 `truncateToCompleteMessages(messages)` 存在并导出，返回 `{ messages, truncated, truncatedCount }`
  - 验证: `grep -n "export function truncateToCompleteMessages\|export const truncateToCompleteMessages" packages/agent/modules/memory/session/session-recovery.ts` 返回 ≥1 条
- [ ] **C4.2** 末尾 assistant 含 `tool_calls` 但缺对应 `tool_result` 时，截断到该 assistant 之前；`truncated: true`、`truncatedCount` 为被截断消息数
  - 验证: `bun test packages/agent/tests/session-recovery.test.ts` 含截断用例且通过
- [ ] **C4.3** 末尾消息完整（无未配对 tool_use）时 `truncated: false`、原样返回
  - 验证: `bun test packages/agent/tests/session-recovery.test.ts` 含完整用例且通过
- [ ] **C4.4** 纯函数 `detectTimeGap(messages, thresholdMs)` 存在并导出
  - 验证: `grep -n "export function detectTimeGap\|export const detectTimeGap" packages/agent/modules/memory/session/session-recovery.ts` 返回 ≥1 条
- [ ] **C4.5** `SessionRecovery.recover(messages, opts)` 编排：先截断、再 token 检查（超限且注入 contextCompactor 时调 forceCompact，异常归一化跳过）、再时间跨度检测；返回 `{ messages, warnings, timeGapReminder? }`
  - 验证: `bun test packages/agent/tests/session-recovery.test.ts` 含编排用例且通过
- [ ] **C4.6** 时间跨度超阈值时 `timeGapReminder` 非空，文案含时间跨度提示
  - 验证: `bun test packages/agent/tests/session-recovery.test.ts` 含时间跨度用例且通过

## 五、SessionCleaner

- [ ] **C5.1** 纯函数 `isExpired(meta, now, maxAgeDays)` 存在并导出
  - 验证: `grep -n "export function isExpired\|export const isExpired" packages/agent/modules/memory/session/session-cleaner.ts` 返回 ≥1 条
- [ ] **C5.2** `lastActiveAt` 距 `now` 超 `maxAgeDays * 86400000` 时 `isExpired` 返回 true；否则 false
  - 验证: `bun test packages/agent/tests/session-cleaner.test.ts` 含超期/未超期两用例且通过
- [ ] **C5.3** `SessionCleaner.cleanExpired(now?)` 扫 `store.listMetas()`，命中过期则 `store.deleteSession(id)`，返回删除数；单条删除失败 warn 不阻塞其余
  - 验证: `bun test packages/agent/tests/session-cleaner.test.ts` 含多会话清理用例且通过

## 六、SessionManager

- [ ] **C6.1** `SessionManager` 类含 `startSession()` / `appendMessage(id, msg)` / `loadSession(id)` / `cleanupExpired()` 四个公开方法
  - 验证: `grep -nE "startSession|appendMessage|loadSession|cleanupExpired" packages/agent/modules/memory/session/session-manger.ts` 返回 ≥4 条
- [ ] **C6.2** `startSession()` 生成 `{pid}-{ts}` 形式 ID 并写空 meta（messageCount 0、createdAt/lastActiveAt 当前时间）
  - 验证: `bun test packages/agent/tests/session-manager.test.ts` 含 startSession 用例且通过
- [ ] **C6.3** `appendMessage` 调 store.appendMessage + 更新 meta（title 首条 user 前 50 字符、summary 末条 assistant 前 200 字符、messageCount++、lastActiveAt 当前时间）
  - 验证: `bun test packages/agent/tests/session-manager.test.ts` 含 appendMessage meta 更新用例且通过
- [ ] **C6.4** `loadSession` 调 store.readMessages + recovery.recover，返回 `{ messages, warnings, timeGapReminder? }`；IO 异常归一化 warn 不抛
  - 验证: `bun test packages/agent/tests/session-manager.test.ts` 含 loadSession 用例且通过

## 七、主流程接入

- [ ] **C7.1** `AgentDeps` 接口含 `instructionLoader?: InstructionLoader` 与 `sessionManager?: SessionManager` 字段
  - 验证: `grep -nE "instructionLoader\?|sessionManager\?" packages/agent/agent.ts` 返回 ≥2 条
- [ ] **C7.2** `Agent` 构造时若注入 instructionLoader：调 `load()` 拿到指令文本，构造 `kind:'system_supplement'` 系统消息追加到 memory（system 之后、user 之前）
  - 验证: `grep -n "system_supplement" packages/agent/agent.ts` 返回 ≥1 条；`bun test packages/agent/tests/` 含 E2E-1 用例且通过
- [ ] **C7.3** `Agent.processInput` 每轮 assistant 与 tool 消息产生后异步调 `sessionManager.appendMessage`（不阻塞主循环）
  - 验证: `grep -n "appendMessage" packages/agent/agent.ts` 返回 ≥1 条
- [ ] **C7.4** `app/index.ts` 装配 InstructionLoader + SessionStore + SessionRecovery + SessionCleaner + SessionManager 并注入 Agent；启动后调 `sessionManager.cleanupExpired()`
  - 验证: `grep -nE "new InstructionLoader|new SessionManager|cleanupExpired" app/index.ts` 返回 ≥3 条
- [ ] **C7.5** `packages/agent/index.ts` 桶文件导出 `InstructionLoader` / `SessionStore` / `SessionRecovery` / `SessionCleaner` / `SessionManager` 及相关类型与纯函数
  - 验证: `grep -nE "InstructionLoader|SessionStore|SessionRecovery|SessionCleaner|SessionManager" packages/agent/index.ts` 返回 ≥5 条

## 八、note.md 更新

- [ ] **C8.1** `packages/agent/modules/memory/note.md` 更新：列出 instructions/ 子目录与 session/ 下新增文件
  - 验证: `grep -nE "instruction-loader|session-store|session-recovery|session-cleaner|session-manger" packages/agent/modules/memory/note.md` 返回 ≥5 条
- [ ] **C8.2** `packages/agent/modules/note.md` 的 `### 子目录 memory/` 小节更新
  - 验证: `grep -n "instructions/" packages/agent/modules/note.md` 返回 ≥1 条
- [ ] **C8.3** `packages/agent/note.md` 的 tests 小节或文件索引已加入新增测试文件
  - 验证: `grep -nE "instruction-loader.test|session-store.test|session-recovery.test|session-cleaner.test|session-manager.test|memory-system-e2e.test" packages/agent/note.md` 返回 ≥6 条

## 九、端到端验收

- [ ] **E2E-1** 项目根 `AGENTS.md` 存在时，构造 Agent（注入 InstructionLoader），验证 `agent.getMemory()` 首条 system 之后存在一条 `kind:'system_supplement'` 系统消息，content 含 AGENTS.md 文本
  - 验证: `bun test packages/agent/tests/memory-system-e2e.test.ts` 含 E2E-1 用例且通过
- [ ] **E2E-2** AGENTS.md 含 `@include ./docs/NOTE.md` 时，指令文本中含 NOTE.md 文件内容（即被展开）；含 `@include ../../../etc/passwd` 时原文本保留 + 警告注释
  - 验证: `bun test packages/agent/tests/memory-system-e2e.test.ts` 含 E2E-2 用例且通过
- [ ] **E2E-3** 构造一段对话：末尾 assistant 含 tool_calls 但无对应 tool_result，调 `SessionRecovery.recover` 后 messages 截断到该 assistant 之前，warnings 含截断说明
  - 验证: `bun test packages/agent/tests/memory-system-e2e.test.ts` 含 E2E-3 用例且通过
- [ ] **E2E-4** 构造两个会话：一个 `lastActiveAt` 31 天前、一个 1 天前，调 `SessionCleaner.cleanExpired` 后 31 天前的会话 .jsonl 与 .meta.json 均被删除，1 天前的保留，返回删除数 = 1
  - 验证: `bun test packages/agent/tests/memory-system-e2e.test.ts` 含 E2E-4 用例且通过
- [ ] **E2E-5** `SessionManager.startSession` + 多次 `appendMessage` 后，`loadSession` 能拿回全部消息（除最后被截断的未配对 tool_use）；meta 文件 messageCount 与实际消息数一致
  - 验证: `bun test packages/agent/tests/memory-system-e2e.test.ts` 含 E2E-5 用例且通过

## 十、静态检查与全量测试

- [ ] **C10.1** `bun --check packages/agent/modules/memory/instructions/instruction-loader.ts` 通过
- [ ] **C10.2** `bun --check packages/agent/modules/memory/session/session-store.ts` 通过
- [ ] **C10.3** `bun --check packages/agent/modules/memory/session/session-recovery.ts` 通过
- [ ] **C10.4** `bun --check packages/agent/modules/memory/session/session-cleaner.ts` 通过
- [ ] **C10.5** `bun --check packages/agent/modules/memory/session/session-manger.ts` 通过
- [ ] **C10.6** `bun --check packages/agent/agent.ts` 通过
- [ ] **C10.7** `bun --check packages/agent/index.ts` 通过
- [ ] **C10.8** `bun --check app/index.ts` 通过
- [ ] **C10.9** `bun --check packages/agent-types/index.ts` 通过
- [ ] **C10.10** `bun --check packages/agent/utils/config/config-types.ts` 通过
- [ ] **C10.11** `bun test packages/agent/` 全量通过（含原有测试 + 新增 6 个测试文件，0 失败）
