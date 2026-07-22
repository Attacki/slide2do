/**
 * Anthropic Claude SSE 流式 Provider（含 extended thinking 与 prompt caching）
 *
 * 向 {base_url}/v1/messages 发起 stream:true 请求并解析 SSE。
 * 支持工具：将中立 ToolDefinition 映射为 Anthropic 工具格式，并拼接
 * content_block_delta(input_json_delta) 中的 partial_json 参数碎片。
 *
 * 当配置开启 thinking 时启用 extended thinking 并输出思考增量事件。
 *
 * Prompt caching：
 * system 字段仅含稳定段（角色 prompt，无 kind 标记的 system 消息）挂cache_control:{type:'ephemeral'}（断点 1）
 * tools 数组末尾工具挂 cache_control（断点 2），
 * 其前缀 = 稳定 system + tools，完全静态、命中率最高，不受动态段变动影响。动态段
 * （env_info / mode_reminder / system_supplement，带 kind 的 system 消息）转为 user 消息，
 * 置于 messages 末尾（mode_reminder 兜底在最后），不参与断点 1/2 的前缀计算，避免污染缓存。
 *
 * 对话历史缓存（断点 3 / 4，可选）：在对话历史中每 N 轮（CONVERSATION_CACHE_EVERY_N_TURNS，
 * 默认 3）的最后一条消息挂 cache_control，使「稳定 system + tools + 截至该轮的历史」成为可
 * 缓存前缀。轮号从对话起点 1-based 计数（turn % N === 0），故对话增长时旧断点位置不动、缓存
 * 键不漂移。断点只落在真实对话历史上（restMsgs），尾部动态段在其之后追加，因此模式/环境变动
 * 不会击穿对话断点前缀。受 Anthropic 单请求 cache_control 上限（MAX_CACHE_BREAKPOINTS = 4）
 * 约束，扣除系统/工具已用断点后，仅保留最靠近末尾的最多 2 个对话断点。
 *
 * 消息序列化（toAnthropicMessages）：
 *  - assistant + tool_calls：content 转为 content blocks 数组（text + tool_use 块），
 *    input 字段为已解析的 JSON 对象；纯文本 assistant 保留字符串 content。
 *  - tool 消息：合并连续条目为单个 user 消息，content 为 tool_result 块数组
 *    （tool_use_id + content），保证「每个 tool_use 都有对应 tool_result」的契约。
 *  - user 消息原样透传。
 * 不正确序列化会导致 LLM 看不到自己之前调用过工具，把 tool 结果当作新的用户输入，
 * 触发「复读用户消息 → 调工具 → 复读 → 再调工具」的死循环。
 */

import type { ILLMProvider, StreamChatParams, StreamCallback } from './base.ts';
import type { ChatMessage } from '../ui-pattern.ts';
import type { ToolDefinition } from '@wuzi/types';
import { ToolCallAccumulator } from '../modules/tools/tool-call-accumulator.ts';

/** Anthropic 工具格式（末尾工具可挂 cache_control 实现工具集缓存） */
interface AnthropicTool {
  name: string;
  description: string;
  input_schema: ToolDefinition['parameters'];
  cache_control?: { type: 'ephemeral' };
}

/** 中立工具定义 -> Anthropic 工具格式 */
function toAnthropicTool(def: ToolDefinition): AnthropicTool {
  return {
    name: def.name,
    description: def.description,
    input_schema: def.parameters,
  };
}

/** Anthropic 单请求允许的 cache_control 断点上限（system + tools + 对话断点合计） */
const MAX_CACHE_BREAKPOINTS = 4;

/**
 * 对话历史缓存断点的轮间隔（1-based 轮号 % N === 0 处挂断点）。
 * 越大 → 缓存写入频率越低（写入费率 1.25x），但两轮之间的新增内容需全价重算；
 * 越小 → 断点越密、缓存命中越细，但写入更频繁。3 在写入成本与覆盖率间较均衡。
 */
const CONVERSATION_CACHE_EVERY_N_TURNS = 3;

/**
 * 计算对话历史中应挂 cache_control 的输入消息下标（基于 restMsgs，不含尾部动态段）。
 *
 * 回合分组：以 `user` 消息作为一轮起点，其后连续的 assistant/tool 消息归属同一轮，
 * 直到下一个 `user` 出现；每轮最后的输入消息即为该轮边界。
 *
 * 命中策略：
 *  - 在「轮号(1-based) % everyN === 0」的轮末挂断点，前缀按轮稳定，对话增长时旧断点位置不漂移。
 *  - 仅保留最靠近末尾的最多 maxBreakpoints 个候选，最大化最近对话的缓存读取覆盖率，
 *    同时受 Anthropic 单请求 cache_control 上限约束。
 *  - 对话轮数不足 everyN 时不挂断点（前缀过短缓存收益低，且避免浪费断点额度）。
 *
 * 返回的下标基于传入的 msgs（即 restMsgs）；调用方将其与尾部动态段拼接后下标仍然有效。
 */
function computeConversationBreakpointIndices(
  msgs: ChatMessage[],
  everyN: number,
  maxBreakpoints: number,
): Set<number> {
  if (everyN < 1 || maxBreakpoints < 1) return new Set();

  // 1) 分组为轮，记录每轮最后的输入下标
  const turnLastIndices: number[] = [];
  let currentTurnLast = -1;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    if (m.role === 'user') {
      if (currentTurnLast >= 0) turnLastIndices.push(currentTurnLast);
      currentTurnLast = i;
    } else {
      currentTurnLast = i;
    }
  }
  if (currentTurnLast >= 0) turnLastIndices.push(currentTurnLast);

  // 2) 轮数不足 everyN 不挂断点（前缀过短，缓存收益低）
  if (turnLastIndices.length < everyN) return new Set();

  // 3) 候选：轮号(1-based) % everyN === 0
  const candidates: number[] = [];
  for (let t = 0; t < turnLastIndices.length; t++) {
    if ((t + 1) % everyN === 0) candidates.push(turnLastIndices[t]!);
  }

  // 4) 仅保留最靠近末尾的 maxBreakpoints 个
  return new Set(candidates.slice(-maxBreakpoints));
}

/**
 * 在消息的最后一个 content block 上挂 cache_control:{type:'ephemeral'}。
 * 若 content 为字符串（user/assistant 纯文本），先转为单 block 数组再挂。
 */
function attachCacheControl(msg: Record<string, unknown>): void {
  let content = msg.content;
  if (typeof content === 'string') {
    content = [{ type: 'text', text: content }];
    msg.content = content;
  }
  if (Array.isArray(content) && content.length > 0) {
    const lastBlock = content[content.length - 1] as Record<string, unknown>;
    lastBlock.cache_control = { type: 'ephemeral' };
  }
}

export class AnthropicProvider implements ILLMProvider {
  readonly protocol = 'anthropic';

  async streamChat(params: StreamChatParams, onEvent: StreamCallback): Promise<void> {
    const { messages, config, tools } = params;

    // 校验关键配置，缺失时直接抛出清晰错误，避免后续产生无信息的失败
    const missing = [
      !config.api_key && 'api_key',
      !config.base_url && 'base_url',
      !config.model && 'model',
    ].filter(Boolean) as string[];
    if (missing.length > 0) {
      const err = new Error(
        `Anthropic 配置缺失 (${missing.join(', ')})，请检查全局 LLM 配置`
      );
      onEvent({ type: 'error', error: err });
      throw err;
    }

    const url = `${config.base_url.replace(/\/+$/, '')}/v1/messages`;

    const enableThinking = config.thinking === true && config.protocol === 'anthropic';

    // 构建请求体：Anthropic 要求 system 单独传。
    // 按 kind 分流 system 消息：
    //  - 稳定段（无 kind，角色 prompt）→ system 字段，挂 cache_control（断点 1，可缓存）
    //  - 动态段（env_info / mode_reminder / system_supplement，带 kind）→ 转为 user 消息，
    //    置于 messages 末尾（不参与断点 1/2 的前缀计算，避免污染缓存）
    const stableSystemMsgs = messages.filter((m) => m.role === 'system' && m.kind === undefined);
    const dynamicSystemMsgs = messages.filter((m) => m.role === 'system' && m.kind !== undefined);
    const restMsgs = messages.filter((m) => m.role !== 'system');

    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: enableThinking ? 16000 : 4096,
      stream: true,
    };

    // system 字段以数组形式传递：仅稳定段，挂 cache_control（断点 1）
    const systemBlocks: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> = [];
    if (stableSystemMsgs.length > 0) {
      systemBlocks.push({
        type: 'text',
        text: stableSystemMsgs.map((m) => m.content).join('\n\n'),
        cache_control: { type: 'ephemeral' },
      });
    }
    if (systemBlocks.length > 0) {
      body.system = systemBlocks;
    }

    // 挂载工具（中立格式 -> Anthropic 格式）；末尾工具挂 cache_control（断点 2）。
    // 断点 2 前缀 = 稳定 system + tools，完全静态，命中率最高，不受动态段变动影响。
    if (tools && tools.length > 0) {
      const anthropicTools: AnthropicTool[] = tools.map(toAnthropicTool);
      anthropicTools[anthropicTools.length - 1]!.cache_control = { type: 'ephemeral' };
      body.tools = anthropicTools;
    }

    // 对话历史缓存断点：扣除 system/工具已用断点后，在真实对话历史（restMsgs）的每 N 轮末
    // 挂 cache_control（断点 3/4）。下标基于 restMsgs，与尾部动态段拼接后仍有效。
    const usedBreakpoints =
      (systemBlocks.length > 0 ? 1 : 0) + (tools && tools.length > 0 ? 1 : 0);
    const availableConversationBreakpoints = Math.max(
      0,
      MAX_CACHE_BREAKPOINTS - usedBreakpoints,
    );
    const conversationBreakpoints = computeConversationBreakpointIndices(
      restMsgs,
      CONVERSATION_CACHE_EVERY_N_TURNS,
      availableConversationBreakpoints,
    );

    // 动态段转为 user 消息，置于 messages 末尾（mode_reminder 兜底在最后），
    // 不参与 system / tools 缓存断点的前缀计算，避免污染缓存。
    const dynamicAsUser = dynamicSystemMsgs.map((m) => ({ role: 'user' as const, content: m.content }));
    body.messages = this.toAnthropicMessages(
      [...restMsgs, ...dynamicAsUser],
      conversationBreakpoints,
    );

    if (enableThinking) {
      body.thinking = {
        type: 'enabled',
        budget_tokens: 10000,
      };
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.api_key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Anthropic API 错误 (${response.status}): ${errText}`);
      }

      if (!response.body) {
        throw new Error('Anthropic 响应无 body');
      }

      await this.parseSSE(response.body, onEvent);
    } catch (err) {
      onEvent({
        type: 'error',
        error: err instanceof Error ? err : new Error(String(err)),
      });
      throw err;
    }
  }

  /** 将已累加且完成的工具调用 flush（保留未在此处完成的，待 message_stop 兜底） */
  private flushToolCalls(acc: ToolCallAccumulator, onEvent: StreamCallback): void {
    for (const raw of acc.list()) {
      onEvent({ type: 'tool_call', id: raw.id, name: raw.name, arguments: raw.arguments });
    }
    acc.clear();
  }

  /**
   * 将中立 ChatMessage 序列（已剔除 system）转换为 Anthropic messages 数组。
   *
   * 关键映射：
   *  - assistant + tool_calls：content 转为 content blocks 数组（text + tool_use），
   *    其中 tool_use.input 为已解析的 JSON 对象（Anthropic 要求对象而非字符串）；
   *    纯文本 assistant 保留字符串 content。
   *  - tool 消息：合并连续条目为单个 user 消息，content 为 tool_result 块数组
   *    （tool_use_id + content）。合并连续 tool 消息避免出现连续 user 角色，
   *    同时匹配 Anthropic「每个 tool_use 必须有对应 tool_result」的契约。
   *  - user 消息：原样透传。
   *
   * 参数 JSON 解析失败时传空对象，Anthropic 会以 400 拒绝并提示参数错误，
   * 由调用方上层归一化为结构化错误给模型调整。
   */
  private toAnthropicMessages(
    msgs: ChatMessage[],
    /** 需挂 cache_control 的输入消息下标（基于 msgs，指向每轮末消息） */
    breakpoints: Set<number> = new Set(),
  ): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    let i = 0;
    while (i < msgs.length) {
      const m = msgs[i]!;
      if (m.role === 'assistant') {
        if (m.tool_calls && m.tool_calls.length > 0) {
          // assistant + tool_calls → content blocks 数组（text + tool_use）
          const content: Array<Record<string, unknown>> = [];
          if (m.content) {
            content.push({ type: 'text', text: m.content });
          }
          for (const tc of m.tool_calls) {
            let input: unknown = {};
            try {
              input = tc.arguments.trim() ? JSON.parse(tc.arguments) : {};
            } catch {
              // 解析失败时传空对象，由 Anthropic 以 400 拒绝并提示参数错误
              input = {};
            }
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input,
            });
          }
          out.push({ role: 'assistant', content });
        } else {
          // 纯文本 assistant
          out.push({ role: 'assistant', content: m.content });
        }
        i++;
      } else if (m.role === 'tool') {
        // 合并连续 tool 消息为单个 user 消息（含多个 tool_result 块）
        const toolResults: Array<Record<string, unknown>> = [];
        while (i < msgs.length && msgs[i]!.role === 'tool') {
          const t = msgs[i]!;
          toolResults.push({
            type: 'tool_result',
            tool_use_id: t.tool_call_id,
            content: t.content,
          });
          i++;
        }
        out.push({ role: 'user', content: toolResults });
      } else {
        // user 消息原样保留
        out.push({ role: m.role, content: m.content });
        i++;
      }

      // 若本轮最后消费的输入下标命中断点，在当前末尾输出消息上挂 cache_control。
      // 由于 tool 合并后整轮末消息即为本次 push 的合并 user 消息，故统一以 out 末尾为准。
      if (breakpoints.has(i - 1)) {
        attachCacheControl(out[out.length - 1]!);
      }
    }
    return out;
  }

  private async parseSSE(
    body: ReadableStream<Uint8Array>,
    onEvent: StreamCallback
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const acc = new ToolCallAccumulator();
    let buffer = '';

    // usage 累积：input_tokens / cache_* 来自 message_start，output_tokens 来自 message_delta（覆盖最新值）
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadInputTokens: number | undefined;
    let cacheCreationInputTokens: number | undefined;
    let sawUsage = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;

          // SSE 规范：冒号后的空格可选，需同时兼容 "data:{...}" 与 "data: {...}"
          if (trimmed.startsWith('data:')) {
            const data = trimmed.slice(5).replace(/^ /, '');
            let event: any;
            try {
              event = JSON.parse(data);
            } catch {
              // 忽略非 JSON 数据（心跳/不完整分片由 buffer 兜底）
              continue;
            }
            switch (event.type) {
              case 'message_start': {
                // 初始 usage：input_tokens 与 cache_* 在此处给出，output_tokens 通常为 0 或缺省
                const u = event.message?.usage;
                if (u) {
                  inputTokens = Number(u.input_tokens ?? 0);
                  outputTokens = Number(u.output_tokens ?? 0);
                  if (typeof u.cache_read_input_tokens === 'number') {
                    cacheReadInputTokens = u.cache_read_input_tokens;
                  }
                  if (typeof u.cache_creation_input_tokens === 'number') {
                    cacheCreationInputTokens = u.cache_creation_input_tokens;
                  }
                  sawUsage = true;
                }
                break;
              }

              case 'message_delta': {
                // 增量 usage：output_tokens 在此处给出最终累计值，覆盖即可
                const u = event.usage;
                if (u) {
                  if (typeof u.output_tokens === 'number') {
                    outputTokens = u.output_tokens;
                    sawUsage = true;
                  }
                }
                break;
              }

              case 'content_block_start': {
                const idx = event.index as number;
                const delta = event.content_block;
                if (delta?.type === 'tool_use') {
                  acc.push(idx, { id: delta.id, name: delta.name });
                }
                break;
              }

              case 'content_block_delta': {
                const idx = event.index as number;
                const deltaType = event.delta?.type;
                if (deltaType === 'thinking_delta') {
                  const text = event.delta?.thinking ?? '';
                  if (text) onEvent({ type: 'thinking_delta', delta: text });
                } else if (deltaType === 'text_delta') {
                  const text = event.delta?.text ?? '';
                  if (text) onEvent({ type: 'text_delta', delta: text });
                } else if (deltaType === 'input_json_delta') {
                  // 工具参数 JSON 碎片拼接
                  acc.push(idx, { json: event.delta?.partial_json ?? '' });
                }
                break;
              }

              case 'content_block_stop': {
                const idx = event.index as number;
                const raw = acc.get(idx);
                if (raw) {
                  onEvent({
                    type: 'tool_call',
                    id: raw.id,
                    name: raw.name,
                    arguments: raw.arguments,
                  });
                  acc.remove(idx); // 该块已完成，移除避免 message_stop 重复推送
                }
                break;
              }

              case 'error': {
                // 流内错误事件：Anthropic 有时以 200 + SSE error 形式返回失败
                const msg =
                  event.error?.message ??
                  event.error?.type ??
                  'Anthropic 流式返回错误';
                this.flushToolCalls(acc, onEvent);
                throw new Error(`Anthropic 错误: ${msg}`);
              }

              case 'message_stop':
                this.flushToolCalls(acc, onEvent);
                onEvent({ type: 'done', usage: this.buildUsage(sawUsage, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens) });
                return;
            }
          }
        }
      }

      // 流正常结束（无显式 message_stop）
      this.flushToolCalls(acc, onEvent);
      onEvent({ type: 'done', usage: this.buildUsage(sawUsage, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens) });
    } finally {
      reader.releaseLock();
    }
  }

  /** 构造 done 事件的 usage（仅在解析到过 usage 字段时返回，否则 undefined 保持兼容） */
  private buildUsage(
    sawUsage: boolean,
    inputTokens: number,
    outputTokens: number,
    cacheReadInputTokens?: number,
    cacheCreationInputTokens?: number,
  ): { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number } | undefined {
    if (!sawUsage) return undefined;
    const usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number } = {
      inputTokens,
      outputTokens,
    };
    if (cacheReadInputTokens !== undefined) usage.cacheReadInputTokens = cacheReadInputTokens;
    if (cacheCreationInputTokens !== undefined) usage.cacheCreationInputTokens = cacheCreationInputTokens;
    return usage;
  }
}
