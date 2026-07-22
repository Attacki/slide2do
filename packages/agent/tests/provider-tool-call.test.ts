/**
 * Provider 流式工具调用解析测试
 *
 * 通过替换全局 fetch 注入伪造 SSE，验证 OpenAI / Anthropic 两种格式下
 * 「JSON 参数碎片拼接」能被正确还原为完整 tool_call 事件，并验证
 * Anthropic prompt caching 的 usage 字段（input/output/cache_read/cache_creation）
 * 能从 message_start / message_delta 解析并透传到 done 事件。
 */
import { test, expect } from 'bun:test';
import type { LLMConfig } from '../utils/config/config-types.ts';
import { OpenAIProvider } from '../provider/openai.ts';
import { AnthropicProvider } from '../provider/anthropic.ts';
import type { ProviderStreamEvent } from '../provider/base.ts';

const config: LLMConfig = {
  protocol: 'openai',
  model: 'm',
  base_url: 'http://localhost',
  api_key: 'k',
};

function collectEvents(sse: string, provider: OpenAIProvider | AnthropicProvider): Promise<ProviderStreamEvent[]> {
  const orig = globalThis.fetch;
  // mock 仅用于注入伪造 SSE，断言为 typeof fetch 以兼容其静态方法（preconnect 等）
  globalThis.fetch = (async () => new Response(sse)) as unknown as typeof globalThis.fetch;
  const events: ProviderStreamEvent[] = [];
  const onEvent = (e: ProviderStreamEvent) => events.push(e);
  return (provider.streamChat(
    {
      messages: [{ role: 'user', content: 'hi' }],
      config,
      tools: [{ name: 'read_file', description: 'd', parameters: { type: 'object', properties: {}, required: [] } }],
    },
    onEvent,
  ) as Promise<void>)
    .then(() => events)
    .finally(() => {
      globalThis.fetch = orig;
    });
}

const openaiSSE = [
  'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x.txt\\"}"}}]}}]}',
  'data: {"choices":[{"delta":{}}]}',
  'data: [DONE]',
].join('\n');

const anthropicSSE = [
  'data: {"type":"message_start","message":{"id":"m","role":"assistant"}}',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"read_file"}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"x.txt\\"}"}}',
  'data: {"type":"content_block_stop","index":0}',
  'data: {"type":"message_stop"}',
].join('\n');

test('OpenAI: 拼接 tool_calls JSON 碎片为完整 tool_call', async () => {
  const events = await collectEvents(openaiSSE, new OpenAIProvider());
  const call = events.find((e) => e.type === 'tool_call');
  expect(call?.type).toBe('tool_call');
  if (call?.type === 'tool_call') {
    expect(call.id).toBe('call_1');
    expect(call.name).toBe('read_file');
    expect(JSON.parse(call.arguments)).toEqual({ path: 'x.txt' });
  }
  expect(events.some((e) => e.type === 'done')).toBe(true);
});

test('Anthropic: 拼接 input_json_delta 碎片为完整 tool_call', async () => {
  const events = await collectEvents(anthropicSSE, new AnthropicProvider());
  const call = events.find((e) => e.type === 'tool_call');
  expect(call?.type).toBe('tool_call');
  if (call?.type === 'tool_call') {
    expect(call.id).toBe('tu_1');
    expect(call.name).toBe('read_file');
    expect(JSON.parse(call.arguments)).toEqual({ path: 'x.txt' });
  }
  expect(events.some((e) => e.type === 'done')).toBe(true);
});

// usage 解析：message_start 给出 input_tokens + cache_*，message_delta 给出 output_tokens
const anthropicUsageSSE = [
  'data: {"type":"message_start","message":{"id":"m","role":"assistant","usage":{"input_tokens":120,"output_tokens":0,"cache_read_input_tokens":80,"cache_creation_input_tokens":40}}}',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
  'data: {"type":"content_block_stop","index":0}',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}',
  'data: {"type":"message_stop"}',
].join('\n');

test('Anthropic: 解析 message_start / message_delta usage 并透传到 done', async () => {
  const events = await collectEvents(anthropicUsageSSE, new AnthropicProvider());
  const done = events.find((e) => e.type === 'done');
  expect(done?.type).toBe('done');
  if (done?.type === 'done') {
    expect(done.usage).toBeDefined();
    expect(done.usage?.inputTokens).toBe(120);
    expect(done.usage?.outputTokens).toBe(12); // 来自 message_delta，覆盖 message_start 的 0
    expect(done.usage?.cacheReadInputTokens).toBe(80);
    expect(done.usage?.cacheCreationInputTokens).toBe(40);
  }
});

// 无 usage 字段时 done.usage 保持 undefined（兼容不返回 usage 的代理或老版本）
const anthropicNoUsageSSE = [
  'data: {"type":"message_start","message":{"id":"m","role":"assistant"}}',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
  'data: {"type":"content_block_stop","index":0}',
  'data: {"type":"message_stop"}',
].join('\n');

test('Anthropic: 无 usage 字段时 done.usage 为 undefined', async () => {
  const events = await collectEvents(anthropicNoUsageSSE, new AnthropicProvider());
  const done = events.find((e) => e.type === 'done');
  expect(done?.type).toBe('done');
  if (done?.type === 'done') {
    expect(done.usage).toBeUndefined();
  }
});

// OpenAI 结构分离：按 kind 分流 system 消息，合并为单条 system（稳定段在前、动态段在后）
test('OpenAI: 合并稳定+动态 system 为单条 system 消息（稳定段在前）', async () => {
  const orig = globalThis.fetch;
  let capturedBody: any;
  globalThis.fetch = (async (input: any, init?: any) => {
    capturedBody = JSON.parse(init.body);
    return new Response('data: [DONE]\n');
  }) as unknown as typeof globalThis.fetch;

  try {
    const provider = new OpenAIProvider();
    await provider.streamChat(
      {
        messages: [
          { role: 'system', content: 'STABLE_ROLE' } as any, // 无 kind → 稳定段
          { role: 'system', kind: 'env_info', content: 'ENV_INFO' } as any,
          { role: 'system', kind: 'mode_reminder', content: 'MODE_REMINDER' } as any,
          { role: 'user', content: 'hi' },
        ],
        config,
      },
      () => {},
    );
  } finally {
    globalThis.fetch = orig;
  }

  // 应只有一条 system 消息，且内容为「稳定段\n\n动态段合并」
  const systemMsgs = capturedBody.messages.filter((m: any) => m.role === 'system');
  expect(systemMsgs.length).toBe(1);
  expect(systemMsgs[0].content).toBe('STABLE_ROLE\n\nENV_INFO\n\nMODE_REMINDER');
  // user 消息保留
  const userMsgs = capturedBody.messages.filter((m: any) => m.role === 'user');
  expect(userMsgs.length).toBe(1);
  expect(userMsgs[0].content).toBe('hi');
  // system 在首位
  expect(capturedBody.messages[0].role).toBe('system');
});

// OpenAI 无 system 消息时不强行注入（兼容现有测试场景）
test('OpenAI: 无 system 消息时不注入空 system', async () => {
  const orig = globalThis.fetch;
  let capturedBody: any;
  globalThis.fetch = (async (input: any, init?: any) => {
    capturedBody = JSON.parse(init.body);
    return new Response('data: [DONE]\n');
  }) as unknown as typeof globalThis.fetch;

  try {
    const provider = new OpenAIProvider();
    await provider.streamChat(
      {
        messages: [{ role: 'user', content: 'hi' }],
        config,
      },
      () => {},
    );
  } finally {
    globalThis.fetch = orig;
  }

  const systemMsgs = capturedBody.messages.filter((m: any) => m.role === 'system');
  expect(systemMsgs.length).toBe(0);
  expect(capturedBody.messages.length).toBe(1);
  expect(capturedBody.messages[0].role).toBe('user');
});

// OpenAI 仅动态 system（无稳定段）时仍合并为单条
test('OpenAI: 仅动态 system 时合并为单条 system', async () => {
  const orig = globalThis.fetch;
  let capturedBody: any;
  globalThis.fetch = (async (input: any, init?: any) => {
    capturedBody = JSON.parse(init.body);
    return new Response('data: [DONE]\n');
  }) as unknown as typeof globalThis.fetch;

  try {
    const provider = new OpenAIProvider();
    await provider.streamChat(
      {
        messages: [
          { role: 'system', kind: 'env_info', content: 'ENV_ONLY' } as any,
          { role: 'user', content: 'hi' },
        ],
        config,
      },
      () => {},
    );
  } finally {
    globalThis.fetch = orig;
  }

  const systemMsgs = capturedBody.messages.filter((m: any) => m.role === 'system');
  expect(systemMsgs.length).toBe(1);
  expect(systemMsgs[0].content).toBe('ENV_ONLY');
});

// Anthropic 多轮工具调用历史序列化：assistant.tool_calls 必须转为 tool_use 块，
// tool 消息必须转为 user + tool_result 块；否则 LLM 看不到自己调用过工具，触发死循环
test('Anthropic: assistant.tool_calls 序列化为 content blocks 含 tool_use', async () => {
  const orig = globalThis.fetch;
  let capturedBody: any;
  globalThis.fetch = (async (_input: any, init?: any) => {
    capturedBody = JSON.parse(init.body);
    return new Response('data: {"type":"message_stop"}\n');
  }) as unknown as typeof globalThis.fetch;

  try {
    const provider = new AnthropicProvider();
    await provider.streamChat(
      {
        messages: [
          { role: 'user', content: '读 x.txt' },
          {
            role: 'assistant',
            content: '正在读取',
            tool_calls: [
              { id: 'tu_1', name: 'read_file', arguments: '{"path":"x.txt"}' },
            ],
          } as any,
        ],
        config: { protocol: 'anthropic', model: 'm', base_url: 'http://localhost', api_key: 'k' } as any,
      },
      () => {},
    );
  } finally {
    globalThis.fetch = orig;
  }

  // assistant 消息应转为 content 数组：[text 块, tool_use 块]
  const assistantMsg = capturedBody.messages.find((m: any) => m.role === 'assistant');
  expect(assistantMsg).toBeDefined();
  expect(Array.isArray(assistantMsg.content)).toBe(true);
  const textBlock = assistantMsg.content.find((b: any) => b.type === 'text');
  expect(textBlock?.text).toBe('正在读取');
  const toolUseBlock = assistantMsg.content.find((b: any) => b.type === 'tool_use');
  expect(toolUseBlock).toBeDefined();
  expect(toolUseBlock.id).toBe('tu_1');
  expect(toolUseBlock.name).toBe('read_file');
  // input 必须是已解析的对象，不是字符串
  expect(typeof toolUseBlock.input).toBe('object');
  expect(toolUseBlock.input).toEqual({ path: 'x.txt' });
});

test('Anthropic: tool 消息序列化为 user + tool_result 块（含 tool_use_id）', async () => {
  const orig = globalThis.fetch;
  let capturedBody: any;
  globalThis.fetch = (async (_input: any, init?: any) => {
    capturedBody = JSON.parse(init.body);
    return new Response('data: {"type":"message_stop"}\n');
  }) as unknown as typeof globalThis.fetch;

  try {
    const provider = new AnthropicProvider();
    await provider.streamChat(
      {
        messages: [
          { role: 'user', content: '读 x.txt' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'tu_1', name: 'read_file', arguments: '{"path":"x.txt"}' },
              { id: 'tu_2', name: 'read_file', arguments: '{"path":"y.txt"}' },
            ],
          } as any,
          { role: 'tool', content: 'X 内容', tool_call_id: 'tu_1' } as any,
          { role: 'tool', content: 'Y 内容', tool_call_id: 'tu_2' } as any,
        ],
        config: { protocol: 'anthropic', model: 'm', base_url: 'http://localhost', api_key: 'k' } as any,
      },
      () => {},
    );
  } finally {
    globalThis.fetch = orig;
  }

  // 连续两条 tool 消息应合并为单个 user 消息，含两个 tool_result 块
  const msgs = capturedBody.messages;
  // 顺序：user(原 user) → assistant(含 2 个 tool_use) → user(含 2 个 tool_result)
  expect(msgs[0].role).toBe('user');
  expect(msgs[1].role).toBe('assistant');
  expect(Array.isArray(msgs[1].content)).toBe(true);
  // assistant.content 应有 2 个 tool_use 块（content 为空，不加 text 块）
  const toolUseBlocks = msgs[1].content.filter((b: any) => b.type === 'tool_use');
  expect(toolUseBlocks.length).toBe(2);
  expect(toolUseBlocks[0].id).toBe('tu_1');
  expect(toolUseBlocks[1].id).toBe('tu_2');

  // 合并后的 user 消息含两个 tool_result 块
  expect(msgs[2].role).toBe('user');
  expect(Array.isArray(msgs[2].content)).toBe(true);
  expect(msgs[2].content.length).toBe(2);
  expect(msgs[2].content[0]).toEqual({
    type: 'tool_result',
    tool_use_id: 'tu_1',
    content: 'X 内容',
  });
  expect(msgs[2].content[1]).toEqual({
    type: 'tool_result',
    tool_use_id: 'tu_2',
    content: 'Y 内容',
  });
});

test('Anthropic: 纯文本 assistant 消息保持字符串 content（不包装为数组）', async () => {
  const orig = globalThis.fetch;
  let capturedBody: any;
  globalThis.fetch = (async (_input: any, init?: any) => {
    capturedBody = JSON.parse(init.body);
    return new Response('data: {"type":"message_stop"}\n');
  }) as unknown as typeof globalThis.fetch;

  try {
    const provider = new AnthropicProvider();
    await provider.streamChat(
      {
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
        config: { protocol: 'anthropic', model: 'm', base_url: 'http://localhost', api_key: 'k' } as any,
      },
      () => {},
    );
  } finally {
    globalThis.fetch = orig;
  }

  const assistantMsg = capturedBody.messages.find((m: any) => m.role === 'assistant');
  expect(assistantMsg).toBeDefined();
  // 纯文本 assistant 应保持字符串 content，不包装为数组
  expect(typeof assistantMsg.content).toBe('string');
  expect(assistantMsg.content).toBe('hello');
});

// Anthropic: 参数 JSON 解析失败时 input 为空对象，不抛错（由 API 返回 400 提示模型调整）
test('Anthropic: tool_calls 参数 JSON 非法时 input 回退为空对象', async () => {
  const orig = globalThis.fetch;
  let capturedBody: any;
  globalThis.fetch = (async (_input: any, init?: any) => {
    capturedBody = JSON.parse(init.body);
    return new Response('data: {"type":"message_stop"}\n');
  }) as unknown as typeof globalThis.fetch;

  try {
    const provider = new AnthropicProvider();
    await provider.streamChat(
      {
        messages: [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'tu_bad', name: 'read_file', arguments: 'not-json{' }],
          } as any,
        ],
        config: { protocol: 'anthropic', model: 'm', base_url: 'http://localhost', api_key: 'k' } as any,
      },
      () => {},
    );
  } finally {
    globalThis.fetch = orig;
  }

  const assistantMsg = capturedBody.messages.find((m: any) => m.role === 'assistant');
  const toolUseBlock = assistantMsg.content.find((b: any) => b.type === 'tool_use');
  expect(toolUseBlock.input).toEqual({});
});
