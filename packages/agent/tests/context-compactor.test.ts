/**
 * ContextCompactor 单元测试
 *
 * 覆盖:
 * - C7.2 第一层:offloadEnabled=true 时遍历 assistant 消息(含 tool_calls)调
 *   singleMessageCompactor.compact;offloadEnabled=false 时跳过第一层
 * - C7.3 第二层触发:memory 总 token ≥ windowUsageThreshold * windowHardLimit 时调
 *   historyCompactor.compact
 * - C7.4 阈值未达:memory 总 token < 阈值时不调 historyCompactor.compact
 * - C7.5 熔断:historyCompactor 抛错连续失败达 summaryFailureThreshold(3)次后 tripped=true;
 *   后续 runCompaction 自动触发被跳过
 * - C7.6 forceCompact 跳过熔断:tripped=true 时 forceCompact 仍调 historyCompactor;
 *   失败不计入 consecutiveFailures
 * - C7.7 reset 清零:reset() 后 consecutiveFailures=0、tripped=false
 * - C7.8 异常归一化:runCompaction 内任何异常被 try/catch 归一化为「跳过本轮压缩」,
 *   不向调用方抛出
 *
 * 测试用 mock 实现 TokenCounter / ToolResultOffloader / SingleMessageCompactor /
 * HistoryCompactor,真实 ConversationMemory。
 */
import { describe, it, expect } from 'bun:test';
import type { ChatMessage } from '../ui-pattern.ts';
import { ConversationMemory } from '../modules/memory/memory-manger.ts';
import {
  ContextCompactor,
  type ContextCompactorDeps,
} from '../modules/context/context-compactor.ts';
import { DEFAULT_CONTEXT_CONFIG } from '../utils/config/config-types.ts';
import type { ContextConfig } from '@wuzi/types';

/**
 * mock TokenCounter:estimate 返回 text.length(1 字符/token),便于按字符阈值断言。
 *
 * 阈值 = windowUsageThreshold(0.8) * windowHardLimit(160000) = 128000,
 * 故构造 content 总长 > 128000 字符即可触发第二层。
 */
class MockTokenCounter {
  public estimateCalls: string[] = [];
  estimate(text: string): number {
    this.estimateCalls.push(text);
    return text.length;
  }
  calibrate(): void {}
  getFactor(): number {
    return 1.0;
  }
}

/** mock ToolResultOffloader:不实际写盘,返回模拟路径 */
class MockOffloader {
  public calls: Array<{ content: string; sessionId: string }> = [];
  async offload(content: string, sessionId: string): Promise<string> {
    this.calls.push({ content, sessionId });
    return `/mock/${sessionId}/001.txt`;
  }
}

/** mock SingleMessageCompactor:记录调用,可配置抛错或返回自定义结果 */
class MockSingleMessageCompactor {
  public callCount = 0;
  public lastAssistant?: ChatMessage;
  public lastTools?: ChatMessage[];
  public lastSessionId?: string;
  public shouldThrow?: Error;
  public nextResult?: { assistant: ChatMessage; tools: ChatMessage[] };

  constructor(opts?: {
    shouldThrow?: Error;
    nextResult?: { assistant: ChatMessage; tools: ChatMessage[] };
  }) {
    this.shouldThrow = opts?.shouldThrow;
    this.nextResult = opts?.nextResult;
  }

  async compact(
    assistant: ChatMessage,
    tools: ChatMessage[],
    sessionId: string,
  ): Promise<{ assistant: ChatMessage; tools: ChatMessage[] }> {
    this.callCount++;
    this.lastAssistant = assistant;
    this.lastTools = tools;
    this.lastSessionId = sessionId;
    if (this.shouldThrow) throw this.shouldThrow;
    if (this.nextResult) return this.nextResult;
    return { assistant, tools };
  }
}

/** mock HistoryCompactor:记录调用,可配置抛错或返回自定义结果 */
class MockHistoryCompactor {
  public callCount = 0;
  public lastMessages?: ChatMessage[];
  public lastSignal?: AbortSignal;
  public shouldThrow?: Error;
  public nextResult?: ChatMessage[];

  constructor(opts?: {
    shouldThrow?: Error;
    nextResult?: ChatMessage[];
  }) {
    this.shouldThrow = opts?.shouldThrow;
    this.nextResult = opts?.nextResult;
  }

  async compact(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): Promise<ChatMessage[]> {
    this.callCount++;
    this.lastMessages = messages;
    this.lastSignal = signal;
    if (this.shouldThrow) throw this.shouldThrow;
    if (this.nextResult) return this.nextResult;
    return messages;
  }
}

/** 构造一条 assistant 消息(含 tool_calls) */
function makeAssistant(
  toolCallIds: string[],
  content = 'calling tools',
): ChatMessage {
  return {
    role: 'assistant',
    content,
    tool_calls: toolCallIds.map(id => ({
      id,
      name: 'tool',
      arguments: '{}',
    })),
  };
}

/** 构造一条 tool 角色消息 */
function makeTool(id: string, content: string): ChatMessage {
  return { role: 'tool', content, tool_call_id: id };
}

/** 构造一条 user 消息 */
function makeUser(content: string): ChatMessage {
  return { role: 'user', content };
}

/** 构造一条 system 消息 */
function makeSystem(content: string): ChatMessage {
  return { role: 'system', content };
}

/** 构造 ContextCompactorDeps,允许覆盖各组件与配置 */
function makeDeps(opts: {
  config?: Partial<Required<ContextConfig>>;
  tokenCounter?: MockTokenCounter;
  offloader?: MockOffloader;
  singleMessageCompactor?: MockSingleMessageCompactor;
  historyCompactor?: MockHistoryCompactor;
}): ContextCompactorDeps {
  return {
    config: { ...DEFAULT_CONTEXT_CONFIG, ...opts.config },
    tokenCounter: opts.tokenCounter ?? new MockTokenCounter(),
    offloader: opts.offloader ?? new MockOffloader(),
    singleMessageCompactor:
      opts.singleMessageCompactor ?? new MockSingleMessageCompactor(),
    historyCompactor: opts.historyCompactor ?? new MockHistoryCompactor(),
  };
}

/** 构造超阈值 memory:content 总长 130000 字符 > 阈值 128000 */
function makeOversizedMemory(): ConversationMemory {
  const m = new ConversationMemory();
  m.append(makeUser('a'.repeat(130000)));
  return m;
}

describe('ContextCompactor - C7.2 第一层', () => {
  it('offloadEnabled=true 时遍历 assistant 消息(含 tool_calls)调 singleMessageCompactor.compact', async () => {
    const single = new MockSingleMessageCompactor();
    const compactor = new ContextCompactor(
      makeDeps({
        singleMessageCompactor: single,
        // 关闭第二层,避免干扰
        config: { offloadEnabled: true, compactionEnabled: false },
      }),
    );
    const memory = new ConversationMemory();
    memory.append(makeSystem('sys'));
    memory.append(makeUser('hello'));
    memory.append(makeAssistant(['t1']));
    memory.append(makeTool('t1', 'result1'));
    memory.append(makeAssistant(['t2', 't3']));
    memory.append(makeTool('t2', 'result2'));
    memory.append(makeTool('t3', 'result3'));

    await compactor.runCompaction(memory, { sessionId: 'session-A' });

    // compact 被调用 2 次(两组 assistant+tool)
    expect(single.callCount).toBe(2);
    // sessionId 透传
    expect(single.lastSessionId).toBe('session-A');
    // 最后一次调用的入参:assistant(t2,t3) + 2 条 tool
    expect(single.lastAssistant?.tool_calls?.length).toBe(2);
    expect(single.lastTools?.length).toBe(2);
  });

  it('offloadEnabled=false 时跳过第一层(singleMessageCompactor 未被调用)', async () => {
    const single = new MockSingleMessageCompactor();
    const compactor = new ContextCompactor(
      makeDeps({
        singleMessageCompactor: single,
        config: { offloadEnabled: false, compactionEnabled: false },
      }),
    );
    const memory = new ConversationMemory();
    memory.append(makeUser('hello'));
    memory.append(makeAssistant(['t1']));
    memory.append(makeTool('t1', 'result1'));

    await compactor.runCompaction(memory);

    expect(single.callCount).toBe(0);
  });

  it('第一层发生 offload 时,新 assistant 的 compacted 置 true,memory 被重建', async () => {
    const originalAssistant = makeAssistant(['t1']);
    const originalTool = makeTool('t1', 'long result');
    // mock 返回新的 tools(标记 compacted: true),模拟发生了 offload
    const newTool: ChatMessage = {
      ...originalTool,
      content: 'preview',
      compacted: true,
    };
    const single = new MockSingleMessageCompactor({
      nextResult: { assistant: originalAssistant, tools: [newTool] },
    });
    const compactor = new ContextCompactor(
      makeDeps({
        singleMessageCompactor: single,
        config: { offloadEnabled: true, compactionEnabled: false },
      }),
    );
    const memory = new ConversationMemory();
    memory.append(makeSystem('sys'));
    memory.append(originalAssistant);
    memory.append(originalTool);

    await compactor.runCompaction(memory);

    expect(single.callCount).toBe(1);
    const messages = memory.getMessages();
    // system 保留 + assistant(compacted=true) + tool(compacted=true)
    expect(messages.length).toBe(3);
    expect(messages[0]).toEqual(makeSystem('sys'));
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].compacted).toBe(true);
    expect(messages[2].role).toBe('tool');
    expect(messages[2].compacted).toBe(true);
    expect(messages[2].content).toBe('preview');
  });

  it('第一层中已 compacted 的 assistant 消息不被调 compact(幂等)', async () => {
    const single = new MockSingleMessageCompactor();
    const compactor = new ContextCompactor(
      makeDeps({
        singleMessageCompactor: single,
        config: { offloadEnabled: true, compactionEnabled: false },
      }),
    );
    const memory = new ConversationMemory();
    memory.append(makeUser('hello'));
    memory.append({ ...makeAssistant(['t1']), compacted: true });
    memory.append(makeTool('t1', 'result'));

    await compactor.runCompaction(memory);

    // compact 未被调用(因为 assistant 已 compacted)
    expect(single.callCount).toBe(0);
  });

  it('第一层中无 tool_calls 的 assistant 消息不被调 compact', async () => {
    const single = new MockSingleMessageCompactor();
    const compactor = new ContextCompactor(
      makeDeps({
        singleMessageCompactor: single,
        config: { offloadEnabled: true, compactionEnabled: false },
      }),
    );
    const memory = new ConversationMemory();
    memory.append(makeUser('hello'));
    memory.append({ role: 'assistant', content: 'no tools' });

    await compactor.runCompaction(memory);

    expect(single.callCount).toBe(0);
  });
});

describe('ContextCompactor - C7.3 第二层触发', () => {
  it('memory 总 token ≥ windowUsageThreshold * windowHardLimit 时调 historyCompactor.compact', async () => {
    const history = new MockHistoryCompactor();
    const compactor = new ContextCompactor(
      makeDeps({
        historyCompactor: history,
        // 关闭第一层,避免干扰
        config: { offloadEnabled: false, compactionEnabled: true },
      }),
    );
    // 阈值 = 0.8 * 160000 = 128000;MockTokenCounter.estimate = text.length
    // 构造 content 总长 130000 > 128000
    const memory = makeOversizedMemory();

    await compactor.runCompaction(memory);

    expect(history.callCount).toBe(1);
    expect(history.lastMessages?.length).toBe(1);
  });

  it('第二层成功后,memory 被替换为 compacted 结果,consecutiveFailures 清零', async () => {
    const newMessages: ChatMessage[] = [
      makeSystem('summary'),
      makeUser('compressed'),
    ];
    const history = new MockHistoryCompactor({ nextResult: newMessages });
    const compactor = new ContextCompactor(
      makeDeps({
        historyCompactor: history,
        config: { offloadEnabled: false, compactionEnabled: true },
      }),
    );
    const memory = makeOversizedMemory();

    await compactor.runCompaction(memory);

    expect(memory.getMessages()).toEqual(newMessages);
    expect(compactor.getConsecutiveFailures()).toBe(0);
  });

  it('signal 透传给 historyCompactor.compact', async () => {
    const history = new MockHistoryCompactor();
    const compactor = new ContextCompactor(
      makeDeps({
        historyCompactor: history,
        config: { offloadEnabled: false, compactionEnabled: true },
      }),
    );
    const controller = new AbortController();
    const memory = makeOversizedMemory();

    await compactor.runCompaction(memory, { signal: controller.signal });

    expect(history.lastSignal).toBe(controller.signal);
  });
});

describe('ContextCompactor - C7.4 阈值未达', () => {
  it('memory 总 token < 阈值时不调 historyCompactor.compact', async () => {
    const history = new MockHistoryCompactor();
    const compactor = new ContextCompactor(
      makeDeps({
        historyCompactor: history,
        config: { offloadEnabled: false, compactionEnabled: true },
      }),
    );
    const memory = new ConversationMemory();
    // content 总长 1000 < 128000
    memory.append(makeUser('a'.repeat(1000)));

    await compactor.runCompaction(memory);

    expect(history.callCount).toBe(0);
  });

  it('compactionEnabled=false 时第二层被跳过(historyCompactor 未被调用)', async () => {
    const history = new MockHistoryCompactor();
    const compactor = new ContextCompactor(
      makeDeps({
        historyCompactor: history,
        config: { offloadEnabled: false, compactionEnabled: false },
      }),
    );
    const memory = makeOversizedMemory();

    await compactor.runCompaction(memory);

    expect(history.callCount).toBe(0);
  });
});

describe('ContextCompactor - C7.5 熔断', () => {
  it('historyCompactor 连续失败达 summaryFailureThreshold(3)次后 tripped=true,后续 runCompaction 自动触发被跳过', async () => {
    const history = new MockHistoryCompactor({
      shouldThrow: new Error('summary fail'),
    });
    const compactor = new ContextCompactor(
      makeDeps({
        historyCompactor: history,
        config: {
          offloadEnabled: false,
          compactionEnabled: true,
          summaryFailureThreshold: 3,
        },
      }),
    );

    expect(compactor.isTripped()).toBe(false);
    expect(compactor.getConsecutiveFailures()).toBe(0);

    // 第 1 次失败
    await compactor.runCompaction(makeOversizedMemory());
    expect(compactor.getConsecutiveFailures()).toBe(1);
    expect(compactor.isTripped()).toBe(false);

    // 第 2 次失败
    await compactor.runCompaction(makeOversizedMemory());
    expect(compactor.getConsecutiveFailures()).toBe(2);
    expect(compactor.isTripped()).toBe(false);

    // 第 3 次失败 → 熔断
    await compactor.runCompaction(makeOversizedMemory());
    expect(compactor.getConsecutiveFailures()).toBe(3);
    expect(compactor.isTripped()).toBe(true);

    // 后续 runCompaction:historyCompactor 不再被调用(自动触发被跳过)
    const callCountBefore = history.callCount;
    await compactor.runCompaction(makeOversizedMemory());
    expect(history.callCount).toBe(callCountBefore); // 未增长
    // consecutiveFailures 不再增长(因为第二层直接跳过,未进入 compact 调用)
    expect(compactor.getConsecutiveFailures()).toBe(3);
  });

  it('熔断后第二层失败计数不再增长(自动触发被跳过)', async () => {
    const history = new MockHistoryCompactor({
      shouldThrow: new Error('summary fail'),
    });
    const compactor = new ContextCompactor(
      makeDeps({
        historyCompactor: history,
        config: {
          offloadEnabled: false,
          compactionEnabled: true,
          summaryFailureThreshold: 2,
        },
      }),
    );

    // 触发 2 次失败让 tripped=true
    await compactor.runCompaction(makeOversizedMemory());
    await compactor.runCompaction(makeOversizedMemory());
    expect(compactor.isTripped()).toBe(true);
    expect(compactor.getConsecutiveFailures()).toBe(2);

    // 后续多次 runCompaction:计数不再增长
    await compactor.runCompaction(makeOversizedMemory());
    await compactor.runCompaction(makeOversizedMemory());
    expect(compactor.getConsecutiveFailures()).toBe(2);
    expect(compactor.isTripped()).toBe(true);
  });
});

describe('ContextCompactor - C7.6 forceCompact 跳过熔断', () => {
  it('tripped=true 时 forceCompact 仍调 historyCompactor;失败不计入 consecutiveFailures', async () => {
    const history = new MockHistoryCompactor({
      shouldThrow: new Error('summary fail'),
    });
    const compactor = new ContextCompactor(
      makeDeps({
        historyCompactor: history,
        config: {
          offloadEnabled: false,
          compactionEnabled: true,
          summaryFailureThreshold: 3,
        },
      }),
    );

    // 先触发 3 次失败让 tripped=true
    await compactor.runCompaction(makeOversizedMemory());
    await compactor.runCompaction(makeOversizedMemory());
    await compactor.runCompaction(makeOversizedMemory());
    expect(compactor.isTripped()).toBe(true);
    expect(compactor.getConsecutiveFailures()).toBe(3);

    // forceCompact:historyCompactor 仍被调用(跳过熔断)
    const callCountBefore = history.callCount;
    const result = await compactor.forceCompact(makeOversizedMemory());
    expect(history.callCount).toBe(callCountBefore + 1); // 被调用
    expect(result).toBe(false); // 因为 shouldThrow,返回 false

    // 失败不计入 consecutiveFailures
    expect(compactor.getConsecutiveFailures()).toBe(3); // 仍是 3,未增长
    // tripped 保持原值
    expect(compactor.isTripped()).toBe(true);
  });

  it('forceCompact 成功时返回 true 并替换 memory 内容', async () => {
    const newMessages: ChatMessage[] = [
      makeSystem('summary'),
      makeUser('compressed'),
    ];
    const history = new MockHistoryCompactor({ nextResult: newMessages });
    const compactor = new ContextCompactor(
      makeDeps({
        historyCompactor: history,
        config: { offloadEnabled: false, compactionEnabled: true },
      }),
    );
    const memory = new ConversationMemory();
    memory.append(makeUser('a'.repeat(1000)));

    const result = await compactor.forceCompact(memory);

    expect(result).toBe(true);
    expect(memory.getMessages()).toEqual(newMessages);
  });

  it('forceCompact 跳过阈值检查(无论 memory 大小都触发)', async () => {
    const history = new MockHistoryCompactor();
    const compactor = new ContextCompactor(
      makeDeps({
        historyCompactor: history,
        config: { offloadEnabled: false, compactionEnabled: true },
      }),
    );
    const memory = new ConversationMemory();
    // content 总长很小,远小于阈值 128000
    memory.append(makeUser('a'.repeat(100)));

    // forceCompact 仍调用 historyCompactor(跳过阈值检查)
    await compactor.forceCompact(memory);

    expect(history.callCount).toBe(1);
  });

  it('forceCompact 不影响 tripped 状态(成功后 tripped 保持原值)', async () => {
    const newMessages: ChatMessage[] = [makeSystem('summary')];
    const history = new MockHistoryCompactor({ nextResult: newMessages });
    // 先让 history 抛错,触发熔断
    history.shouldThrow = new Error('fail');

    const compactor = new ContextCompactor(
      makeDeps({
        historyCompactor: history,
        config: {
          offloadEnabled: false,
          compactionEnabled: true,
          summaryFailureThreshold: 1,
        },
      }),
    );

    // 触发 1 次失败让 tripped=true(summaryFailureThreshold=1)
    await compactor.runCompaction(makeOversizedMemory());
    expect(compactor.isTripped()).toBe(true);

    // 清除 shouldThrow,让 forceCompact 成功(返回 nextResult)
    history.shouldThrow = undefined;
    const result = await compactor.forceCompact(makeOversizedMemory());
    expect(result).toBe(true);

    // tripped 保持原值(true),forceCompact 不影响 tripped 状态
    expect(compactor.isTripped()).toBe(true);
  });
});

describe('ContextCompactor - C7.7 reset 清零', () => {
  it('reset() 后 consecutiveFailures=0、tripped=false', async () => {
    const history = new MockHistoryCompactor({
      shouldThrow: new Error('fail'),
    });
    const compactor = new ContextCompactor(
      makeDeps({
        historyCompactor: history,
        config: {
          offloadEnabled: false,
          compactionEnabled: true,
          summaryFailureThreshold: 2,
        },
      }),
    );

    // 触发 2 次失败让 tripped=true
    await compactor.runCompaction(makeOversizedMemory());
    await compactor.runCompaction(makeOversizedMemory());
    expect(compactor.getConsecutiveFailures()).toBe(2);
    expect(compactor.isTripped()).toBe(true);

    // reset
    compactor.reset();
    expect(compactor.getConsecutiveFailures()).toBe(0);
    expect(compactor.isTripped()).toBe(false);

    // reset 后再次 runCompaction:historyCompactor 被调用(因为 tripped 已清零)
    const callCountBefore = history.callCount;
    await compactor.runCompaction(makeOversizedMemory());
    expect(history.callCount).toBe(callCountBefore + 1);
  });

  it('reset() 后再次失败从 0 开始计数', async () => {
    const history = new MockHistoryCompactor({
      shouldThrow: new Error('fail'),
    });
    const compactor = new ContextCompactor(
      makeDeps({
        historyCompactor: history,
        config: {
          offloadEnabled: false,
          compactionEnabled: true,
          summaryFailureThreshold: 3,
        },
      }),
    );

    // 触发 3 次失败让 tripped=true
    await compactor.runCompaction(makeOversizedMemory());
    await compactor.runCompaction(makeOversizedMemory());
    await compactor.runCompaction(makeOversizedMemory());
    expect(compactor.isTripped()).toBe(true);

    // reset
    compactor.reset();
    expect(compactor.getConsecutiveFailures()).toBe(0);
    expect(compactor.isTripped()).toBe(false);

    // 再次失败 1 次:计数从 0 开始,应变为 1
    await compactor.runCompaction(makeOversizedMemory());
    expect(compactor.getConsecutiveFailures()).toBe(1);
    expect(compactor.isTripped()).toBe(false);
  });
});

describe('ContextCompactor - C7.8 异常归一化', () => {
  it('第一层 singleMessageCompactor 抛错时,runCompaction 不抛出,继续第二层', async () => {
    const single = new MockSingleMessageCompactor({
      shouldThrow: new Error('single fail'),
    });
    const history = new MockHistoryCompactor();
    const compactor = new ContextCompactor(
      makeDeps({
        singleMessageCompactor: single,
        historyCompactor: history,
        config: { offloadEnabled: true, compactionEnabled: true },
      }),
    );
    const memory = new ConversationMemory();
    memory.append(makeAssistant(['t1']));
    memory.append(makeTool('t1', 'result'));

    // runCompaction 不抛出
    await expect(compactor.runCompaction(memory)).resolves.toBeUndefined();
    // 第一层抛错被归一化,memory 状态未被破坏(原 2 条消息仍保留)
    expect(memory.getMessages().length).toBe(2);
    // 第二层:memory 总 token 远小于阈值,不调 historyCompactor
    expect(history.callCount).toBe(0);
  });

  it('第二层 historyCompactor 抛错时,runCompaction 不抛出,memory 状态未被破坏', async () => {
    const history = new MockHistoryCompactor({
      shouldThrow: new Error('summary fail'),
    });
    const compactor = new ContextCompactor(
      makeDeps({
        historyCompactor: history,
        config: { offloadEnabled: false, compactionEnabled: true },
      }),
    );
    const memory = makeOversizedMemory();
    const originalMessages = memory.getMessages();

    // runCompaction 不抛出
    await expect(compactor.runCompaction(memory)).resolves.toBeUndefined();
    // memory 状态未被破坏(因为 compact 失败,未替换)
    expect(memory.getMessages()).toEqual(originalMessages);
    // consecutiveFailures 增加
    expect(compactor.getConsecutiveFailures()).toBe(1);
  });

  it('第一层 + 第二层都抛错时,runCompaction 不抛出', async () => {
    const single = new MockSingleMessageCompactor({
      shouldThrow: new Error('single fail'),
    });
    const history = new MockHistoryCompactor({
      shouldThrow: new Error('summary fail'),
    });
    const compactor = new ContextCompactor(
      makeDeps({
        singleMessageCompactor: single,
        historyCompactor: history,
        config: { offloadEnabled: true, compactionEnabled: true },
      }),
    );
    const memory = new ConversationMemory();
    // assistant + 超长 tool 结果(让第一层抛错,第二层超阈值)
    memory.append(makeAssistant(['t1']));
    memory.append(makeTool('t1', 'a'.repeat(130000)));

    // runCompaction 不抛出
    await expect(compactor.runCompaction(memory)).resolves.toBeUndefined();
    // 第一层抛错被归一化,memory 未被重建(原 2 条消息保留)
    expect(memory.getMessages().length).toBe(2);
    // 第二层失败被归一化,consecutiveFailures 增加
    expect(compactor.getConsecutiveFailures()).toBe(1);
  });

  it('runCompaction 不向调用方抛出任何异常(归一化为跳过本轮压缩)', async () => {
    // 各种异常场景组合,runCompaction 都不应抛出
    const scenarios: Array<{
      name: string;
      single?: MockSingleMessageCompactor;
      history?: MockHistoryCompactor;
      memory: () => ConversationMemory;
    }> = [
      {
        name: 'offloader 抛错',
        single: new MockSingleMessageCompactor({
          shouldThrow: new Error('offload fail'),
        }),
        memory: () => {
          const m = new ConversationMemory();
          m.append(makeAssistant(['t1']));
          m.append(makeTool('t1', 'result'));
          return m;
        },
      },
      {
        name: 'summarizer/historyCompactor 抛错',
        history: new MockHistoryCompactor({
          shouldThrow: new Error('summary fail'),
        }),
        memory: makeOversizedMemory,
      },
      {
        name: '两者都抛错',
        single: new MockSingleMessageCompactor({
          shouldThrow: new Error('offload fail'),
        }),
        history: new MockHistoryCompactor({
          shouldThrow: new Error('summary fail'),
        }),
        memory: () => {
          const m = new ConversationMemory();
          m.append(makeAssistant(['t1']));
          m.append(makeTool('t1', 'a'.repeat(130000)));
          return m;
        },
      },
    ];

    for (const s of scenarios) {
      const compactor = new ContextCompactor(
        makeDeps({
          singleMessageCompactor: s.single,
          historyCompactor: s.history,
          config: { offloadEnabled: true, compactionEnabled: true },
        }),
      );
      // 不抛出即通过
      await expect(compactor.runCompaction(s.memory())).resolves.toBeUndefined();
    }
  });
});
