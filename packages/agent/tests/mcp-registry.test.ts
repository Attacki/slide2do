/**
 * McpConnectionPool 单元测试
 *
 * 使用 factory 注入点 + fake transport / fake McpClient 验证：
 * - 池化复用：同 name 第二次 getClient 返回同一 McpClient 实例（引用相等）
 * - 失败容忍：两个 server，第一个 initialize reject → getTools 仅返回第二个的工具，不抛异常
 * - enabled=false：该 server 不在 getTools 结果中、getClient 不被调用
 * - close：所有缓存的 McpClient 的 close 被调用一次（幂等）
 * - 并发 getClient：同一 server 同时两次 getClient 调用，仅触发一次 initialize
 * - 重名 server：构造时两个同名 config，后者覆盖前者（console.warn 不抛错）
 */
import { test, expect, mock, spyOn } from 'bun:test';
import type { McpServerConfig, McpTool } from '@wuzi/types';
import {
  McpConnectionPool,
  createMcpConnectionPool,
} from '../modules/mcp/mcp-registry.ts';
import type { McpClient, McpToolCallResult } from '../modules/mcp/mcp-client.ts';
import type { Transport } from '../modules/mcp/transport.ts';

/** fake Transport：仅记录 start / close 调用，不做实际 IO */
class FakeTransport implements Transport {
  readonly startCalls = mock(() => {});
  readonly closeCalls = mock(() => {});

  start(): void {
    this.startCalls();
  }
  close(): void {
    this.closeCalls();
  }
  send(): void {}
  onMessage(): void {}
  onClose(): void {}
}

/** fake McpClient 工厂：注入 initialize / listTools / close 行为，便于 spy */
function fakeClient(impl: {
  initialize?: () => Promise<void>;
  listTools?: () => Promise<McpTool[]>;
  close?: () => Promise<void>;
  callTool?: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<McpToolCallResult>;
}): { client: McpClient; spies: { initialize: ReturnType<typeof mock>; listTools: ReturnType<typeof mock>; close: ReturnType<typeof mock> } } {
  const initialize = mock(impl.initialize ?? (async () => {}));
  const listTools = mock(impl.listTools ?? (async () => [] as McpTool[]));
  const close = mock(impl.close ?? (async () => {}));
  const callTool = mock(
    impl.callTool ??
      (async () => ({ content: [] }) as McpToolCallResult),
  );
  const client = { initialize, listTools, close, callTool } as unknown as McpClient;
  return { client, spies: { initialize, listTools, close } };
}

/** 构造 stdio 形态测试 config */
function stdioConfig(
  name: string,
  overrides: Partial<McpServerConfig> = {},
): McpServerConfig {
  return {
    type: 'stdio',
    name,
    command: 'fake',
    ...overrides,
  } as McpServerConfig;
}

test('池化复用：同 name 第二次 getClient 返回同一 McpClient 实例（引用相等，未重新握手）', async () => {
  const transport = new FakeTransport();
  const { client, spies } = fakeClient({});
  const factory = mock(() => ({ transport, client }));

  const pool = new McpConnectionPool([stdioConfig('srv1')], factory);

  const c1 = await pool.getClient('srv1');
  const c2 = await pool.getClient('srv1');

  expect(c1).toBe(client);
  expect(c2).toBe(client);
  // factory 仅调用一次（第二次命中缓存，不重新握手）
  expect(factory).toHaveBeenCalledTimes(1);
  // initialize 仅调用一次
  expect(spies.initialize).toHaveBeenCalledTimes(1);
  // transport.start 也仅调用一次
  expect(transport.startCalls).toHaveBeenCalledTimes(1);
});

test('失败容忍：第一个 server initialize reject → getTools 仅返回第二个的工具，不抛异常', async () => {
  const transport1 = new FakeTransport();
  const { client: client1, spies: spies1 } = fakeClient({
    initialize: async () => {
      throw new Error('init failed');
    },
  });
  const transport2 = new FakeTransport();
  const toolB: McpTool = {
    name: 'toolB',
    description: 'B tool',
    inputSchema: { type: 'object' },
  };
  const { client: client2 } = fakeClient({
    listTools: async () => [toolB],
  });

  const factory = mock((config: McpServerConfig) => {
    if (config.name === 'srv1') return { transport: transport1, client: client1 };
    return { transport: transport2, client: client2 };
  });

  const pool = new McpConnectionPool(
    [stdioConfig('srv1'), stdioConfig('srv2')],
    factory,
  );

  // 不应抛异常
  const tools = await pool.getTools();

  // 仅返回第二个 server 的工具
  expect(tools).toHaveLength(1);
  expect(tools[0]!.name).toBe('mcp__srv2__toolB');
  // 第一个 server 失败后调用 close 清理
  expect(spies1.close).toHaveBeenCalledTimes(1);
  // 第二个 server 的 close 在 getTools 期间不应被调用（连接仍缓存）
  // 不强校验 client2.close 次数，仅验证返回结果
});

test('enabled=false：该 server 不在 getTools 结果中，也不建立连接', async () => {
  const transport = new FakeTransport();
  const toolA: McpTool = {
    name: 'toolA',
    description: 'A tool',
    inputSchema: { type: 'object' },
  };
  const { client } = fakeClient({ listTools: async () => [toolA] });
  const factory = mock(() => ({ transport, client }));

  const pool = new McpConnectionPool(
    [
      stdioConfig('disabled', { enabled: false }),
      stdioConfig('enabled', { enabled: true }),
    ],
    factory,
  );

  const tools = await pool.getTools();

  // 仅 enabled server 的工具
  expect(tools).toHaveLength(1);
  expect(tools[0]!.name).toBe('mcp__enabled__toolA');
  // factory 仅被调用一次（跳过 disabled）
  expect(factory).toHaveBeenCalledTimes(1);
  expect(factory.mock.calls[0]![0]).toMatchObject({ name: 'enabled' });
});

test('close：所有缓存的 McpClient 的 close 被调用一次；幂等', async () => {
  const transport1 = new FakeTransport();
  const transport2 = new FakeTransport();
  const { client: client1, spies: spies1 } = fakeClient({
    listTools: async () => [],
  });
  const { client: client2, spies: spies2 } = fakeClient({
    listTools: async () => [],
  });

  const factory = mock((config: McpServerConfig) => {
    if (config.name === 'srv1') return { transport: transport1, client: client1 };
    return { transport: transport2, client: client2 };
  });

  const pool = new McpConnectionPool(
    [stdioConfig('srv1'), stdioConfig('srv2')],
    factory,
  );

  // 触发两个 server 的握手并缓存
  await pool.getTools();

  // 关闭
  await pool.close();
  expect(spies1.close).toHaveBeenCalledTimes(1);
  expect(spies2.close).toHaveBeenCalledTimes(1);

  // 幂等：再次调用不重复 close
  await pool.close();
  expect(spies1.close).toHaveBeenCalledTimes(1);
  expect(spies2.close).toHaveBeenCalledTimes(1);
});

test('并发 getClient：同一 server 同时两次 getClient 调用，仅触发一次 initialize', async () => {
  const transport = new FakeTransport();
  const { client, spies } = fakeClient({
    initialize: async () => {
      // 微小延迟模拟握手耗时，使两次 getClient 真正并发
      await new Promise((r) => setTimeout(r, 10));
    },
  });
  const factory = mock(() => ({ transport, client }));

  const pool = new McpConnectionPool([stdioConfig('srv1')], factory);

  // 并发调用
  const [c1, c2] = await Promise.all([
    pool.getClient('srv1'),
    pool.getClient('srv1'),
  ]);

  expect(c1).toBe(client);
  expect(c2).toBe(client);
  // factory 仅调用一次（inflight Promise 缓存命中）
  expect(factory).toHaveBeenCalledTimes(1);
  // initialize 仅调用一次
  expect(spies.initialize).toHaveBeenCalledTimes(1);
});

test('重名 server：构造时两个同名 config，后者覆盖前者（console.warn 不抛错）', async () => {
  const warnSpy = spyOn(console, 'warn');

  const transport = new FakeTransport();
  const { client } = fakeClient({});
  const factory = mock(() => ({ transport, client }));

  const pool = new McpConnectionPool(
    [stdioConfig('dup', { command: 'first' }), stdioConfig('dup', { command: 'second' })],
    factory,
  );

  // 调用 getClient 应使用后入的 config（command='second'）
  await pool.getClient('dup');

  expect(factory).toHaveBeenCalledTimes(1);
  expect(factory.mock.calls[0]![0]).toMatchObject({
    name: 'dup',
    command: 'second',
  });
  // 触发了 warn
  expect(warnSpy).toHaveBeenCalledTimes(1);
  expect(String(warnSpy.mock.calls[0]![0])).toContain('duplicate');
  expect(String(warnSpy.mock.calls[0]![0])).toContain('dup');

  warnSpy.mockRestore();
});

test('createMcpConnectionPool 便捷构造：返回 McpConnectionPool 实例', async () => {
  const transport = new FakeTransport();
  const { client } = fakeClient({});
  const factory = mock(() => ({ transport, client }));

  const pool = createMcpConnectionPool([stdioConfig('srv1')], factory);

  expect(pool).toBeInstanceOf(McpConnectionPool);
  const c = await pool.getClient('srv1');
  expect(c).toBe(client);
});

test('getClient 不存在的 name：返回 undefined，不抛异常', async () => {
  const factory = mock(() => ({ transport: new FakeTransport(), client: fakeClient({}).client }));
  const pool = new McpConnectionPool([], factory);

  const c = await pool.getClient('nonexistent');
  expect(c).toBeUndefined();
  expect(factory).toHaveBeenCalledTimes(0);
});

test('transport.start 抛错：getClient 返回 undefined，client.close 被调用清理', async () => {
  const transport = new FakeTransport();
  // 覆盖 start 使其抛错
  transport.startCalls.mockImplementation(() => {
    throw new Error('start boom');
  });
  const { client, spies } = fakeClient({});
  const factory = mock(() => ({ transport, client }));

  const pool = new McpConnectionPool([stdioConfig('srv1')], factory);

  const c = await pool.getClient('srv1');
  expect(c).toBeUndefined();
  // 失败后调用 close 清理
  expect(spies.close).toHaveBeenCalledTimes(1);
});

test('listTools 抛错：getTools 跳过该 server，其他 server 工具仍返回', async () => {
  const transport1 = new FakeTransport();
  const transport2 = new FakeTransport();
  const toolB: McpTool = {
    name: 'toolB',
    description: 'B tool',
    inputSchema: { type: 'object' },
  };
  const { client: client1, spies: spies1 } = fakeClient({
    listTools: async () => {
      throw new Error('listTools boom');
    },
  });
  const { client: client2 } = fakeClient({
    listTools: async () => [toolB],
  });

  const factory = mock((config: McpServerConfig) => {
    if (config.name === 'srv1') return { transport: transport1, client: client1 };
    return { transport: transport2, client: client2 };
  });

  const pool = new McpConnectionPool(
    [stdioConfig('srv1'), stdioConfig('srv2')],
    factory,
  );

  const tools = await pool.getTools();

  // srv1 listTools 失败被跳过，仅 srv2 的工具
  expect(tools).toHaveLength(1);
  expect(tools[0]!.name).toBe('mcp__srv2__toolB');
  // listTools 确实被调用过一次（即使失败）
  expect(spies1.listTools).toHaveBeenCalledTimes(1);
});
