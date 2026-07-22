# 05-mcp-client 完成摘要

- **完成时间**: 2026-07-19 00:10
- **归档编号**: 260719-001000
- **涉及包**: `@wuzi/types`、`@wuzi/core`、`app`
- **验证模式**: harness（executor/tester 分离）

## 批量提交历史

| 序号 | Commit | 任务 | Scope | Tester 判定 |
|------|--------|------|-------|-------------|
| 1 | `5081d6b` | 定义 MCP 类型与配置结构 | types / config | ✅ 通过 |
| 2 | `8e0f751` | 实现 JSON-RPC 2.0 客户端 | mcp | ✅ 通过（9/9） |
| 3 | `74b22e5` | 实现 Transport 抽象 + StdioTransport | mcp | ✅ 通过（3/3） |
| 4 | `caee09a` | 实现 HttpTransport（Streamable HTTP） | mcp | ✅ 通过（9/9 + stdio 3/3 无回归） |
| 5 | `8609754` | 实现 McpClient（握手 + tools/list + tools/call） | mcp | ✅ 通过（8/8） |
| 6 | `f74867d` | 实现 McpToolAdapter（远端工具 → Tool 接口） | mcp | ✅ 通过（9/9） |
| 7 | `a70996f` | 实现 McpConnectionPool（连接池化 + 懒加载） | mcp | ✅ 通过（10/10） |
| 8 | `1d40f71` | 接入主流程（Agent 装配时初始化 MCP，退出时关闭） | agent / app | ✅ 通过（6/6） |
| 9 | `553669b` | 端到端验证（mock stdio + http server） | test | ✅ 通过（6/6 E2E） |

## 实现功能总览

### 新增功能

1. **MCP 配置层**：`AgentConfig.mcp.servers` 字段，沿用三级合并机制；`McpServerConfig` 联合类型支持 stdio（command + args + env）与 http（url + headers）两种形态
2. **JSON-RPC 2.0 客户端**（`packages/agent/modules/mcp/json-rpc.ts`）：id 自增 + Map 异步匹配 + 超时清理 + notification 通道
3. **Transport 抽象**（`packages/agent/modules/mcp/transport.ts`）：统一 `start / send / onMessage / onClose / close` 接口
4. **StdioTransport**：`Bun.spawn` 子进程，stdin/stdout 行分隔 JSON-RPC，stderr 转发日志，子进程退出触发 onClose，close() 调用 proc.kill()
5. **HttpTransport**（Streamable HTTP）：fetch POST + SSE / JSON 双模式响应解析 + `Mcp-Session-Id` 缓存回传 + 用户 headers 透传；通过 `fetchFn` 注入支持测试 mock
6. **McpClient**（`packages/agent/modules/mcp/mcp-client.ts`）：三阶段会话 `initialize()`（协议版本 `2024-11-05`，10s 握手超时，幂等）→ `listTools()` → `callTool(name, args)`；`notifications/initialized` 完成握手
7. **McpToolAdapter**（`packages/agent/modules/mcp/mcp-tool-adapter.ts`）：远端工具 → 本地 `Tool` 接口，name 加 `mcp__{server}__{tool}` 前缀消歧；execute 把 content 数组拼接为字符串，isError / 异常映射为 `ok: false`
8. **McpConnectionPool**（`packages/agent/modules/mcp/mcp-registry.ts`，原空文件已填充）：按 server name 懒加载 + 池化缓存（含 inflight Promise 防并发重复握手）；`getTools()` 失败容忍（单个 server 失败不影响其他）；`close()` 幂等
9. **Agent 接入**：`AgentDeps.mcpPool` 可选注入；`Agent.initMcp()` / `Agent.closeMcp()` async 方法（幂等）；`app/index.ts` 按 `config.mcp.servers` 自动创建 pool、注册工具、退出时清理子进程

### 修改内容

1. **`packages/agent-types/index.ts`**：新增 `McpServerBase / McpStdioServerConfig / McpHttpServerConfig / McpServerConfig / McpTool / JsonRpcRequest / JsonRpcResponse / JsonRpcNotification / JsonRpcError` 类型
2. **`packages/agent/utils/config/config-types.ts`**：`AgentConfig` 新增可选 `mcp?: { servers: McpServerConfig[] }` 字段
3. **`packages/agent/agent.ts`**：`AgentDeps` 新增 `mcpPool?`；`Agent` 新增 `initMcp()` / `closeMcp()` 方法
4. **`packages/agent/index.ts`**：导出 `McpConnectionPool` / `McpClient` 等 MCP 模块
5. **`app/index.ts`**：Step 4.5b 创建 McpConnectionPool；Step 5.1 调用 `agent.initMcp()`；`onExit` / `onExitRequest` 钩子调用 `agent.closeMcp()` 后再 `process.exit`

## 端到端验证结论

- checklist 共 33 条验收项，全部通过（Tester 独立判定）。
- `bun --check`：所有新增 / 修改的 `.ts` 实现文件均通过。
- `bun test packages/agent/tests/`：305 通过 / 2 skip / 1 预存失败（`caching-e2e.test.ts > should not inject mode_reminder in agent mode`，stash 验证确认与本次改动无关，属 prompt-composer / reasoning-loop 模块的预存问题）
- 新增测试覆盖：json-rpc（9）+ transport-stdio（3）+ transport-http（9）+ mcp-client（8）+ mcp-tool-adapter（9）+ mcp-registry（10）+ agent-mcp-integration（6）+ mcp-e2e（6）= **共 60 个测试用例，全部通过**

## 遗留问题

- `caching-e2e.test.ts > should not inject mode_reminder in agent mode` 预存失败，建议另起任务排查 `prompt-composer.ts` / `reasoning-loop.ts` 的 agent 模式 mode_reminder 注入逻辑（与 MCP 改动无关，本次未触碰）
- MCP 协议版本固定为 `2024-11-05`，后续如需升级到 `2025-06-18` 等新版，仅需修改 `mcp-client.ts` 中的 `MCP_PROTOCOL_VERSION` 常量与 `initialize` 参数
- 不支持 resources / prompts / sampling 能力（按 Out of Scope 设计，后续可扩展）
- 不实现 OAuth 流程（headers 由用户填 Bearer token，按 Out of Scope 设计）

## 归档位置

`docs/done-plan/260719-001000-05-mcp-client/`
