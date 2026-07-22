# AGENTS.md

wuzi-agent：TypeScript + BunJS 多角色 AI 助手。摒弃单一臃肿智能体，提供可按需启用的专注型角色适配器（独立 prompt + 适配器）。

## 文档索引

| 文档 | 职责 |
|------|------|
| `docs/LOOP.md` | 任务开发闭环：分级触发、状态机、三角色、会话恢复 |
| `docs/PLANNING.md` | 复杂功能的 spec / tasks / checklist / progress 四文档规范 |
| `docs/ACTING.md` | Executor 规范：包地图、改动流程、自检命令 |
| `docs/TESTING.md` | Tester 规范：测试编写、测试分层、报告格式、验收约束 |
| `docs/NOTE.md` | `note.md` 知识笔记维护（叶节点裁剪、格式、读取策略） |

## 工作流触发器

用户表达「添加/实现/新增/修改功能」「帮我做 X」「开发 Y」等开发意图时，进入 `docs/LOOP.md` 闭环。**按任务规模分级触发**，简单任务不必走完整三角色流程。

## 设计约束

- **TypeScript**，ESM 模块规范，Bun workspaces 单体仓库
- 核心引擎保持模型服务商无关性：新增 Provider 放入 `packages/agent/provider`，禁止写入主循环
- 配置三层结构（全局 / 项目 / 用户）：密钥通过交互式配置或环境变量注入，严禁硬编码
