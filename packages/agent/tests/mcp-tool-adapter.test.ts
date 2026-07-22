/**
 * McpToolAdapter 单元测试
 *
 * 使用 fake McpClient（仅实现 callTool）验证：
 * - name 格式：`mcp__{serverName}__{originalName}`
 * - parameters / description 透传
 * - execute 成功 / 多 content / 非 text item / isError / 异常 等场景
 * - toMcpToolName 辅助函数
 */
import { test, expect } from 'bun:test';
import type { McpTool, ToolContext } from '@wuzi/types';
import { McpToolAdapter, toMcpToolName } from '../modules/mcp/mcp-tool-adapter.ts';
import type { McpClient, McpToolCallResult } from '../modules/mcp/mcp-client.ts';

/** 构造 fake McpClient：注入预设的 callTool 行为（不依赖真实 McpClient） */
function fakeClient(impl: {
  callTool: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<McpToolCallResult>;
}): McpClient {
  return impl as unknown as McpClient;
}

/** 构造测试用 McpTool */
function makeTool(overrides: Partial<McpTool> = {}): McpTool {
  return {
    name: 'echo',
    description: 'Echo the input text',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    ...overrides,
  };
}

const ctx: ToolContext = { cwd: '/tmp' };

test('name 格式：`mcp__{serverName}__{originalName}`', () => {
  const client = fakeClient({
    callTool: async () => ({ content: [] }),
  });
  const adapter = new McpToolAdapter({
    serverName: 'srv1',
    tool: makeTool({ name: 'echo' }),
    client,
  });
  expect(adapter.name).toBe('mcp__srv1__echo');
});

test('execute 成功：调用 client.callTool(originalName, params) → ok=true, content=hi', async () => {
  let capturedName: string | undefined;
  let capturedArgs: Record<string, unknown> | undefined;
  const client = fakeClient({
    callTool: async (name, args) => {
      capturedName = name;
      capturedArgs = args;
      return { content: [{ type: 'text', text: 'hi' }] };
    },
  });
  const adapter = new McpToolAdapter({
    serverName: 'srv1',
    tool: makeTool({ name: 'echo' }),
    client,
  });
  const params = { text: 'hi' };
  const result = await adapter.execute(params, ctx);
  // 校验调用 callTool 时传入的是原始工具名（不带 mcp__ 前缀）与原样 params
  expect(capturedName).toBe('echo');
  expect(capturedArgs).toEqual(params);
  // 校验成功结果
  expect(result.ok).toBe(true);
  expect(result.content).toBe('hi');
});

test('execute 多个 content item：用 \\n 连接', async () => {
  const client = fakeClient({
    callTool: async () => ({
      content: [
        { type: 'text', text: 'line1' },
        { type: 'text', text: 'line2' },
      ],
    }),
  });
  const adapter = new McpToolAdapter({
    serverName: 'srv1',
    tool: makeTool(),
    client,
  });
  const result = await adapter.execute({}, ctx);
  expect(result.ok).toBe(true);
  expect(result.content).toBe('line1\nline2');
});

test('execute 非 text item：用 JSON.stringify 兜底', async () => {
  const imageItem = { type: 'image', data: 'base64...', mimeType: 'image/png' };
  const client = fakeClient({
    callTool: async () => ({ content: [imageItem] }),
  });
  const adapter = new McpToolAdapter({
    serverName: 'srv1',
    tool: makeTool(),
    client,
  });
  const result = await adapter.execute({}, ctx);
  expect(result.ok).toBe(true);
  expect(result.content).toBe(JSON.stringify(imageItem));
});

test('execute server 返回 isError=true → ok=false, error=mcp_tool_error, content=拼接字符串', async () => {
  const client = fakeClient({
    callTool: async () => ({
      content: [{ type: 'text', text: 'err' }],
      isError: true,
    }),
  });
  const adapter = new McpToolAdapter({
    serverName: 'srv1',
    tool: makeTool(),
    client,
  });
  const result = await adapter.execute({}, ctx);
  expect(result.ok).toBe(false);
  expect(result.error).toBe('mcp_tool_error');
  expect(result.content).toBe('err');
});

test('execute client.callTool 抛异常 → ok=false, error=mcp_call_failed, content 含异常 message', async () => {
  const client = fakeClient({
    callTool: async () => {
      throw new Error('boom');
    },
  });
  const adapter = new McpToolAdapter({
    serverName: 'srv1',
    tool: makeTool(),
    client,
  });
  const result = await adapter.execute({}, ctx);
  expect(result.ok).toBe(false);
  expect(result.error).toBe('mcp_call_failed');
  expect(result.content).toContain('boom');
});

test('parameters 透传：adapter.parameters === tool.inputSchema（引用相等）', () => {
  const tool = makeTool();
  const client = fakeClient({
    callTool: async () => ({ content: [] }),
  });
  const adapter = new McpToolAdapter({
    serverName: 'srv1',
    tool,
    client,
  });
  expect(adapter.parameters).toBe(tool.inputSchema);
});

test('description 透传：adapter.description === tool.description', () => {
  const tool = makeTool({ description: 'custom desc' });
  const client = fakeClient({
    callTool: async () => ({ content: [] }),
  });
  const adapter = new McpToolAdapter({
    serverName: 'srv1',
    tool,
    client,
  });
  expect(adapter.description).toBe('custom desc');
});

test('toMcpToolName 辅助函数：返回 mcp__{server}__{original}', () => {
  expect(toMcpToolName('srv1', 'echo')).toBe('mcp__srv1__echo');
  expect(toMcpToolName('fs', 'read_file')).toBe('mcp__fs__read_file');
});
