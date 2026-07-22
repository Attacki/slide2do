# 05-mcp-client 任务清单

> 执行顺序由上至下；每条任务进入 Phase 1~4 循环，Tester 通过后才能进入下一条。

---

## 任务 1：定义 MCP 类型与配置结构 ✅ 完成

- **任务描述**：在 `@wuzi/types` 新增 MCP 相关类型（`McpServerConfig` / `McpTool` / `JsonRpcRequest` / `JsonRpcResponse` / `JsonRpcNotification`），在 `config-types.ts` 的 `AgentConfig` 新增可选 `mcp?: { servers: McpServerConfig[] }` 字段
- **影响文件**：
  - `packages/agent-types/index.ts`
  - `packages/agent/utils/config/config-types.ts`
- **依赖任务**：无
- **参考定位**：
  - spec.md §配置层
  - `packages/agent/utils/config/config-types.ts` `AgentConfig` 接口
  - `packages/agent/utils/config/config-loader.ts` 三级合并逻辑（本次不改 loader，仅扩展类型）

---

## 任务 2：实现 JSON-RPC 2.0 客户端 ✅ 完成

- **任务描述**：实现 `JsonRpcClient` —— id 自增 + `Map<id, {resolve, reject, timer}>` 异步匹配；支持 request / response / notification（无 id）；request 默认 30s 超时自动 reject 并清理；提供 `sendRequest(method, params)` 与 `sendNotification(method, params)` API
- **影响文件**：
  - `packages/agent/modules/mcp/json-rpc.ts`（新增）
  - `packages/agent/tests/json-rpc.test.ts`（新增）
- **依赖任务**：任务 1
- **参考定位**：spec.md §协议层

---

## 任务 3：实现 Transport 抽象 + StdioTransport ✅ 完成

- **任务描述**：定义 `Transport` 接口（`start / send / onMessage / onClose / close`），实现 `StdioTransport`：`Bun.spawn` 子进程，stdin 写入行分隔 JSON-RPC，stdout 按行解析触发 `onMessage`；stderr 转发到 console.error；子进程退出触发 `onClose`；`close()` 调用 `proc.kill()`
- **影响文件**：
  - `packages/agent/modules/mcp/transport.ts`（新增）
  - `packages/agent/tests/transport-stdio.test.ts`（新增）
- **依赖任务**：任务 1
- **参考定位**：spec.md §传输层

---

## 任务 4：实现 HttpTransport（Streamable HTTP） ✅ 完成

- **任务描述**：在同文件 `transport.ts` 新增 `HttpTransport`：`fetch` POST JSON-RPC 到 `url`（带 `headers` 配置），响应 `Content-Type: text/event-stream` 时按 SSE `data:` 行解析多条 JSON-RPC；响应 `application/json` 时按单条 JSON 解析；首次响应中的 `Mcp-Session-Id` header 在后续请求中回传
- **影响文件**：
  - `packages/agent/modules/mcp/transport.ts`
  - `packages/agent/tests/transport-http.test.ts`（新增）
- **依赖任务**：任务 3
- **参考定位**：spec.md §传输层

---

## 任务 5：实现 McpClient（握手 + tools/list + tools/call） ✅ 完成

- **任务描述**：实现 `McpClient`：包装 `Transport` + `JsonRpcClient`，提供 `initialize()`（协议版本 `2024-11-05`，握手超时 10s）、`listTools()`（返回 `McpTool[]`，含 name / description / inputSchema）、`callTool(name, args)`（返回 server 的 content 数组）、`close()`。tools/list 与 tools/call 使用 server 配置的 `timeoutMs`
- **影响文件**：
  - `packages/agent/modules/mcp/mcp-client.ts`（新增）
  - `packages/agent/tests/mcp-client.test.ts`（新增）
- **依赖任务**：任务 2、任务 3、任务 4
- **参考定位**：spec.md §协议层

---

## 任务 6：实现 McpToolAdapter（远端工具 → Tool 接口） ✅ 完成

- **任务描述**：实现 `McpToolAdapter implements Tool` —— `name` = `mcp__{serverName}__{originalName}`，`parameters` 透传 `inputSchema`，`execute(params, ctx)` 调用 `McpClient.callTool()`，把返回的 `content[]` 拼成字符串作为 `ToolResult.content`；server 报错（`isError: true` 或异常）时返回 `ok: false`
- **影响文件**：
  - `packages/agent/modules/mcp/mcp-tool-adapter.ts`（新增）
  - `packages/agent/tests/mcp-tool-adapter.test.ts`（新增）
- **依赖任务**：任务 5
- **参考定位**：spec.md §适配层

---

## 任务 7：实现 McpConnectionPool（连接池化 + 懒加载） ✅ 完成

- **任务描述**：在已有空文件 `mcp-registry.ts` 实现 `McpConnectionPool`：构造接收 `McpServerConfig[]`；`getClient(name)` 懒加载并握手（成功后缓存）；`getTools(): Tool[]` 遍历所有 enabled server 调用 `listTools()` + `McpToolAdapter` 包装返回（单个 server 失败不影响其他）；`close()` 关闭所有缓存 client；连接失败不抛异常，返回空工具列表并记录错误
- **影响文件**：
  - `packages/agent/modules/mcp/mcp-registry.ts`（空文件，本次填充）
  - `packages/agent/tests/mcp-registry.test.ts`（新增）
- **依赖任务**：任务 6
- **参考定位**：spec.md §池化层

---

## 任务 8：接入主流程（Agent 装配时初始化 MCP，退出时关闭） ✅ 完成

- **任务描述**：在 `AgentDeps` 新增可选 `mcpPool?: McpConnectionPool`，Agent 构造时若注入则把 `pool.getTools()` 注册进 `ToolRegistry`；新增 `Agent.closeMcp()` 方法供外层调用；在 `app/index.ts` 启动流程中按 `config.mcp.servers` 创建 pool 并注入 Agent，进程退出时调用 `closeMcp()`
- **影响文件**：
  - `packages/agent/agent.ts`
  - `packages/agent/index.ts`
  - `app/index.ts`
- **依赖任务**：任务 7
- **参考定位**：spec.md §接入主流程

---

## 任务 9：端到端验证（mock stdio + http server） ✅ 完成

- **任务描述**：在 `packages/agent/tests/mcp-e2e.test.ts` 用 bun 写两个 mock MCP server（stdio + http），覆盖：Agent 调用 stdio server 工具返回正确结果；调用 http server 工具返回正确结果；两个 server 同名工具 `echo` 注册后无冲突（`mcp__srv1__echo` / `mcp__srv2__echo`）；stdio server 子进程被 kill 后下次调用返回 `ok: false` 结构化错误而非抛异常；Agent `closeMcp()` 后子进程被终止
- **影响文件**：
  - `packages/agent/tests/mcp-e2e.test.ts`（新增）
- **依赖任务**：任务 8
- **参考定位**：spec.md §版本完成标准 5~7

---

## Progress
- **当前任务**: (暂无，全部完成)
- **状态**: ✅ 全部完成
- **已完成**: 9 / 9
- **上次操作**: 2026-07-19T00:09 — Task 9 Tester 全部通过（6/6 E2E + 无新增回归），已 commit `553669b`，进入 Phase 5 归档
- **阻塞原因**: (无)
