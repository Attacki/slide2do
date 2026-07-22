# notes for `packages/agent-roles/coding/`

> 最后更新: 2026-07-17 — roles-registry 注册 loadRole 并暴露 loadStableSystem() 助手；app/index.ts 通过 loadStableSystem() 加载稳定段并装配 ContextManager+PromptComposer 传入 Agent（03-coding-prompt-arch 任务 11）

coding 角色：专业编程助手。本目录为非叶级（含 `prompts/`、`sub-agents/` 子目录）。

## 文件索引

### `index.ts`
- **用途**: coding 角色加载器，读取 prompts/ 下模块文件按文件名优先级拼装为一段稳定 system prompt
- **关键导出**: `ROLE_META`（id/name/description）, `loadRole()`（加载稳定段，供 PromptComposer 持有）, `loadSystemPrompt()`（向后兼容薄封装，等价 loadRole）
- **依赖**: `node:fs/promises`, `node:url`, `node:path`
- **消费者**: `packages/agent-roles/roles-registry.ts`（注册到 registry）
- **注意**: prompts/ 文件名前缀（01-/02-/...）控制模块优先级顺序，便于后续插入新模块；稳定段内容在会话内不变，可被 provider 挂载 cache_control；环境信息/模式提醒等动态内容不写入本稳定段（由核心引擎 kind 标签消息注入）

## 子目录（各有独立笔记）

### 子目录 prompts/
- `01-identity.md` — 身份：coding 角色定位、核心能力、技术栈上下文
- `02-behavior.md` — 工作原则：清晰优先/上下文感知/主动追问/最小改动/先理解后修改/事实导向
- `03-tool-usage.md` — 工具使用：专用工具优先（禁止 cat/sed/find/grep 等）、编辑前必须先读、代码引用用文件链接、工具调用节奏（与 agent-tools 工具描述层双重呼应）
- `04-code-standards.md` — 代码规范：通用风格/TypeScript Bun 约定/错误处理/测试/提交规范
- `05-security.md` — 安全边界：硬约束/密钥配置/用户数据/权限尊重
- `06-task-mode.md` — 任务模式：任务拆解/规划与执行分离/会话恢复/失败处理（稳定指导，动态模式提醒由 mode_reminder 消息注入）
- `07-output-style.md` — 输出风格：代码块标注/简洁性/专业风格/响应结构

### 子目录 sub-agents/
- `prompt-templates/review.md` — （空 / 待实现）
- 本子目录为非叶级（含 `prompt-templates/`），待实际有内容时维护 `sub-agents/note.md`
