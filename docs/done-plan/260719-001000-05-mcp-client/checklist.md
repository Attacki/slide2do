# 05-mcp-client 验收清单

> 所有条目可由命令行 / 测试脚本客观验证；Tester 逐条 ✅ / ❌，禁止软化判定。
> 与 `tasks.md` 任务关联以 `[Tn]` 标注。

---

## 配置与类型

- [x] **[T1]** `grep -n "McpServerConfig" packages/agent-types/index.ts` 返回 ≥1 条类型定义
- [x] **[T1]** `grep -n "mcp" packages/agent/utils/config/config-types.ts` 返回 ≥1 条，且 `AgentConfig` 接口包含可选 `mcp?: { servers: McpServerConfig[] }` 字段
- [x] **[T1]** `McpServerConfig` 联合类型可同时描述 `type: 'stdio'`（含 command / args? / env?）与 `type: 'http'`（含 url / headers?）两种形态，且包含通用字段 `name` / `enabled?` / `timeoutMs?`
- [x] **[T1]** `bun --check packages/agent-types/index.ts` 与 `bun --check packages/agent/utils/config/config-types.ts` 均通过

## JSON-RPC 客户端

- [x] **[T2]** `bun --check packages/agent/modules/mcp/json-rpc.ts` 通过
- [x] **[T2]** 单测：发出 `id=1` 的 request，喂入回包 `{jsonrpc:'2.0', id:1, result:{...}}`，对应 Promise resolve 出 result
- [x] **[T2]** 单测：发出 request 后不喂回包，达到超时阈值后 Promise reject（错误标识含 'timeout'），且 `Map` 中该 id 条目被清理（无内存泄漏）
- [x] **[T2]** 单测：喂入 `notification`（无 `id` 字段，仅 `method` + `params`）触发 onNotification 回调，不挂 Promise
- [x] **[T2]** 单测：连续发出 3 个 request，id 严格递增（如 1/2/3），不重复

## 传输层 — Stdio

- [x] **[T3]** `bun --check packages/agent/modules/mcp/transport.ts` 通过
- [x] **[T3]** 单测：spawn 一个 bun 子进程作为 echo server（读 stdin 一行 → 回写一行 JSON），StdioTransport.send 一条 JSON 消息后能在 onMessage 收到回包
- [x] **[T3]** 单测：子进程退出（process.exit）后 StdioTransport 触发 onClose 回调
- [x] **[T3]** 单测：close() 调用后子进程被 kill（proc.killed === true 或退出码非 0）

## 传输层 — HTTP

- [x] **[T4]** `bun --check packages/agent/modules/mcp/transport.ts` 仍通过（含 HttpTransport）
- [x] **[T4]** 单测：mock fetch 返回 `Content-Type: text/event-stream` 响应体，含两条 `data: {...}\n\n`，HttpTransport.onMessage 被触发 2 次，每次得到一条 JSON-RPC
- [x] **[T4]** 单测：mock fetch 返回 `Content-Type: application/json` 单条响应，HttpTransport.onMessage 被触发 1 次
- [x] **[T4]** 单测：首次响应 headers 含 `Mcp-Session-Id: abc123`，第二次 send 时 fetch 调用的 headers 中 `Mcp-Session-Id` 等于 `abc123`
- [x] **[T4]** 单测：构造时传入 `headers: { Authorization: 'Bearer xxx' }`，fetch 调用 headers 中包含该键值对

## MCP 客户端

- [x] **[T5]** `bun --check packages/agent/modules/mcp/mcp-client.ts` 通过
- [x] **[T5]** 单测：mock Transport 喂入 `initialize` 成功响应（含 `protocolVersion: '2024-11-05'`、`serverInfo`、`capabilities`），`McpClient.initialize()` resolve 且不抛异常
- [x] **[T5]** 单测：`initialize` 握手超过 10s 未回包 → reject（错误标识含 'timeout'）
- [x] **[T5]** 单测：`listTools()` 返回的数组每项含 `name` / `description` / `inputSchema` 字段（透传 server 的 `tools/list` 响应）
- [x] **[T5]** 单测：`callTool('echo', {text:'hi'})` 返回 server 的 `content` 数组（如 `[{type:'text', text:'hi'}]`）

## 适配层

- [x] **[T6]** `bun --check packages/agent/modules/mcp/mcp-tool-adapter.ts` 通过
- [x] **[T6]** 单测：远端工具 `{name:'echo', description:'...', inputSchema:{...}}` + serverName='srv1' → adapter.name === `mcp__srv1__echo`
- [x] **[T6]** 单测：adapter.execute 调用 `McpClient.callTool('echo', params)`，server 返回 `content: [{type:'text', text:'hi'}]` → `ToolResult.ok === true` 且 `content` 字符串包含 `'hi'`
- [x] **[T6]** 单测：server 返回 `isError: true` 或抛异常 → `ToolResult.ok === false`，`error` 字段非空
- [x] **[T6]** 单测：adapter.parameters 严格等于远端 `inputSchema`（引用或深比较通过即可）

## 连接池

- [x] **[T7]** `bun --check packages/agent/modules/mcp/mcp-registry.ts` 通过
- [x] **[T7]** 单测：同 server name 第二次 `getClient(name)` 返回与第一次相同的 `McpClient` 实例（引用相等，未重新握手）
- [x] **[T7]** 单测：两个 server 中第一个连接失败（mock initialize reject），第二个成功 → `getTools()` 仅返回第二个 server 的工具，不抛异常
- [x] **[T7]** 单测：`enabled: false` 的 server 不出现在 `getTools()` 结果中，也不建立连接
- [x] **[T7]** 单测：`close()` 调用后所有缓存的 `McpClient` 的 `close()` 被调用一次

## 接入主流程

- [x] **[T8]** `bun --check packages/agent/agent.ts` 与 `bun --check packages/agent/index.ts` 与 `bun --check app/index.ts` 均通过
- [x] **[T8]** `grep -n "mcpPool\|McpConnectionPool" packages/agent/agent.ts` 返回 ≥1 条
- [x] **[T8]** `grep -n "closeMcp\|mcpPool" app/index.ts` 返回 ≥1 条（外层退出时调用清理钩子）
- [x] **[T8]** 单测：构造 Agent 时注入含 1 个 stdio server 的 mcpPool（mock 已握手），`agent.tools.list()` 包含 `mcp__` 前缀工具

## 端到端验证（≥5 条）

- [x] **[T9]** E2E：用 bun 启动一个 stdio mock MCP server（实现 initialize / tools/list / tools/call），Agent 调用其 `echo` 工具，最终 `ToolResult.content` 包含预期回声字符串
- [x] **[T9]** E2E：用 bun 启动一个 http mock MCP server（同上接口），Agent 调用其 `echo` 工具，返回正确结果
- [x] **[T9]** E2E：配置两个 server `srv1` / `srv2` 都暴露同名工具 `echo`，注册后 `ToolRegistry.list()` 同时包含 `mcp__srv1__echo` 与 `mcp__srv2__echo`，两者皆可独立调用
- [x] **[T9]** E2E：stdio server 子进程被外部 kill 后，下次 Agent 调用该 server 工具返回 `{ ok: false, error: ... }` 结构化结果，**不抛异常**，Agent 主循环可继续
- [x] **[T9]** E2E：调用 `agent.closeMcp()` 后，stdio 子进程的 `proc.killed` 为 true 或 `exitCode` 非 null（确认被终止，无僵尸进程）
- [x] **[T9]** E2E：HTTP server 在两次连续工具调用间复用同一 `McpClient` 实例（可通过 server 端记录 initialize 调用次数 == 1 验证，不重连）

## 全量自检

- [x] `bun --check` 对所有新增 / 修改的 `.ts` 文件均通过
- [x] `bun test packages/agent/tests/` 全部测试用例通过（含已有测试不回归）
