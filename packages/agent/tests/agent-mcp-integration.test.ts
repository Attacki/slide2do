/**
 * Agent × MCP 集成测试（checklist [T8] 第 4 条）
 *
 * 验证：
 * - Agent 构造时注入 mcpPool（fake，已握手）后，调用 `agent.initMcp()` 会
 *   通过 `mcpPool.getTools()` 拉取工具并批量注册进外部传入的 ToolRegistry
 * - 注册后的 ToolRegistry.list() 包含以 `mcp__` 前缀命名的工具
 * - `agent.initMcp()` 幂等：重复调用不会重注册（registry 数量不翻倍）
 * - `agent.closeMcp()` 调用 `mcpPool.close()` 一次（幂等：重复调用不再触发）
 * - mcpPool 未注入时：initMcp / closeMcp 直接 return，不抛异常
 */
import { test, expect, mock } from 'bun:test';
import { Agent } from '../agent.ts';
import { ToolRegistry } from '../modules/tools/tool-registry.ts';
import type { McpConnectionPool } from '../modules/mcp/mcp-registry.ts';
import type { Tool, ToolResult } from '@wuzi/types';
import type { ILLMProvider, StreamCallback, StreamChatParams } from '../provider/base.ts';
import type { LLMConfig } from '../utils/config/config-types.ts';

/** 空 streamChat 的 fake provider（本测试不触发循环，仅验证 initMcp） */
class EmptyFakeProvider implements ILLMProvider {
  readonly protocol = 'fake';
  async streamChat(_params: StreamChatParams, _onEvent: StreamCallback): Promise<void> {
    /* no-op */
  }
}

const fakeConfig = {
  protocol: 'fake',
  model: 'm',
  base_url: 'http://localhost',
  api_key: 'k',
} as unknown as LLMConfig;

/** 构造一个以 `mcp__` 开头命名的 fake Tool */
function fakeMcpTool(name: string): Tool {
  return {
    name,
    description: `fake mcp tool ${name}`,
    parameters: { type: 'object', properties: {} },
    mutates: false,
    async execute(): Promise<ToolResult> {
      return { ok: true, content: 'fake' };
    },
  };
}

/** 构造一个 fake McpConnectionPool：getTools 返回指定工具列表，close 是 mock */
function fakeMcpPool(tools: Tool[]): {
  pool: McpConnectionPool;
  closeSpy: ReturnType<typeof mock>;
  getToolsSpy: ReturnType<typeof mock>;
} {
  const getToolsSpy = mock(async () => tools);
  const closeSpy = mock(async () => {});
  const pool = { getTools: getToolsSpy, close: closeSpy } as unknown as McpConnectionPool;
  return { pool, closeSpy, getToolsSpy };
}

test('initMcp 把 mcpPool.getTools() 返回的工具批量注册进 ToolRegistry', async () => {
  const fakeTools = [fakeMcpTool('mcp__srv1__read'), fakeMcpTool('mcp__srv1__search')];
  const { pool } = fakeMcpPool(fakeTools);
  const reg = new ToolRegistry();

  const agent = new Agent({
    provider: new EmptyFakeProvider(),
    config: fakeConfig,
    systemPrompt: 'sys',
    tools: reg,
    toolContext: { cwd: process.cwd() },
    mcpPool: pool,
  });

  await agent.initMcp();

  const names = reg.list().map((t) => t.name);
  expect(names).toContain('mcp__srv1__read');
  expect(names).toContain('mcp__srv1__search');
  expect(reg.list().length).toBe(2);
});

test('initMcp 幂等：重复调用不重注册（registry 数量不翻倍）', async () => {
  const fakeTools = [fakeMcpTool('mcp__srv1__read')];
  const { pool, getToolsSpy } = fakeMcpPool(fakeTools);
  const reg = new ToolRegistry();

  const agent = new Agent({
    provider: new EmptyFakeProvider(),
    config: fakeConfig,
    systemPrompt: 'sys',
    tools: reg,
    toolContext: { cwd: process.cwd() },
    mcpPool: pool,
  });

  await agent.initMcp();
  await agent.initMcp();
  await agent.initMcp();

  // getTools 只被调用一次（首次注册后幂等返回）
  expect(getToolsSpy).toHaveBeenCalledTimes(1);
  expect(reg.list().length).toBe(1);
});

test('initMcp 重名工具跳过并继续注册其他工具（不抛错）', async () => {
  // 第一个工具与已注册的本地工具重名 → 应跳过；第二个应成功注册
  const fakeTools = [fakeMcpTool('conflict'), fakeMcpTool('mcp__srv2__unique')];
  const { pool } = fakeMcpPool(fakeTools);
  const reg = new ToolRegistry();
  reg.register(fakeMcpTool('conflict')); // 预先占用 'conflict' 名字

  const agent = new Agent({
    provider: new EmptyFakeProvider(),
    config: fakeConfig,
    systemPrompt: 'sys',
    tools: reg,
    toolContext: { cwd: process.cwd() },
    mcpPool: pool,
  });

  await agent.initMcp();

  const names = reg.list().map((t) => t.name);
  expect(names).toContain('conflict');
  expect(names).toContain('mcp__srv2__unique');
  expect(reg.list().length).toBe(2);
});

test('closeMcp 调用 mcpPool.close() 一次且幂等', async () => {
  const fakeTools = [fakeMcpTool('mcp__srv1__read')];
  const { pool, closeSpy } = fakeMcpPool(fakeTools);

  const agent = new Agent({
    provider: new EmptyFakeProvider(),
    config: fakeConfig,
    systemPrompt: 'sys',
    tools: new ToolRegistry(),
    toolContext: { cwd: process.cwd() },
    mcpPool: pool,
  });

  await agent.closeMcp();
  await agent.closeMcp();
  await agent.closeMcp();

  expect(closeSpy).toHaveBeenCalledTimes(1);
});

test('mcpPool 未注入时：initMcp / closeMcp 直接 return（向后兼容）', async () => {
  const reg = new ToolRegistry();
  const agent = new Agent({
    provider: new EmptyFakeProvider(),
    config: fakeConfig,
    systemPrompt: 'sys',
    tools: reg,
    toolContext: { cwd: process.cwd() },
    // 不传 mcpPool
  });

  await agent.initMcp();
  await agent.closeMcp();

  // 未注入 mcpPool 时，registry 保持空
  expect(reg.list().length).toBe(0);
});

test('initMcp 在 ToolRegistry 未注入时记录 warn 不抛错', async () => {
  const fakeTools = [fakeMcpTool('mcp__srv1__read')];
  const { pool } = fakeMcpPool(fakeTools);

  const agent = new Agent({
    provider: new EmptyFakeProvider(),
    config: fakeConfig,
    systemPrompt: 'sys',
    // 不传 tools
    mcpPool: pool,
  });

  // 不抛错即可
  await agent.initMcp();
});
