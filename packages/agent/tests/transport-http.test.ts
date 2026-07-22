/**
 * HttpTransport 单元测试
 *
 * 通过 `fetchFn` 注入 mock fetch（不 patch 全局 fetch，避免污染其他测试）。
 * 覆盖：SSE 响应、JSON 响应、Mcp-Session-Id 缓存、用户 headers 透传、close() 幂等性。
 */
import { test, expect } from 'bun:test';
import { HttpTransport } from '../modules/mcp/transport.ts';

/** Mock fetch 调用记录（用于断言 headers / body / url） */
interface FetchCall {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** 构造伪造 Response：支持 headers.get / text() */
function makeResponse(opts: {
  status?: number;
  headers?: Record<string, string>;
  body: string;
}): Response {
  const headers = new Headers(opts.headers ?? {});
  const status = opts.status ?? 200;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    text: async () => opts.body,
  } as unknown as Response;
}

/** 等待异步 onMessage 处理（fetch 解析为 microtask + await text） */
function flush(): Promise<void> {
  // 双层 microtask + 1ms 延时：覆盖 await fetch → await text() → parseSse 的全链路
  return new Promise((r) => setTimeout(r, 10));
}

const TEST_URL = 'http://localhost:9999/mcp';

test('SSE 响应：2 条 data → onMessage 触发 2 次，每次得到完整 JSON 字符串', async () => {
  const sseBody =
    'data: {"jsonrpc":"2.0","id":1,"result":{"x":1}}\n\n' +
    'data: {"jsonrpc":"2.0","id":2,"result":{"x":2}}\n\n';

  const fetchFn = async (): Promise<Response> =>
    makeResponse({
      headers: { 'Content-Type': 'text/event-stream' },
      body: sseBody,
    });

  const transport = new HttpTransport({
    url: TEST_URL,
    fetchFn: fetchFn as typeof fetch,
  });

  const received: string[] = [];
  transport.onMessage((raw) => received.push(raw));
  transport.start();
  transport.send({ jsonrpc: '2.0', id: 1, method: 'test' });

  await flush();

  expect(received.length).toBe(2);
  expect(received[0]).toBe('{"jsonrpc":"2.0","id":1,"result":{"x":1}}');
  expect(received[1]).toBe('{"jsonrpc":"2.0","id":2,"result":{"x":2}}');

  transport.close();
});

test('SSE 响应：单 event 内多行 data 按 \\n 拼接为一条消息', async () => {
  // 单 event 包含多行 data:，应拼接为一条消息（按 SSE 规范用 \n 连接）
  const sseBody = 'data: line1\ndata: line2\n\n';

  const fetchFn = async (): Promise<Response> =>
    makeResponse({
      headers: { 'Content-Type': 'text/event-stream' },
      body: sseBody,
    });

  const transport = new HttpTransport({
    url: TEST_URL,
    fetchFn: fetchFn as typeof fetch,
  });

  const received: string[] = [];
  transport.onMessage((raw) => received.push(raw));
  transport.start();
  transport.send({ jsonrpc: '2.0', id: 1, method: 'test' });

  await flush();

  expect(received.length).toBe(1);
  expect(received[0]).toBe('line1\nline2');

  transport.close();
});

test('JSON 响应：onMessage 触发 1 次', async () => {
  const jsonBody = '{"jsonrpc":"2.0","id":1,"result":{"x":1}}';

  const fetchFn = async (): Promise<Response> =>
    makeResponse({
      headers: { 'Content-Type': 'application/json' },
      body: jsonBody,
    });

  const transport = new HttpTransport({
    url: TEST_URL,
    fetchFn: fetchFn as typeof fetch,
  });

  const received: string[] = [];
  transport.onMessage((raw) => received.push(raw));
  transport.start();
  transport.send({ jsonrpc: '2.0', id: 1, method: 'test' });

  await flush();

  expect(received.length).toBe(1);
  expect(received[0]).toBe(jsonBody);

  transport.close();
});

test('Mcp-Session-Id 缓存：首次响应带 header，第二次 send 的 fetch headers 含该值', async () => {
  const calls: FetchCall[] = [];

  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    const callHeaders = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      headers: callHeaders,
      body: init?.body as string,
    });
    // 首次响应携带 Mcp-Session-Id，后续不携带（已缓存）
    const isFirst = calls.length === 1;
    return makeResponse({
      headers: isFirst
        ? { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'abc123' }
        : { 'Content-Type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"result":{}}',
    });
  };

  const transport = new HttpTransport({
    url: TEST_URL,
    fetchFn: fetchFn as typeof fetch,
  });

  transport.onMessage(() => {});
  transport.start();

  transport.send({ jsonrpc: '2.0', id: 1, method: 'init' });
  await flush();

  transport.send({ jsonrpc: '2.0', id: 2, method: 'call' });
  await flush();

  expect(calls.length).toBe(2);
  // 首次请求尚未缓存 sessionId，headers 中无 Mcp-Session-Id
  expect(calls[0].headers['Mcp-Session-Id']).toBeUndefined();
  // 第二次请求带上了缓存的 sessionId
  expect(calls[1].headers['Mcp-Session-Id']).toBe('abc123');

  transport.close();
});

test('用户 headers 透传：fetch 调用 headers 包含 Authorization', async () => {
  let capturedHeaders: Record<string, string> = {};

  const fetchFn = async (_url: string, init?: RequestInit): Promise<Response> => {
    capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
    return makeResponse({
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  };

  const transport = new HttpTransport({
    url: TEST_URL,
    headers: { Authorization: 'Bearer xxx' },
    fetchFn: fetchFn as typeof fetch,
  });

  transport.onMessage(() => {});
  transport.start();
  transport.send({ jsonrpc: '2.0', id: 1, method: 'test' });

  await flush();

  expect(capturedHeaders['Authorization']).toBe('Bearer xxx');
  // 默认 headers 仍然存在
  expect(capturedHeaders['Content-Type']).toBe('application/json');
  expect(capturedHeaders['Accept']).toBe('application/json, text/event-stream');

  transport.close();
});

test('close() → 触发 onClose 一次；重复调用幂等', async () => {
  const fetchFn = async (): Promise<Response> =>
    makeResponse({
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

  const transport = new HttpTransport({
    url: TEST_URL,
    fetchFn: fetchFn as typeof fetch,
  });

  let closeCount = 0;
  transport.onClose(() => closeCount++);

  transport.close();
  transport.close();
  transport.close();

  expect(closeCount).toBe(1);
});

test('close 后 send → 抛出 already closed 错误', () => {
  const fetchFn = async (): Promise<Response> =>
    makeResponse({ headers: { 'Content-Type': 'application/json' }, body: '{}' });

  const transport = new HttpTransport({
    url: TEST_URL,
    fetchFn: fetchFn as typeof fetch,
  });
  transport.close();

  expect(() =>
    transport.send({ jsonrpc: '2.0', id: 1, method: 'noop' }),
  ).toThrow(/already closed/);
});

test('不支持的 Content-Type → 不触发 onMessage', async () => {
  const fetchFn = async (): Promise<Response> =>
    makeResponse({
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello',
    });

  const transport = new HttpTransport({
    url: TEST_URL,
    fetchFn: fetchFn as typeof fetch,
  });

  const received: string[] = [];
  transport.onMessage((raw) => received.push(raw));
  transport.start();
  transport.send({ jsonrpc: '2.0', id: 1, method: 'test' });

  await flush();

  expect(received.length).toBe(0);

  transport.close();
});

test('start()：非法 URL 抛出错误', () => {
  const transport = new HttpTransport({
    url: 'not-a-valid-url',
    fetchFn: (async () => makeResponse({ body: '{}' })) as typeof fetch,
  });

  expect(() => transport.start()).toThrow();
});
