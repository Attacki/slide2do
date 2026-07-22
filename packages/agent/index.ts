/**
 * @wuzi/core - 核心模块导出
 */

// IO 模型
export type {
    ChatMessage,
    MessageRole,
    StreamEvent,
    UserMessageEvent,
    TextDeltaEvent,
    ThinkingDeltaEvent,
    ToolCallEvent,
    ToolCallStartEvent,
    ToolResultEvent,
    PlanBlockedEvent,
    FinalAnswerEvent,
    LoopTerminatedEvent,
    TerminationReason,
    StreamDoneEvent,
    StreamErrorEvent,
    UserInputEvent,
    SubmitInputEvent,
    CommandEvent,
} from './ui-pattern.ts';

// Provider
export type { ILLMProvider, StreamChatParams, StreamCallback } from './provider/base.ts';
export {
    createProvider,
    registerProvider,
} from './provider/client.ts';
export { OpenAIProvider } from './provider/openai.ts';
export { AnthropicProvider } from './provider/anthropic.ts';

// 配置
export {
    loadConfig,
    getActiveProvider as resolveActiveConfig,
    validateProvider,
} from './utils/config/path-sheet.ts';
export type {
    AgentConfig,
    AgentMode,
    LLMConfig,
    LLMProtocol,
    LoopConfig,
} from './utils/config/config-types.ts';
export { DEFAULT_LOOP_CONFIG } from './utils/config/config-types.ts';

// 记忆
export { ConversationMemory } from './modules/memory/memory-manger.ts';

// Prompt 编排层
export { PromptComposer } from './prompt/prompt-composer.ts';

// 环境信息收集
export { ContextManager } from './modules/context/context-manger.ts';

// 上下文压缩模块
export { TokenCounter, estimateTokens } from './modules/context/token-counter.ts';
export { ToolResultOffloader, buildPreviewText } from './modules/context/offloader.ts';
export {
  SingleMessageCompactor,
  planOffloads,
} from './modules/context/single-message-compactor.ts';
export type {
  SingleMessageCompactorConfig,
  SingleMessageCompactorLike,
  CompactResult,
  ToolResultEntry,
} from './modules/context/single-message-compactor.ts';
export type { ToolResultOffloaderLike } from './modules/context/offloader.ts';
export { Summarizer, buildSummaryPrompt } from './modules/context/summarizer.ts';
export {
  HistoryCompactor,
  partitionMessages,
} from './modules/context/history-compactor.ts';
export type {
  HistoryCompactorConfig,
  PartitionResult,
  SummarizerLike,
} from './modules/context/history-compactor.ts';
export { ContextCompactor } from './modules/context/context-compactor.ts';
export type {
  ContextCompactorDeps,
  CompactionOptions,
} from './modules/context/context-compactor.ts';

// 上下文配置默认值
export { DEFAULT_CONTEXT_CONFIG } from './utils/config/config-types.ts';
export type { ContextConfig } from '@wuzi/types';

// 项目指令与会话存档配置默认值
export {
  DEFAULT_INSTRUCTION_CONFIG,
  DEFAULT_SESSION_CONFIG,
} from './utils/config/config-types.ts';
export type {
  InstructionConfig,
  SessionConfig,
  SessionMeta,
} from '@wuzi/types';

// 项目指令加载器（AGENTS.md 多层级 + @include）
export { InstructionLoader } from './modules/memory/instructions/instruction-loader.ts';
export type {
  InstructionLoaderOptions,
  InstructionLoadResult,
  IncludeDirective,
} from './modules/memory/instructions/instruction-loader.ts';
export {
  parseIncludeDirectives,
  isPathSafe,
  expandIncludes,
  DEFAULT_MAX_INCLUDE_DEPTH,
} from './modules/memory/instructions/instruction-loader.ts';

// 会话存档与恢复
export {
  SessionStore,
  serializeMessage,
  parseJsonlLine,
} from './modules/memory/session/session-store.ts';
export type {
  SessionStoreOptions,
  ReadMessagesResult,
} from './modules/memory/session/session-store.ts';
export {
  SessionRecovery,
  truncateToCompleteMessages,
  detectTimeGap,
} from './modules/memory/session/session-recovery.ts';
export type {
  SessionRecoveryOptions,
  RecoverOptions,
  RecoveryResult,
  TruncateResult,
} from './modules/memory/session/session-recovery.ts';
export {
  SessionCleaner,
  isExpired,
  ONE_DAY_MS,
} from './modules/memory/session/session-cleaner.ts';
export type {
  SessionCleanerOptions,
  CleanResult,
} from './modules/memory/session/session-cleaner.ts';
export {
  SessionManager,
  computeMetaUpdate,
} from './modules/memory/session/session-manger.ts';
export type {
  SessionManagerOptions,
  LoadSessionResult,
} from './modules/memory/session/session-manger.ts';

// 角色
export { getRole, getRegisteredRoles, registerRole, loadStableSystem } from '../agent-roles/roles-registry.ts';
export type { RoleLoader } from '../agent-roles/roles-registry.ts';

// Agent 核心
export { Agent } from './agent.ts';
export type { AgentDeps, ProcessOptions } from './agent.ts';
export { AgentSession } from './agent-session.ts';
export type { LoopCallbacks } from './agent-session.ts';
export { ReasoningLoop, groupToolCalls } from './reasoning-loop.ts';
export type { ReasoningLoopDeps, RunOptions, GroupedToolCalls } from './reasoning-loop.ts';

// 工具系统
export { ToolRegistry } from './modules/tools/tool-registry.ts';
export { ToolExecutor, DEFAULT_TOOL_TIMEOUT_MS } from './modules/tools/tool-executor.ts';
export {
  ToolCallAccumulator,
  parseToolArguments,
} from './modules/tools/tool-call-accumulator.ts';
export type {
  RawToolCall,
  ToolCallFragment,
} from './modules/tools/tool-call-accumulator.ts';
export type {
  Tool,
  ToolContext,
  ToolResult,
  ToolDefinition,
  ToolCall,
  JSONSchema,
} from '@wuzi/types';

// 安全模块
export { RuleStore } from './modules/security/rule-store.ts';
export type { RuleStorePaths } from './modules/security/rule-store.ts';
export { SecurityGate } from './modules/security/security-gate.ts';
export type { SecurityDecision, SecurityGateOptions } from './modules/security/security-gate.ts';

// MCP 模块
export { McpConnectionPool, createMcpConnectionPool } from './modules/mcp/mcp-registry.ts';
export type { McpClientFactory } from './modules/mcp/mcp-registry.ts';
export type { McpClient, McpClientOptions, McpToolCallResult } from './modules/mcp/mcp-client.ts';
