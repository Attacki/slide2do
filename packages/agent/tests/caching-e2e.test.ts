/**
 * 端到端验证：Prompt 编排架构 + 缓存策略 + 兼容性
 *
 * 覆盖 checklist.md 中的端到端验收项：
 *  - E2E-1 缓存挂载：Anthropic 请求体 system 数组首元素 + tools 末元素挂 cache_control
 *  - E2E-2 缓存命中透传：ReasoningLoop done 事件 usage 含 cacheReadInputTokens/cacheCreationInputTokens
 *  - E2E-3 env_info 注入：装配 ContextManager + PromptComposer 的 ReasoningLoop 发给 provider 的消息序列含 kind:'env_info'
 *  - E2E-6 兼容性：loadStableSystem 优先 loadRole、缺省回退 loadSystemPrompt（未改造角色兼容）
 *
 * 离线测试，使用 mock provider 捕获请求体 / 注入伪造 SSE。
 */
import { describe, it, expect } from 'bun:test';
import { ReasoningLoop } from '../reasoning-loop.ts';
import { ConversationMemory } from '../modules/memory/memory-manger.ts';
import { PromptComposer } from '../prompt/prompt-composer.ts';
import { ContextManager } from '../modules/context/context-manger.ts';
import { loadStableSystem } from '../../agent-roles/roles-registry.ts';
import type { ILLMProvider, StreamCallback, StreamChatParams } from '../provider/base.ts';
import type { LLMConfig } from '../utils/config/config-types.ts';
import type { ChatMessage, StreamEvent } from '../ui-pattern.ts';

const fakeConfig = {
  protocol: 'mock',
  model: 'm',
  base_url: 'http://localhost',
  api_key: 'k',
} as unknown as LLMConfig;

/** 捕获 provider 收到的消息序列与工具定义，便于断言 env_info 注入与缓存挂载 */
class CapturingProvider implements ILLMProvider {
  readonly protocol = 'mock';
  capturedMessages: ChatMessage[] = [];
  capturedTools: StreamChatParams['tools'] | undefined;
  capturedConfig: LLMConfig | undefined;
  /** 控制下次 streamChat 时注入的伪造 usage（模拟 Anthropic cache 命中） */
  nextUsage?: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number };

  async streamChat(params: StreamChatParams, onEvent: StreamCallback): Promise<void> {
    this.capturedMessages = params.messages;
    this.capturedTools = params.tools;
    this.capturedConfig = params.config;
    // 模拟一轮最终回复（无工具调用）
    onEvent({ type: 'text_delta', delta: 'ok' });
    onEvent({ type: 'done', usage: this.nextUsage });
  }
}

/** 构造装配了 composer + contextManager 的 ReasoningLoop */
function makeLoop(opts: {
  stableSystem?: string;
  nextUsage?: CapturingProvider['nextUsage'];
  mode?: 'agent' | 'ask' | 'plan';
} = {}) {
  const memory = new ConversationMemory();
  const stableSystem = opts.stableSystem ?? 'STABLE_ROLE_PROMPT';
  memory.setSystem(stableSystem);
  const provider = new CapturingProvider();
  provider.nextUsage = opts.nextUsage;
  const contextManager = new ContextManager();
  const composer = new PromptComposer(stableSystem);
  const loop = new ReasoningLoop({
    provider,
    config: fakeConfig,
    memory,
    composer,
    contextManager,
    loop: opts.mode ? { mode: opts.mode } : undefined,
  });
  return { loop, provider, memory, contextManager, composer };
}

// ---------------------------------------------------------------------------
// E2E-1 Anthropic 请求体 cache_control 挂载（直接调用 AnthropicProvider 验证请求体）
// ---------------------------------------------------------------------------
describe('E2E-1 Anthropic 缓存挂载', () => {
  it('should mount cache_control on stable system segment (breakpoint 1) and last tool (breakpoint 2)', async () => {
    const { AnthropicProvider } = await import('../provider/anthropic.ts');
    const orig = globalThis.fetch;
    let capturedBody: any;
    globalThis.fetch = (async (_input: any, init?: any) => {
      capturedBody = JSON.parse(init.body);
      // 返回最小合法 SSE 让 streamChat 完成
      const sse = [
        'data: {"type":"message_start","message":{"id":"m","role":"assistant","usage":{"input_tokens":10,"output_tokens":0}}}',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
        'data: {"type":"content_block_stop","index":0}',
        'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":2}}',
        'data: {"type":"message_stop"}',
      ].join('\n');
      return new Response(sse);
    }) as unknown as typeof globalThis.fetch;

    try {
      const provider = new AnthropicProvider();
      await provider.streamChat(
        {
          messages: [
            { role: 'system', content: 'STABLE_ROLE' } as any, // 稳定段（无 kind）
            { role: 'system', kind: 'env_info', content: 'ENV_INFO' } as any, // 动态段
            { role: 'user', content: 'hi' },
          ],
          config: { protocol: 'anthropic', model: 'm', base_url: 'http://localhost', api_key: 'k' } as any,
          tools: [
            { name: 'read_file', description: 'd', parameters: { type: 'object', properties: {}, required: [] } },
            { name: 'edit_file', description: 'd', parameters: { type: 'object', properties: {}, required: [] } },
          ],
        },
        () => {},
      );
    } finally {
      globalThis.fetch = orig;
    }

    // system 字段为数组形式，仅含稳定段（动态段已移出，不再污染缓存断点）
    expect(Array.isArray(capturedBody.system)).toBe(true);
    expect(capturedBody.system.length).toBe(1);
    // 稳定段（首元素）挂 cache_control（断点 1）
    expect(capturedBody.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(capturedBody.system[0].text).toBe('STABLE_ROLE');
    // 动态段（env_info）不再出现在 system 中
    expect(capturedBody.system[1]).toBeUndefined();
    // tools 数组末元素挂 cache_control（断点 2，前缀 = system + tools 完全静态）
    expect(Array.isArray(capturedBody.tools)).toBe(true);
    expect(capturedBody.tools.length).toBe(2);
    expect(capturedBody.tools[0].cache_control).toBeUndefined();
    expect(capturedBody.tools[1].cache_control).toEqual({ type: 'ephemeral' });
    // 动态段（env_info）转为 user 消息置于 messages 末尾
    const lastMsg = capturedBody.messages[capturedBody.messages.length - 1];
    expect(lastMsg.role).toBe('user');
    expect(lastMsg.content).toBe('ENV_INFO');
  });

  it('should not attach body.system when no system messages present', async () => {
    const { AnthropicProvider } = await import('../provider/anthropic.ts');
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
          messages: [{ role: 'user', content: 'hi' }],
          config: { protocol: 'anthropic', model: 'm', base_url: 'http://localhost', api_key: 'k' } as any,
        },
        () => {},
      );
    } finally {
      globalThis.fetch = orig;
    }

    expect(capturedBody.system).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// E2E-1b 对话历史缓存断点：每 N 轮末挂 cache_control（断点 3/4）
// 默认 N=3，受单请求 4 个断点上限约束（system+tools 已用 2，最多再挂 2 个对话断点）
// ---------------------------------------------------------------------------
describe('E2E-1b 对话历史缓存断点', () => {
  /** 捕获 Anthropic 请求体并喂入最小合法 SSE */
  async function captureAnthropicBody(messages: any[], tools?: any[]) {
    const { AnthropicProvider } = await import('../provider/anthropic.ts');
    const orig = globalThis.fetch;
    let capturedBody: any;
    globalThis.fetch = (async (_input: any, init?: any) => {
      capturedBody = JSON.parse(init.body);
      const sse = [
        'data: {"type":"message_start","message":{"id":"m","role":"assistant","usage":{"input_tokens":10,"output_tokens":0}}}',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
        'data: {"type":"content_block_stop","index":0}',
        'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":2}}',
        'data: {"type":"message_stop"}',
      ].join('\n');
      return new Response(sse);
    }) as unknown as typeof globalThis.fetch;

    const cfg: any = { protocol: 'anthropic', model: 'm', base_url: 'http://localhost', api_key: 'k' };
    try {
      const provider = new AnthropicProvider();
      await provider.streamChat({ messages, config: cfg, tools }, () => {});
    } finally {
      globalThis.fetch = orig;
    }
    return capturedBody;
  }

  /** 构造 turnCount 轮（每轮 user + assistant 纯文本）的对话历史 */
  function buildTurns(turnCount: number): any[] {
    const msgs: any[] = [{ role: 'system', content: 'STABLE_ROLE' }];
    for (let t = 1; t <= turnCount; t++) {
      msgs.push({ role: 'user', content: `user turn ${t}` });
      msgs.push({ role: 'assistant', content: `assistant turn ${t}` });
    }
    return msgs;
  }

  it('should NOT attach conversation breakpoints when turns < 3 (prefix too short)', async () => {
    const body = await captureAnthropicBody(buildTurns(2), [
      { name: 'read_file', description: 'd', parameters: { type: 'object', properties: {}, required: [] } },
    ]);
    // 仅 system(1) + tools(1) = 2 个断点，对话历史不应有 cache_control
    const convMsgs = body.messages as any[];
    for (const m of convMsgs) {
      const blocks = Array.isArray(m.content) ? m.content : [m];
      for (const b of blocks) expect(b.cache_control).toBeUndefined();
    }
  });

  it('should attach conversation breakpoints at ends of turns 3 and 6 (N=3, 2 most-recent)', async () => {
    const tools = [
      { name: 'read_file', description: 'd', parameters: { type: 'object', properties: {}, required: [] } },
      { name: 'edit_file', description: 'd', parameters: { type: 'object', properties: {}, required: [] } },
    ];
    const body = await captureAnthropicBody(buildTurns(7), tools);
    const conv = body.messages as any[];
    // 7 轮 → 对话部分 14 条：idx5=第3轮末 assistant；idx11=第6轮末 assistant
    expect(conv[5].role).toBe('assistant');
    expect(conv[5].content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(conv[11].role).toBe('assistant');
    expect(conv[11].content[0].cache_control).toEqual({ type: 'ephemeral' });
    // 第 7 轮末（idx13）不应挂断点
    expect(conv[13].content[0].cache_control).toBeUndefined();
    // 尾部动态段（env_info）无断点
    const last = conv[conv.length - 1];
    const lastBlocks = Array.isArray(last.content) ? last.content : [last];
    for (const b of lastBlocks) expect(b.cache_control).toBeUndefined();
    // 全请求 cache_control 总数不超过 4（system + tools + 2 对话）
    const toolBreakpoints = (body.tools as any[]).filter((t) => t.cache_control).length;
    let convBreakpoints = 0;
    for (const m of conv) {
      const blocks = Array.isArray(m.content) ? m.content : [m];
      convBreakpoints += blocks.filter((b: any) => b.cache_control).length;
    }
    const systemBreakpoints = (body.system as any[]).filter((s) => s.cache_control).length;
    expect(systemBreakpoints + toolBreakpoints + convBreakpoints).toBeLessThanOrEqual(4);
    expect(convBreakpoints).toBe(2);
  });

  it('should keep conversation breakpoint positions stable as conversation grows (no shift)', async () => {
    const tools = [
      { name: 'read_file', description: 'd', parameters: { type: 'object', properties: {}, required: [] } },
    ];
    const body3 = await captureAnthropicBody(buildTurns(4), tools); // 4 轮：断点落在第 3 轮末
    const body6 = await captureAnthropicBody(buildTurns(7), tools); // 7 轮：断点落在第 3、6 轮末
    // 第 3 轮末在两种长度下应都位于 conv[5]
    expect((body3.messages as any[])[5].content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect((body6.messages as any[])[5].content[0].cache_control).toEqual({ type: 'ephemeral' });
  });
});

// ---------------------------------------------------------------------------
// E2E-2 cache 命中字段透传到 StreamDoneEvent（通过 ReasoningLoop 全链路）
// ---------------------------------------------------------------------------
describe('E2E-2 cache 命中透传', () => {
  it('should passthrough cacheReadInputTokens / cacheCreationInputTokens to final done event', async () => {
    const { loop, provider } = makeLoop({
      nextUsage: {
        inputTokens: 200,
        outputTokens: 15,
        cacheReadInputTokens: 150,
        cacheCreationInputTokens: 50,
      },
    });
    provider.capturedMessages = []; // reset
    const events: StreamEvent[] = [];
    await loop.run('hi', (e) => events.push(e));

    const done = events.find((e) => e.type === 'done');
    expect(done?.type).toBe('done');
    if (done?.type === 'done') {
      expect(done.usage?.inputTokens).toBe(200);
      expect(done.usage?.outputTokens).toBe(15);
      expect(done.usage?.cacheReadInputTokens).toBe(150);
      expect(done.usage?.cacheCreationInputTokens).toBe(50);
    }
  });
});

// ---------------------------------------------------------------------------
// E2E-3 env_info 注入：装配 ContextManager + PromptComposer 的 ReasoningLoop
// 发给 provider 的消息序列含 kind:'env_info'，且 content 含 cwd/OS
// ---------------------------------------------------------------------------
describe('E2E-3 env_info 注入', () => {
  it('should inject kind:env_info message into provider-bound sequence with cwd/OS', async () => {
    const { loop, provider } = makeLoop();
    const events: StreamEvent[] = [];
    await loop.run('hi', (e) => events.push(e));

    // provider 应收到含 env_info 的消息序列
    const envInfoMsg = provider.capturedMessages.find(
      (m) => m.role === 'system' && m.kind === 'env_info',
    );
    expect(envInfoMsg).toBeDefined();
    expect(envInfoMsg?.content).toContain('工作目录');
    expect(envInfoMsg?.content).toContain('操作系统');
    expect(envInfoMsg?.content).not.toContain('当前时间');
    expect(envInfoMsg?.content).not.toContain('时区');
  });

  it('should place env_info after stable system and before user history', async () => {
    const { loop, provider } = makeLoop();
    await loop.run('hi', () => {});

    const msgs = provider.capturedMessages;
    expect(msgs.length).toBeGreaterThanOrEqual(3);
    // 首条应为稳定 system（无 kind）
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[0]!.kind).toBeUndefined();
    // 次条应为 env_info
    expect(msgs[1]!.role).toBe('system');
    expect(msgs[1]!.kind).toBe('env_info');
    // 其后是 user 消息
    expect(msgs[2]!.role).toBe('user');
  });

  it('should not duplicate stable system (old stable system filtered from history)', async () => {
    const { loop, provider } = makeLoop();
    await loop.run('hi', () => {});

    // memory.setSystem 写入的稳定 system 应被 PromptComposer 过滤，
    // 只保留 composer 持有的那份（首位），不重复出现
    const stableSystemMsgs = provider.capturedMessages.filter(
      (m) => m.role === 'system' && m.kind === undefined,
    );
    expect(stableSystemMsgs.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// E2E-6 兼容性：loadStableSystem 优先 loadRole、缺省回退 loadSystemPrompt
// ---------------------------------------------------------------------------
describe('E2E-6 loadStableSystem 兼容性', () => {
  it('should prefer loadRole when present', async () => {
    const role = {
      meta: { id: 'test', name: 'Test', description: 'd' },
      loadRole: async () => 'FROM_LOAD_ROLE',
      loadSystemPrompt: async () => 'FROM_LOAD_SYSTEM_PROMPT',
    };
    const result = await loadStableSystem(role);
    expect(result).toBe('FROM_LOAD_ROLE');
  });

  it('should fall back to loadSystemPrompt when loadRole absent (unrefactored role compat)', async () => {
    const role = {
      meta: { id: 'legacy', name: 'Legacy', description: 'd' },
      loadSystemPrompt: async () => 'FROM_LOAD_SYSTEM_PROMPT',
    };
    const result = await loadStableSystem(role);
    expect(result).toBe('FROM_LOAD_SYSTEM_PROMPT');
  });

  it('should load coding role stable system via registry (integration)', async () => {
    const { getRole } = await import('../../agent-roles/roles-registry.ts');
    const role = getRole('coding');
    const stable = await loadStableSystem(role);
    expect(stable.length).toBeGreaterThan(0);
    // coding 角色模块化拼装结果应含身份段关键词
    expect(stable).toContain('Coding Assistant');
  });
});

// ---------------------------------------------------------------------------
// E2E-4 节奏控制（通过 ReasoningLoop 全链路验证 mode_reminder 节奏）
// ---------------------------------------------------------------------------
describe('E2E-4 节奏控制（全链路）', () => {
  /** 多轮 provider：前 N 轮发起工具调用，最后一轮给最终回复 */
  class MultiRoundProvider implements ILLMProvider {
    readonly protocol = 'mock';
    constructor(private readonly toolRounds: number) {}
    private i = 0;
    capturedPerRound: ChatMessage[][] = [];
    async streamChat(params: StreamChatParams, onEvent: StreamCallback): Promise<void> {
      this.capturedPerRound.push(params.messages);
      this.i++;
      if (this.i <= this.toolRounds) {
        onEvent({ type: 'tool_call', id: `c${this.i}`, name: 'noop', arguments: '{}' });
      } else {
        onEvent({ type: 'text_delta', delta: 'done' });
      }
      onEvent({ type: 'done' });
    }
  }

  it('should inject full mode_reminder on round 1 and concise on round 2+ in plan mode', async () => {
    const memory = new ConversationMemory();
    memory.setSystem('SYS');
    const provider = new MultiRoundProvider(2); // 2 轮工具 + 1 轮最终 = 3 轮
    const contextManager = new ContextManager();
    const composer = new PromptComposer('SYS');
    const loop = new ReasoningLoop({
      provider,
      config: fakeConfig,
      memory,
      composer,
      contextManager,
      loop: { mode: 'plan' },
    });

    const tools = new (await import('../modules/tools/tool-registry.ts')).ToolRegistry();
    tools.register({
      name: 'noop',
      description: 'noop',
      parameters: { type: 'object' },
      mutates: false,
      execute: async () => ({ ok: true, content: 'ok' }),
    });
    // 重新构造带工具的 loop
    const loopWithTools = new ReasoningLoop({
      provider,
      config: fakeConfig,
      memory: new ConversationMemory(),
      composer,
      contextManager,
      tools,
      executor: new (await import('../modules/tools/tool-executor.ts')).ToolExecutor(tools, { cwd: process.cwd() }),
      loop: { mode: 'plan' },
    });
    await loopWithTools.run('go', () => {});

    // 至少捕获了 3 轮消息
    expect(provider.capturedPerRound.length).toBeGreaterThanOrEqual(3);
    // 第 1 轮的 mode_reminder 应为完整指令（含"PLAN 模式"说明，多行）
    const round1Reminder = provider.capturedPerRound[0]!.find(
      (m) => m.role === 'system' && m.kind === 'mode_reminder',
    );
    expect(round1Reminder).toBeDefined();
    expect(round1Reminder?.content).toContain('PLAN');
    expect(round1Reminder?.content.split('\n').length).toBeGreaterThanOrEqual(3);
    // 第 2 轮的 mode_reminder 应为精简指令（单行）
    const round2Reminder = provider.capturedPerRound[1]!.find(
      (m) => m.role === 'system' && m.kind === 'mode_reminder',
    );
    expect(round2Reminder).toBeDefined();
    expect(round2Reminder?.content).toContain('PLAN');
    expect(round2Reminder?.content.split('\n').length).toBeLessThanOrEqual(2);
  });

  it('should inject mode_reminder in agent mode to inform model of current mode', async () => {
    const memory = new ConversationMemory();
    memory.setSystem('SYS');
    const provider = new MultiRoundProvider(0);
    const composer = new PromptComposer('SYS');
    const contextManager = new ContextManager();
    const loop = new ReasoningLoop({
      provider,
      config: fakeConfig,
      memory,
      composer,
      contextManager,
      loop: { mode: 'agent' },
    });
    await loop.run('hi', () => {});

    expect(provider.capturedPerRound.length).toBeGreaterThanOrEqual(1);
    const reminder = provider.capturedPerRound[0]!.find(
      (m) => m.role === 'system' && m.kind === 'mode_reminder',
    );
    expect(reminder).toBeDefined();
    expect(reminder?.content).toContain('AGENT');

    // mode_reminder 位于本轮消息末尾（需求：每轮消息最后，且位于工具缓存断点之后）
    const msgs = provider.capturedPerRound[0]!;
    const lastMsg = msgs[msgs.length - 1]!;
    expect(lastMsg.role).toBe('system');
    expect(lastMsg.kind).toBe('mode_reminder');
  });
});
