# Wuzi Agent

> 一个 TypeScript + Bun 的多角色 AI 助手：摒弃单一臃肿的智能体，转而提供可按需启用的专注型角色适配器（独立 prompt + 适配器）。

## 特性

- **多角色适配**：每个角色拥有独立的 system prompt 与适配器，可一键启用，聚焦特定场景。
- **Provider 无关**：核心引擎抽象模型服务商，新增 Provider 只需放入 `packages/agent/provider`，不侵入主循环。
- **插件化能力**：工具（tools）、MCP、skills 按需动态注册，支持外部接入与单元测试。
- **工程化内置**：内置安全网关、上下文压缩、会话存档与恢复、项目指令加载等生产级能力。
- **交互增强**：提供 TUI 终端交互层，提升命令行使用体验。

## 技术栈

- 语言：[TypeScript](https://www.typescriptlang.org/)（ESM 模块规范）
- 运行时：[Bun](https://bun.sh/)
- 架构：Bun workspaces 单体仓库（monorepo）

## 目录结构

```
packages/
├── agent/        核心引擎：Provider、Agent、配置、记忆、安全、上下文压缩、会话管理
├── agent-roles/  角色与 system prompt 管理
├── agent-tools/  内置工具（独立抽离，便于单元测试与权限校验）
├── agent-skills/ 预编排的技能（特定情境工作流）
├── agent-tui/    终端交互层（TUI）
├── agent-mcp/    独立的 MCP server 服务
└── agent-types/  跨模块通用类型声明
app/              CLI 入口与启动流程
docs/             开发规范文档（闭环、规划、执行、测试等）
```

## 快速开始

### 环境要求

- Bun >= 1.0

### 安装

```bash
bun install
```

### 配置

密钥通过交互式配置或环境变量注入（三级配置：全局 / 项目 / 用户），**严禁硬编码**。首次启动时按引导完成配置即可。

### 运行

```bash
bun start      # 启动交互式 CLI
bun dev        # 监听模式启动（热重载）
```

## 开发

```bash
bun test       # 运行测试
bun check      # 类型检查（tsc --noEmit）
```

### 包映射

| 包名            | 目录             | 说明                         |
| --------------- | ---------------- | ---------------------------- |
| `@wuzi/core`    | `packages/agent` | 核心模块（Provider、Agent、配置、记忆） |
| `@wuzi/roles`   | `packages/agent-roles` | 角色与 system prompt 管理 |
| `@wuzi/tools`   | `packages/agent-tools` | 内置工具               |
| `@wuzi/tui`     | `packages/agent-tui`   | 终端交互层               |
| `@wuzi/types`   | `packages/agent-types` | 通用类型声明           |

## 文档

更详细的开发规范与流程见 [`docs/`](./docs) 目录，包括任务开发闭环、复杂功能规划、执行与测试规范等。

