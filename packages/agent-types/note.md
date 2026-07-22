# notes for `packages/agent-types/`

> 最后更新: 2026-07-21 — 新建本笔记

wuzi-agent 工具系统与配置的共享类型定义。这些类型被「工具实现（@wuzi/tools）」「核心引擎（@wuzi/core 的注册中心 / 执行器 / Provider）」「Security 模块」共同依赖，抽离到独立包避免跨包重复定义。

## 文件索引

### `index.ts`
- **用途**: 全局共享类型定义的唯一来源——工具系统契约 + Security / HITL 契约 + Context 压缩配置 + MCP 类型
- **关键导出**:
  - 工具系统: `JSONSchema`, `ToolContext`, `Tool`, `ToolDefinition`, `ToolCall`, `ToolResult`
  - Security / HITL: `PermissionMode`(`strict|default|permissive`), `RuleAction`(`allow|deny|ask`), `HitlChoice`(`once|session|permanent|cancel`), `SecurityRule`, `SecurityConfig`, `HitlRequest`, `HitlResponse`
  - Context 配置: `ContextConfig`（compactionEnabled / offloadEnabled / singleToolResultThreshold / singleMessageTotalThreshold / windowUsageThreshold / windowHardLimit / keepRecentRounds / summaryMaxTokens / summaryFailureThreshold）
  - MCP: `McpServerBase`, `McpStdioServerConfig`, `McpHttpServerConfig`, `McpServerConfig`, `McpTool`, `JsonRpcError`, `JsonRpcRequest`, `JsonRpcResponse`, `JsonRpcNotification`
- **依赖**: 无项目内依赖（纯类型定义）
- **消费者**: `@wuzi/core`, `@wuzi/tools`, `@wuzi/tui`（HITL）, `app/`
- **注意**: 此包被多包依赖，修改接口需检查所有消费者的编译（`bun --check` 全量）；`ToolResult` 统一成功失败结构（失败用 `ok:false` 表达，便于模型调整）；`Tool.mutates` 字段决定读/写分组（写类串行执行）
