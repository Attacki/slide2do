/**
 * Summarizer — 整体对话历史压缩为结构化摘要
 *
 * 当对话整体逼近窗口上限时，调用 LLM 生成「9 段固定结构」的摘要替换中间历史。
 *
 * 设计要点：
 *  - `buildSummaryPrompt` 为无状态纯函数，可独立单测；负责构造首尾各一次「禁止调用工具」声明、
 *    「草稿+正文」两段格式要求、9 段固定结构标题，以及对话历史拼接。
 *  - `Summarizer` 类复用 `ILLMProvider`，沿用当前 `LLMConfig`，内部强制 `thinking: false`、
 *    不挂 `tools`（确保模型只能输出纯文本，不会触发工具调用）。
 *  - 流式累积 `text_delta`，忽略 `thinking_delta` / `tool_call`；流结束后用非贪婪正则提取
 *    `<summary>...</summary>` 段，草稿 `<draft>...</draft>` 丢弃。
 */

import type { ChatMessage } from '../../ui-pattern.ts';
import type { LLMConfig } from '../../utils/config/config-types.ts';
import type { ILLMProvider, StreamChatParams } from '../../provider/base.ts';

/** summary 段提取正则：非贪婪匹配 `<summary>` 与 `</summary>` 之间内容 */
const SUMMARY_REGEX = /<summary>([\s\S]*?)<\/summary>/;

/**
 * 构造摘要 Prompt（纯函数，无副作用）。
 *
 * Prompt 结构（按顺序）：
 *  1. 首部声明：身份说明 + 【强制约束 1】禁止调用任何工具
 *  2. 【强制约束 2】草稿与正文格式要求（含 `<draft>` / `<summary>` 标签与「草稿用完即弃」）
 *  3. 9 段固定结构标题（## 主要请求 / ## 关键概念 / ... / ## 下一步）
 *  4. 尾部【最后强调】再次声明禁止调用任何工具
 *  5. 对话历史拼接（`[role]: content` 形式）
 *
 * @param messages 待摘要的对话历史
 * @returns 完整 Prompt 字符串
 */
export function buildSummaryPrompt(messages: ChatMessage[]): string {
  const lines: string[] = [];

  // 1. 首部声明（含「禁止调用任何工具」语义，第 1 次）
  lines.push('你是上下文压缩助手。请对以下对话历史生成结构化摘要。');
  lines.push('');
  lines.push(
    '【强制约束 1】禁止调用任何工具。本次请求不携带任何工具定义,你也无法调用工具。只能输出文本。',
  );

  // 2. 草稿与正文格式要求
  lines.push('');
  lines.push('【强制约束 2】请先输出分析草稿,再输出正式摘要。格式严格如下:');
  lines.push('<draft>');
  lines.push(
    '(这里写你的分析草稿:逐条梳理对话中的关键信息,可自由思考。草稿用完即弃,不会保留)',
  );
  lines.push('</draft>');
  lines.push('<summary>');
  lines.push('(这里写正式摘要,按下方 9 段结构组织)');
  lines.push('</summary>');

  // 3. 9 段固定结构标题
  lines.push('');
  lines.push('正式摘要必须包含以下 9 个段落,每段以「## 段落名」开头:');
  lines.push('## 主要请求');
  lines.push('## 关键概念');
  lines.push('## 文件代码');
  lines.push('## 错误修复');
  lines.push('## 解决过程');
  lines.push('## 用户原话');
  lines.push('## 待办');
  lines.push('## 当前工作');
  lines.push('## 下一步');

  // 4. 尾部声明（含「禁止调用任何工具」语义，第 2 次）
  lines.push('');
  lines.push(
    '【最后强调】再次声明:禁止调用任何工具。只输出 <draft>...</draft> 与 <summary>...</summary> 两段文本,不要输出其他内容。',
  );

  // 5. 对话历史拼接
  lines.push('');
  lines.push('=== 对话历史(待摘要)===');
  for (const msg of messages) {
    lines.push(`[${msg.role}]: ${msg.content ?? ''}`);
  }

  return lines.join('\n');
}

/**
 * Summarizer — 调 provider 产出结构化摘要。
 *
 * 构造接收 `provider` 与完整 `LLMConfig`，内部强制 `thinking: false`、不挂 `tools`。
 * `summarize(messages, signal)` 调 `provider.streamChat` 累积 `text_delta`，
 * 流结束后提取 `<summary>...</summary>` 段（草稿丢弃）。
 */
export class Summarizer {
  private readonly provider: ILLMProvider;
  private readonly config: LLMConfig;

  constructor(provider: ILLMProvider, config: LLMConfig) {
    this.provider = provider;
    this.config = config;
  }

  /**
   * 对给定对话历史生成结构化摘要。
   *
   * @param messages 待摘要的对话历史
   * @param signal 可选取消信号；触发 abort 时抛 `Error('Summarizer: aborted')`
   * @returns summary 段内容（trim 后）
   * @throws `Error('Summarizer: aborted')` — signal abort
   * @throws `Error('Summarizer: LLM stream failed: ...')` — provider reject 或流错误事件
   * @throws `Error('Summarizer: missing </summary> tag in LLM response')` — 未匹配闭合标签
   */
  async summarize(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): Promise<string> {
    const prompt = buildSummaryPrompt(messages);

    // 构造 streamChat 入参：强制 thinking:false、不挂 tools
    const params: StreamChatParams = {
      messages: [{ role: 'user', content: prompt }],
      config: { ...this.config, thinking: false },
      // tools 字段缺省（undefined），不挂工具
    };

    let accumulated = '';
    let streamError: Error | null = null;

    const streamPromise = this.provider.streamChat(params, (event) => {
      switch (event.type) {
        case 'text_delta':
          accumulated += event.delta;
          break;
        case 'error':
          streamError = event.error;
          break;
        case 'thinking_delta':
        case 'tool_call':
        case 'done':
          // 忽略思考增量、工具调用；done 仅作为正常结束标志
          break;
      }
    });

    try {
      if (signal) {
        // 用 Promise.race 实现 abort：signal 已 abort 或后续 abort 时立即 reject
        const abortPromise = new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(new Error('Summarizer: aborted'));
            return;
          }
          signal.addEventListener(
            'abort',
            () => reject(new Error('Summarizer: aborted')),
            { once: true },
          );
        });
        await Promise.race([streamPromise, abortPromise]);
      } else {
        await streamPromise;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'Summarizer: aborted') {
        throw new Error('Summarizer: aborted');
      }
      throw new Error(`Summarizer: LLM stream failed: ${msg}`);
    }

    // race 结束后再检查一次 abort（stream 先 resolve 但信号已被触发）
    if (signal?.aborted) {
      throw new Error('Summarizer: aborted');
    }

    if (streamError) {
      throw new Error(
        `Summarizer: LLM stream failed: ${streamError.message}`,
      );
    }

    // 提取 <summary>...</summary> 段（非贪婪）；未匹配抛错
    const match = accumulated.match(SUMMARY_REGEX);
    if (!match) {
      throw new Error('Summarizer: missing </summary> tag in LLM response');
    }

    return match[1].trim();
  }
}
