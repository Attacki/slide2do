/**
 * Provider 工厂
 *
 * 依据生效后端的 protocol 选择对应 Provider 实现。
 */

import type { ILLMProvider } from './base.ts';
import type { LLMConfig, LLMProtocol } from '../utils/config/config-types.ts';
import { OpenAIProvider } from './openai.ts';
import { AnthropicProvider } from './anthropic.ts';

/** 已注册的 Provider 构造器 */
const registry: Record<string, new () => ILLMProvider> = {
  openai: OpenAIProvider,
  anthropic: AnthropicProvider,
};

/**
 * 注册自定义 Provider（供后续扩展新后端）
 */
export function registerProvider(protocol: string, ctor: new () => ILLMProvider): void {
  registry[protocol.toLowerCase()] = ctor;
}

/**
 * 根据配置创建对应的 Provider 实例
 *
 * @throws 若 protocol 未注册则抛出错误
 */
export function createProvider(config: LLMConfig): ILLMProvider {
  const proto = config.protocol.toLowerCase() as LLMProtocol;
  const Ctor = registry[proto];
  if (!Ctor) {
    throw new Error(`未知的 LLM protocol: "${proto}" (仅支持 ${Object.keys(registry).join(', ')})`);
  }
  return new Ctor();
}

/** 导出类型供外部引用 */
export type { ILLMProvider, StreamChatParams, StreamCallback } from './base.ts';
