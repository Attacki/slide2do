# 03 — Coding 角色 Prompt 架构优化 · 任务清单

> 执行规范见 `docs/LOOP.md`，包归属与改动 SOP 见 `docs/ACTING.md`，测试规范见 `docs/TESTING.md`。
> 每条任务完成后更新末尾 `## Progress` 字段。

---

## 任务 1 — 扩展数据结构：ChatMessage.kind + usage 加 cache 字段

**任务描述**：在 `ui-pattern.ts` 给 `ChatMessage` 增加可选 `kind?: 'user' | 'env_info' | 'mode_reminder' | 'system_supplement'` 字段（缺省视为 `user` 语义）；在 `ui-pattern.ts` 的 `StreamDoneEvent.usage` 与 `provider/base.ts` 的 `ProviderStreamEvent.done.usage` 中增加可选 `cacheReadInputTokens?: number` 与 `cacheCreationInputTokens?: number` 字段。

**影响文件**：
- `packages/agent/ui-pattern.ts`
- `packages/agent/provider/base.ts`

**依赖任务**：无

**参考定位**：`ui-pattern.ts` ChatMessage（第 19-28 行）、StreamDoneEvent（第 121-127 行）；`provider/base.ts` ProviderStreamEvent（第 21-26 行）。

---

## 任务 2 — 实现 ContextManager 环境信息收集

**任务描述**：填充空文件 `modules/context/context-manger.ts`，实现 `ContextManager` 类：收集 cwd / OS（platform+arch）/ 当前时间 / 时区（Asia/Shanghai）；对外提供 `getEnvInfo(): EnvInfo` 与 `toMessage(): ChatMessage`（产出 `kind:'env_info'` 的消息）；预留自定义扩展点（`registerField(name, provider)` 接口，允许后续注入 Git 状态/技术栈等）。

**影响文件**：
- `packages/agent/modules/context/context-manger.ts`（填充）
- `packages/agent/modules/context/note.md`（按 `docs/NOTE.md` 规范更新）

**依赖任务**：任务 1

**参考定位**：`agent.ts:52`（`process.cwd()` 现有用法）；`ui-pattern.ts` ChatMessage（kind 字段由任务 1 新增）。

---

## 任务 3 — 实现 PromptComposer 通用拼装器

**任务描述**：新增 `packages/agent/prompt/prompt-composer.ts`，实现 `PromptComposer` 类：接收角色稳定段字符串（由角色层拼装好的模块化 system）、接收环境信息消息、接收模式提醒消息，对外提供 `compose(messages, opts): ChatMessage[]` 方法，按"稳定 system（可缓存）→ env_info（动态）→ 对话历史 → mode_reminder（动态，按节奏）"顺序输出结构化消息序列。节奏控制选项：`round`（当前轮次）、`modeChanged`（本轮是否发生模式切换）、`firstRound`（是否首轮）。

**影响文件**：
- `packages/agent/prompt/prompt-composer.ts`（新增）
- `packages/agent/prompt/note.md`（按 `docs/NOTE.md` 规范新增）

**依赖任务**：任务 1、任务 2

**参考定位**：`reasoning-loop.ts:253-263`（现有 buildMessages 逻辑，将被替换）。

---

## 任务 4 — coding 角色 prompt 模块化拆分

**任务描述**：将 `packages/agent-roles/coding/system-prompt.md` 拆分为 `prompts/` 目录下 7 个模块文件：`01-identity.md`（身份）、`02-behavior.md`（行为）、`03-tool-usage.md`（工具使用）、`04-code-standards.md`（代码规范）、`05-security.md`（安全边界）、`06-task-mode.md`（任务模式-稳定部分）、`07-output-style.md`（输出风格）；改造 `coding/index.ts` 的 `loadSystemPrompt()` 为 `loadRole()`：读取 7 个模块按文件名优先级拼装为一段稳定 system 字符串返回（保持向后兼容，仍提供 `loadSystemPrompt` 作为薄封装）。

**影响文件**：
- `packages/agent-roles/coding/prompts/01-identity.md` ~ `07-output-style.md`（新增 7 个文件）
- `packages/agent-roles/coding/system-prompt.md`（删除或清空，由模块拼装取代）
- `packages/agent-roles/coding/index.ts`（改造加载逻辑）

**依赖任务**：无（与任务 1-3 可并行）

**参考定位**：`coding/system-prompt.md`（现有 24 行内容将拆分扩充）；`roles-registry.ts:7`（`loadSystemPrompt` 调用点）。

---

## 任务 5 — coding 角色 prompt 内容优化与双重强化

**任务描述**：在任务 4 拆分出的模块文件基础上做内容优化：清理冗余/过时表述；在 `03-tool-usage.md` 强化"优先调用专用工具而非通用 shell 命令""编辑前必须先读""使用专用工具而非 cat/grep/find 等"等关键规则；在 `04-code-standards.md` 补充代码规范细节；确保工具描述层（agent-tools 包各工具的 description）与全局指令层对关键规则双重强化（本任务只改全局指令层，工具描述层如需调整在端到端验证任务中标注）。

**影响文件**：
- `packages/agent-roles/coding/prompts/03-tool-usage.md`
- `packages/agent-roles/coding/prompts/04-code-standards.md`
- `packages/agent-roles/coding/prompts/05-security.md`
- 其余模块文件视内容补充

**依赖任务**：任务 4

**参考定位**：任务 4 产出的模块文件；AGENTS.md 中"使用专用工具"相关约束。

---

## 任务 6 — 改造 reasoning-loop 的 buildMessages 集成 PromptComposer

**任务描述**：改造 `reasoning-loop.ts` 的 `buildMessages()`：不再在末条消息 content 末尾追加 directive 文本，改为委托 `PromptComposer.compose()` 输出结构化消息序列；集成 `ContextManager` 产出 env_info 消息；按节奏控制选项（首轮/模式切换/其余轮）决定 mode_reminder 注入形式。保留"作用于副本、不写入 memory"的语义。删除原 `modeDirective()` 的文本追加逻辑（迁移到任务 7）。

**影响文件**：
- `packages/agent/reasoning-loop.ts`

**依赖任务**：任务 1、2、3

**参考定位**：`reasoning-loop.ts:253-263`（buildMessages）、`266-285`（modeDirective）、`288-354`（streamOneRound 调用 buildMessages）。

---

## 任务 7 — modeDirective 改造为 kind=mode_reminder + 节奏控制

**任务描述**：将原 `modeDirective()` 文本生成逻辑迁移为 `buildModeReminder(round, modeChanged): ChatMessage | null`：产出 `kind:'mode_reminder'` 的消息；首轮或模式切换时返回完整指令，其余轮次返回精简指令（仅模式名 + 一行核心约束）；agent 模式返回 null。在 ReasoningLoop 中维护 `round` 计数与 `modeChanged` 标志（`setMode` 时置 true，注入后置 false）。

**影响文件**：
- `packages/agent/reasoning-loop.ts`

**依赖任务**：任务 6

**参考定位**：`reasoning-loop.ts:92-120`（mode 状态机）、`266-285`（modeDirective 现有实现）。

---

## 任务 8 — Anthropic provider 挂载 cache_control（system + tools）

**任务描述**：改造 `provider/anthropic.ts`：system 字段从字符串改为数组形式 `[{type:'text', text, cache_control:{type:'ephemeral'}}]`，稳定段（第一条 system 消息）挂 cache_control，动态段（env_info / mode_reminder 合并后的 system 消息）不挂；tools 数组末尾工具挂 `cache_control:{type:'ephemeral'}`；按 kind 字段正确分流（env_info/mode_reminder/system_supplement 归入 system 段，user/assistant/tool 归入 messages 段）。

**影响文件**：
- `packages/agent/provider/anthropic.ts`

**依赖任务**：任务 1、6、7

**参考定位**：`provider/anthropic.ts:48-76`（请求体构造）、`16-22`（toAnthropicTool）。

---

## 任务 9 — Anthropic provider 解析并透传 cache usage

**任务描述**：改造 `provider/anthropic.ts` 的 SSE 解析：在 `message_start` / `message_delta` 事件中解析 `usage.input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`，在 `done` 事件中透传完整 usage（含 cache 字段）到 `ProviderStreamEvent`；同步改造 `reasoning-loop.ts` 的 `RoundResult.usage` 与 `StreamDoneEvent` 透传 cache 字段到 UI。

**影响文件**：
- `packages/agent/provider/anthropic.ts`
- `packages/agent/reasoning-loop.ts`（usage 累积与透传段）

**依赖任务**：任务 1、8

**参考定位**：`provider/anthropic.ts:200-203`（现有 message_stop 未解析 usage）；`reasoning-loop.ts:80-82`（RoundResult.usage）、`165-168, 217-220`（usage 累积）。

---

## 任务 10 — OpenAI provider 适配（结构分离 + kind 归并）

**任务描述**：改造 `provider/openai.ts`：按 kind 字段分流，env_info/mode_reminder/system_supplement 归并到 system 消息（稳定段在前、动态段在后，结构分离便于 API 侧自动缓存）；不挂 cache_control（无原生字段）；保持 user/assistant/tool 映射不变。

**影响文件**：
- `packages/agent/provider/openai.ts`

**依赖任务**：任务 1、6、7

**参考定位**：`provider/openai.ts:46-69`（请求体构造）、`14-23`（toOpenAITool）。

---

## 任务 11 — 接入主流程（app/index.ts + agent.ts 装配）

**任务描述**：改造 `agent.ts` 的 `AgentDeps` 与构造函数：注入 `PromptComposer` 与 `ContextManager` 依赖，`setSystem` 改为接收角色稳定段（由 `loadRole()` 返回）；改造 `app/index.ts` 的启动链路：调用 `loadRole()` 获取角色稳定段，构造 `ContextManager` 与 `PromptComposer`，传入 `Agent`。确保 desk-manger 角色不改造仍可加载（兼容 `loadSystemPrompt` 旧接口）。

**影响文件**：
- `packages/agent/agent.ts`
- `app/index.ts`
- `packages/agent-roles/roles-registry.ts`（如有必要补充 `loadRole` 接口）

**依赖任务**：任务 1-10

**参考定位**：`agent.ts:21-65`（AgentDeps 与构造函数）；`app/index.ts:50-85`（启动链路）。

---

## 任务 12 — 端到端验证 + 缓存命中验证

**任务描述**：编写端到端测试与定性评估场景：验证首轮完整模式指令注入、模式切换后完整注入、其余轮精简注入；验证 env_info 作为首条系统级补充消息注入；验证 Anthropic 请求体含 cache_control（system + tools）；验证 cache 命中字段透传到 StreamDoneEvent；验证 desk-manger 角色兼容性；运行全量 `bun test` 确保无回归。准备典型行为场景对照表（见 checklist.md）作为定性评估手段。

**影响文件**：
- `packages/agent/tests/prompt-composer.test.ts`（新增）
- `packages/agent/tests/context-manger.test.ts`（新增）
- `packages/agent/tests/caching-e2e.test.ts`（新增）
- `packages/agent/tests/build-messages.test.ts`（新增或扩展）

**依赖任务**：任务 1-11

**参考定位**：`packages/agent/tests/`（现有测试目录）；`docs/TESTING.md`（测试规范）。

---

## Progress
- **当前任务**: 全部完成 ✅
- **状态**: 🎉 已完成
- **已完成**: 12 / 12
- **上次操作**: 2026-07-17T12:00 — 任务12完成：新增 caching-e2e.test.ts 端到端验证（11 个测试覆盖 E2E-1 Anthropic cache_control 双断点挂载 / E2E-2 cache 命中字段全链路透传 / E2E-3 env_info 注入位置与内容 / E2E-4 节奏控制全链路 / E2E-6 loadStableSystem 兼容性）；全量 bun test 96 pass / 0 fail，无回归
- **阻塞原因**: 无
