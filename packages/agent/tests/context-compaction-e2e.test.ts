/**
 * Context Compaction 端到端(E2E)测试
 *
 * 覆盖 checklist §十 的 E2E-1 ~ E2E-6 共 6 条验收项:
 *  - E2E-1: 单条 tool 结果 > 8000 字符 → offload 写盘 + 预览替换
 *  - E2E-2: 多条 tool 结果合计 > 20000 → 从大到小 offload,小者保留
 *  - E2E-3: 总长 > 128000 → 第二层摘要 + 边界消息 + 保留消息
 *  - E2E-4: 熔断后自动触发跳过,手动 forceCompact 仍触发
 *  - E2E-5: /compact 命令 → forceCompact 被调用 + memory 长度下降
 *  - E2E-6: 摘要 LLM 调用入参 tools 字段为 undefined
 *
 * 测试策略:
 *  - 使用真实 ToolResultOffloader(写盘)、真实 SingleMessageCompactor、真实 Summarizer、
 *    真实 HistoryCompactor、真实 ContextCompactor,仅 mock TokenCounter(estimate=text.length
 *    便于按字符阈值断言)与 ILLMProvider(内存版流式输出)。
 *  - E2E-5 使用真实 Agent + AgentSession,通过 processInput 累积对话后触发 /compact。
 *  - 每条用例用唯一 sessionId,afterEach 清理 offload 目录,避免污染工作区。
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ChatMessage } from '../ui-pattern.ts';
import type { LLMConfig } from '../utils/config/config-types.ts';
import type {
  ILLMProvider,
  StreamChatParams,
  StreamCallback,
} from '../provider/base.ts';
import { ConversationMemory } from '../modules/memory/memory-manger.ts';
import {
  ContextCompactor,
  type ContextCompactorDeps,
} from '../modules/context/context-compactor.ts';
import type { TokenCounter } from '../modules/context/token-counter.ts';
import { ToolResultOffloader } from '../modules/context/offloader.ts';
import { SingleMessageCompactor } from '../modules/context/single-message-compactor.ts';
import { Summarizer } from '../modules/context/summarizer.ts';
import { HistoryCompactor } from '../modules/context/history-compactor.ts';
import { DEFAULT_CONTEXT_CONFIG } from '../utils/config/config-types.ts';
import type { ContextConfig } from '@wuzi/types';
import { Agent } from '../agent.ts';
import { AgentSession } from '../agent-session.ts';

// ==================== Mock / Helper 基础设施 ====================

/**
 * MockTokenCounter: estimate 返回 text.length(1 字符/token),
 * 便于按字符阈值断言。阈值 = 0.8 * 160000 = 128000。
 * 结构兼容 TokenCounter 类(仅需 estimate/calibrate/getFactor)。
 */
class MockTokenCounter {
  estimate(text: string): number {
    return text.length;
  }
  calibrate(): void {}
  getFactor(): number {
    return 1.0;
  }
}

/**
 * MockProvider: 内存版 ILLMProvider,按 textChunks 顺序推送 text_delta。
 * - shouldReject: streamChat 直接 throw
 * - lastParams: 暴露最后一次 streamChat 入参供断言
 * - callCount: 记录 streamChat 调用次数
 */
class MockProvider implements ILLMProvider {
  readonly protocol = 'openai';
  public lastParams?: StreamChatParams;
  public callCount = 0;
  constructor(
    private readonly textChunks: string[] = [],
    private readonly shouldReject?: Error,
  ) {}
  async streamChat(
    params: StreamChatParams,
    onEvent: StreamCallback,
  ): Promise<void> {
    this.lastParams = params;
    this.callCount++;
    if (this.shouldReject) throw this.shouldReject;
    for (const chunk of this.textChunks) {
      onEvent({ type: 'text_delta', delta: chunk });
    }
    onEvent({ type: 'done' });
  }
}

/** 构造测试用 LLMConfig */
function makeLLMConfig(): LLMConfig {
  return {
    protocol: 'openai',
    model: 'gpt-4o',
    base_url: 'https://api.openai.com',
    api_key: 'sk-test',
    thinking: false,
  };
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

/**
 * 生成多行长文本(确保 buildPreviewText 触发预览:行数 > headLines+tailLines=20)。
 *
 * buildPreviewText 按 `\n` 分割行数判断,无换行符的长文本只有 1 行,不会触发预览替换。
 * 故构造多行文本(默认 30 行),使行数 > 20 触发预览。
 */
function makeMultilineContent(
  char: string,
  totalChars: number,
  lines: number = 30,
): string {
  const perLine = Math.ceil(totalChars / lines);
  const line = char.repeat(perLine);
  return Array.from({ length: lines }, () => line).join('\n');
}

/** 生成唯一 sessionId(避免跨用例冲突) */
function uniqueSessionId(label: string): string {
  return `e2e-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** offloader 默认根目录(相对 process.cwd()) */
const OFFLOAD_BASE = '.wuzi/context-offload';

/**
 * 构造真实依赖的 ContextCompactorDeps(仅 mock TokenCounter 与 Provider)。
 *
 * - offloader: 真实 ToolResultOffloader(写盘到默认 .wuzi/context-offload)
 * - singleMessageCompactor: 真实 SingleMessageCompactor
 * - summarizer: 真实 Summarizer(用传入的 provider 与 llmConfig)
 * - historyCompactor: 真实 HistoryCompactor
 * - tokenCounter: MockTokenCounter(estimate = text.length)
 */
function makeRealDeps(opts: {
  config?: Partial<Required<ContextConfig>>;
  provider?: ILLMProvider;
  llmConfig?: LLMConfig;
}): ContextCompactorDeps {
  const config = { ...DEFAULT_CONTEXT_CONFIG, ...opts.config };
  const provider =
    opts.provider ??
    new MockProvider([
      '<draft>分析草稿</draft><summary>## 主要请求\n测试摘要内容</summary>',
    ]);
  const llmConfig = opts.llmConfig ?? makeLLMConfig();
  const tokenCounter = new MockTokenCounter() as unknown as TokenCounter;
  const offloader = new ToolResultOffloader();
  const singleMessageCompactor = new SingleMessageCompactor(offloader, {
    singleToolResultThreshold: config.singleToolResultThreshold,
    singleMessageTotalThreshold: config.singleMessageTotalThreshold,
  });
  const summarizer = new Summarizer(provider, llmConfig);
  const historyCompactor = new HistoryCompactor(summarizer, {
    keepRecentRounds: config.keepRecentRounds,
  });
  return {
    config,
    tokenCounter,
    offloader,
    singleMessageCompactor,
    historyCompactor,
  };
}

/** 清理指定 sessionId 的 offload 目录 */
async function cleanupSession(sessionId: string): Promise<void> {
  const dir = path.resolve(OFFLOAD_BASE, sessionId);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // 忽略清理失败(目录不存在等)
  }
}

/**
 * 构造超阈值 memory:大 user 消息(> 128000 字符)+ 5 轮 assistant+tool。
 * 用于 E2E-4 / E2E-6:总 token > 128000 触发第二层,toSummarize 非空。
 */
function makeOversizedMemory(): ConversationMemory {
  const m = new ConversationMemory();
  m.append(makeSystem('sys'));
  m.append(makeUser('a'.repeat(130000))); // > 128000 触发阈值
  m.append(makeAssistant(['t1']));
  m.append(makeTool('t1', 'r1'));
  m.append(makeAssistant(['t2']));
  m.append(makeTool('t2', 'r2'));
  m.append(makeAssistant(['t3']));
  m.append(makeTool('t3', 'r3'));
  m.append(makeAssistant(['t4']));
  m.append(makeTool('t4', 'r4'));
  m.append(makeAssistant(['t5']));
  m.append(makeTool('t5', 'r5'));
  return m;
}

// ==================== E2E 测试用例 ====================

describe('E2E-1 单条 tool 结果 > 8000 字符 → offload 写盘 + 预览替换', () => {
  const sessionId = uniqueSessionId('1');
  afterEach(async () => {
    await cleanupSession(sessionId);
  });

  it('tool content 被替换为预览+路径,offload 文件内容与原始一致', async () => {
    // 30 行文本(行数 > 20 触发预览),总长 > 8000 单条阈值
    const longContent = makeMultilineContent('A', 9000, 30);
    const compactor = new ContextCompactor(makeRealDeps({}));
    const memory = new ConversationMemory();
    memory.append(makeSystem('sys'));
    memory.append(makeUser('请读取大文件'));
    memory.append(makeAssistant(['t1']));
    memory.append(makeTool('t1', longContent));

    await compactor.runCompaction(memory, { sessionId });

    const messages = memory.getMessages();
    const toolMsg = messages.find(m => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    // content 不再是原始长文本(被预览替换)
    expect(toolMsg!.content).not.toBe(longContent);
    // 含「已省略」与文件路径
    expect(toolMsg!.content).toContain('已省略');
    expect(toolMsg!.content).toContain('.txt');
    // compacted 标记为 true
    expect(toolMsg!.compacted).toBe(true);

    // offload 文件存在且内容与原始一致
    const offloadDir = path.resolve(OFFLOAD_BASE, sessionId);
    const files = await fs.readdir(offloadDir);
    expect(files.length).toBeGreaterThanOrEqual(1);
    const fileContent = await fs.readFile(
      path.join(offloadDir, files[0]),
      'utf8',
    );
    expect(fileContent).toBe(longContent);
  });
});

describe('E2E-2 多 tool 结果合计 > 20000 → 从大到小 offload', () => {
  const sessionId = uniqueSessionId('2');
  afterEach(async () => {
    await cleanupSession(sessionId);
  });

  it('10000 被 offload(单条阈值+合计阈值),6000 与 5000 保留原文', async () => {
    // 25 行文本(行数 > 20 触发预览);合计 21000 > 20000 触发 planOffloads
    const c5000 = makeMultilineContent('B', 5000, 25);
    const c6000 = makeMultilineContent('C', 6000, 25);
    const c10000 = makeMultilineContent('D', 10000, 25);
    const compactor = new ContextCompactor(makeRealDeps({}));
    const memory = new ConversationMemory();
    memory.append(makeUser('multi tools'));
    memory.append(makeAssistant(['t1', 't2', 't3']));
    memory.append(makeTool('t1', c5000));
    memory.append(makeTool('t2', c6000));
    memory.append(makeTool('t3', c10000));

    await compactor.runCompaction(memory, { sessionId });

    const tools = memory.getMessages().filter(m => m.role === 'tool');
    expect(tools.length).toBe(3);

    // t1 (5000): 保留原文,未 offload(单条 < 8000,planOffloads 不选)
    const t1 = tools.find(m => m.tool_call_id === 't1');
    expect(t1!.content).toBe(c5000);
    expect(t1!.compacted).not.toBe(true);

    // t2 (6000): 保留原文,未 offload(单条 < 8000,planOffloads 选 10000 后 total=11000 ≤ 20000 停止)
    const t2 = tools.find(m => m.tool_call_id === 't2');
    expect(t2!.content).toBe(c6000);
    expect(t2!.compacted).not.toBe(true);

    // t3 (10000): 被 offload(单条 > 8000 + planOffloads 选中),content 替换为预览+路径
    const t3 = tools.find(m => m.tool_call_id === 't3');
    expect(t3!.content).not.toBe(c10000);
    expect(t3!.content).toContain('已省略');
    expect(t3!.compacted).toBe(true);
  });
});

describe('E2E-3 总长 > 128000 → 第二层摘要 + 边界消息', () => {
  const sessionId = uniqueSessionId('3');
  afterEach(async () => {
    await cleanupSession(sessionId);
  });

  it('中间历史被替换为 summary + 边界 + 保留消息', async () => {
    const provider = new MockProvider([
      '<draft>分析</draft><summary>## 主要请求\n用户请求\n## 下一步\n继续</summary>',
    ]);
    const compactor = new ContextCompactor(makeRealDeps({ provider }));
    const memory = new ConversationMemory();

    memory.append(makeSystem('system prompt'));
    // 3 个大 user 消息(保留,计入总 token 触发阈值 128000)
    memory.append(makeUser('X'.repeat(45000)));
    // 第 1 轮(进入 toSummarize)
    memory.append(makeAssistant(['t1']));
    memory.append(makeTool('t1', 'r1'));
    memory.append(makeUser('Y'.repeat(45000)));
    // 第 2 轮(进入 toSummarize)
    memory.append(makeAssistant(['t2']));
    memory.append(makeTool('t2', 'r2'));
    memory.append(makeUser('Z'.repeat(45000)));
    // 第 3 轮(进入 toSummarize)
    memory.append(makeAssistant(['t3']));
    memory.append(makeTool('t3', 'r3'));
    // 最近 4 轮(保留)
    memory.append(makeUser('u4'));
    memory.append(makeAssistant(['t4']));
    memory.append(makeTool('t4', 'r4'));
    memory.append(makeUser('u5'));
    memory.append(makeAssistant(['t5']));
    memory.append(makeTool('t5', 'r5'));
    memory.append(makeUser('u6'));
    memory.append(makeAssistant(['t6']));
    memory.append(makeTool('t6', 'r6'));
    memory.append(makeUser('u7'));
    memory.append(makeAssistant(['t7']));
    memory.append(makeTool('t7', 'r7'));

    await compactor.runCompaction(memory, { sessionId });

    const messages = memory.getMessages();

    // 第 1 条:summary 消息(role:system, kind:system_supplement)
    expect(messages[0].role).toBe('system');
    expect(messages[0].kind).toBe('system_supplement');
    expect(messages[0].content).toContain('上下文压缩摘要');

    // 第 2 条:边界消息(role:system, kind:system_supplement, 含「禁止根据摘要脑补」)
    expect(messages[1].role).toBe('system');
    expect(messages[1].kind).toBe('system_supplement');
    expect(messages[1].content).toContain('禁止根据摘要脑补');
    expect(messages[1].content).toContain('请重新读取');

    // 不含 assistant1,2,3 对应的 tool(被摘要替换)
    const toolIds = messages
      .filter(m => m.role === 'tool')
      .map(m => m.tool_call_id);
    expect(toolIds).not.toContain('t1');
    expect(toolIds).not.toContain('t2');
    expect(toolIds).not.toContain('t3');
    // 含最近 4 轮 tool
    expect(toolIds).toContain('t4');
    expect(toolIds).toContain('t5');
    expect(toolIds).toContain('t6');
    expect(toolIds).toContain('t7');

    // 含所有 user 消息(用户原话强制保留)
    const userMsgs = messages.filter(m => m.role === 'user');
    expect(userMsgs.length).toBe(7);

    // provider 被调用 1 次(摘要)
    expect(provider.callCount).toBe(1);
  });
});

describe('E2E-4 熔断后自动触发跳过,forceCompact 仍触发', () => {
  const sessionId = uniqueSessionId('4');
  afterEach(async () => {
    await cleanupSession(sessionId);
  });

  it('summarize 连续失败 3 次后 tripped=true,第 4 次 runCompaction 不调;forceCompact 仍调', async () => {
    const provider = new MockProvider([], new Error('summary fail'));
    const compactor = new ContextCompactor(makeRealDeps({ provider }));

    // 3 次失败
    await compactor.runCompaction(makeOversizedMemory());
    expect(compactor.getConsecutiveFailures()).toBe(1);
    await compactor.runCompaction(makeOversizedMemory());
    expect(compactor.getConsecutiveFailures()).toBe(2);
    await compactor.runCompaction(makeOversizedMemory());
    expect(compactor.getConsecutiveFailures()).toBe(3);
    expect(compactor.isTripped()).toBe(true);

    const callCountAfter3 = provider.callCount;

    // 第 4 次 runCompaction:tripped=true,不调 summarizer(callCount 不增长)
    await compactor.runCompaction(makeOversizedMemory());
    expect(provider.callCount).toBe(callCountAfter3);

    // forceCompact:跳过熔断,仍调 summarizer(callCount +1)
    await compactor.forceCompact(makeOversizedMemory());
    expect(provider.callCount).toBe(callCountAfter3 + 1);
  });
});

describe('E2E-5 /compact 命令 → forceCompact 被调用 + memory 长度下降', () => {
  const sessionId = uniqueSessionId('5');
  afterEach(async () => {
    await cleanupSession(sessionId);
  });

  it('AgentSession.submit({type:"command",name:"/compact"}) 后 memory 长度下降', async () => {
    // mock provider:processInput 时返回文本(无 tool_call,循环一轮终止);
    // summarize 时返回 summary 段
    const provider = new MockProvider([
      '<draft>d</draft><summary>## 主要请求\n测试\n## 下一步\n继续</summary>',
    ]);
    // keepRecentRounds=1:5 轮中 4 轮进入 toSummarize,确保 forceCompact 有内容可压缩
    const contextCompactor = new ContextCompactor(
      makeRealDeps({ provider, config: { keepRecentRounds: 1 } }),
    );
    const agent = new Agent({
      provider,
      config: makeLLMConfig(),
      systemPrompt: 'test system',
      contextCompactor,
      sessionId,
    });
    const session = new AgentSession(agent, {
      onStreamEvent: () => {},
      onExit: () => {},
      onHelp: () => {},
      onCleared: () => {},
    });
    session.start();

    // 5 轮 processInput 累积 memory:system + 5*(user+assistant) = 11 条
    for (let i = 0; i < 5; i++) {
      await agent.processInput(
        { type: 'submit', text: `用户第${i + 1}轮` },
        () => {},
        {},
      );
    }
    const beforeLen = agent.getMemory().length;
    expect(beforeLen).toBe(11);

    // 提交 /compact 命令
    const result = await session.submit({
      type: 'command',
      name: '/compact',
    });
    expect(result).toBe(true);

    const afterLen = agent.getMemory().length;
    // memory 长度下降:toSummarize(4 个 assistant)被替换为 summary + boundary(2 条)
    // 11 → 9
    expect(afterLen).toBeLessThan(beforeLen);
  });
});

describe('E2E-6 摘要 LLM 调用入参 tools 为 undefined', () => {
  const sessionId = uniqueSessionId('6');
  afterEach(async () => {
    await cleanupSession(sessionId);
  });

  it('streamChat 入参 tools 字段为 undefined(不挂工具定义)', async () => {
    const provider = new MockProvider([
      '<draft>d</draft><summary>## 主要请求\n测试</summary>',
    ]);
    const compactor = new ContextCompactor(makeRealDeps({ provider }));

    await compactor.runCompaction(makeOversizedMemory(), { sessionId });

    expect(provider.lastParams).toBeDefined();
    expect(provider.lastParams!.tools).toBeUndefined();
  });
});
