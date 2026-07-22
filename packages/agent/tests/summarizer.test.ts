/**
 * Summarizer 与 buildSummaryPrompt 单元测试
 *
 * 覆盖：
 * - buildSummaryPrompt：首尾「禁止调用任何工具」声明计数 / 9 段标题存在 / draft+summary 标签声明 /
 *   「草稿用完即弃」语义 / 对话历史拼接格式
 * - Summarizer.summarize：草稿丢弃 / 入参 tools=undefined 且 thinking=false / 缺失闭合标签抛错 /
 *   provider reject 抛错含原始信息 / signal abort 抛 'Summarizer: aborted'
 *
 * 测试用 MockProvider 实现内存版 ILLMProvider，不实际调用远端 LLM。
 */
import { describe, it, expect } from 'bun:test';
import type { ChatMessage } from '../ui-pattern.ts';
import type { LLMConfig } from '../utils/config/config-types.ts';
import type {
  ILLMProvider,
  StreamChatParams,
  StreamCallback,
} from '../provider/base.ts';
import {
  buildSummaryPrompt,
  Summarizer,
} from '../modules/context/summarizer.ts';

/**
 * 内存版 mock provider：按构造时传入的 textChunks 顺序推送 text_delta 事件，
 * 模拟 LLM 流式输出。lastParams 暴露最后一次 streamChat 入参供断言。
 *
 * - shouldReject：若提供，streamChat 直接 throw（模拟 provider 报错）
 * - hang：若为 true，streamChat 返回永不 resolve 的 Promise（模拟长流，用于 abort 测试）
 */
class MockProvider implements ILLMProvider {
  readonly protocol = 'openai';
  public lastParams?: StreamChatParams;
  constructor(
    private readonly textChunks: string[] = [],
    private readonly shouldReject?: Error,
    private readonly hang: boolean = false,
  ) {}
  async streamChat(
    params: StreamChatParams,
    onEvent: StreamCallback,
  ): Promise<void> {
    this.lastParams = params;
    if (this.shouldReject) throw this.shouldReject;
    if (this.hang) {
      // 永不 resolve，仅供 abort 测试使用
      return new Promise<void>(() => {});
    }
    for (const chunk of this.textChunks) {
      onEvent({ type: 'text_delta', delta: chunk });
    }
    onEvent({ type: 'done' });
  }
}

/** 构造测试用 LLMConfig */
function makeConfig(): LLMConfig {
  return {
    protocol: 'openai',
    model: 'gpt-4o',
    base_url: 'https://api.openai.com',
    api_key: 'sk-test',
    thinking: true, // 构造时故意为 true，验证 summarize 内部强制覆盖为 false
  };
}

/** 构造测试用对话历史 */
function makeMessages(): ChatMessage[] {
  return [
    { role: 'user', content: '请帮我修复登录 bug' },
    { role: 'assistant', content: '好的,我来检查 auth.ts 文件' },
    { role: 'user', content: '错误日志显示密码比对失败' },
  ];
}

describe('buildSummaryPrompt', () => {
  it('输出含「禁止调用任何工具」字符串至少 2 次（首尾各一次）', () => {
    const prompt = buildSummaryPrompt(makeMessages());
    const count = prompt.split('禁止调用任何工具').length - 1;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('输出含 9 段固定结构标题（逐个断言存在）', () => {
    const prompt = buildSummaryPrompt(makeMessages());
    expect(prompt).toContain('## 主要请求');
    expect(prompt).toContain('## 关键概念');
    expect(prompt).toContain('## 文件代码');
    expect(prompt).toContain('## 错误修复');
    expect(prompt).toContain('## 解决过程');
    expect(prompt).toContain('## 用户原话');
    expect(prompt).toContain('## 待办');
    expect(prompt).toContain('## 当前工作');
    expect(prompt).toContain('## 下一步');
  });

  it('输出含 <draft> 与 <summary> 标签要求声明', () => {
    const prompt = buildSummaryPrompt(makeMessages());
    expect(prompt).toContain('<draft>');
    expect(prompt).toContain('</draft>');
    expect(prompt).toContain('<summary>');
    expect(prompt).toContain('</summary>');
  });

  it('输出含「草稿用完即弃」语义', () => {
    const prompt = buildSummaryPrompt(makeMessages());
    expect(prompt).toContain('草稿用完即弃');
  });

  it('输出含「=== 对话历史(待摘要)==」与 [role]: content 格式', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hello world' },
      { role: 'assistant', content: 'hi there' },
    ];
    const prompt = buildSummaryPrompt(messages);
    expect(prompt).toContain('=== 对话历史(待摘要)===');
    expect(prompt).toContain('[user]: hello world');
    expect(prompt).toContain('[assistant]: hi there');
  });

  it('空消息列表也能构造 Prompt（对话历史段只有标题）', () => {
    const prompt = buildSummaryPrompt([]);
    expect(prompt).toContain('=== 对话历史(待摘要)===');
    expect(prompt).toContain('禁止调用任何工具');
  });
});

describe('Summarizer.summarize', () => {
  it('provider 流式返回 <draft>xxx</draft><summary>yyy</summary> 时仅返回 yyy（草稿被丢弃）', async () => {
    const provider = new MockProvider([
      '<draft>这是草稿内容,逐条分析对话</draft>',
      '<summary>## 主要请求\n修复登录 bug\n## 下一步\n复查代码</summary>',
    ]);
    const summarizer = new Summarizer(provider, makeConfig());

    const result = await summarizer.summarize(makeMessages());

    expect(result).toBe('## 主要请求\n修复登录 bug\n## 下一步\n复查代码');
  });

  it('调 streamChat 时入参 tools 为 undefined（不挂 tools）', async () => {
    const provider = new MockProvider([
      '<draft>d</draft><summary>s</summary>',
    ]);
    const summarizer = new Summarizer(provider, makeConfig());

    await summarizer.summarize(makeMessages());

    expect(provider.lastParams).toBeDefined();
    // tools 字段缺省（undefined），不挂工具
    expect(provider.lastParams?.tools).toBeUndefined();
  });

  it('调 streamChat 时 config.thinking 为 false（即使构造时 thinking:true 也被覆盖）', async () => {
    const provider = new MockProvider([
      '<draft>d</draft><summary>s</summary>',
    ]);
    const summarizer = new Summarizer(provider, makeConfig());

    await summarizer.summarize(makeMessages());

    expect(provider.lastParams?.config.thinking).toBe(false);
  });

  it('调 streamChat 时入参 messages 仅含一条 user 消息，内容为 buildSummaryPrompt 输出', async () => {
    const provider = new MockProvider([
      '<draft>d</draft><summary>s</summary>',
    ]);
    const summarizer = new Summarizer(provider, makeConfig());
    const messages = makeMessages();

    await summarizer.summarize(messages);

    const expectedPrompt = buildSummaryPrompt(messages);
    expect(provider.lastParams?.messages.length).toBe(1);
    expect(provider.lastParams?.messages[0].role).toBe('user');
    expect(provider.lastParams?.messages[0].content).toBe(expectedPrompt);
  });

  it('调 streamChat 时 config 其他字段（model/base_url/api_key/protocol）沿用构造配置', async () => {
    const provider = new MockProvider([
      '<draft>d</draft><summary>s</summary>',
    ]);
    const config = makeConfig();
    const summarizer = new Summarizer(provider, config);

    await summarizer.summarize(makeMessages());

    expect(provider.lastParams?.config.model).toBe(config.model);
    expect(provider.lastParams?.config.base_url).toBe(config.base_url);
    expect(provider.lastParams?.config.api_key).toBe(config.api_key);
    expect(provider.lastParams?.config.protocol).toBe(config.protocol);
  });

  it('流式输出分多个 text_delta 片段时也能正确拼接并提取 summary', async () => {
    const provider = new MockProvider([
      '<draft>partial</draft>',
      '<summary>',
      '## 主要请求\n',
      '完成某事',
      '</summary>',
    ]);
    const summarizer = new Summarizer(provider, makeConfig());

    const result = await summarizer.summarize(makeMessages());

    expect(result).toBe('## 主要请求\n完成某事');
  });

  it('忽略 thinking_delta 与 tool_call 事件，仅累积 text_delta', async () => {
    // 自定义 provider：在 text_delta 之间穿插 thinking_delta / tool_call
    class MixedProvider implements ILLMProvider {
      readonly protocol = 'openai';
      public lastParams?: StreamChatParams;
      async streamChat(
        params: StreamChatParams,
        onEvent: StreamCallback,
      ): Promise<void> {
        this.lastParams = params;
        onEvent({ type: 'thinking_delta', delta: '思考内容' });
        onEvent({ type: 'text_delta', delta: '<draft>d</draft>' });
        onEvent({
          type: 'tool_call',
          id: 'tc1',
          name: 'some_tool',
          arguments: '{}',
        });
        onEvent({ type: 'text_delta', delta: '<summary>正文</summary>' });
        onEvent({ type: 'done' });
      }
    }
    const provider = new MixedProvider();
    const summarizer = new Summarizer(provider, makeConfig());

    const result = await summarizer.summarize(makeMessages());

    expect(result).toBe('正文');
  });

  it('provider 流式返回缺失 </summary> 闭合标签时抛 Error', async () => {
    const provider = new MockProvider([
      '<draft>草稿</draft><summary>正文未闭合',
    ]);
    const summarizer = new Summarizer(provider, makeConfig());

    await expect(summarizer.summarize(makeMessages())).rejects.toThrow(
      'Summarizer: missing </summary> tag in LLM response',
    );
  });

  it('provider 流式返回完全没有 summary 标签时抛 Error', async () => {
    const provider = new MockProvider(['只有普通文本,没有标签']);
    const summarizer = new Summarizer(provider, makeConfig());

    await expect(summarizer.summarize(makeMessages())).rejects.toThrow(
      'Summarizer: missing </summary> tag in LLM response',
    );
  });

  it('provider 报错（streamChat reject）时抛 Error,错误信息含原始错误', async () => {
    const originalError = new Error('network timeout');
    const provider = new MockProvider([], originalError);
    const summarizer = new Summarizer(provider, makeConfig());

    await expect(summarizer.summarize(makeMessages())).rejects.toThrow(
      'Summarizer: LLM stream failed: network timeout',
    );
  });

  it('provider 报错时错误信息含原始错误（另一种错误信息）', async () => {
    const originalError = new Error('401 unauthorized');
    const provider = new MockProvider([], originalError);
    const summarizer = new Summarizer(provider, makeConfig());

    await expect(summarizer.summarize(makeMessages())).rejects.toThrow(
      'Summarizer: LLM stream failed: 401 unauthorized',
    );
  });

  it('signal abort 时抛 Error("Summarizer: aborted")', async () => {
    const provider = new MockProvider([], undefined, true);
    const summarizer = new Summarizer(provider, makeConfig());
    const controller = new AbortController();

    const promise = summarizer.summarize(makeMessages(), controller.signal);
    // 触发 abort,abortPromise 应立即 reject
    controller.abort();

    await expect(promise).rejects.toThrow('Summarizer: aborted');
  });

  it('signal 已 abort 时调 summarize 立即抛 Error("Summarizer: aborted")', async () => {
    const provider = new MockProvider([
      '<draft>d</draft><summary>s</summary>',
    ]);
    const summarizer = new Summarizer(provider, makeConfig());
    const controller = new AbortController();
    controller.abort();

    await expect(
      summarizer.summarize(makeMessages(), controller.signal),
    ).rejects.toThrow('Summarizer: aborted');
  });
});
