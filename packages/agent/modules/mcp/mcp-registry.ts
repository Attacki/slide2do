/**
 * McpConnectionPool — 多 MCP Server 连接池化与懒加载
 *
 * 职责：
 * - 按 server name 缓存 McpClient 实例，首次 `getClient(name)` 时握手并缓存
 * - 并发 getClient：用 inflight Promise 缓存避免同一 server 重复握手
 * - 失败容忍：单个 server 连接 / 拉工具失败不影响其他 server
 * - `close()` 关闭所有缓存的 client，释放子进程 / HTTP 连接；幂等
 *
 * 设计要点：
 * - 构造参数可选 `factory` 注入点，测试时传入 mock factory 返回 fake transport + fake McpClient；
 *   生产代码不传 factory，使用默认实现（按 config.type 构造 StdioTransport / HttpTransport + McpClient）
 * - enabled 判断：`config.enabled === false` 才跳过；`undefined` / `true` 都视为启用
 * - 重名 server：后入覆盖前者，console.warn 提示
 */
import type { McpServerConfig, Tool } from '@wuzi/types';
import { McpClient } from './mcp-client.ts';
import { McpToolAdapter } from './mcp-tool-adapter.ts';
import { HttpTransport, StdioTransport } from './transport.ts';
import type { Transport } from './transport.ts';

/**
 * factory 注入点：按 config 创建 transport + client。
 * 测试可传 mock 实现返回 fake transport + fake McpClient；生产代码使用 defaultFactory。
 */
export type McpClientFactory = (config: McpServerConfig) => {
  transport: Transport;
  client: McpClient;
};

/**
 * 默认 factory：按 config.type 创建 StdioTransport / HttpTransport + McpClient。
 * - stdio → `new StdioTransport({ command, args, env })`
 * - http  → `new HttpTransport({ url, headers })`
 * - 统一通过 `new McpClient(transport, { toolCallTimeoutMs: config.timeoutMs })` 装配
 */
function defaultFactory(config: McpServerConfig): {
  transport: Transport;
  client: McpClient;
} {
  let transport: Transport;
  if (config.type === 'stdio') {
    transport = new StdioTransport({
      command: config.command,
      args: config.args,
      env: config.env,
    });
  } else {
    transport = new HttpTransport({
      url: config.url,
      headers: config.headers,
    });
  }
  const client = new McpClient(transport, {
    toolCallTimeoutMs: config.timeoutMs,
  });
  return { transport, client };
}

export class McpConnectionPool {
  /** server 配置表（name → config；重名后者覆盖前者） */
  private readonly servers: Map<string, McpServerConfig> = new Map();
  /** 已握手的 client 缓存（name → McpClient） */
  private readonly clients: Map<string, McpClient> = new Map();
  /** 进行中的握手 Promise 缓存（防止并发 getClient 重复握手） */
  private readonly inflight: Map<string, Promise<McpClient | undefined>> = new Map();
  /** factory 注入点（缺省 defaultFactory） */
  private readonly factory: McpClientFactory;

  constructor(servers: McpServerConfig[], factory?: McpClientFactory) {
    this.factory = factory ?? defaultFactory;
    for (const config of servers) {
      if (this.servers.has(config.name)) {
        console.warn(
          `[mcp:pool] duplicate server name "${config.name}", later config overrides earlier one`,
        );
      }
      this.servers.set(config.name, config);
    }
  }

  /**
   * 获取指定 server 的 McpClient：
   * - 命中缓存直接返回
   * - 否则按 config 调用 factory 创建 transport + client
   * - 调用 `transport.start()` + `client.initialize()`；成功后缓存并返回
   * - 失败（transport.start 抛错或 initialize reject）→ 调用 `client.close()` 清理，
   *   不抛异常，记录 `console.error('[mcp:pool] ...')`，返回 `undefined`
   * - 同一 server 并发 getClient 共享 inflight Promise，避免重复握手
   */
  async getClient(name: string): Promise<McpClient | undefined> {
    const cached = this.clients.get(name);
    if (cached) return cached;

    const existing = this.inflight.get(name);
    if (existing) return existing;

    const promise = this.createClient(name);
    this.inflight.set(name, promise);
    try {
      const client = await promise;
      if (client) {
        this.clients.set(name, client);
      }
      return client;
    } finally {
      this.inflight.delete(name);
    }
  }

  /** 内部：创建并握手一个 client；失败时清理并返回 undefined（不抛异常） */
  private async createClient(name: string): Promise<McpClient | undefined> {
    const config = this.servers.get(name);
    if (!config) {
      console.error(`[mcp:pool] server "${name}" not found`);
      return undefined;
    }

    let transport: Transport;
    let client: McpClient;
    try {
      const created = this.factory(config);
      transport = created.transport;
      client = created.client;
    } catch (e) {
      console.error(
        `[mcp:pool] factory failed for server "${name}": ${(e as Error).message}`,
      );
      return undefined;
    }

    try {
      await transport.start();
    } catch (e) {
      console.error(
        `[mcp:pool] transport.start failed for server "${name}": ${(e as Error).message}`,
      );
      await safeClose(client);
      return undefined;
    }

    try {
      await client.initialize();
    } catch (e) {
      console.error(
        `[mcp:pool] initialize failed for server "${name}": ${(e as Error).message}`,
      );
      await safeClose(client);
      return undefined;
    }

    return client;
  }

  /**
   * 拉取所有 enabled server 的工具，通过 McpToolAdapter 包装为本地 Tool：
   * - 遍历所有 `enabled !== false` 的 server
   * - 调用 `getClient(name)`；返回 undefined → 跳过该 server
   * - 调用 `client.listTools()`；失败 → 跳过该 server 并记日志
   * - 每个 tool 用 `new McpToolAdapter({ serverName, tool, client })` 包装
   * - 累积所有 server 的工具返回；单个 server 失败不影响其他
   */
  async getTools(): Promise<Tool[]> {
    const tools: Tool[] = [];
    for (const [name, config] of this.servers) {
      if (config.enabled === false) continue;

      const client = await this.getClient(name);
      if (!client) continue;

      let mcpTools;
      try {
        mcpTools = await client.listTools();
      } catch (e) {
        console.error(
          `[mcp:pool] listTools failed for server "${name}": ${(e as Error).message}`,
        );
        continue;
      }

      for (const tool of mcpTools) {
        tools.push(new McpToolAdapter({ serverName: name, tool, client }));
      }
    }
    return tools;
  }

  /**
   * 关闭所有缓存的 client 并清空缓存；幂等。
   * 单个 client.close 异常被捕获记日志，不影响其他 client 关闭。
   */
  async close(): Promise<void> {
    const clients = Array.from(this.clients.values());
    this.clients.clear();
    await Promise.all(clients.map((c) => safeClose(c)));
  }
}

/** 安全关闭 client：吞异常，避免 Promise 永挂 */
async function safeClose(client: McpClient): Promise<void> {
  try {
    await client.close();
  } catch (e) {
    console.error(`[mcp:pool] close failed: ${(e as Error).message}`);
  }
}

/** 便捷构造：创建 McpConnectionPool */
export function createMcpConnectionPool(
  servers: McpServerConfig[],
  factory?: McpClientFactory,
): McpConnectionPool {
  return new McpConnectionPool(servers, factory);
}
