# 03 — Coding 角色 Prompt 架构优化 · 验收清单

> 所有条目可观测、可复现、可勾选。禁止模糊表述。至少 5 条端到端验收项对齐 tasks 任务 12。

## 数据结构层

- [ ] `grep -n "kind\?:" packages/agent/ui-pattern.ts` 返回 ≥1 条，且 `kind` 类型包含 `'user' | 'env_info' | 'mode_reminder' | 'system_supplement'` 四个取值
- [ ] `grep -n "cacheReadInputTokens\|cacheCreationInputTokens" packages/agent/ui-pattern.ts packages/agent/provider/base.ts` 返回 ≥4 条（两个文件各 2 个字段）
- [ ] `bun --check packages/agent/ui-pattern.ts` 与 `bun --check packages/agent/provider/base.ts` 均无错误

## ContextManager

- [ ] `packages/agent/modules/context/context-manger.ts` 文件非空，且 `grep -n "class ContextManager" packages/agent/modules/context/context-manger.ts` 返回 1 条
- [ ] `grep -n "registerField" packages/agent/modules/context/context-manger.ts` 返回 ≥1 条（自定义扩展点存在）
- [ ] `ContextManager.toMessage()` 返回的消息 `kind === 'env_info'`，content 包含 cwd / OS / 时间 / 时区四个字段
- [ ] `bun test packages/agent/tests/context-manger.test.ts` 通过

## PromptComposer

- [ ] `packages/agent/prompt/prompt-composer.ts` 文件存在，`grep -n "class PromptComposer" packages/agent/prompt/prompt-composer.ts` 返回 1 条
- [ ] `PromptComposer.compose()` 输出顺序为：稳定 system → env_info → 对话历史 → mode_reminder（当注入时）
- [ ] `bun test packages/agent/prompt` 通过

## coding 角色 prompt 模块化

- [ ] `ls packages/agent-roles/coding/prompts/` 返回 7 个文件：`01-identity.md` ~ `07-output-style.md`
- [ ] `packages/agent-roles/coding/system-prompt.md` 不再存在或内容为空（被模块拼装取代）
- [ ] `grep -r "优先调用专用工具\|编辑前必须先读\|专用工具" packages/agent-roles/coding/prompts/03-tool-usage.md` 返回 ≥2 条（关键规则双重强化）
- [ ] `coding/index.ts` 的 `loadSystemPrompt()` 仍可调用并返回非空字符串（向后兼容）
- [ ] `bun --check packages/agent-roles/coding/index.ts` 无错误

## buildMessages 改造

- [ ] `grep -n "PromptComposer\|contextManager" packages/agent/reasoning-loop.ts` 返回 ≥2 条
- [ ] `reasoning-loop.ts` 中不再存在 `content: last.content ? \`${last.content}\\n\\n${directive}\` : directive` 这一文本追加写法（原 modeDirective 追加逻辑已迁移）
- [ ] `grep -n "buildModeReminder\|kind: 'mode_reminder'" packages/agent/reasoning-loop.ts` 返回 ≥1 条

## 节奏控制

- [ ] 首轮调用 `buildModeReminder(round=1, modeChanged=false)` 返回完整指令（content 行数 ≥5 或包含"PLAN/ASK 模式"完整说明）
- [ ] 模式切换后首轮 `buildModeReminder(round=N, modeChanged=true)` 返回完整指令
- [ ] 其余轮次 `buildModeReminder(round=N, modeChanged=false)` 返回精简指令（content 行数 ≤2）
- [ ] agent 模式 `buildModeReminder()` 返回 null

## Anthropic provider cache_control

- [ ] `grep -n "cache_control" packages/agent/provider/anthropic.ts` 返回 ≥2 条（system 段 + tools 段）
- [ ] `grep -n "ephemeral" packages/agent/provider/anthropic.ts` 返回 ≥2 条
- [ ] Anthropic 请求体中 system 字段为数组形式（`Array.isArray(body.system)` 为 true），第一个元素挂 `cache_control`
- [ ] Anthropic 请求体中 tools 数组最后一个工具挂 `cache_control`

## Anthropic cache usage 透传

- [ ] `grep -n "cache_read_input_tokens\|cache_creation_input_tokens" packages/agent/provider/anthropic.ts` 返回 ≥2 条
- [ ] `grep -n "cacheReadInputTokens\|cacheCreationInputTokens" packages/agent/reasoning-loop.ts` 返回 ≥2 条（透传到 RoundResult 与 StreamDoneEvent）
- [ ] `bun test packages/agent/tests/provider-tool-call.test.ts` 通过

## OpenAI provider 适配

- [ ] `grep -n "kind" packages/agent/provider/openai.ts` 返回 ≥1 条（按 kind 分流）
- [ ] OpenAI 请求体中 env_info/mode_reminder/system_supplement 归并到 role='system' 消息
- [ ] `bun --check packages/agent/provider/openai.ts` 无错误

## 主流程接入

- [ ] `grep -n "PromptComposer\|ContextManager" packages/agent/agent.ts` 返回 ≥2 条
- [ ] `grep -n "PromptComposer\|ContextManager\|loadRole" app/index.ts` 返回 ≥2 条
- [ ] `bun start` 能正常启动，coding 角色加载成功（无报错退出）
- [ ] desk-manger 角色不改造仍可加载：`grep -n "loadSystemPrompt" packages/agent-roles/desk-manger/index.ts` 仍存在且 `getRole('desk-manger')` 不抛错

## 端到端验收（≥5 条）

- [ ] **E2E-1 缓存挂载**：启动 coding 角色，发起一轮对话，抓取 Anthropic 请求体（mock provider 或日志），断言 `body.system` 为数组且首元素含 `cache_control`、`body.tools` 末元素含 `cache_control`
- [ ] **E2E-2 缓存命中透传**：连续发起两轮对话（第二轮稳定段不变），第二轮 `StreamDoneEvent.usage.cacheReadInputTokens > 0` 或 `cacheCreationInputTokens > 0`（至少一个非零，证明 cache 字段被解析透传）
- [ ] **E2E-3 env_info 注入**：发起首轮对话，抓取发给 provider 的消息序列，断言存在 `kind:'env_info'` 的消息（Anthropic 侧归入 system 段、OpenAI 侧归入 system 消息），且 content 含 cwd/OS/时间/时区
- [ ] **E2E-4 节奏控制**：在 plan 模式下连续发起 3 轮对话，断言第 1 轮 mode_reminder 为完整指令（行数 ≥5），第 2、3 轮为精简指令（行数 ≤2）；中途执行 `/agent` 切换后再发起一轮，断言该轮 mode_reminder 为完整指令或 null（agent 模式）
- [ ] **E2E-5 双重强化**：检查 `packages/agent-roles/coding/prompts/03-tool-usage.md` 与 `packages/agent-tools/` 下任一工具的 description，断言"优先专用工具 / 编辑前先读"类规则在两处都出现
- [ ] **E2E-6 兼容性**：将 `app/index.ts` 中 `agent_role` 改为 `desk-manger`，`bun start` 仍能正常启动并加载（不因 PromptComposer/ContextManager 改造破坏未改造角色）
- [ ] **E2E-7 无回归**：`bun test` 全量通过，无新增失败用例

## 定性评估场景（人工对比）

- [ ] 场景 A：同一用户问题在改造前后对比，coding 角色是否更倾向调用专用工具（如 Read/Edit/Grep）而非 `cat`/`sed`/`find` shell 命令
- [ ] 场景 B：环境变化（切换 cwd）后，稳定段缓存是否仍命中（cacheReadInputTokens 不归零）
- [ ] 场景 C：plan → agent 模式切换后，首轮是否注入完整 agent 指令（应为 null，不注入）
