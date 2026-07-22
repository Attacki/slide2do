/**
 * SingleMessageCompactor 与 planOffloads 单元测试
 *
 * 覆盖：
 * - planOffloads：空数组 / 合计 ≤ threshold / 大→小依次选中 / threshold ≤ 0 / 全选中
 * - ChatMessage.compacted 字段类型层面存在
 * - SingleMessageCompactor.compact：幂等返回 / 非 assistant 跳过 / 无 tool_calls 跳过
 *   / 单条阈值触发 offload / 合计阈值触发按大→小 offload / 单条失败不阻塞其他条目
 *
 * 测试用 MockOffloader 实现内存版接口，不实际写盘。
 */
import { describe, it, expect } from 'bun:test';
import type { ChatMessage } from '../ui-pattern.ts';
import {
  planOffloads,
  SingleMessageCompactor,
  type ToolResultOffloaderLike,
} from '../modules/context/single-message-compactor.ts';

/**
 * 内存版 mock offloader：不实际写盘，返回形如 `/mock/{sessionId}/{n}.txt` 的路径。
 * 通过 `failContents` 集合可指定哪些 content 触发抛错，用于测试失败容错。
 */
class MockOffloader implements ToolResultOffloaderLike {
  public calls: Array<{ content: string; sessionId: string }> = [];
  /** 触发抛错的 content 集合（按内容匹配） */
  public failContents: Set<string> = new Set();
  private counter = 0;

  async offload(content: string, sessionId: string): Promise<string> {
    this.calls.push({ content, sessionId });
    this.counter += 1;
    if (this.failContents.has(content)) {
      throw new Error(`mock offload failed (call #${this.counter})`);
    }
    return `/mock/${sessionId}/${String(this.counter).padStart(3, '0')}.txt`;
  }
}

/** 构造 assistant 消息（含 tool_calls） */
function makeAssistant(toolCallIds: string[]): ChatMessage {
  return {
    role: 'assistant',
    content: 'calling tools',
    tool_calls: toolCallIds.map(id => ({
      id,
      name: 'tool',
      arguments: '{}',
    })),
  };
}

/** 构造 tool 角色消息 */
function makeTool(id: string, content: string): ChatMessage {
  return {
    role: 'tool',
    content,
    tool_call_id: id,
  };
}

/** 生成多行长文本（每行带前缀，便于断言首尾内容） */
function makeLongContent(lines: number, charsPerLine: number): string {
  return Array.from(
    { length: lines },
    (_, i) => `line-${i}-${'x'.repeat(charsPerLine)}`,
  ).join('\n');
}

describe('planOffloads', () => {
  it('空数组返回空', () => {
    expect(planOffloads([], 1000)).toEqual([]);
  });

  it('合计 ≤ threshold 返回空', () => {
    const items = [
      { id: 'a', content: 'x'.repeat(100) },
      { id: 'b', content: 'y'.repeat(200) },
    ];
    // total = 300 ≤ 1000
    expect(planOffloads(items, 1000)).toEqual([]);
  });

  it('按大→小依次选中，直到合计 ≤ threshold', () => {
    const items = [
      { id: 'a', content: 'x'.repeat(5000) },
      { id: 'b', content: 'y'.repeat(3000) },
      { id: 'c', content: 'z'.repeat(2000) },
    ];
    // total = 10000, threshold = 4000
    // select a (5000): 10000 - 5000 = 5000 > 4000
    // select b (3000): 5000 - 3000 = 2000 ≤ 4000, stop
    // 顺序 [a, b]
    expect(planOffloads(items, 4000)).toEqual(['a', 'b']);
  });

  it('threshold ≤ 0 返回空', () => {
    const items = [
      { id: 'a', content: 'x'.repeat(100) },
      { id: 'b', content: 'y'.repeat(200) },
    ];
    expect(planOffloads(items, 0)).toEqual([]);
    expect(planOffloads(items, -1)).toEqual([]);
  });

  it('全部选中后仍超 threshold 时返回全部 id（按大→小顺序）', () => {
    const items = [
      { id: 'a', content: 'x'.repeat(100) },
      { id: 'b', content: 'y'.repeat(200) },
    ];
    // total = 300, threshold = 50
    // select b (200): 300 - 200 = 100 > 50
    // select a (100): 100 - 100 = 0 ≤ 50, stop
    // 全部选中，顺序 [b, a]（大→小）
    expect(planOffloads(items, 50)).toEqual(['b', 'a']);
  });
});

describe('ChatMessage.compacted 字段', () => {
  it('类型层面支持 compacted?: boolean 字段', () => {
    const msg: ChatMessage = {
      role: 'assistant',
      content: 'test',
      compacted: true,
    };
    expect(msg.compacted).toBe(true);
  });

  it('compacted 字段缺省时为 undefined', () => {
    const msg: ChatMessage = {
      role: 'assistant',
      content: 'test',
    };
    expect(msg.compacted).toBeUndefined();
  });
});

describe('SingleMessageCompactor', () => {
  it('对已 compacted: true 的消息直接返回（幂等）', async () => {
    const mock = new MockOffloader();
    const compactor = new SingleMessageCompactor(mock, {
      singleToolResultThreshold: 8000,
      singleMessageTotalThreshold: 20000,
    });
    const assistant: ChatMessage = {
      role: 'assistant',
      content: 'done',
      compacted: true,
      tool_calls: [{ id: 't1', name: 'tool', arguments: '{}' }],
    };
    const tools: ChatMessage[] = [makeTool('t1', 'x'.repeat(10000))];

    const result = await compactor.compact(assistant, tools, 'session-1');

    // 直接返回原引用（未处理），offloader 未被调用
    expect(result.assistant).toBe(assistant);
    expect(result.tools).toBe(tools);
    expect(mock.calls.length).toBe(0);
  });

  it('对非 assistant 消息直接返回', async () => {
    const mock = new MockOffloader();
    const compactor = new SingleMessageCompactor(mock, {
      singleToolResultThreshold: 8000,
      singleMessageTotalThreshold: 20000,
    });
    const userMsg: ChatMessage = {
      role: 'user',
      content: 'hello',
    };

    const result = await compactor.compact(userMsg, [], 'session-1');

    expect(result.assistant).toBe(userMsg);
    expect(result.tools).toEqual([]);
    expect(mock.calls.length).toBe(0);
  });

  it('对无 tool_calls 的 assistant 消息直接返回', async () => {
    const mock = new MockOffloader();
    const compactor = new SingleMessageCompactor(mock, {
      singleToolResultThreshold: 8000,
      singleMessageTotalThreshold: 20000,
    });
    const assistant: ChatMessage = {
      role: 'assistant',
      content: 'no tools called',
    };

    const result = await compactor.compact(assistant, [], 'session-1');

    expect(result.assistant).toBe(assistant);
    expect(mock.calls.length).toBe(0);
  });

  it('单条 tool 结果 > singleToolResultThreshold 触发 offload，content 替换为预览+路径，compacted 置 true', async () => {
    const mock = new MockOffloader();
    const compactor = new SingleMessageCompactor(mock, {
      singleToolResultThreshold: 8000,
      singleMessageTotalThreshold: 20000,
      headLines: 2,
      tailLines: 2,
    });
    // 30 行内容，每行约 310 字符，总长 > 8000
    const longContent = makeLongContent(30, 300);
    expect(longContent.length).toBeGreaterThan(8000);

    const assistant = makeAssistant(['t1']);
    const tools = [makeTool('t1', longContent)];

    const result = await compactor.compact(assistant, tools, 'session-A');

    // offloader 被调用一次，参数正确
    expect(mock.calls.length).toBe(1);
    expect(mock.calls[0].sessionId).toBe('session-A');
    expect(mock.calls[0].content).toBe(longContent);

    // 返回的 tool 消息已被替换为预览，标记 compacted
    const offloaded = result.tools[0];
    expect(offloaded.compacted).toBe(true);
    expect(offloaded.content).not.toBe(longContent);
    // 预览包含文件路径
    expect(offloaded.content).toContain('/mock/session-A/001.txt');
    // 预览包含省略提示（30 行 > head+tail=4，必然省略）
    expect(offloaded.content).toContain('已省略');
    // 预览包含首尾行
    expect(offloaded.content).toContain('line-0-');
    expect(offloaded.content).toContain('line-29-');
    // 预览不包含中间行
    expect(offloaded.content).not.toContain('line-15-');

    // assistant 原样返回（自身无变化）
    expect(result.assistant).toBe(assistant);
  });

  it('多 tool 结果合计 > singleMessageTotalThreshold 且单条均未超单阈值时，按大→小 offload 直至合计 ≤ 阈值', async () => {
    const mock = new MockOffloader();
    const compactor = new SingleMessageCompactor(mock, {
      singleToolResultThreshold: 8000,
      singleMessageTotalThreshold: 20000,
      headLines: 2,
      tailLines: 2,
    });
    // 4 条多行 tool 结果，单条均 < 8000，合计 > 20000
    // 多行内容确保 buildPreviewText 会实际截断（lines > headLines + tailLines）
    const a = makeLongContent(30, 250);
    const b = makeLongContent(29, 250);
    const c = makeLongContent(28, 250);
    const d = makeLongContent(27, 250);
    const total = a.length + b.length + c.length + d.length;
    // planOffloads（按大→小）:
    //   select a: total - a.length > 20000
    //   select b: total - a.length - b.length ≤ 20000, stop
    //   returns [a, b]
    expect(a.length).toBeLessThanOrEqual(8000);
    expect(b.length).toBeLessThanOrEqual(8000);
    expect(c.length).toBeLessThanOrEqual(8000);
    expect(d.length).toBeLessThanOrEqual(8000);
    expect(total).toBeGreaterThan(20000);
    expect(total - a.length).toBeGreaterThan(20000);
    expect(total - a.length - b.length).toBeLessThanOrEqual(20000);

    const assistant = makeAssistant(['a', 'b', 'c', 'd']);
    const tools = [
      makeTool('a', a),
      makeTool('b', b),
      makeTool('c', c),
      makeTool('d', d),
    ];

    const result = await compactor.compact(assistant, tools, 'session-B');

    // offloader 被调用 2 次（a, b），按大→小顺序
    expect(mock.calls.length).toBe(2);
    expect(mock.calls[0].content).toBe(a);
    expect(mock.calls[1].content).toBe(b);

    // a, b 被替换为预览，compacted = true
    const toolA = result.tools.find(t => t.tool_call_id === 'a');
    const toolB = result.tools.find(t => t.tool_call_id === 'b');
    const toolC = result.tools.find(t => t.tool_call_id === 'c');
    const toolD = result.tools.find(t => t.tool_call_id === 'd');
    expect(toolA?.compacted).toBe(true);
    expect(toolB?.compacted).toBe(true);
    expect(toolA?.content).not.toBe(a);
    expect(toolB?.content).not.toBe(b);
    expect(toolA?.content).toContain('/mock/session-B/');
    expect(toolB?.content).toContain('/mock/session-B/');

    // c, d 保持原文，未标记 compacted
    expect(toolC?.compacted).toBeUndefined();
    expect(toolD?.compacted).toBeUndefined();
    expect(toolC?.content).toBe(c);
    expect(toolD?.content).toBe(d);

    // assistant 原样返回
    expect(result.assistant).toBe(assistant);
  });

  it('单条 offload 失败时，失败条目保留原文，其他条目正常处理', async () => {
    const mock = new MockOffloader();
    // 两条多行内容，均 > 8000 单阈值，触发 offload
    // 多行确保 buildPreviewText 会实际截断（lines > headLines + tailLines）
    const a = makeLongContent(30, 300);
    const b = makeLongContent(29, 300);
    expect(a.length).toBeGreaterThan(8000);
    expect(b.length).toBeGreaterThan(8000);
    // 让 b 的内容触发失败
    mock.failContents.add(b);

    const compactor = new SingleMessageCompactor(mock, {
      singleToolResultThreshold: 8000,
      singleMessageTotalThreshold: 20000,
      headLines: 2,
      tailLines: 2,
    });
    const assistant = makeAssistant(['a', 'b']);
    const tools = [makeTool('a', a), makeTool('b', b)];

    const result = await compactor.compact(assistant, tools, 'session-C');

    // offloader 被调用 2 次（按大→小：a 先，b 后）
    expect(mock.calls.length).toBe(2);
    expect(mock.calls[0].content).toBe(a);
    expect(mock.calls[1].content).toBe(b);

    // a 成功 offload：替换为预览，compacted = true
    const toolA = result.tools.find(t => t.tool_call_id === 'a');
    const toolB = result.tools.find(t => t.tool_call_id === 'b');
    expect(toolA?.compacted).toBe(true);
    expect(toolA?.content).not.toBe(a);
    expect(toolA?.content).toContain('/mock/session-C/');

    // b 失败：保留原文，未标记 compacted
    expect(toolB?.compacted).toBeUndefined();
    expect(toolB?.content).toBe(b);

    // assistant 原样返回
    expect(result.assistant).toBe(assistant);
  });

  it('无任何阈值触发时，原样返回所有消息', async () => {
    const mock = new MockOffloader();
    const compactor = new SingleMessageCompactor(mock, {
      singleToolResultThreshold: 8000,
      singleMessageTotalThreshold: 20000,
    });
    // 单条与合计均未超阈值
    const assistant = makeAssistant(['a', 'b']);
    const tools = [
      makeTool('a', 'short-a'),
      makeTool('b', 'short-b'),
    ];

    const result = await compactor.compact(assistant, tools, 'session-D');

    // offloader 未被调用
    expect(mock.calls.length).toBe(0);
    // 原样返回
    expect(result.assistant).toBe(assistant);
    expect(result.tools).toBe(tools);
    expect(result.tools[0].compacted).toBeUndefined();
    expect(result.tools[1].compacted).toBeUndefined();
  });
});
