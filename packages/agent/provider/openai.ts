/**
 * OpenAI 兼容 SSE 流式 Provider
 *
 * 向 {base_url}/v1/chat/completions 发起 stream:true 请求并解析 SSE 文本增量。
 * 支持工具：将中立 ToolDefinition 映射为 OpenAI function 工具格式，并拼接
 * delta.tool_calls 中的 JSON 参数碎片。
 *
 * 结构分离：按 `kind` 字段将 system 消息分为稳定段（无 kind，角色 prompt）与
 * 动态段（env_info / mode_reminder / system_supplement），合并为单条 system 消息
 * 置于 messages 首位——稳定段在前、动态段在后，便于 OpenAI 侧前缀自动缓存命中
 * （稳定段不变时缓存前缀稳定）。OpenAI 无原生 cache_control 字段，依赖 API 侧
 * 自动缓存。user / assistant / tool 消息映射保持不变。
 */

import type { ILLMProvider, StreamChatParams, StreamCallback } from './base.ts';
import type { ChatMessage } from '../ui-pattern.ts';
import type { ToolDefinition } from '@wuzi/types';
import { ToolCallAccumulator } from '../modules/tools/tool-call-accumulator.ts';

/** 中立工具定义 -> OpenAI function 工具格式 */
function toOpenAITool(def: ToolDefinition) {
  return {
    type: 'function' as const,
    function: {
      name: def.name,
      description: def.description,
      parameters: def.parameters,
    },
  };
}

/** 将中立 ChatMessage 序列归并为 OpenAI messages 数组（system 合并前置） */
function toOpenAIMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  // 按 kind 分流 system 消息：稳定段（无 kind）+ 动态段（带 kind）
  const stableSystem = messages.filter((m) => m.role === 'system' && m.kind === undefined);
  const dynamicSystem = messages.filter((m) => m.role === 'system' && m.kind !== undefined);
  const rest = messages.filter((m) => m.role !== 'system');

  const out: Array<Record<string, unknown>> = [];

  // 合并 system：稳定段在前、动态段在后，拼成单条 system 消息（结构分离便于 API 侧自动缓存）
  const systemParts: string[] = [];
  if (stableSystem.length > 0) {
    systemParts.push(stableSystem.map((m) => m.content).join('\n\n'));
  }
  if (dynamicSystem.length > 0) {
    systemParts.push(dynamicSystem.map((m) => m.content).join('\n\n'));
  }
  if (systemParts.length > 0) {
    out.push({ role: 'system', content: systemParts.join('\n\n') });
  }

  // 其余消息保持原顺序与字段映射
  for (const m of rest) {
    out.push({
      role: m.role,
      content: m.content,
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.tool_calls
        ? {
            tool_calls: m.tool_calls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: tc.arguments },
            })),
          }
        : {}),
    });
  }

  return out;
}

export class OpenAIProvider implements ILLMProvider {
  readonly protocol = 'openai';

  async streamChat(params: StreamChatParams, onEvent: StreamCallback): Promise<void> {
    const { messages, config, tools } = params;

    const missing = [
      !config.api_key && 'api_key',
      !config.base_url && 'base_url',
      !config.model && 'model',
    ].filter(Boolean) as string[];
    if (missing.length > 0) {
      const err = new Error(
        `OpenAI 配置缺失 (${missing.join(', ')})，请检查全局 LLM 配置`
      );
      onEvent({ type: 'error', error: err });
      throw err;
    }

    const url = `${config.base_url.replace(/\/+$/, '')}/v1/chat/completions`;

    const body: Record<string, unknown> = {
      model: config.model,
      stream: true,
      messages: toOpenAIMessages(messages),
    };

    // 挂载工具（中立格式 -> OpenAI 格式）
    if (tools && tools.length > 0) {
      body.tools = tools.map(toOpenAITool);
      body.tool_choice = 'auto';
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.api_key}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`OpenAI API 错误 (${response.status}): ${errText}`);
      }

      if (!response.body) {
        throw new Error('OpenAI 响应无 body');
      }

      await this.parseSSE(response.body, onEvent);
    } catch (err) {
      onEvent({
        type: 'error',
        error: err instanceof Error ? err : new Error(String(err)),
      });
      throw err; // 向上抛出让调用方可捕获
    }
  }

  /** 将已累加的工具调用以 tool_call 事件形式 flush 出去 */
  private flushToolCalls(acc: ToolCallAccumulator, onEvent: StreamCallback): void {
    for (const raw of acc.list()) {
      onEvent({ type: 'tool_call', id: raw.id, name: raw.name, arguments: raw.arguments });
    }
    acc.clear();
  }

  private async parseSSE(
    body: ReadableStream<Uint8Array>,
    onEvent: StreamCallback
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const acc = new ToolCallAccumulator();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // 保留最后一行（可能不完整）
        buffer = lines.pop()!;

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;

          // SSE 规范：冒号后的空格可选，需同时兼容 "data:{...}" 与 "data: {...}"
          if (trimmed.startsWith('data:')) {
            const data = trimmed.slice(5).replace(/^ /, '');
            if (data === '[DONE]') {
              this.flushToolCalls(acc, onEvent);
              onEvent({ type: 'done' });
              return;
            }
            let parsed: any;
            try {
              parsed = JSON.parse(data);
            } catch {
              // 忽略非 JSON 数据（心跳/不完整分片由 buffer 兜底）
              continue;
            }
            // OpenAI 错误以 data: {"error": {...}} 形式返回，需在此拦截
            if (parsed.error) {
              const msg =
                typeof parsed.error === 'string'
                  ? parsed.error
                  : parsed.error.message ?? 'OpenAI 流式返回错误';
              // 先 flush 可能已拼接的工具调用，再报错
              this.flushToolCalls(acc, onEvent);
              throw new Error(`OpenAI 错误: ${msg}`);
            }

            // 文本增量
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              onEvent({ type: 'text_delta', delta: content });
            }

            // 工具调用增量：拼合 id / name / JSON 参数碎片
            const toolCalls = parsed.choices?.[0]?.delta?.tool_calls;
            if (Array.isArray(toolCalls)) {
              for (const tc of toolCalls) {
                const index = typeof tc.index === 'number' ? tc.index : 0;
                acc.push(index, {
                  id: tc.id,
                  name: tc.function?.name,
                  json: tc.function?.arguments,
                });
              }
            }
          }
        }
      }

      // 流正常结束（无显式 [DONE]）
      this.flushToolCalls(acc, onEvent);
      onEvent({ type: 'done' });
    } finally {
      reader.releaseLock();
    }
  }
}
