import { describe, it, expect } from 'bun:test';
import {
  truncateToCompleteMessages,
  detectTimeGap,
  SessionRecovery,
} from '../modules/memory/session/session-recovery.ts';
import type { ChatMessage } from '../ui-pattern.ts';
import type { ContextCompactor } from '../modules/context/context-compactor.ts';
import type { TokenCounter } from '../modules/context/token-counter.ts';

function mkMsg(role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { role, content, ...extra };
}

function mkAssistantWithTools(content: string, toolCalls: Array<{ id: string; name: string; arguments: string }>): ChatMessage {
  return {
    role: 'assistant',
    content,
    tool_calls: toolCalls,
  };
}

function mkToolResult(toolCallId: string, content: string): ChatMessage {
  return {
    role: 'tool',
    content,
    tool_call_id: toolCallId,
  };
}

describe('truncateToCompleteMessages', () => {
  it('should return empty unchanged', () => {
    const r = truncateToCompleteMessages([]);
    expect(r.truncated).toBe(false);
    expect(r.truncatedCount).toBe(0);
    expect(r.messages).toEqual([]);
  });

  it('should not truncate when no tool_calls exist', () => {
    const msgs = [
      mkMsg('user', 'hi'),
      mkMsg('assistant', 'hello'),
      mkMsg('user', 'bye'),
    ];
    const r = truncateToCompleteMessages(msgs);
    expect(r.truncated).toBe(false);
    expect(r.messages.length).toBe(3);
  });

  it('should not truncate when all tool_calls have matching tool_results', () => {
    const msgs = [
      mkMsg('user', 'do x'),
      mkAssistantWithTools('calling', [{ id: 't1', name: 'read', arguments: '{}' }]),
      mkToolResult('t1', 'result1'),
      mkMsg('assistant', 'done'),
    ];
    const r = truncateToCompleteMessages(msgs);
    expect(r.truncated).toBe(false);
    expect(r.messages.length).toBe(4);
  });

  it('should truncate trailing assistant with unpaired tool_calls', () => {
    const msgs = [
      mkMsg('user', 'do x'),
      mkAssistantWithTools('calling', [{ id: 't1', name: 'read', arguments: '{}' }]),
      // 缺 tool_result
    ];
    const r = truncateToCompleteMessages(msgs);
    expect(r.truncated).toBe(true);
    expect(r.truncatedCount).toBe(1);
    expect(r.messages.length).toBe(1);
    expect(r.messages[0]!.role).toBe('user');
  });

  it('should truncate assistant with partial tool_results (some paired, some not)', () => {
    const msgs = [
      mkMsg('user', 'do x'),
      mkAssistantWithTools('calling', [
        { id: 't1', name: 'read', arguments: '{}' },
        { id: 't2', name: 'read', arguments: '{}' },
      ]),
      mkToolResult('t1', 'result1'),
      // t2 缺 result
    ];
    const r = truncateToCompleteMessages(msgs);
    expect(r.truncated).toBe(true);
    // 截断到 assistant 之前，丢弃 assistant + 已有的 t1 result
    expect(r.truncatedCount).toBe(2);
    expect(r.messages.length).toBe(1);
    expect(r.messages[0]!.role).toBe('user');
  });

  it('should not truncate when tool_result exists but no assistant before it (orphan tool)', () => {
    // 边界情况：孤立的 tool 消息（无前置 assistant），不应被截断（向前找不到未配对 assistant）
    const msgs = [
      mkMsg('user', 'hi'),
      mkToolResult('orphan', 'orphan result'),
    ];
    const r = truncateToCompleteMessages(msgs);
    // 不截断（向前扫描没找到含 tool_calls 的 assistant）
    expect(r.truncated).toBe(false);
    expect(r.messages.length).toBe(2);
  });

  it('should keep messages before truncated assistant intact', () => {
    const msgs = [
      mkMsg('user', 'first'),
      mkAssistantWithTools('call1', [{ id: 't1', name: 'r', arguments: '{}' }]),
      mkToolResult('t1', 'r1'),
      mkMsg('user', 'second'),
      mkAssistantWithTools('call2', [{ id: 't2', name: 'r', arguments: '{}' }]),
      // t2 缺 result
    ];
    const r = truncateToCompleteMessages(msgs);
    expect(r.truncated).toBe(true);
    expect(r.truncatedCount).toBe(1); // 仅末尾未配对的 assistant 被截断
    // 注意：截断到「该 assistant 之前」，second user 在 assistant 之前应保留
    expect(r.messages.length).toBe(4);
    expect(r.messages[3]!.role).toBe('user');
    expect(r.messages[3]!.content).toBe('second');
  });
});

describe('detectTimeGap', () => {
  it('should return null when lastActiveAt is null', () => {
    expect(detectTimeGap(null, 1000, 100)).toBeNull();
  });

  it('should return null when gap is below threshold', () => {
    expect(detectTimeGap(1000, 1050, 100)).toBeNull();
    expect(detectTimeGap(1000, 1100, 100)).toBeNull(); // 等于阈值不触发
  });

  it('should return reminder when gap exceeds threshold', () => {
    const r = detectTimeGap(1000, 2000, 100);
    expect(r).not.toBeNull();
    expect(r!).toContain('会话恢复提醒');
    expect(r!).toContain('距上次活跃已过去');
  });

  it('should format duration as hours and minutes', () => {
    const hour = 3600000;
    const min = 60000;
    // 2 hours 15 min
    const r = detectTimeGap(0, 2 * hour + 15 * min, hour);
    expect(r).toContain('2 小时');
    expect(r).toContain('15 分钟');
  });

  it('should format duration as days and hours', () => {
    const day = 86400000;
    const hour = 3600000;
    // 3 days 4 hours
    const r = detectTimeGap(0, 3 * day + 4 * hour, hour);
    expect(r).toContain('3 天');
    expect(r).toContain('4 小时');
    // 不应包含分钟（天数 > 0 时不显示分钟）
    expect(r).not.toContain('分钟');
  });

  it('should return null for non-finite lastActiveAt', () => {
    expect(detectTimeGap(NaN, 1000, 100)).toBeNull();
    expect(detectTimeGap(Infinity, 1000, 100)).toBeNull();
  });
});

describe('SessionRecovery', () => {
  it('should run truncate step and populate warnings', async () => {
    const recovery = new SessionRecovery();
    const msgs = [
      mkMsg('user', 'hi'),
      mkAssistantWithTools('calling', [{ id: 't1', name: 'r', arguments: '{}' }]),
    ];
    const r = await recovery.recover(msgs, { now: 1000 });
    expect(r.messages.length).toBe(1);
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toContain('未配对');
  });

  it('should not truncate when messages are complete', async () => {
    const recovery = new SessionRecovery();
    const msgs = [
      mkMsg('user', 'hi'),
      mkAssistantWithTools('calling', [{ id: 't1', name: 'r', arguments: '{}' }]),
      mkToolResult('t1', 'r1'),
    ];
    const r = await recovery.recover(msgs, { now: 1000 });
    expect(r.messages.length).toBe(3);
    expect(r.warnings.length).toBe(0);
  });

  it('should produce timeGapReminder when lastActiveAt exceeds 1 hour', async () => {
    const recovery = new SessionRecovery();
    const hour = 3600000;
    const r = await recovery.recover([], { lastActiveAt: 0, now: 2 * hour });
    expect(r.timeGapReminder).toBeDefined();
    expect(r.timeGapReminder!).toContain('会话恢复提醒');
  });

  it('should not produce timeGapReminder when within 1 hour', async () => {
    const recovery = new SessionRecovery();
    const r = await recovery.recover([], { lastActiveAt: 0, now: 1000 });
    expect(r.timeGapReminder).toBeUndefined();
  });

  it('should not produce timeGapReminder when lastActiveAt is undefined', async () => {
    const recovery = new SessionRecovery();
    const r = await recovery.recover([], { now: 1000000 });
    expect(r.timeGapReminder).toBeUndefined();
  });

  it('should skip token compression when tokenCounter/tokenLimit/contextCompactor missing', async () => {
    const recovery = new SessionRecovery(); // 三件套全缺
    const bigMsgs: ChatMessage[] = [mkMsg('user', 'x'.repeat(100000))];
    const r = await recovery.recover(bigMsgs, { now: 1000 });
    // 不压缩，原样返回
    expect(r.messages.length).toBe(1);
    expect(r.messages[0]!.content.length).toBe(100000);
    expect(r.warnings.length).toBe(0);
  });

  it('should trigger compression when token exceeds limit', async () => {
    // 用 mock ContextCompactor + TokenCounter
    const fakeCompactor: ContextCompactor = {
      async forceCompact(memory, _opts) {
        // 把所有消息合并成一条摘要
        const orig = memory.getMessages();
        memory.reset();
        memory.append({ role: 'system', content: 'summary of ' + orig.length + ' msgs' });
        return true;
      },
      // 其他方法不需要，类型断言绕过
    } as unknown as ContextCompactor;

    const fakeTokenCounter: TokenCounter = {
      estimate(text: string) {
        return text.length; // 1 字符 = 1 token
      },
    } as unknown as TokenCounter;

    const recovery = new SessionRecovery({
      contextCompactor: fakeCompactor,
      tokenCounter: fakeTokenCounter,
      tokenLimit: 100,
    });

    const bigMsgs: ChatMessage[] = [
      mkMsg('user', 'x'.repeat(200)), // 200 tokens > 100 limit
    ];
    const r = await recovery.recover(bigMsgs, { now: 1000 });
    expect(r.warnings.some((w) => w.includes('超限'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('压缩'))).toBe(true);
    // 压缩后消息变化
    expect(r.messages.length).toBe(1);
    expect(r.messages[0]!.role).toBe('system');
    expect(r.messages[0]!.content).toContain('summary of 1 msgs');
  });

  it('should normalize compression failure as warning (not throw)', async () => {
    const failingCompactor: ContextCompactor = {
      async forceCompact() {
        return false; // 压缩失败
      },
    } as unknown as ContextCompactor;

    const fakeTokenCounter: TokenCounter = {
      estimate(text: string) {
        return text.length;
      },
    } as unknown as TokenCounter;

    const recovery = new SessionRecovery({
      contextCompactor: failingCompactor,
      tokenCounter: fakeTokenCounter,
      tokenLimit: 100,
    });

    const bigMsgs: ChatMessage[] = [mkMsg('user', 'x'.repeat(200))];
    const r = await recovery.recover(bigMsgs, { now: 1000 });
    expect(r.warnings.some((w) => w.includes('压缩失败'))).toBe(true);
    // 原消息保留
    expect(r.messages.length).toBe(1);
    expect(r.messages[0]!.content.length).toBe(200);
  });

  it('should normalize thrown error in compression step as warning', async () => {
    const throwingCompactor: ContextCompactor = {
      async forceCompact() {
        throw new Error('boom');
      },
    } as unknown as ContextCompactor;

    const fakeTokenCounter: TokenCounter = {
      estimate(text: string) {
        return text.length;
      },
    } as unknown as TokenCounter;

    const recovery = new SessionRecovery({
      contextCompactor: throwingCompactor,
      tokenCounter: fakeTokenCounter,
      tokenLimit: 100,
    });

    const bigMsgs: ChatMessage[] = [mkMsg('user', 'x'.repeat(200))];
    const r = await recovery.recover(bigMsgs, { now: 1000 });
    expect(r.warnings.some((w) => w.includes('异常'))).toBe(true);
    // 原消息保留
    expect(r.messages.length).toBe(1);
  });

  it('should run all three steps in order: truncate -> compress -> timeGap', async () => {
    const fakeCompactor: ContextCompactor = {
      async forceCompact(memory) {
        const orig = memory.getMessages();
        memory.reset();
        for (const m of orig) {
          memory.append({ ...m, content: 'compressed:' + (m.content ?? '').slice(0, 10) });
        }
        return true;
      },
    } as unknown as ContextCompactor;

    const fakeTokenCounter: TokenCounter = {
      estimate(text: string) {
        return text.length;
      },
    } as unknown as TokenCounter;

    const recovery = new SessionRecovery({
      contextCompactor: fakeCompactor,
      tokenCounter: fakeTokenCounter,
      tokenLimit: 100,
    });

    const hour = 3600000;
    const msgs = [
      mkMsg('user', 'x'.repeat(200)),
      mkAssistantWithTools('call', [{ id: 't1', name: 'r', arguments: '{}' }]),
      // 缺 t1 result
    ];
    const r = await recovery.recover(msgs, { lastActiveAt: 0, now: 2 * hour });

    // 截断 + 压缩 + 时间跨度 三步全跑
    expect(r.warnings.some((w) => w.includes('未配对'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('压缩'))).toBe(true);
    expect(r.timeGapReminder).toBeDefined();
    // 截断后只剩 user，压缩后 content 应有 'compressed:' 前缀
    expect(r.messages.length).toBe(1);
    expect(r.messages[0]!.content).toContain('compressed:');
  });
});
