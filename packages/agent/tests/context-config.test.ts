/**
 * ContextConfig 类型与默认值单元测试
 *
 * 覆盖：
 * - DEFAULT_CONTEXT_CONFIG 全部 9 个字段值与 spec.md 默认值严格一致
 * - AgentConfig 接口接受 context 字段（类型层面）
 */
import { describe, it, expect } from 'bun:test';
import {
  DEFAULT_CONTEXT_CONFIG,
  type AgentConfig,
  type LLMConfig,
} from '../utils/config/config-types.ts';
import type { ContextConfig } from '@wuzi/types';

describe('DEFAULT_CONTEXT_CONFIG — 字段默认值', () => {
  it('compactionEnabled 应为 true', () => {
    expect(DEFAULT_CONTEXT_CONFIG.compactionEnabled).toBe(true);
  });

  it('offloadEnabled 应为 true', () => {
    expect(DEFAULT_CONTEXT_CONFIG.offloadEnabled).toBe(true);
  });

  it('singleToolResultThreshold 应为 8000', () => {
    expect(DEFAULT_CONTEXT_CONFIG.singleToolResultThreshold).toBe(8000);
  });

  it('singleMessageTotalThreshold 应为 20000', () => {
    expect(DEFAULT_CONTEXT_CONFIG.singleMessageTotalThreshold).toBe(20000);
  });

  it('windowUsageThreshold 应为 0.8', () => {
    expect(DEFAULT_CONTEXT_CONFIG.windowUsageThreshold).toBe(0.8);
  });

  it('windowHardLimit 应为 160000', () => {
    expect(DEFAULT_CONTEXT_CONFIG.windowHardLimit).toBe(160000);
  });

  it('keepRecentRounds 应为 4', () => {
    expect(DEFAULT_CONTEXT_CONFIG.keepRecentRounds).toBe(4);
  });

  it('summaryMaxTokens 应为 2000', () => {
    expect(DEFAULT_CONTEXT_CONFIG.summaryMaxTokens).toBe(2000);
  });

  it('summaryFailureThreshold 应为 3', () => {
    expect(DEFAULT_CONTEXT_CONFIG.summaryFailureThreshold).toBe(3);
  });

  it('字段数量应为 9 个（防止字段 silently 漂移）', () => {
    expect(Object.keys(DEFAULT_CONTEXT_CONFIG).length).toBe(9);
  });
});

describe('AgentConfig.context — 类型层面接受 ContextConfig', () => {
  it('应能构造包含 context 字段的合法 AgentConfig', () => {
    const llm: LLMConfig = {
      protocol: 'anthropic',
      model: 'claude-3-5-sonnet',
      base_url: 'https://api.anthropic.com',
      api_key: 'sk-test',
    };

    const context: ContextConfig = {
      compactionEnabled: false,
      offloadEnabled: true,
      singleToolResultThreshold: 4096,
      singleMessageTotalThreshold: 10000,
      windowUsageThreshold: 0.7,
      windowHardLimit: 120000,
      keepRecentRounds: 2,
      summaryMaxTokens: 1500,
      summaryFailureThreshold: 5,
    };

    const config: AgentConfig = {
      agent_role: 'coding',
      llm: [llm],
      context,
    };

    expect(config.context).toBe(context);
    expect(config.context?.compactionEnabled).toBe(false);
    expect(config.context?.singleToolResultThreshold).toBe(4096);
  });

  it('应能构造不含 context 字段的合法 AgentConfig（缺省可选）', () => {
    const llm: LLMConfig = {
      protocol: 'openai',
      model: 'gpt-4o',
      base_url: 'https://api.openai.com',
      api_key: 'sk-test',
    };

    const config: AgentConfig = {
      agent_role: 'coding',
      llm: [llm],
    };

    expect(config.context).toBeUndefined();
  });

  it('应能构造 context 字段为空对象的合法 AgentConfig（全部字段可选）', () => {
    const llm: LLMConfig = {
      protocol: 'openai',
      model: 'gpt-4o',
      base_url: 'https://api.openai.com',
      api_key: 'sk-test',
    };

    const config: AgentConfig = {
      agent_role: 'coding',
      llm: [llm],
      context: {},
    };

    expect(config.context).toEqual({});
  });
});
