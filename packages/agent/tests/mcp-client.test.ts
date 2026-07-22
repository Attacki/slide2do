/**
 * McpClient 单元测试
 *
 * 使用 MockTransport（实现 Transport 接口）记录 send 消息，并通过 feed() 把
 * JSON-RPC 响应回喂给 McpClient，验证 initialize / listTools / callTool / close 行为。
 */
import { test, expect } from 'bun:test';
import type { JsonRpcNotification, JsonRpcRequest } from '@wuzi/types';
import { McpClient } from '../modules/mcp/mcp-client.ts';
import type { Transport } from '../modules/mcp/transport.ts';

type OutboundMessage = JsonRpcRequest | JsonRpcNotification;

/** 简单 fake Transport：记录 send 消息，支持 feed() 回喂响应字符串 */
class MockTransport implements Transport {
  readonly sent: OutboundMessage[] = [];
  private messageCb: ((raw: string) => void) | null = null;
  private closeCb: (() => void) | null = null;
  closed = false;

  start(): void {}

  send(message: OutboundMessage): void {
    this.sent.push(message);
  }

  onMessage(cb: (raw: string) => void): void {
    this.messageCb = cb;
  }

  onClose(cb: () => void): void {
    this.closeCb = cb;
  }

  close(): void {
    if (this.closed) return; // 幂等
    this.closed = true;
  }

  /** 触发 onClose 回调（模拟 transport 主动断开，用于验证 jsonRpc 联动关闭） */
  fireClose(): void {
    if (this.closeCb) this.closeCb();
  }

  /** 把响应对象 JSON.stringify 后通过 messageCb 回喂给 McpClient */
  feed(msg: object): void {
    if (this.messageCb) {
      this.messageCb(JSON.stringify(msg));
    }
  }

  /** 查找指定 method 的最近一条出站消息（request 或 notification） */
  find(method: string): OutboundMessage | undefined {
    return this.sent.find((m) => m.method === method);
  }
}

/** 构造 initialize 成功响应 */
function initResult() {
  return {
    protocolVersion: '2024-11-05',
    serverInfo: { name: 'mock-server', version: '1.0.0' },
    capabilities: { tools: {} },
  };
}

/** 完成 initialize 握手 */
async function handshake(transport: MockTransport, client: McpClient): Promise<void> {
  const p = client.initialize();
  const req = transport.find('initialize') as JsonRpcRequest | undefined;
  expect(req).toBeDefined();
  transport.feed({ jsonrpc: '2.0', id: req!.id, result: initResult() });
  await p;
}

test('initialize 成功：喂入含 protocolVersion/serverInfo/capabilities 的响应 → resolve', async () => {
  const transport = new MockTransport();
  const client = new McpClient(transport, { initializeTimeoutMs: 1000 });

  const promise = client.initialize();

  // 校验请求体
  const req = transport.find('initialize') as JsonRpcRequest | undefined;
  expect(req).toBeDefined();
  expect(req!.params).toEqual({
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'wuzi-agent', version: '0.1.0' },
  });

  // 喂入成功响应
  transport.feed({
    jsonrpc: '2.0',
    id: req!.id,
    result: {
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'mock-server', version: '1.0.0' },
      capabilities: { tools: {} },
    },
  });

  await expect(promise).resolves.toBeUndefined();

  // 校验握手完成后发送了 notifications/initialized（无 id）
  const notif = transport.find('notifications/initialized');
  expect(notif).toBeDefined();
  expect('id' in (notif as OutboundMessage)).toBe(false);

  await client.close();
});

test('initialize 超时：未喂回包 → reject 含 timeout', async () => {
  const transport = new MockTransport();
  const client = new McpClient(transport, { initializeTimeoutMs: 50 });

  const promise = client.initialize();

  // 校验确实发出了 initialize 请求
  expect(transport.find('initialize')).toBeDefined();

  let err: unknown;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toMatch(/timeout/);

  await client.close();
});

test('listTools：喂入 { tools: [...] } → 返回数组（每项含 name/description/inputSchema）', async () => {
  const transport = new MockTransport();
  const client = new McpClient(transport, { toolCallTimeoutMs: 1000 });

  await handshake(transport, client);

  const toolsPromise = client.listTools();
  const listReq = transport.find('tools/list') as JsonRpcRequest | undefined;
  expect(listReq).toBeDefined();

  const tools = [
    {
      name: 'echo',
      description: 'Echo the input text',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    },
    {
      name: 'add',
      description: 'Add two numbers',
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
      },
    },
  ];
  transport.feed({ jsonrpc: '2.0', id: listReq!.id, result: { tools } });

  const got = await toolsPromise;
  expect(got).toEqual(tools);
  // 透传字段
  expect(got[0]!.name).toBe('echo');
  expect(got[0]!.description).toBe('Echo the input text');
  expect(got[0]!.inputSchema).toEqual(tools[0]!.inputSchema);

  await client.close();
});

test('callTool：喂入 { content: [...] } → 返回该 content 数组', async () => {
  const transport = new MockTransport();
  const client = new McpClient(transport, { toolCallTimeoutMs: 1000 });

  await handshake(transport, client);

  const callPromise = client.callTool('echo', { text: 'hi' });
  const callReq = transport.find('tools/call') as JsonRpcRequest | undefined;
  expect(callReq).toBeDefined();
  expect(callReq!.params).toEqual({ name: 'echo', arguments: { text: 'hi' } });

  const content = [{ type: 'text', text: 'hi' }];
  transport.feed({ jsonrpc: '2.0', id: callReq!.id, result: { content } });

  await expect(callPromise).resolves.toEqual({ content });

  await client.close();
});

test('callTool：server 返回 isError=true → 透传给调用方', async () => {
  const transport = new MockTransport();
  const client = new McpClient(transport, { toolCallTimeoutMs: 1000 });

  await handshake(transport, client);

  const callPromise = client.callTool('boom');
  const callReq = transport.find('tools/call') as JsonRpcRequest | undefined;
  transport.feed({
    jsonrpc: '2.0',
    id: callReq!.id,
    result: { content: [{ type: 'text', text: 'boom failed' }], isError: true },
  });

  const got = await callPromise;
  expect(got.isError).toBe(true);
  expect(got.content).toEqual([{ type: 'text', text: 'boom failed' }]);

  await client.close();
});

test('initialize 幂等：连续调用两次，第二次不重新发请求', async () => {
  const transport = new MockTransport();
  const client = new McpClient(transport, { initializeTimeoutMs: 1000 });

  await handshake(transport, client);

  const sentBefore = transport.sent.length;
  // 第二次调用应直接 resolve，不发送任何消息
  await client.initialize();
  expect(transport.sent.length).toBe(sentBefore);

  // 校验没有第二个 initialize 请求
  const initReqs = transport.sent.filter((m) => m.method === 'initialize');
  expect(initReqs).toHaveLength(1);

  await client.close();
});

test('close：调用 transport.close 且重复调用幂等', async () => {
  const transport = new MockTransport();
  const client = new McpClient(transport);

  await client.close();
  expect(transport.closed).toBe(true);

  // 重复调用不抛错
  await expect(client.close()).resolves.toBeUndefined();
  expect(transport.closed).toBe(true);
});

test('transport 主动关闭 → jsonRpc 联动关闭，pending request 被 reject', async () => {
  const transport = new MockTransport();
  const client = new McpClient(transport, { toolCallTimeoutMs: 10000 });

  await handshake(transport, client);

  // 发起一个 listTools 请求，不喂回包
  const toolsPromise = client.listTools();
  expect(transport.find('tools/list')).toBeDefined();

  // 模拟 transport 主动断开
  transport.fireClose();

  let err: unknown;
  try {
    await toolsPromise;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toMatch(/client closed/);

  await client.close();
});
