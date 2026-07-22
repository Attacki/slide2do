/**
 * McpClient — MCP 协议客户端
 *
 * 职责：
 * - 包装 `Transport` + `JsonRpcClient`，对外提供三阶段 API：
 *   1. `initialize()` — 完成协议握手（initialize request + notifications/initialized）
 *   2. `listTools()` — 拉取远端工具列表
 *   3. `callTool(name, args)` — 调用远端工具
 * - `close()` 幂等关闭：先关 jsonRpc（reject 所有 pending），再关 transport
 *
 * 设计要点：
 * - initialize 握手超时独立配置（`initializeTimeoutMs`，缺省 10000ms），不受 `toolCallTimeoutMs` 影响
 * - `initialize()` 幂等：重复调用直接 resolve，不重新握手
 * - 所有异常透传给调用方（reject），不吞错
 */
import type { McpTool } from '@wuzi/types';
import { JsonRpcClient } from './json-rpc.ts';
import type { Transport } from './transport.ts';

/** MCP 协议版本（2024-11-05） */
const MCP_PROTOCOL_VERSION = '2024-11-05';

/** initialize 握手默认超时（毫秒） */
const INITIALIZE_TIMEOUT_MS = 10000;

/** 工具调用默认超时（毫秒） */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 30000;

/** McpClient 构造参数。 */
export interface McpClientOptions {
  /** 工具调用（listTools / callTool）超时（毫秒），缺省 30000 */
  toolCallTimeoutMs?: number;
  /** initialize 握手超时（毫秒），缺省 10000；测试可传短值加速 */
  initializeTimeoutMs?: number;
}

/**
 * `callTool` 返回的结果：透传 server 的 `tools/call` response.result。
 * `content` 数组每项至少含 `type`；文本项附 `text`；其他形态字段以 `[k: string]: unknown` 保留。
 */
export interface McpToolCallResult {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  /** server 标记的调用错误（如工具内部异常），true 时调用方应视为失败 */
  isError?: boolean;
}

/** initialize 请求参数（protocolVersion + capabilities + clientInfo）。 */
interface InitializeParams {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  clientInfo: { name: string; version: string };
}

/** initialize 响应结果（server 返回的协议版本 / 服务端信息 / 能力声明）。 */
interface InitializeResult {
  protocolVersion: string;
  serverInfo?: { name?: string; version?: string };
  capabilities?: Record<string, unknown>;
}

export class McpClient {
  private readonly transport: Transport;
  private readonly jsonRpc: JsonRpcClient;
  private readonly toolCallTimeoutMs: number;
  private readonly initializeTimeoutMs: number;
  private initialized = false;
  private closed = false;

  constructor(transport: Transport, options?: McpClientOptions) {
    this.transport = transport;
    this.toolCallTimeoutMs = options?.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;
    this.initializeTimeoutMs = options?.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS;

    // 装配：jsonRpc 的出站消息走 transport；进站消息由 transport 喂给 jsonRpc
    this.jsonRpc = new JsonRpcClient((message) => {
      this.transport.send(message);
    });
    this.transport.onMessage((raw) => {
      this.jsonRpc.handleMessage(raw);
    });
    this.transport.onClose(() => {
      // transport 关闭 → reject 所有 pending request，防 Promise 永挂
      this.jsonRpc.close();
    });
  }

  /**
   * 发起 MCP 握手：
   * 1. 发送 `initialize` request（带 id，使用 `initializeTimeoutMs` 超时）
   * 2. 等待响应，校验含 `protocolVersion` / `serverInfo` / `capabilities`
   * 3. 成功后发送 `notifications/initialized` notification（无 id）完成握手
   *
   * 幂等：已初始化时直接 resolve，不重新握手。
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const params: InitializeParams = {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'wuzi-agent', version: '0.1.0' },
    };

    const result = (await this.jsonRpc.sendRequest(
      'initialize',
      params,
      this.initializeTimeoutMs,
    )) as InitializeResult | undefined;

    // 响应含 protocolVersion / serverInfo / capabilities 即视为成功
    // （serverInfo / capabilities 允许缺失，仅作存在性检查不抛错）
    if (!result || typeof result.protocolVersion !== 'string') {
      throw new Error('McpClient.initialize: server response missing protocolVersion');
    }

    // 握手成功 → 发送 notifications/initialized（无 id，不挂 Promise）
    this.jsonRpc.sendNotification('notifications/initialized', {});
    this.initialized = true;
  }

  /**
   * 拉取远端工具列表：发送 `tools/list` request，返回 `result.tools` 数组。
   * 每项透传 server 返回的 `name` / `description` / `inputSchema`（不重命名字段）。
   * 使用 `toolCallTimeoutMs` 超时。
   */
  async listTools(): Promise<McpTool[]> {
    const result = (await this.jsonRpc.sendRequest(
      'tools/list',
      undefined,
      this.toolCallTimeoutMs,
    )) as { tools?: McpTool[] } | undefined;

    if (!result || !Array.isArray(result.tools)) {
      throw new Error('McpClient.listTools: server response missing tools array');
    }
    return result.tools;
  }

  /**
   * 调用远端工具：发送 `tools/call` request，参数 `{ name, arguments }`；
   * 返回 `result` 对象（含 `content` 数组与可选 `isError` 标志）。
   * 使用 `toolCallTimeoutMs` 超时。
   */
  async callTool(
    name: string,
    arguments_?: Record<string, unknown>,
  ): Promise<McpToolCallResult> {
    const result = (await this.jsonRpc.sendRequest(
      'tools/call',
      { name, arguments: arguments_ ?? {} },
      this.toolCallTimeoutMs,
    )) as McpToolCallResult | undefined;

    if (!result || !Array.isArray(result.content)) {
      throw new Error('McpClient.callTool: server response missing content array');
    }
    return result;
  }

  /**
   * 关闭客户端：先关 jsonRpc（reject 所有 pending），再关 transport。
   * 幂等：重复调用直接 return。
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.jsonRpc.close();
    } catch {
      // jsonRpc.close 异常静默忽略，确保 transport 仍能关闭
    }
    try {
      await this.transport.close();
    } catch {
      // transport.close 异常静默忽略，避免 Promise 永挂
    }
  }
}
