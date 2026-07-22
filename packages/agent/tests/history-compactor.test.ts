/**
 * HistoryCompactor 与 partitionMessages 单元测试
 *
 * 覆盖:
 * - partitionMessages: system 保留 / user 保留 / 最近 N 轮分区 / 一轮定义 /
 *   空 toSummarize 场景 / 顺序保持 / user 穿插不打断轮次
 * - HistoryCompactor.compact: 输出顺序与 kind / 边界文案 / 空 toSummarize /
 *   summarizer 入参 / summarizer 抛错 / signal 透传
 *
 * 测试用 MockSummarizer 实现内存版 SummarizerLike,不实际调用远端 LLM。
 */
import { describe, it, expect } from 'bun:test';
import type { ChatMessage } from '../ui-pattern.ts';
import {
  partitionMessages,
  HistoryCompactor,
} from '../modules/context/history-compactor.ts';

/**
 * 内存版 mock summarizer:返回固定摘要文本,记录入参与 signal 供断言。
 *
 * - callCount:累计调用次数(用于验证「空 toSummarize 时不调」)
 * - shouldThrow:若提供,summarize 抛出该错误
 */
class MockSummarizer {
  public lastInput?: ChatMessage[];
  public lastSignal?: AbortSignal;
  public callCount = 0;
  constructor(
    private readonly summaryText: string = 'mock summary',
    public shouldThrow?: Error,
  ) {}
  async summarize(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): Promise<string> {
    this.lastInput = messages;
    this.lastSignal = signal;
    this.callCount++;
    if (this.shouldThrow) throw this.shouldThrow;
    return this.summaryText;
  }
}

/** 构造一条 assistant 消息 */
function makeAssistant(content: string): ChatMessage {
  return { role: 'assistant', content };
}

/** 构造一条 tool 消息 */
function makeTool(content: string, toolCallId = 'tc'): ChatMessage {
  return { role: 'tool', content, tool_call_id: toolCallId };
}

/** 构造一条 user 消息 */
function makeUser(content: string): ChatMessage {
  return { role: 'user', content };
}

/** 构造一条 system 消息(可选 kind) */
function makeSystem(content: string, kind?: ChatMessage['kind']): ChatMessage {
  return kind !== undefined
    ? { role: 'system', content, kind }
    : { role: 'system', content };
}

/** 构造 N 轮对话:每轮含 1 条 assistant + 1 条 tool,content 含索引便于断言 */
function makeRounds(n: number): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < n; i++) {
    messages.push(makeAssistant(`assistant ${i}`));
    messages.push(makeTool(`tool result ${i}`, `tc_${i}`));
  }
  return messages;
}

describe('partitionMessages', () => {
  it('把所有 system 消息归入 toKeep(无论 kind:env_info/mode_reminder/system_supplement/无 kind)', () => {
    const messages: ChatMessage[] = [
      makeSystem('no kind'),
      makeSystem('env', 'env_info'),
      makeSystem('mode', 'mode_reminder'),
      makeSystem('supplement', 'system_supplement'),
      ...makeRounds(6),
    ];
    const { toKeep, toSummarize } = partitionMessages(messages, 4);

    // 4 条 system 全部在 toKeep
    const systemMessages = toKeep.filter(m => m.role === 'system');
    expect(systemMessages.length).toBe(4);
    expect(systemMessages.some(m => m.content === 'no kind' && m.kind === undefined)).toBe(true);
    expect(systemMessages.some(m => m.content === 'env' && m.kind === 'env_info')).toBe(true);
    expect(systemMessages.some(m => m.content === 'mode' && m.kind === 'mode_reminder')).toBe(true);
    expect(systemMessages.some(m => m.content === 'supplement' && m.kind === 'system_supplement')).toBe(true);
    // 没有 system 入 toSummarize
    expect(toSummarize.filter(m => m.role === 'system').length).toBe(0);
  });

  it('把所有 user 消息归入 toKeep(用户原话强制保留)', () => {
    const messages: ChatMessage[] = [
      makeUser('user1'),
      ...makeRounds(6),
      makeUser('user2'),
    ];
    const { toKeep, toSummarize } = partitionMessages(messages, 4);

    const userMessages = toKeep.filter(m => m.role === 'user');
    expect(userMessages.length).toBe(2);
    expect(userMessages.some(m => m.content === 'user1')).toBe(true);
    expect(userMessages.some(m => m.content === 'user2')).toBe(true);
    expect(toSummarize.filter(m => m.role === 'user').length).toBe(0);
  });

  it('把最近 N 轮 assistant+tool 配对归入 toKeep,其余中间历史归入 toSummarize(6 轮,keepRecentRounds=4)', () => {
    const messages = makeRounds(6);
    const { toKeep, toSummarize } = partitionMessages(messages, 4);

    // 最后 4 轮在 toKeep(4 assistant + 4 tool = 8 条)
    const keepAssistant = toKeep.filter(m => m.role === 'assistant');
    const keepTool = toKeep.filter(m => m.role === 'tool');
    expect(keepAssistant.length).toBe(4);
    expect(keepTool.length).toBe(4);
    // 验证是最后 4 轮:assistant 2,3,4,5
    expect(keepAssistant.map(m => m.content)).toEqual([
      'assistant 2',
      'assistant 3',
      'assistant 4',
      'assistant 5',
    ]);
    expect(keepTool.map(m => m.content)).toEqual([
      'tool result 2',
      'tool result 3',
      'tool result 4',
      'tool result 5',
    ]);

    // 前 2 轮在 toSummarize(2 assistant + 2 tool = 4 条)
    const summarizeAssistant = toSummarize.filter(m => m.role === 'assistant');
    const summarizeTool = toSummarize.filter(m => m.role === 'tool');
    expect(summarizeAssistant.length).toBe(2);
    expect(summarizeTool.length).toBe(2);
    expect(summarizeAssistant.map(m => m.content)).toEqual([
      'assistant 0',
      'assistant 1',
    ]);
    expect(summarizeTool.map(m => m.content)).toEqual([
      'tool result 0',
      'tool result 1',
    ]);
  });

  it('一轮 = 一条 assistant + 其后连续 tool 消息(assistant 后跟 3 条 tool 算作 1 轮)', () => {
    const messages: ChatMessage[] = [
      ...makeRounds(2), // 前 2 轮(每轮 1 assistant + 1 tool)
      makeAssistant('target assistant'), // 第 3 轮起点
      makeTool('tool1', 'tc_a'),
      makeTool('tool2', 'tc_b'),
      makeTool('tool3', 'tc_c'),
    ];
    // keepRecentRounds=1:只保留最后 1 轮(即第 3 轮 = 1 assistant + 3 tool)
    const { toKeep, toSummarize } = partitionMessages(messages, 1);

    // 最后 1 轮 = 1 assistant + 3 tool 全部入 toKeep
    const keepAssistant = toKeep.filter(m => m.role === 'assistant');
    const keepTool = toKeep.filter(m => m.role === 'tool');
    expect(keepAssistant.length).toBe(1);
    expect(keepAssistant[0].content).toBe('target assistant');
    expect(keepTool.length).toBe(3);
    expect(keepTool.map(m => m.content)).toEqual(['tool1', 'tool2', 'tool3']);

    // 前 2 轮(2 assistant + 2 tool)入 toSummarize
    expect(toSummarize.filter(m => m.role === 'assistant').length).toBe(2);
    expect(toSummarize.filter(m => m.role === 'tool').length).toBe(2);
  });

  it('消息总数 ≤ keepRecentRounds 轮时,toSummarize 为空(全部入 toKeep)', () => {
    const messages = makeRounds(3);
    const { toKeep, toSummarize } = partitionMessages(messages, 4);

    expect(toSummarize.length).toBe(0);
    expect(toKeep.length).toBe(6); // 3 assistant + 3 tool
  });

  it('顺序保持(toSummarize 与 toKeep 内部顺序与原 messages 一致)', () => {
    const messages: ChatMessage[] = [
      makeSystem('sys1'),
      makeUser('user1'),
      ...makeRounds(6),
      makeUser('user2'),
    ];
    const { toSummarize, toKeep } = partitionMessages(messages, 4);

    // toSummarize 内部顺序 = 原 messages 中前 2 轮的顺序
    expect(toSummarize.map(m => m.content)).toEqual([
      'assistant 0',
      'tool result 0',
      'assistant 1',
      'tool result 1',
    ]);

    // toKeep 内部顺序 = 原 messages 中 system + user + 最后 4 轮的顺序
    expect(toKeep.map(m => m.content)).toEqual([
      'sys1',
      'user1',
      'assistant 2',
      'tool result 2',
      'assistant 3',
      'tool result 3',
      'assistant 4',
      'tool result 4',
      'assistant 5',
      'tool result 5',
      'user2',
    ]);
  });

  it('user 消息穿插时不打断轮次计数(user 始终入 toKeep,assistant 轮次正常计数)', () => {
    // 构造:assistant0, tool0, user_mid, assistant1, tool1, user_mid2, assistant2, tool2
    // 3 轮,keepRecentRounds=2:保留最后 2 轮(assistant1+tool1, assistant2+tool2)
    // user_mid 与 user_mid2 始终入 toKeep
    const messages: ChatMessage[] = [
      makeAssistant('assistant 0'),
      makeTool('tool 0', 'tc_0'),
      makeUser('user_mid'),
      makeAssistant('assistant 1'),
      makeTool('tool 1', 'tc_1'),
      makeUser('user_mid2'),
      makeAssistant('assistant 2'),
      makeTool('tool 2', 'tc_2'),
    ];
    const { toKeep, toSummarize } = partitionMessages(messages, 2);

    // 前 1 轮(assistant0 + tool0)入 toSummarize
    expect(toSummarize.map(m => m.content)).toEqual([
      'assistant 0',
      'tool 0',
    ]);

    // toKeep:2 个 user + 最后 2 轮(assistant1+tool1, assistant2+tool2),保持原顺序
    expect(toKeep.map(m => m.content)).toEqual([
      'user_mid',
      'assistant 1',
      'tool 1',
      'user_mid2',
      'assistant 2',
      'tool 2',
    ]);
  });
});

describe('HistoryCompactor.compact', () => {
  it('输出顺序为 [summary 消息, 边界消息, ...toKeep];summary 与边界消息均 role:"system", kind:"system_supplement"', async () => {
    const summarizer = new MockSummarizer('summary content');
    const compactor = new HistoryCompactor(summarizer, { keepRecentRounds: 2 });
    const messages: ChatMessage[] = [
      makeSystem('sys1'),
      makeUser('user1'),
      ...makeRounds(4), // 4 轮,保留最后 2 轮,前 2 轮入 toSummarize
    ];

    const result = await compactor.compact(messages);

    // 第一条:summary 消息
    expect(result[0].role).toBe('system');
    expect(result[0].kind).toBe('system_supplement');
    expect(result[0].content).toBe('## 上下文压缩摘要\n\nsummary content');
    // 第二条:边界消息
    expect(result[1].role).toBe('system');
    expect(result[1].kind).toBe('system_supplement');
    // 之后:toKeep(保持原顺序)
    // sys1, user1, assistant2, tool result 2, assistant3, tool result 3
    expect(result.length).toBe(2 + 6);
    expect(result[2].content).toBe('sys1');
    expect(result[3].content).toBe('user1');
    expect(result[4].content).toBe('assistant 2');
    expect(result[5].content).toBe('tool result 2');
    expect(result[6].content).toBe('assistant 3');
    expect(result[7].content).toBe('tool result 3');
  });

  it('边界消息 content 含「禁止根据摘要脑补」与「请重新读取」', async () => {
    const summarizer = new MockSummarizer();
    const compactor = new HistoryCompactor(summarizer, { keepRecentRounds: 1 });
    const messages = makeRounds(3);

    const result = await compactor.compact(messages);

    const boundary = result[1];
    expect(boundary.content).toContain('禁止根据摘要脑补');
    expect(boundary.content).toContain('请重新读取');
  });

  it('toSummarize 为空时不调 summarizer,直接返回原 messages(不注入 summary/边界消息)', async () => {
    const summarizer = new MockSummarizer();
    const compactor = new HistoryCompactor(summarizer, { keepRecentRounds: 10 });
    const messages = makeRounds(3); // 3 轮,keepRecentRounds=10 → toSummarize 为空

    const result = await compactor.compact(messages);

    // 直接返回原数组(同一引用,不注入 summary/边界消息)
    expect(result).toBe(messages);
    expect(summarizer.callCount).toBe(0);
  });

  it('调 summarizer.summarize 时传入 toSummarize(用 mock summarizer 验证入参)', async () => {
    const summarizer = new MockSummarizer('mock summary');
    const compactor = new HistoryCompactor(summarizer, { keepRecentRounds: 2 });
    const messages = makeRounds(4); // 前 2 轮入 toSummarize

    await compactor.compact(messages);

    // 验证 summarizer 收到的入参 = 前 2 轮(assistant0, tool0, assistant1, tool1)
    expect(summarizer.lastInput).toBeDefined();
    expect(summarizer.lastInput!.map(m => m.content)).toEqual([
      'assistant 0',
      'tool result 0',
      'assistant 1',
      'tool result 1',
    ]);
  });

  it('summarizer 抛错时抛出(用 mock summarizer 抛错验证)', async () => {
    const summarizer = new MockSummarizer(
      'mock',
      new Error('summarizer failed'),
    );
    const compactor = new HistoryCompactor(summarizer, { keepRecentRounds: 2 });
    const messages = makeRounds(4);

    await expect(compactor.compact(messages)).rejects.toThrow(
      'summarizer failed',
    );
  });

  it('signal 透传给 summarizer.summarize', async () => {
    const summarizer = new MockSummarizer('mock');
    const compactor = new HistoryCompactor(summarizer, { keepRecentRounds: 2 });
    const controller = new AbortController();

    await compactor.compact(makeRounds(4), controller.signal);

    expect(summarizer.lastSignal).toBe(controller.signal);
  });
});
