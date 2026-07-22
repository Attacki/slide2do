# 03-coding-prompt-arch 完成摘要

- **完成时间**: 2026-07-17 12:00
- **归档编号**: 260717-120000
- **涉及包**: `packages/agent`, `packages/agent-roles`, `packages/agent-tools`, `app/`

## 批量提交历史

| 序号 | Commit | 任务 | Scope |
|------|--------|------|-------|
| 1 | `0278403` | 规划文档：spec.md + tasks.md + checklist.md | docs |
| 2 | `f93d199` | 任务1：ChatMessage.kind 字段 + StreamDoneEvent/ProviderStreamEvent usage 扩展 cache 字段 | core |
| 3 | `eb6e58f` | 任务2：ContextManager 环境信息收集器（cwd/OS/时间/时区 + registerField 扩展点） | core |
| 4 | `bb4bfa9` | 任务3：PromptComposer 结构化拼装器（稳定 system → env_info → 历史 → mode_reminder） | core |
| 5 | `750b5a2` | 任务4：coding 角色 prompt 模块化拆分为 7 个文件（01-identity ~ 07-output-style） | roles |
| 6 | `ad8ba79` | 任务5：工具描述层 + 全局指令层双重强化「专用工具优先 / 编辑前必须先读」 | tools |
| 7 | `cabf6ed` | 任务6：reasoning-loop buildMessages 委托 PromptComposer 拼装 | agent |
| 8 | `094e2b5` | 任务7：buildModeReminder 节奏控制（首轮/模式切换完整、其余精简、agent 不注入） | agent |
| 9 | `42ff18a` | 任务8：Anthropic provider cache_control 双断点挂载（system 稳定段 + tools 末尾） | provider |
| 10 | `507a324` | 任务9：Anthropic provider 解析 message_start/message_delta usage 并透传 cache 字段 | provider |
| 11 | `2cb7836` | 任务10：OpenAI provider 按 kind 分流 system 合并为单条（稳定在前、动态在后） | provider |
| 12 | `ba4ec8c` | 任务11：主流程接入（roles-registry loadRole + agent.ts 装配 + app/index.ts 启动链路） | agent |
| 13 | `22d644b` | 任务12：端到端验证 caching-e2e.test.ts（11 个测试覆盖 E2E-1/2/3/4/6） | test |

## 实现功能总览

### 新增功能

1. **ChatMessage.kind 字段**：扩展消息类型，区分 `user` / `env_info` / `mode_reminder` / `system_supplement`，为 prompt 编排层提供分流依据。
2. **ContextManager**：环境信息收集器，将 cwd/OS/时间/时区从全局指令剥离，作为 `kind:'env_info'` 动态消息注入；预留 `registerField` 扩展点供后续注入 Git 状态等。
3. **PromptComposer**：结构化 prompt 拼装器，按「稳定 system（可缓存）→ env_info（动态）→ 对话历史（过滤旧稳定 system）→ mode_reminder（按节奏）」顺序输出，是双通道缓存架构的核心。
4. **coding 角色 prompt 模块化**：拆分为 7 个模块文件（01-identity ~ 07-output-style），按文件名前缀控制优先级，便于后续插入新模块。
5. **mode_reminder 节奏控制**：首轮或模式切换后注入完整模式指令、其余轮次精简、agent 模式不注入；`roundInRun` 每次 run 重置、`modeChanged` 仅实际切换时置 true。
6. **Anthropic prompt caching 双断点**：system 字段数组化，稳定段挂 `cache_control` 断点 1、tools 末尾挂断点 2；按 kind 分流确保环境/模式变化不波及稳定段缓存。
7. **cache usage 解析透传**：从 `message_start.message.usage`（input_tokens + cache_read/cache_creation）与 `message_delta.usage`（output_tokens）解析，透传到 `StreamDoneEvent.usage`，UI/日志可观测缓存命中。
8. **OpenAI provider 结构分离**：按 kind 分流 system 合并为单条（稳定在前、动态在后），利用 OpenAI 侧前缀自动缓存。
9. **loadStableSystem 兼容助手**：优先 `loadRole`、缺省回退 `loadSystemPrompt`，未改造角色（如 desk-manger）仍可加载。

### 修改内容

1. **reasoning-loop.ts**：`buildMessages()` 委托 PromptComposer（未装配时透传 memory 兼容）；新增 `buildModeReminder()` 与 `fullModeDirective()` / `conciseModeDirective()`；`RoundResult.usage` 扩展 cache 字段，`run()` 跨轮累积 input/output、cache 取首次值。
2. **agent.ts**：`AgentDeps` 新增可选 `composer` / `contextManager` 透传 ReasoningLoop。
3. **app/index.ts**：装配 `ContextManager` + `PromptComposer` 传入 Agent。
4. **roles-registry.ts**：`RoleLoader` 新增可选 `loadRole`；新增 `loadStableSystem()` 助手。
5. **packages/agent/index.ts**：导出 `PromptComposer` / `ContextManager` / `loadStableSystem` / `RoleLoader`。
6. **agent-tools 工具描述层**：`read_file` / `edit_file` / `exec_command` 描述强化「编辑前必须先读」等规则，与全局指令双重呼应。

## 端到端验证结论

- **checklist 验收项**：数据结构层 / ContextManager / PromptComposer / coding 模块化 / buildMessages 改造 / 节奏控制 / Anthropic cache_control / cache usage 透传 / OpenAI 适配 / 主流程接入 / 端到端验收（E2E-1~7）全部通过。
- **bun --check**：全量源文件类型检查通过。
- **bun test**：96 通过 / 0 失败（含 11 个新增 e2e 测试），无回归。
- **E2E-1 缓存挂载**：Anthropic 请求体 `body.system` 为数组，首元素挂 `cache_control:{type:'ephemeral'}`，`body.tools` 末元素挂 `cache_control`。
- **E2E-2 缓存命中透传**：`StreamDoneEvent.usage.cacheReadInputTokens` / `cacheCreationInputTokens` 全链路透传。
- **E2E-3 env_info 注入**：装配 ContextManager + PromptComposer 后，provider 收到 `kind:'env_info'` 消息位于稳定 system 之后、user 历史之前，content 含 cwd/OS/时间/时区。
- **E2E-4 节奏控制**：plan 模式首轮完整（≥3 行）、第 2 轮精简（≤2 行）；agent 模式不注入。
- **E2E-6 兼容性**：`loadStableSystem` 优先 `loadRole`、缺省回退 `loadSystemPrompt`；coding 角色集成加载成功。
- **E2E-7 无回归**：全量 `bun test` 96 pass / 0 fail。

## 遗留问题

- **desk-manger 角色**：`packages/agent-roles/desk-manger/index.ts` 为空文件，未注册到 registry，不在本次 scope 内；`loadStableSystem` 的回退路径已通过合成 role 验证，待 desk-manger 实际实现后可直接加载。
- **定性评估场景（人工对比）**：checklist.md 中的「场景 A/B/C」（改造前后行为对比、环境变化后缓存命中、模式切换后首轮注入）需人工在实际运行中观察，不在自动化测试覆盖范围。
- **cache 命中字段的实际命中率**：需接入真实 Anthropic API 后通过 `cacheReadInputTokens` 观测，本次仅验证字段透传链路正确。
