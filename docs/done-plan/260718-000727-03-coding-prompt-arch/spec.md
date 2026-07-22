# 03 — Coding 角色 Prompt 架构优化

## 背景

当前 coding 角色的 system prompt 仅一份扁平的 24 行 markdown，全程以纯字符串形式从 `agent-roles` 包加载后透传到 provider，核心引擎（`packages/agent`）内没有任何 prompt 模块化、缓存分层、环境注入、标签消息或缓存命中验证机制：

- system prompt 单段字符串，无职责拆分、无优先级拼装，扩展只能整体覆盖；
- 不支持 prompt caching：provider 请求体无 `cache_control`，未解析 cache 命中字段，每轮全量重发；
- 环境信息（cwd / OS / 时间 / Git）完全不进 prompt，`modules/context/context-manger.ts` 是空占位文件；
- 工具描述无分层，单字段 `description` 原样透传，关键规则未在工具描述与全局指令双重强化；
- 对话消息只有 system/user/assistant/tool 四种 role，无结构化"系统级补充消息"通道，模式指令靠在末条消息 content 末尾追加 `[系统提示 · 当前模式：XXX]` 文本片段实现，模型无法在结构上区分用户输入与系统补充；
- 会话级开关指令（plan/ask 模式）每轮都全量注入末条消息，既污染对话上下文又让缓存失效。

本次改造目标是建立一套**可缓存、可分层、可扩展**的 prompt 编排架构，并以 coding 角色为首个落地对象。

## 目标用户

- **角色开发者**：在 `packages/agent-roles/<role>/` 下新增/维护角色的提示词，需要按职责拆分模块、按优先级拼装；
- **核心引擎维护者**：在 `packages/agent/` 内扩展 prompt 拼装、缓存控制、环境注入、标签消息等通用能力；
- **最终使用用户**：获得响应更稳定、缓存命中率更高、环境感知更准确、模式切换更轻量的 coding 助手体验。

## 核心能力清单

1. 将 coding 角色全局指令按职责拆分为身份、行为、工具使用、代码规范、安全边界、任务模式、输出风格共 7 个模块文件，支持按优先级排序拼装。
2. 提供通用 PromptComposer，按"稳定缓存通道"与"动态对话通道"分流拼装 system 消息，稳定段可被 provider 标记为可缓存。
3. 将环境信息（cwd / OS / 当前时间 / 时区）从全局指令中剥离，作为对话首条系统级补充消息动态注入，环境变化不再导致稳定段缓存失效。
4. 扩展 ChatMessage 增加 `kind` 字段，使系统级补充消息（env_info / mode_reminder / system_supplement）在结构上区别于用户输入，buildMessages 按 kind 分流拼装。
5. 在工具自身描述与全局指令"工具使用"模块双重强化关键规则（优先调用专用工具、编辑前必须先读），覆盖模型默认偏好。
6. 引入带 kind 标签的对话消息机制，支持在运行中向模型注入补充指令（外部工具上线提醒、模式提醒、温和提示），不污染稳定缓存段、不被模型当作用户输入回复。
7. 会话级开关功能（plan/ask 模式）指令从全局指令中拆出，按"首轮完整 + 模式切换时完整 + 其余轮次精简"的节奏动态注入。
8. Anthropic provider 在 system 段与 tools 段挂载 `cache_control`，解析并透传 `cache_read_input_tokens` / `cache_creation_input_tokens` 到上层 usage。
9. OpenAI provider 做内容结构性分离（稳定段在前、动态段在后），不挂 cache_control（无原生字段），kind 字段在映射时正确归并。
10. 提供缓存命中字段的解析与透传链路，准备一组典型行为场景作为定性评估手段，验证缓存策略是否真正生效。
11. 本次一次性做整体编排优化，清理 coding 角色 prompt 中冗余/过时内容，利用 prompt 调整间隙最大化后续缓存命中率。

## 非功能要求

- **缓存最大化命中**：稳定段（角色模块拼装的 system + tools 简要描述）与动态段（env_info / mode_reminder / 对话历史）严格分离，稳定段内容在会话内不变化；
- **向后兼容**：ChatMessage 的 `kind` 字段为可选，未标注 kind 的现有消息按 `user`/原 role 语义处理；现有角色（如 desk-manger）不改造也能继续工作；
- **模型服务商无关**：prompt 模块化与 kind 分流在核心引擎层实现，provider 层只负责映射与 cache_control 挂载，不在主循环硬编码服务商差异；
- **可扩展**：ContextManager 预留自定义环境字段扩展点；PromptComposer 支持后续插入新模块；新的 kind 类型可增量加入；
- **可观测**：cache 命中字段透传到 StreamDoneEvent，UI/日志可读取；
- **测试覆盖**：新增模块均有单元测试，端到端场景对照 checklist 验证。

## 设计骨架

### 分层

```
agent-roles/coding/                  ← 角色层：模块文件 + 角色加载器
  prompts/                           ← 7 个职责模块（稳定内容）
    01-identity.md
    02-behavior.md
    03-tool-usage.md
    04-code-standards.md
    05-security.md
    06-task-mode.md
    07-output-style.md
  index.ts                           ← 加载模块、按优先级拼装、导出结构化角色定义

packages/agent/
  prompt/                            ← 新增：通用 prompt 编排层
    prompt-composer.ts               ← 接收角色稳定段 + 动态段，输出结构化 system 消息
  modules/context/
    context-manger.ts                ← 填充：收集环境信息，预留扩展点
  reasoning-loop.ts                  ← 改造 buildMessages：按 kind 分流 + 节奏控制
  provider/
    anthropic.ts                     ← 改造：多 system 段 + cache_control + cache usage 透传
    openai.ts                        ← 改造：kind 归并 + 结构分离
    base.ts                          ← 扩展：ProviderStreamEvent.done.usage 加 cache 字段
  ui-pattern.ts                      ← 扩展：ChatMessage.kind + StreamDoneEvent.usage 加 cache
  agent.ts                           ← 装配：PromptComposer + ContextManager
```

### 数据流

```
角色模块(稳定) ──┐
                 ├─→ PromptComposer ──→ 结构化 system 消息(稳定,可缓存)
环境信息(动态) ──┘                    ──→ env_info 消息(动态,不缓存)
模式指令(动态) ──→ mode_reminder 消息(动态,按节奏注入)
对话历史 ────────→ user/assistant/tool 消息(动态)
                                        │
                                        ▼
                              buildMessages 按 kind 分流
                                        │
                                        ▼
                          provider 映射 + cache_control 挂载
                                        │
                          ┌─────────────┴─────────────┐
                          ▼                           ▼
                   Anthropic                    OpenAI
              (system+tools 挂 cache,         (结构分离,无 cache,
               解析 cache usage 透传)          kind 归并到 system/user)
```

### kind 取值约定

- `user`（默认）：真实用户输入，未标注 kind 时按此处理；
- `env_info`：环境信息补充，对话首条系统级补充消息，动态生成不入 memory；
- `mode_reminder`：模式提醒，按节奏（首轮/模式切换完整、其余精简）注入，不入 memory；
- `system_supplement`：通用运行时补充指令（外部工具上线、温和提示等），可入 memory 也可动态注入。

### 缓存断点策略（Anthropic）

- 断点 1：角色稳定 system 段末尾（`cache_control: { type: 'ephemeral' }`）；
- 断点 2：tools 段末尾（`cache_control: { type: 'ephemeral' }`）；
- 环境信息、模式提醒、对话历史不挂 cache_control（动态变化）；
- Anthropic system 字段以数组形式 `[{type:'text', text, cache_control}, ...]` 传递，稳定段在前（可缓存）、动态段在后（不缓存）。

### 节奏控制策略（会话级开关）

- 首轮：注入完整模式指令；
- 模式切换后的第一轮：注入完整模式指令；
- 其余轮次：注入精简指令（仅模式名 + 一行核心约束）；
- agent 模式：不注入任何模式提醒。

## Out of Scope

- 不改造 `desk-manger` 角色（仅作为兼容性验证对象，确保不破坏）；
- 不实现 OpenAI 原生 prompt caching（OpenAI 自动缓存由 API 侧决定，本次只做结构分离）；
- 不实现工具描述的"简要 vs 详细"双层 schema（Anthropic tools 段整体可缓存，工具描述保持简洁稳定即可，详细调用信息由 input_schema 承载）；
- 不实现 Git 状态、项目技术栈检测等进阶环境字段（本次仅基础环境 + 预留扩展点，进阶字段后续按需扩展）；
- 不改造 sub-agents / skills / mcp / hooks / slash-command 等空占位模块；
- 不实现 UI 层的缓存命中展示（仅透传到 StreamDoneEvent，UI 渲染留后续）；
- 不引入新的 LLM 服务商适配。

## 版本完成标准

- coding 角色 prompt 按 7 模块拆分完成，内容清理冗余、双重强化关键规则；
- PromptComposer / ContextManager 模块实现并通过单元测试；
- ChatMessage.kind 字段扩展完成，buildMessages 按 kind 分流生效；
- Anthropic provider 的 system+tools cache_control 挂载生效，cache 命中字段解析并透传到 StreamDoneEvent；
- OpenAI provider 结构分离与 kind 归并生效；
- 会话级开关节奏控制生效（首轮/切换完整、其余精简）；
- 现有角色（desk-manger）不改造仍可正常加载运行；
- 端到端验收清单全部通过（见 checklist.md）。
