/**
 * Agent 配置数据结构定义
 */

import type { SecurityConfig, McpServerConfig, ContextConfig, InstructionConfig, SessionConfig } from '@wuzi/types';

export type LLMProtocol = 'anthropic' | 'openai';

/** 单个 LLM 后端配置条目 */
export interface LLMConfig {
  protocol: LLMProtocol;
  model: string;
  base_url: string;
  api_key: string;
  thinking?: boolean; // 默认 false，仅 anthropic 生效
}

/**
 * Agent 运行模式：
 *  - `agent`：完整能力，读写工具均可用，自主执行任务（默认）。
 *  - `ask`  ：只读问答/讨论，写类工具被拦截，不改动工程。
 *  - `plan` ：只读调研 + 产出待审批实施计划，写类工具被拦截。
 */
export type AgentMode = 'agent' | 'ask' | 'plan';

/** ReAct 循环配置 */
export interface LoopConfig {
  /** 单次用户输入允许的最大轮数（一轮 = 一次 LLM 调用 + 可选工具执行）；默认 30 */
  maxRounds?: number;
  /** 运行模式：agent（读写）/ ask（只读问答）/ plan（只读规划）；默认 'agent' */
  mode?: AgentMode;
  /**
   * @deprecated 请使用 `mode`。保留用于向后兼容：`planOnly:true` 等价于 `mode:'plan'`。
   * 仅当未显式设置 `mode` 时生效。
   */
  planOnly?: boolean;
  /** 整个循环的内置超时（毫秒），到时以 timeout 原因终止；缺省不限时 */
  timeoutMs?: number;
}

/** 循环配置默认值 */
export const DEFAULT_LOOP_CONFIG: Required<Pick<LoopConfig, 'maxRounds' | 'mode'>> = {
  maxRounds: 30,
  mode: 'agent',
};

/** 顶层配置结构 */
export interface AgentConfig {
  agent_role: string; // 如 'coding'
  active?: string; // 指定生效的 protocol，缺省取首个
  llm: LLMConfig[];
  /** ReAct 循环配置，缺省使用 DEFAULT_LOOP_CONFIG */
  loop?: LoopConfig;
  /** 安全配置，缺省使用 DEFAULT_SECURITY_CONFIG；sandbox 由运行时解析 */
  security?: SecurityConfig;
  /** MCP 配置（远端工具服务列表），缺省无 MCP server */
  mcp?: { servers: McpServerConfig[] };
  /** 上下文窗口管理配置，缺省使用 DEFAULT_CONTEXT_CONFIG */
  context?: ContextConfig;
  /** 项目指令文件（AGENTS.md）加载配置，缺省使用 DEFAULT_INSTRUCTION_CONFIG */
  instructions?: InstructionConfig;
  /** 会话存档与恢复配置，缺省使用 DEFAULT_SESSION_CONFIG */
  session?: SessionConfig;
}

/** Security 配置默认值（mode 与 rules 静态固定；sandbox 留空由运行时解析） */
export const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
  mode: 'default',
  rules: [],
};

/** Context 配置默认值（与 spec.md 设计骨架一致，字段值严格固定） */
export const DEFAULT_CONTEXT_CONFIG: Required<ContextConfig> = {
  compactionEnabled: true,
  offloadEnabled: true,
  singleToolResultThreshold: 8000,
  singleMessageTotalThreshold: 20000,
  windowUsageThreshold: 0.8,
  windowHardLimit: 160000,
  keepRecentRounds: 4,
  summaryMaxTokens: 2000,
  summaryFailureThreshold: 3,
};

/** Instruction 配置默认值（与 spec.md 设计骨架一致，字段值严格固定） */
export const DEFAULT_INSTRUCTION_CONFIG: Required<InstructionConfig> = {
  maxIncludeDepth: 3,
  userLevelPath: '~/.wuzi/AGENTS.md',
};

/** Session 配置默认值（与 spec.md 设计骨架一致，字段值严格固定；dir/tokenLimit 由装配层解析后填入） */
export const DEFAULT_SESSION_CONFIG: Required<Omit<SessionConfig, 'dir' | 'tokenLimit'>> = {
  enabled: true,
  maxAgeDays: 30,
  timeGapMs: 3600000,
};
