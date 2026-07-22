/**
 * JsonRpcClient 单元测试
 */
import { test, expect } from 'bun:test';
import type { JsonRpcRequest } from '@wuzi/types';
import { JsonRpcClient, JsonRpcErrorThrown } from '../modules/mcp/json-rpc.ts';

/** 透出到测试用例的 pending Map 视图（白盒检查内存泄漏） */
function pendingSize(client: JsonRpcClient): number {
  const map = (client as unknown as { pending: Map<number, unknown> }).pending;
  return map.size;
}

test('sendRequest + 正确 response → resolve result', async () => {
  let captured: JsonRpcRequest | undefined;
  const client = new JsonRpcClient((m) => (captured = m as JsonRpcRequest));
  const promise = client.sendRequest('add', { a: 1, b: 2 });
  expect(captured).toBeDefined();
  expect(captured!.method).toBe('add');
  expect(captured!.params).toEqual({ a: 1, b: 2 });
  client.handleMessage({ jsonrpc: '2.0', id: captured!.id, result: { sum: 3 } });
  await expect(promise).resolves.toEqual({ sum: 3 });
});

test('sendRequest + error response → reject 含原始 message/code', async () => {
  let captured: JsonRpcRequest | undefined;
  const client = new JsonRpcClient((m) => (captured = m as JsonRpcRequest));
  const promise = client.sendRequest('fail');
  client.handleMessage({
    jsonrpc: '2.0',
    id: captured!.id,
    error: { code: -32601, message: 'Method not found' },
  });
  let err: unknown;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(JsonRpcErrorThrown);
  expect((err as JsonRpcErrorThrown).code).toBe(-32601);
  expect((err as Error).message).toMatch(/Method not found/);
});

test('sendRequest 超时 → reject 含 "timeout" 且清理 Map', async () => {
  const client = new JsonRpcClient(() => {}, 50);
  const promise = client.sendRequest('slow');
  expect(pendingSize(client)).toBe(1);
  let err: unknown;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toMatch(/timeout/);
  expect(pendingSize(client)).toBe(0);
});

test('notification → 触发 onNotification 回调，不挂 Promise', () => {
  const client = new JsonRpcClient(() => {});
  const calls: Array<{ method: string; params?: unknown }> = [];
  client.onNotification((method, params) => calls.push({ method, params }));

  client.handleMessage({ jsonrpc: '2.0', method: 'update', params: { x: 1 } });
  client.handleMessage({ jsonrpc: '2.0', method: 'ping' });

  expect(calls).toEqual([
    { method: 'update', params: { x: 1 } },
    { method: 'ping', params: undefined },
  ]);
  expect(pendingSize(client)).toBe(0);
});

test('sendNotification 不挂 Promise 且不触发回调', () => {
  const calls: Array<{ method: string; params?: unknown }> = [];
  const sent: JsonRpcRequest[] = [];
  const client = new JsonRpcClient((m) => sent.push(m as JsonRpcRequest));
  client.onNotification((method, params) => calls.push({ method, params }));

  client.sendNotification('hello', { to: 'world' });
  expect(sent).toHaveLength(1);
  expect(sent[0]!.method).toBe('hello');
  expect('id' in sent[0]!).toBe(false);
  expect(pendingSize(client)).toBe(0);
  expect(calls).toEqual([]);
});

test('id 严格递增（连续 3 个 sendRequest → 1/2/3）', async () => {
  const sent: JsonRpcRequest[] = [];
  const client = new JsonRpcClient((m) => sent.push(m as JsonRpcRequest));
  const ps = [client.sendRequest('a'), client.sendRequest('b'), client.sendRequest('c')];
  expect(sent.map((m) => m.id)).toEqual([1, 2, 3]);
  // 清理 pending（未喂回包）；close 会 reject 这 3 个 promise，吞掉以避免未处理拒绝
  client.close();
  await Promise.allSettled(ps);
});

test('close() → pending request 被 reject 含 "client closed"', async () => {
  const client = new JsonRpcClient(() => {}, 10000);
  const p1 = client.sendRequest('one');
  const p2 = client.sendRequest('two');
  expect(pendingSize(client)).toBe(2);

  client.close();

  let err1: unknown;
  let err2: unknown;
  try {
    await p1;
  } catch (e) {
    err1 = e;
  }
  try {
    await p2;
  } catch (e) {
    err2 = e;
  }
  expect(err1).toBeInstanceOf(Error);
  expect((err1 as Error).message).toMatch(/client closed/);
  expect(err2).toBeInstanceOf(Error);
  expect((err2 as Error).message).toMatch(/client closed/);
  expect(pendingSize(client)).toBe(0);
});

test('handleMessage 支持 string（JSON.parse）且解析失败静默忽略', async () => {
  let captured: JsonRpcRequest | undefined;
  const client = new JsonRpcClient((m) => (captured = m as JsonRpcRequest));
  const promise = client.sendRequest('q');
  // 字符串形式回包
  client.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: captured!.id, result: 'ok' }));
  await expect(promise).resolves.toBe('ok');

  // 非法 JSON 不抛错
  expect(() => client.handleMessage('{not json')).not.toThrow();
  // 非对象静默忽略
  expect(() => client.handleMessage('null')).not.toThrow();
  expect(() => client.handleMessage('"string"')).not.toThrow();
});

test('handleMessage 收到已超时的 id 回包 → 静默忽略，无副作用', async () => {
  const client = new JsonRpcClient(() => {}, 30);
  const promise = client.sendRequest('late');
  // 等待超时
  let err: unknown;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  expect((err as Error).message).toMatch(/timeout/);
  expect(pendingSize(client)).toBe(0);
  // 迟到的回包不应抛错
  expect(() => client.handleMessage({ jsonrpc: '2.0', id: 1, result: 'late' })).not.toThrow();
});
