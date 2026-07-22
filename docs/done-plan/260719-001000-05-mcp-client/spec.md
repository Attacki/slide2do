# 05-mcp-client

## 背景

当前 `packages/agent/modules/mcp/mcp-registry.ts` 为空文件，`packages/agent-mcp/` 仅有一个 Rust files-server 示例，**没有 MCP 客户端实现**。Agent 无法调用任何外部 MCP server 暴露的工具，需要补齐 MCP 客户端能力，使 Agent 能透明地调用外部 server 提供的工具。

## 目标用户

- **角色 / Agent 开发者**：通过配置接入外部 MCP server 扩展 Agent 能力，无需改 Agent 主循环代码
- **终端用户**：在 `config.yaml` 声明 server 列表（命令 / URL / env / 超时），启动时自动连接并把远端工具暴露给模型

## 核心能力清单

1. 按 **JSON-RPC 2.0** 协议与外部 MCP server 双向通信
2. 至少支持两种传输方式：**本地子进程 stdio**、**远程 Streamable HTTP**
3. 一次会话分三阶段：**连接初始化握手（initialize）→ 工具列表发现（tools/list）→ 工具调用（tools/call）**
4. 请求-响应**异步匹配**：每个 request 带 id，回包按 id 关联 Promise；notification（无 id）单独通道
5. **适配层**：把发现到的远端工具包装成 `@wuzi/types` 的 `Tool` 接口，注册进 `ToolRegistry`，Agent 调用时无感
6. **连接池化缓存**：按 server name 复用 `McpClient` 实例，避免每次工具调用都重连
7. 配置声明在 `config.yaml` 的 `mcp.servers` 字段，**沿用现有三级合并机制**（global / project / user）

## 非功能要求

- 单次工具调用超时默认 30s（与现有 `ToolExecutor` 一致），可在 server 配置 `timeoutMs` 覆盖
- `initialize` 握手超时 10s；stdio server 子进程启动超时 30s
- 连接失败 / 子进程崩溃 / HTTP 错误 → 返回结构化 `ToolResult { ok: false }`，**不抛异常中断 Agent 主循环**
- 工具命名冲突通过 **`mcp__{serverName}__{toolName}`** 前缀消歧，模型调用无歧义
- 不污染核心引擎：MCP 客户端代码放在 `packages/agent/modules/mcp/`，通过适配层与 `ToolRegistry` 解耦
- 配置三层合并语义与现有 `LLMConfig` 一致：高层级覆盖低层级同 name 条目，新 name 追加

## 设计骨架

### 配置层

`config.yaml` 顶层新增 `mcp.servers: McpServerConfig[]`，每条 server：

- 通用：`name`（唯一标识）、`enabled?`（缺省 true）、`timeoutMs?`（工具调用超时，缺省 30000）
- stdio：`type: 'stdio'`、`command: string`、`args?: string[]`、`env?: Record<string, string>`
- http：`type: 'http'`、`url: string`、`headers?: Record<string, string>`（用户自行填 Authorization 等）

### 传输层（`packages/agent/modules/mcp/transport.ts`）

- `Transport` 抽象接口：`start() / send(msg) / onMessage(cb) / onClose(cb) / close()`
- `StdioTransport`：`Bun.spawn` 子进程，stdin 写入行分隔 JSON-RPC，stdout 行分隔解析；stderr 转发到日志
- `HttpTransport`：`fetch` POST JSON-RPC 到 `url`，响应解析 SSE 流（`text/event-stream`）或单条 JSON；维护 `Mcp-Session-Id` header

### 协议层

- `JsonRpcClient`（`json-rpc.ts`）：id 自增 + `Map<id, {resolve, reject, timer}>`，超时清理；notification 单独回调
- `McpClient`（`mcp-client.ts`）：包装 `Transport` + `JsonRpcClient`，实现 `initialize()` / `listTools()` / `callTool()`；MCP 协议版本 `2024-11-05`

### 池化层（`packages/agent/modules/mcp/mcp-registry.ts`）

- `McpConnectionPool`：按 server name 缓存 `McpClient`，懒加载（首次 `getClient(name)` 时握手并缓存）
- `getTools(): Tool[]`：遍历所有 enabled server，调用 `listTools()` 后通过 adapter 包装返回
- `close()`：关闭所有缓存的 client，释放子进程 / HTTP 连接
- 失败容忍：单个 server 连接失败不影响其他 server，错误记录后该 server 工具不注册

### 适配层（`packages/agent/modules/mcp/mcp-tool-adapter.ts`）

- `McpToolAdapter` 实现 `Tool` 接口
- `name` = `mcp__{serverName}__{originalToolName}`
- `parameters` 直接透传远端 `inputSchema`
- `execute(params, ctx)`：调用 `McpClient.callTool(originalName, params)`，把返回的 `content[]` 拼成 `ToolResult.content` 字符串；server 报错时 `ok: false`

### 接入主流程

- `Agent` 装配时（`agent.ts`）按 `config.mcp.servers` 创建 `McpConnectionPool`
- 调用 `pool.getTools()` 把工具批量注册进 `ToolRegistry`（注册时机：Agent 构造完成后、首次 `processInput` 前）
- `Agent` 新增 `closeMcp()` 方法，由外层 `app/index.ts` 在退出时调用，确保 stdio 子进程被 kill

## Out of Scope

- **不实现 MCP server 端**：`packages/agent-mcp/` 的 Rust files-server 维持现状
- **不支持旧版 SSE 传输**：已被 Streamable HTTP 取代，仅支持 stdio + Streamable HTTP
- **不支持 resources / prompts / sampling**：本次仅做 tools 能力
- **不实现 OAuth 流程**：headers 由用户填 Bearer token
- **不做跨会话连接持久化**：每次进程启动重新建立连接
- **不做工具调用结果缓存**：每次都走真实 MCP 调用
- **不做动态 server 增删**：server 列表在启动时固定，运行时新增 / 删除 server 不在本次范围

## 版本完成标准

1. 在 `config.yaml` 声明 stdio + http server 后，Agent 启动时 `ToolRegistry.list()` 包含 `mcp__` 前缀工具
2. 模型调用 MCP 工具时与调用本地工具行为一致（返回结构化 `ToolResult`），主循环无感知
3. 同一 server 多次工具调用复用同一 `McpClient`（不重连）
4. 单元测试覆盖：JSON-RPC id 匹配 / 超时、stdio 与 http 传输、adapter 包装、pool 缓存复用、连接失败容忍
5. 端到端：mock 一个 stdio MCP server（用 bun 写），Agent 调用其工具返回正确结果
6. 端到端：mock 一个 http MCP server（用 bun 写），同上
7. 端到端：两个 server 暴露同名工具，注册后无冲突；server 崩溃后下次调用返回结构化错误而非抛异常
