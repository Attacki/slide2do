/**
 * Provider 统一接口
 *
 * 抽象流式对话契约，作为各后端实现的上层约束。模型服务商无关：
 * 工具能力通过中立的 ToolDefinition 传入，由各 Provider 映射为自身请求格式。
 */
import type { ChatMessage } from '../ui-pattern.ts';
import type { LLMConfig } from '../utils/config/config-types.ts';
import type { ToolDefinition } from '@wuzi/types';

export interface StreamChatParams {
  /** 完整消息序列（含 system prompt + 历史上下文 + 当前用户输入） */
  messages: ChatMessage[];
  /** 后端配置 */
  config: LLMConfig;
  /** API 认得的工具列表（中立格式）；缺省或为空表示不启用工具 */
  tools?: ToolDefinition[];
}

/**
 * Provider 向核心层推送的流式事件（含工具调用）。
 *
 * `done` 事件的 usage 携带 Anthropic prompt caching 命中字段（cacheReadInputTokens /
 * cacheCreationInputTokens），由 provider 适配层从 API 响应解析后透传，核心层再透传到
 * StreamDoneEvent 供 UI/日志观测缓存策略是否生效。
 */
export type ProviderStreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | {
      type: 'done';
      usage?: {
        inputTokens: number;
        outputTokens: number;
        /** Anthropic prompt caching 命中读取的输入 token 数（OpenAI 侧缺省） */
        cacheReadInputTokens?: number;
        /** Anthropic prompt caching 本次新写入的输入 token 数（OpenAI 侧缺省） */
        cacheCreationInputTokens?: number;
      };
    }
  | { type: 'error'; error: Error };

export type StreamCallback = (event: ProviderStreamEvent) => void;

export interface ILLMProvider {
  /** 协议标识，如 'anthropic' | 'openai' */
  readonly protocol: string;

  /**
   * 发起流式对话
   *
   * @param params - 消息序列、配置与可选工具列表
   * @param onEvent - 每收到一个分片回调一次（text_delta / thinking_delta / tool_call / done / error）
   * @returns Promise 在流结束时 resolve；若发生不可恢复错误则 reject
   */
  streamChat(params: StreamChatParams, onEvent: StreamCallback): Promise<void>;
}
