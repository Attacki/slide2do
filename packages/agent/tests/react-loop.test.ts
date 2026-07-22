/**
 * ReasoningLoop 单元测试
 *
 * 覆盖：
 *  - groupToolCalls 纯函数：全读 / 全写 / 混合 / 未知工具 / 顺序保持
 *  - 状态机终止：no_tool_call / max_rounds / cancelled(预取消 + 中途取消) / timeout
 *  - 运行模式：ask/plan 拦截写类、agent 放行、无 composer 时不注入模式指令（composer 注入由任务 7 覆盖）、planOnly 兼容、setMode 切换
 *  - 事件顺序：tool_call → tool_call_start → tool_result
 *
 * 全部离线，使用脚本化 mock provider 与内存工具，不依赖网络。
 */
import { describe, it, expect } from 'bun:test';
import { ReasoningLoop, groupToolCalls } from '../reasoning-loop.ts';
import { ConversationMemory } from '../modules/memory/memory-manger.ts';
import { PromptComposer } from '../prompt/prompt-composer.ts';
import { ContextManager } from '../modules/context/context-manger.ts';
import { ToolRegistry } from '../modules/tools/tool-registry.ts';
import { ToolExecutor } from '../modules/tools/tool-executor.ts';
import type { ILLMProvider, StreamCallback, StreamChatParams } from '../provider/base.ts';
import type { LLMConfig } from '../utils/config/config-types.ts';
import type { ChatMessage, StreamEvent } from '../ui-pattern.ts';
import type { Tool, ToolContext, ToolResult } from '@wuzi/types';
import type { RawToolCall } from '../modules/tools/tool-call-accumulator.ts';

const fakeConfig = {
  protocol: 'mock',
  model: 'm',
  base_url: 'http://localhost',
  api_key: 'k',
} as unknown as LLMConfig;

/** 单轮脚本：向回调发出该轮的 provider 事件 */
type RoundScript = (emit: StreamCallback) => void;

/** 脚本化 Provider：按轮播放预设脚本；loopLast=true 时末轮脚本无限复用 */
class ScriptedProvider implements ILLMProvider {
  readonly protocol = 'mock';
  private i = 0;
  constructor(
    private readonly scripts: RoundScript[],
    private readonly loopLast = false,
  ) {}
  async streamChat(_params: StreamChatParams, onEvent: StreamCallback): Promise<void> {
    let script = this.scripts[this.i];
    if (!script && this.loopLast) script = this.scripts[this.scripts.length - 1];
    this.i++;
    if (script) script(onEvent);
    else onEvent({ type: 'done' });
  }
}

/** 脚本构造助手 */
const emitText =
  (text: string): RoundScript =>
  (emit) => {
    emit({ type: 'text_delta', delta: text });
    emit({ type: 'done' });
  };
const emitToolCall =
  (id: string, name: string, args: Record<string, unknown> = {}): RoundScript =>
  (emit) => {
    emit({ type: 'tool_call', id, name, arguments: JSON.stringify(args) });
    emit({ type: 'done' });
  };

/** 构造 mock 工具（可注入执行副作用/spy） */
function makeTool(
  name: string,
  mutates: boolean,
  execute: (params: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>,
): Tool {
  return { name, description: name, parameters: { type: 'object' }, mutates, execute };
}

function makeLoop(
  scripts: RoundScript[],
  opts: { tools?: ToolRegistry; loopLast?: boolean; loop?: ConstructorParameters<typeof ReasoningLoop>[0]['loop'] } = {},
) {
  const memory = new ConversationMemory();
  memory.setSystem('sys');
  const provider = new ScriptedProvider(scripts, opts.loopLast);
  const executor = opts.tools ? new ToolExecutor(opts.tools, { cwd: process.cwd() }) : undefined;
  return new ReasoningLoop({
    provider,
    config: fakeConfig,
    memory,
    tools: opts.tools,
    executor,
    loop: opts.loop,
  });
}

const raw = (id: string, name: string): RawToolCall => ({ id, name, arguments: '{}' });

// ---------------------------------------------------------------------------
// groupToolCalls 纯函数
// ---------------------------------------------------------------------------
describe('groupToolCalls', () => {
  const isMut = (name: string) => name.startsWith('w_');

  it('should put all into reads when no tool mutates', () => {
    const g = groupToolCalls([raw('1', 'r_a'), raw('2', 'r_b')], isMut);
    expect(g.reads.length).toBe(2);
    expect(g.writes.length).toBe(0);
  });

  it('should put all into writes when all tools mutate', () => {
    const g = groupToolCalls([raw('1', 'w_a'), raw('2', 'w_b')], isMut);
    expect(g.reads.length).toBe(0);
    expect(g.writes.length).toBe(2);
  });

  it('should split mixed calls and preserve original order', () => {
    const g = groupToolCalls([raw('1', 'r_a'), raw('2', 'w_b'), raw('3', 'r_c')], isMut);
    expect(g.reads.map((c) => c.id)).toEqual(['1', '3']);
    expect(g.writes.map((c) => c.id)).toEqual(['2']);
  });

  it('should treat unknown tool (isMutating=false) as read', () => {
    const g = groupToolCalls([raw('1', 'unknown_tool')], isMut);
    expect(g.reads.length).toBe(1);
    expect(g.writes.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 状态机终止
// ---------------------------------------------------------------------------
describe('ReasoningLoop 终止状态机', () => {
  it('should terminate with no_tool_call and emit final_answer when no tools requested', async () => {
    const loop = makeLoop([emitText('done here')]);
    const events: StreamEvent[] = [];
    const reason = await loop.run('hi', (e) => events.push(e));
    expect(reason).toBe('no_tool_call');
    const final = events.find((e) => e.type === 'final_answer');
    expect(final && final.type === 'final_answer' ? final.text : '').toBe('done here');
  });

  it('should terminate with max_rounds when tools loop forever', async () => {
    const tools = new ToolRegistry();
    let reads = 0;
    tools.register(
      makeTool('r_loop', false, async () => {
        reads++;
        return { ok: true, content: 'r-ok' };
      }),
    );
    const loop = makeLoop([emitToolCall('c', 'r_loop')], {
      tools,
      loopLast: true,
      loop: { maxRounds: 3 },
    });
    const events: StreamEvent[] = [];
    const reason = await loop.run('go', (e) => events.push(e));
    expect(reason).toBe('max_rounds');
    expect(reads).toBe(3);
    const term = events.find((e) => e.type === 'loop_terminated');
    expect(term && term.type === 'loop_terminated' ? term.rounds : -1).toBe(3);
  });

  it('should terminate with cancelled when signal aborted before run', async () => {
    const loop = makeLoop([emitText('never')]);
    const ac = new AbortController();
    ac.abort();
    const events: StreamEvent[] = [];
    const reason = await loop.run('hi', (e) => events.push(e), { signal: ac.signal });
    expect(reason).toBe('cancelled');
    const term = events.find((e) => e.type === 'loop_terminated');
    expect(term && term.type === 'loop_terminated' ? term.reason : '').toBe('cancelled');
  });

  it('should terminate with cancelled when aborted mid tool execution', async () => {
    const tools = new ToolRegistry();
    tools.register(
      makeTool('r_slow', false, async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { ok: true, content: 'slow' };
      }),
    );
    const loop = makeLoop([emitToolCall('c', 'r_slow')], { tools, loopLast: true });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const reason = await loop.run('go', () => {}, { signal: ac.signal });
    expect(reason).toBe('cancelled');
  });

  it('should terminate with timeout when built-in timeoutMs elapses', async () => {
    const tools = new ToolRegistry();
    tools.register(
      makeTool('r_slow', false, async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { ok: true, content: 'slow' };
      }),
    );
    const loop = makeLoop([emitToolCall('c', 'r_slow')], {
      tools,
      loopLast: true,
      loop: { timeoutMs: 50 },
    });
    const reason = await loop.run('go', () => {});
    expect(reason).toBe('timeout');
  });

  it('should emit maxRounds in loop_terminated event', async () => {
    const loop = makeLoop([emitText('done')], {
      loop: { maxRounds: 10 },
    });
    const events: StreamEvent[] = [];
    await loop.run('hi', (e) => events.push(e));
    const term = events.find((e) => e.type === 'loop_terminated');
    expect(term?.type).toBe('loop_terminated');
    if (term?.type === 'loop_terminated') {
      expect(term.maxRounds).toBe(10);
    }
  });
});

// ---------------------------------------------------------------------------
// 运行模式（agent / ask / plan）
// ---------------------------------------------------------------------------
describe('ReasoningLoop 运行模式', () => {
  it('should block write tool in plan mode, then continue to final answer', async () => {
    const tools = new ToolRegistry();
    let writes = 0;
    tools.register(
      makeTool('w_edit', true, async () => {
        writes++;
        return { ok: true, content: 'wrote' };
      }),
    );
    // 第1轮请求写工具，第2轮给出计划文本
    const loop = makeLoop([emitToolCall('c', 'w_edit'), emitText('here is the plan')], {
      tools,
      loop: { mode: 'plan' },
    });
    const events: StreamEvent[] = [];
    const reason = await loop.run('edit file', (e) => events.push(e));

    expect(writes).toBe(0); // 写工具未执行
    expect(events.some((e) => e.type === 'plan_blocked')).toBe(true);
    expect(reason).toBe('no_tool_call');
    const final = events.find((e) => e.type === 'final_answer');
    expect(final && final.type === 'final_answer' ? final.text : '').toBe('here is the plan');
  });

  it('should block write tool in ask mode as well', async () => {
    const tools = new ToolRegistry();
    let writes = 0;
    tools.register(
      makeTool('w_edit', true, async () => {
        writes++;
        return { ok: true, content: 'wrote' };
      }),
    );
    const loop = makeLoop([emitToolCall('c', 'w_edit'), emitText('answer')], {
      tools,
      loop: { mode: 'ask' },
    });
    const events: StreamEvent[] = [];
    await loop.run('do it', (e) => events.push(e));
    expect(writes).toBe(0);
    expect(events.some((e) => e.type === 'plan_blocked')).toBe(true);
  });

  it('should allow write tool in agent mode (default)', async () => {
    const tools = new ToolRegistry();
    let writes = 0;
    tools.register(
      makeTool('w_edit', true, async () => {
        writes++;
        return { ok: true, content: 'wrote' };
      }),
    );
    const loop = makeLoop([emitToolCall('c', 'w_edit'), emitText('done')], { tools });
    const events: StreamEvent[] = [];
    await loop.run('edit file', (e) => events.push(e));
    expect(writes).toBe(1); // 写工具被执行
    expect(events.some((e) => e.type === 'plan_blocked')).toBe(false);
  });

  it('should map deprecated planOnly:true to plan mode', async () => {
    const tools = new ToolRegistry();
    let writes = 0;
    tools.register(
      makeTool('w_edit', true, async () => {
        writes++;
        return { ok: true, content: 'wrote' };
      }),
    );
    const loop = makeLoop([emitToolCall('c', 'w_edit'), emitText('plan')], {
      tools,
      loop: { planOnly: true },
    });
    expect(loop.getMode()).toBe('plan');
    await loop.run('edit', () => {});
    expect(writes).toBe(0);
  });

  it('should switch mode at runtime via setMode', async () => {
    const loop = makeLoop([emitText('ok')]);
    expect(loop.getMode()).toBe('agent');
    loop.setMode('ask');
    expect(loop.getMode()).toBe('ask');
    loop.setMode('agent');
    expect(loop.getMode()).toBe('agent');
  });
});

// ---------------------------------------------------------------------------
// 模式指令注入（无 composer 兼容路径）
// ---------------------------------------------------------------------------
describe('ReasoningLoop 模式指令注入（无 composer）', () => {
  /** 捕获每轮发送给 provider 的 messages 快照 */
  class CapturingProvider implements ILLMProvider {
    readonly protocol = 'mock';
    readonly rounds: ChatMessage[][] = [];
    async streamChat(params: StreamChatParams, onEvent: StreamCallback): Promise<void> {
      this.rounds.push(params.messages.map((m) => ({ ...m })));
      emitText('done')(onEvent);
    }
  }

  function loopWith(provider: ILLMProvider, mode: 'agent' | 'ask' | 'plan') {
    const memory = new ConversationMemory();
    memory.setSystem('sys');
    return new ReasoningLoop({ provider, config: fakeConfig, memory, loop: { mode } });
  }

  it('should not inject any directive in agent mode', async () => {
    const provider = new CapturingProvider();
    await loopWith(provider, 'agent').run('hello', () => {});
    const last = provider.rounds[0]!.at(-1)!;
    expect(last.content).toBe('hello');
  });

  it('should not inject plan directive without composer', async () => {
    const provider = new CapturingProvider();
    await loopWith(provider, 'plan').run('hello', () => {});
    const msgs = provider.rounds[0]!;
    const last = msgs.at(-1)!;
    // 无 composer 时不再追加 directive 文本（mode_reminder 由任务 7 通过 composer 注入）
    expect(last.role).toBe('user');
    expect(last.content).toBe('hello');
    expect(msgs[0]!.content).toBe('sys');
  });

  it('should not inject ask directive without composer', async () => {
    const provider = new CapturingProvider();
    await loopWith(provider, 'ask').run('hello', () => {});
    const last = provider.rounds[0]!.at(-1)!;
    expect(last.content).toBe('hello');
  });

  it('should keep memory clean without composer injection', async () => {
    const provider = new CapturingProvider();
    const memory = new ConversationMemory();
    memory.setSystem('sys');
    const loop = new ReasoningLoop({ provider, config: fakeConfig, memory, loop: { mode: 'plan' } });
    await loop.run('hello', () => {});
    const userMsg = memory.getMessages().find((m) => m.role === 'user');
    expect(userMsg?.content).toBe('hello'); // 记忆保持干净，无注入残留
  });
});

// ---------------------------------------------------------------------------
// Composer 装配路径（稳定 system + env_info + 旧 system 过滤）
// ---------------------------------------------------------------------------
describe('ReasoningLoop composer 装配路径', () => {
  class CapturingProvider implements ILLMProvider {
    readonly protocol = 'mock';
    readonly rounds: ChatMessage[][] = [];
    async streamChat(params: StreamChatParams, onEvent: StreamCallback): Promise<void> {
      this.rounds.push(params.messages.map((m) => ({ ...m })));
      emitText('done')(onEvent);
    }
  }

  it('should compose stable system + env_info + history when composer wired', async () => {
    const provider = new CapturingProvider();
    const memory = new ConversationMemory();
    memory.setSystem('legacy-sys'); // 旧稳定 system（无 kind），应被 composer 过滤
    const composer = new PromptComposer('stable-role');
    const ctx = new ContextManager();
    const loop = new ReasoningLoop({
      provider,
      config: fakeConfig,
      memory,
      composer,
      contextManager: ctx,
    });
    await loop.run('hi', () => {});
    const msgs = provider.rounds[0]!;

    // 稳定 system 在最前（由 composer 持有）
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[0]!.content).toBe('stable-role');
    // env_info 紧随其后（kind=env_info）
    expect(msgs[1]!.kind).toBe('env_info');
    expect(msgs[1]!.role).toBe('system');
    // 旧稳定 system 被过滤，不再出现
    expect(msgs.find((m) => m.content === 'legacy-sys')).toBeUndefined();
    // user 消息保留
    const userMsg = msgs.find((m) => m.role === 'user');
    expect(userMsg?.content).toBe('hi');
    // 默认 agent 模式也会注入 mode_reminder（位于末尾），保证模型知晓当前模式
    const reminder = msgs.find((m) => m.kind === 'mode_reminder');
    expect(reminder).toBeDefined();
    expect(reminder!.content).toContain('AGENT');
  });

  it('should keep memory clean (composer output is a copy, not persisted)', async () => {
    const provider = new CapturingProvider();
    const memory = new ConversationMemory();
    memory.setSystem('legacy-sys');
    const composer = new PromptComposer('stable-role');
    const ctx = new ContextManager();
    const loop = new ReasoningLoop({
      provider,
      config: fakeConfig,
      memory,
      composer,
      contextManager: ctx,
    });
    await loop.run('hi', () => {});
    // memory 不含 env_info / stable-role（composer 输出仅作用于副本）
    expect(memory.getMessages().find((m) => m.kind === 'env_info')).toBeUndefined();
    expect(memory.getMessages().find((m) => m.content === 'stable-role')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 模式提醒节奏控制（composer 装配路径）
// ---------------------------------------------------------------------------
describe('ReasoningLoop 模式提醒节奏控制', () => {
  /** 按脚本播放并捕获每轮 messages 快照的 Provider */
  class CapturingProvider implements ILLMProvider {
    readonly protocol = 'mock';
    readonly rounds: ChatMessage[][] = [];
    private i = 0;
    constructor(private readonly scripts: RoundScript[], private readonly loopLast = false) {}
    async streamChat(params: StreamChatParams, onEvent: StreamCallback): Promise<void> {
      this.rounds.push(params.messages.map((m) => ({ ...m })));
      let script = this.scripts[this.i];
      if (!script && this.loopLast) script = this.scripts[this.scripts.length - 1];
      this.i++;
      if (script) script(onEvent);
      else onEvent({ type: 'done' });
    }
  }

  function makeComposerLoop(
    provider: ILLMProvider,
    opts: { mode?: 'agent' | 'ask' | 'plan'; tools?: ToolRegistry } = {},
  ): { loop: ReasoningLoop; memory: ConversationMemory } {
    const memory = new ConversationMemory();
    memory.setSystem('sys');
    const composer = new PromptComposer('stable-role');
    const loop = new ReasoningLoop({
      provider,
      config: fakeConfig,
      memory,
      composer,
      loop: { mode: opts.mode ?? 'agent' },
      tools: opts.tools,
      executor: opts.tools ? new ToolExecutor(opts.tools, { cwd: process.cwd() }) : undefined,
    });
    return { loop, memory };
  }

  const reminderOf = (msgs: ChatMessage[]) => msgs.find((m) => m.kind === 'mode_reminder');

  it('should inject AGENT mode_reminder on first round in agent mode', async () => {
    const provider = new CapturingProvider([emitText('ok')]);
    const { loop } = makeComposerLoop(provider, { mode: 'agent' });
    await loop.run('hi', () => {});
    const reminder = reminderOf(provider.rounds[0]!);
    expect(reminder).toBeDefined();
    expect(reminder!.content).toContain('AGENT');
    expect(reminder!.content).toContain('系统提示'); // 完整指令前缀
  });

  it('should inject concise AGENT reminder on later rounds (no mode change)', async () => {
    const tools = new ToolRegistry();
    tools.register(makeTool('r_a', false, async () => ({ ok: true, content: 'ok' })));
    const provider = new CapturingProvider([emitToolCall('c1', 'r_a'), emitText('done')]);
    const { loop } = makeComposerLoop(provider, { mode: 'agent', tools });
    await loop.run('go', () => {});
    const r2 = reminderOf(provider.rounds[1]!);
    expect(r2).toBeDefined();
    expect(r2!.content).toContain('模式提醒'); // 精简
    expect(r2!.content).not.toContain('系统提示');
  });

  it('should inject full mode_reminder on first round in plan mode', async () => {
    const provider = new CapturingProvider([emitText('plan-ok')]);
    const { loop } = makeComposerLoop(provider, { mode: 'plan' });
    await loop.run('hi', () => {});
    const reminder = reminderOf(provider.rounds[0]!);
    expect(reminder).toBeDefined();
    expect(reminder!.role).toBe('system');
    expect(reminder!.content).toContain('PLAN');
    expect(reminder!.content).toContain('系统提示'); // 完整指令前缀
  });

  it('should inject full on round 1 and concise on round 2 (no mode change)', async () => {
    const tools = new ToolRegistry();
    tools.register(makeTool('r_a', false, async () => ({ ok: true, content: 'ok' })));
    const provider = new CapturingProvider([emitToolCall('c1', 'r_a'), emitText('done')]);
    const { loop } = makeComposerLoop(provider, { mode: 'plan', tools });
    await loop.run('go', () => {});

    const r1 = reminderOf(provider.rounds[0]!)!;
    expect(r1.content).toContain('系统提示'); // 完整

    const r2 = reminderOf(provider.rounds[1]!)!;
    expect(r2).toBeDefined();
    expect(r2.content).toContain('模式提醒'); // 精简
    expect(r2.content).not.toContain('系统提示');
  });

  it('should inject full with new mode label after mode switch', async () => {
    const provider = new CapturingProvider([emitText('a1'), emitText('a2')]);
    const { loop } = makeComposerLoop(provider, { mode: 'plan' });
    await loop.run('first', () => {}); // plan round 1 (full PLAN)
    loop.setMode('ask'); // 切换 → modeChanged=true
    await loop.run('second', () => {}); // ask round 1 (firstRound → full ASK)

    const r2 = reminderOf(provider.rounds[1]!)!;
    expect(r2.content).toContain('ASK');
    expect(r2.content).toContain('系统提示'); // 切换后首轮完整
  });

  it('should not mark modeChanged when setting same mode', async () => {
    const tools = new ToolRegistry();
    tools.register(makeTool('r_a', false, async () => ({ ok: true, content: 'ok' })));
    const provider = new CapturingProvider([emitToolCall('c1', 'r_a'), emitText('done')]);
    const { loop } = makeComposerLoop(provider, { mode: 'plan', tools });
    loop.setMode('plan'); // 同模式，不应触发 modeChanged
    await loop.run('go', () => {});
    // round 1: firstRound → full
    expect(reminderOf(provider.rounds[0]!)!.content).toContain('系统提示');
    // round 2: 非首轮且 modeChanged=false → 精简
    expect(reminderOf(provider.rounds[1]!)!.content).toContain('模式提醒');
  });

  it('should not persist mode_reminder into memory', async () => {
    const provider = new CapturingProvider([emitText('ok')]);
    const { loop, memory } = makeComposerLoop(provider, { mode: 'plan' });
    await loop.run('hi', () => {});
    expect(memory.getMessages().find((m) => m.kind === 'mode_reminder')).toBeUndefined();
    expect(memory.getMessages().find((m) => m.role === 'user')?.content).toBe('hi');
  });

  it('should place mode_reminder at the end of composed messages', async () => {
    const provider = new CapturingProvider([emitText('ok')]);
    const { loop } = makeComposerLoop(provider, { mode: 'ask' });
    await loop.run('hi', () => {});
    const msgs = provider.rounds[0]!;
    const last = msgs.at(-1)!;
    expect(last.kind).toBe('mode_reminder');
    expect(last.content).toContain('ASK');
  });
});

// ---------------------------------------------------------------------------
// 事件顺序
// ---------------------------------------------------------------------------
describe('ReasoningLoop 事件顺序', () => {
  it('should emit tool_call -> tool_call_start -> tool_result in order', async () => {
    const tools = new ToolRegistry();
    tools.register(makeTool('r_a', false, async () => ({ ok: true, content: 'ok' })));
    // 第1轮请求工具，第2轮结束
    const loop = makeLoop([emitToolCall('c1', 'r_a'), emitText('bye')], { tools });
    const events: StreamEvent[] = [];
    await loop.run('go', (e) => events.push(e));

    const order = events
      .filter((e) => e.type === 'tool_call' || e.type === 'tool_call_start' || e.type === 'tool_result')
      .map((e) => e.type);
    expect(order).toEqual(['tool_call', 'tool_call_start', 'tool_result']);
  });
});

// ---------------------------------------------------------------------------
// usage 透传（含 Anthropic prompt caching 字段）
// ---------------------------------------------------------------------------
describe('ReasoningLoop usage 透传', () => {
  /** 脚本：发出 text 后带 usage 的 done（含 cache 字段） */
  const emitTextWithCacheUsage =
    (text: string): RoundScript =>
    (emit) => {
      emit({ type: 'text_delta', delta: text });
      emit({
        type: 'done',
        usage: {
          inputTokens: 100,
          outputTokens: 8,
          cacheReadInputTokens: 60,
          cacheCreationInputTokens: 30,
        },
      });
    };

  it('should passthrough cache usage fields to final done event (single round)', async () => {
    const loop = makeLoop([emitTextWithCacheUsage('answer')]);
    const events: StreamEvent[] = [];
    await loop.run('hi', (e) => events.push(e));
    const done = events.find((e) => e.type === 'done');
    expect(done?.type).toBe('done');
    if (done?.type === 'done') {
      expect(done.usage).toBeDefined();
      expect(done.usage?.inputTokens).toBe(100);
      expect(done.usage?.outputTokens).toBe(8);
      expect(done.usage?.cacheReadInputTokens).toBe(60);
      expect(done.usage?.cacheCreationInputTokens).toBe(30);
    }
  });

  it('should accumulate input/output tokens across rounds and keep first-seen cache values', async () => {
    // 第1轮：工具调用，带 cache usage；第2轮：最终回复，带不同 cache usage
    const tools = new ToolRegistry();
    tools.register(makeTool('r_a', false, async () => ({ ok: true, content: 'ok' })));
    const round1: RoundScript = (emit) => {
      emit({ type: 'tool_call', id: 'c1', name: 'r_a', arguments: '{}' });
      emit({
        type: 'done',
        usage: { inputTokens: 100, outputTokens: 5, cacheReadInputTokens: 60, cacheCreationInputTokens: 30 },
      });
    };
    const round2: RoundScript = (emit) => {
      emit({ type: 'text_delta', delta: 'final' });
      // 第二轮 cache_read 应增大（缓存已命中），但取首次值作为代表
      emit({
        type: 'done',
        usage: { inputTokens: 80, outputTokens: 10, cacheReadInputTokens: 90, cacheCreationInputTokens: 0 },
      });
    };
    const loop = makeLoop([round1, round2], { tools });
    const events: StreamEvent[] = [];
    await loop.run('go', (e) => events.push(e));
    const done = events.find((e) => e.type === 'done');
    expect(done?.type).toBe('done');
    if (done?.type === 'done') {
      expect(done.usage?.inputTokens).toBe(180); // 100 + 80
      expect(done.usage?.outputTokens).toBe(15); // 5 + 10
      expect(done.usage?.cacheReadInputTokens).toBe(60); // 取首次值
      expect(done.usage?.cacheCreationInputTokens).toBe(30); // 取首次值
    }
  });

  it('should emit done.usage undefined when provider gives no usage', async () => {
    // emitText 的 done 不带 usage
    const loop = makeLoop([emitText('answer')]);
    const events: StreamEvent[] = [];
    await loop.run('hi', (e) => events.push(e));
    const done = events.find((e) => e.type === 'done');
    expect(done?.type).toBe('done');
    if (done?.type === 'done') {
      expect(done.usage).toBeUndefined();
    }
  });
});
