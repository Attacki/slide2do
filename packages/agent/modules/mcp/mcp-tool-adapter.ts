/**
 * McpToolAdapter — 把远端 MCP 工具包装成本地 Tool 接口
 *
 * 职责：
 * - 将 McpClient 拉取的 McpTool 适配为本地 Tool 接口
 * - 调用时通过 client.callTool 转发，把返回的 content 数组拼成字符串
 * - 把 server 的 isError 标志与 callTool 异常统一映射为 ToolResult { ok: false }
 *
 * 设计要点：
 * - name 加 `mcp__{serverName}__` 前缀，避免与本地工具命名冲突
 * - mutates 固定 false：远端工具副作用不可知，但默认按读类处理（与 ToolRegistry 串行写类策略不冲突）
 * - 不传 ctx.signal 给 client（McpClient 暂不支持 abort）
 * - 不持有 McpClient 生命周期（由上层 McpConnectionPool 等管理）
 */
import type { JSONSchema, McpTool, Tool, ToolContext, ToolResult } from '@wuzi/types';
import type { McpClient, McpToolCallResult } from './mcp-client.ts';

/** McpToolAdapter 构造参数。 */
export interface McpToolAdapterOptions {
  /** MCP server 名称（用于生成工具名前缀） */
  serverName: string;
  /** 远端工具描述（来自 McpClient.listTools） */
  tool: McpTool;
  /** 已握手的 McpClient 实例（adapter 不负责生命周期） */
  client: McpClient;
}

/**
 * 生成 MCP 工具的本地名称：`mcp__{serverName}__{originalName}`。
 * 供 McpToolAdapter / McpConnectionPool 等复用，保证命名一致。
 */
export function toMcpToolName(serverName: string, originalName: string): string {
  return `mcp__${serverName}__${originalName}`;
}

/**
 * 把 MCP content 数组拼接为字符串：
 * - type='text' 且 text 字段为 string → 用 text
 * - 其他类型（含 text 但 text 缺失）→ JSON.stringify 兜底
 * - 多个 item 用 `\n` 连接；空数组 → 空字符串
 */
function concatContent(content: McpToolCallResult['content']): string {
  return content
    .map((item) => {
      if (item.type === 'text' && typeof item.text === 'string') {
        return item.text;
      }
      return JSON.stringify(item);
    })
    .join('\n');
}

/**
 * McpToolAdapter — 实现 Tool 接口，把远端 MCP 工具暴露为本地工具。
 *
 * 每次 execute 调用 client.callTool(originalName, params)，根据返回的 isError 标志
 * 与异常情况映射为 ToolResult。content 数组按 concatContent 规则拼接为字符串。
 */
export class McpToolAdapter implements Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: JSONSchema;
  readonly timeoutMs?: number;
  /** 远端工具副作用不可知，默认按读类处理 */
  readonly mutates = false;
  private readonly client: McpClient;
  private readonly originalName: string;

  constructor(options: McpToolAdapterOptions) {
    this.name = toMcpToolName(options.serverName, options.tool.name);
    this.description = options.tool.description;
    this.parameters = options.tool.inputSchema;
    this.client = options.client;
    this.originalName = options.tool.name;
  }

  async execute(
    params: Record<string, unknown>,
    _ctx: ToolContext,
  ): Promise<ToolResult> {
    try {
      const result = await this.client.callTool(this.originalName, params);
      const content = concatContent(result.content);
      if (result.isError === true) {
        return { ok: false, content, error: 'mcp_tool_error' };
      }
      return { ok: true, content };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, content: message, error: 'mcp_call_failed' };
    }
  }
}
