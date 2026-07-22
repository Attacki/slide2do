/**
 * Agent - 核心对话逻辑（领域模型）
 *
 * 组装「角色 system prompt + 记忆上下文 + 用户输入」为通用消息序列，
 * 通过 ReasoningLoop 编排多轮 ReAct 循环（调用 LLM → 执行工具 → 结果回填 → 继续），
 * 将过程以 IO 事件流暴露给上层 UI。
 *
 * 单轮流式、工具分组执行、plan-only 拦截、取消/超时等编排细节下沉至 ReasoningLoop，
 * Agent 仅负责装配依赖与对外接口（记忆查询、清空、plan 切换、命令处理）。
 */

import type { ChatMessage, StreamEvent, UserInputEvent, TerminationReason } from './ui-pattern.ts';
import { ConversationMemory } from './modules/memory/memory-manger.ts';
import type { ILLMProvider } from './provider/base.ts';
import type { AgentMode, LLMConfig, LoopConfig } from './utils/config/config-types.ts';
import type { ToolContext } from '@wuzi/types';
import type { ToolRegistry } from './modules/tools/tool-registry.ts';
import { ToolExecutor, DEFAULT_TOOL_TIMEOUT_MS } from './modules/tools/tool-executor.ts';
import type { SecurityGate } from './modules/security/security-gate.ts';
import { ReasoningLoop } from './reasoning-loop.ts';
import type { PromptComposer } from './prompt/prompt-composer.ts';
import type { ContextManager } from './modules/context/context-manger.ts';
import type { McpConnectionPool } from './modules/mcp/mcp-registry.ts';
import type { ContextCompactor } from './modules/context/context-compactor.ts';
import type { InstructionLoader } from './modules/memory/instructions/instruction-loader.ts';
import type { SessionManager } from './modules/memory/session/session-manger.ts';

export interface AgentDeps {
  provider: ILLMProvider;
  config: LLMConfig;
  /** 角色稳定 system prompt（由 loadRole() 返回的模块拼装结果） */
  systemPrompt: string;
  /** 工具注册中心；缺省表示不启用工具能力 */
  tools?: ToolRegistry;
  /** 工具执行上下文（cwd 等）；缺省取 process.cwd() */
  toolContext?: ToolContext;
  /** ReAct 循环配置（最大轮数 / plan-only / 超时）；缺省使用默认值 */
  loop?: LoopConfig;
  /**
   * Prompt 编排器；装配后 ReasoningLoop 委托其拼装「稳定 system → env_info → 历史 → mode_reminder」
   * 结构化消息序列，并按节奏注入模式提醒。缺省时直接透传 memory 消息（兼容未改造场景）。
   */
  composer?: PromptComposer;
  /** 环境信息收集器；装配后 ReasoningLoop 在每次 run 开始时现取 env_info 注入动态段。缺省时不注入。 */
  contextManager?: ContextManager;
  /**
   * 安全闸门（含 SecurityGate）；缺省时不启用前置安全检查，保持向后兼容。
   * 注入后由 Agent 内部装配的 ToolExecutor 在派发工具调用前先调用 gate.check 拦截。
   */
  securityGate?: SecurityGate;
  /**
   * MCP 连接池；缺省时不启用 MCP 工具能力。
   * 注入后外层需在 Agent 构造后调用 `agent.initMcp()` 批量拉取并注册工具，
   * 退出时调用 `agent.closeMcp()` 释放 stdio 子进程 / HTTP 连接。
   */
  mcpPool?: McpConnectionPool;
  /**
   * 上下文压缩编排器；缺省时不启用自动 / 手动上下文压缩。
   * 注入后透传给 ReasoningLoop，在每轮 streamChat 之前对 memory 执行 runCompaction
   * （预防层 offload + 兜底层摘要）；并通过 `agent.compactContext()` 暴露 `/compact` 手动触发。
   */
  contextCompactor?: ContextCompactor;
  /**
   * 项目指令文件加载器；缺省时不加载 AGENTS.md。
   * 注入后 Agent 异步调用 `load()`，将合并后的指令文本以 `kind:'system_supplement'` 系统
   * 消息形式追加到 memory（system 之后、user 之前），让 LLM 优先遵循项目级 > 用户级指令。
   * 加载失败归一化为 warn 不阻塞主循环。
   */
  instructionLoader?: InstructionLoader;
  /**
   * 会话生命周期管理器；缺省时不持久化会话存档。
   * 注入后 Agent 异步调 `startSession(sessionId)` 写空 meta，并通过 ReasoningLoop 的
   * `onMessagePersisted` 回调把每条 user/assistant/tool 消息 fire-and-forget 持久化到 JSONL。
   * 持久化失败归一化为 warn 不阻塞主循环。
   */
  sessionManager?: SessionManager;
  /**
   * 会话标识；缺省由 Agent 内部用 `process.pid-${Date.now()}` 生成。
   * 用于 offloader 落盘目录隔离与压缩流程的 sessionId 透传。
   */
  sessionId?: string;
}

/** processInput 运行期选项 */
export interface ProcessOptions {
  /** 外部取消信号（如用户 /exit、UI 主动取消） */
  signal?: AbortSignal;
}

export class Agent {
  private readonly memory = new ConversationMemory();
  private readonly deps: AgentDeps;
  private readonly reactLoop: ReasoningLoop;
  /** 会话标识；用于 offloader 落盘目录隔离 / 压缩流程透传 / 会话存档 ID */
  private sessionId: string;
  /** MCP 是否已初始化（避免重复注册）；initMcp 幂等标志 */
  private mcpInitialized = false;
  /** MCP 是否已关闭（避免重复 close）；closeMcp 幂等标志 */
  private mcpClosed = false;
  /**
   * 异步初始化 Promise；构造时启动，processInput 第一次调用前 await。
   * 负责：① 若注入 sessionManager 调 startSession 写空 meta 复用 sessionId；
   *       ② 若注入 instructionLoader 调 load 拿到指令文本并以 system_supplement 消息注入 memory。
   */
  private readonly initPromise: Promise<void>;

  constructor(deps: AgentDeps) {
    this.deps = deps;
    this.sessionId = deps.sessionId ?? `${process.pid}-${Date.now()}`;
    // 初始化 system prompt
    this.memory.setSystem(deps.systemPrompt);

    // 装配工具执行器
    let executor: ToolExecutor | undefined;
    if (deps.tools) {
      const ctx: ToolContext = deps.toolContext ?? { cwd: process.cwd() };
      executor = new ToolExecutor(deps.tools, ctx, DEFAULT_TOOL_TIMEOUT_MS, deps.securityGate);
    }

    // 装配 ReAct 循环编排器（复用同一记忆与执行器）
    this.reactLoop = new ReasoningLoop({
      provider: deps.provider,
      config: deps.config,
      memory: this.memory,
      tools: deps.tools,
      executor,
      loop: deps.loop,
      composer: deps.composer,
      contextManager: deps.contextManager,
      contextCompactor: deps.contextCompactor,
      onMessagePersisted: this.persistMessage.bind(this),
    });

    // 异步初始化（启动会话存档 + 加载指令文件）；不阻塞构造
    this.initPromise = this.initialize();
  }

  /**
   * 异步初始化：启动会话存档 + 加载指令文件。
   * 异常归一化为 warn 不阻塞主循环。
   */
  private async initialize(): Promise<void> {
    // ① 若注入 sessionManager：用 Agent 已生成的 sessionId 启动会话写空 meta
    if (this.deps.sessionManager) {
      try {
        const id = await this.deps.sessionManager.startSession(this.sessionId);
        // SessionManager 可能用传入的 id，也可能新生成（若未传入）；同步回 sessionId
        this.sessionId = id;
      } catch (e) {
        console.warn(`[agent] 启动会话存档失败: ${(e as Error).message}`);
      }
    }

    // ② 若注入 instructionLoader：加载并合并项目级 + 用户级指令，追加为 system_supplement
    if (this.deps.instructionLoader) {
      try {
        const result = await this.deps.instructionLoader.load();
        if (result.loaded) {
          this.memory.append({
            role: 'system',
            kind: 'system_supplement',
            content: result.content,
          });
        }
      } catch (e) {
        console.warn(`[agent] 指令文件加载失败: ${(e as Error).message}`);
      }
    }
  }

  /**
   * ReasoningLoop onMessagePersisted 回调：把每条 user/assistant/tool 消息
   * fire-and-forget 持久化到 SessionManager 的 JSONL 存档。
   *
   * - sessionManager 缺省时直接 return（不阻塞）
   * - 异常归一化 warn（SessionManager 内部已处理）
   * - 不 await（异步不阻塞主循环）
   */
  private persistMessage(msg: ChatMessage): void {
    if (!this.deps.sessionManager) return;
    // fire-and-forget：错误由 SessionManager 内部归一化 warn
    void this.deps.sessionManager.appendMessage(this.sessionId, msg);
  }

  /** 当前会话标识（供外层 offloader 目录 / 压缩流程透传） */
  getSessionId(): string {
    return this.sessionId;
  }

  /** 获取当前记忆（供外部查询/持久化） */
  getMemory(): ChatMessage[] {
    return this.memory.getMessages();
  }

  /** 当前运行模式（agent / ask / plan） */
  getMode(): AgentMode {
    return this.reactLoop.getMode();
  }

  /** 设置运行模式（即时生效） */
  setMode(mode: AgentMode): void {
    this.reactLoop.setMode(mode);
  }

  /**
   * 处理用户输入并流式返回事件（委托给 ReasoningLoop 驱动多轮循环）。
   *
   * @param input 用户输入或命令
   * @param onEvent 流式事件回调
   * @param options 运行期选项（外部取消信号）
   * @returns 循环终止原因；命令 / 空输入返回 undefined
   */
  async processInput(
    input: UserInputEvent,
    onEvent: (event: StreamEvent) => void,
    options: ProcessOptions = {},
  ): Promise<TerminationReason | undefined> {
    // 等待异步初始化完成（指令加载 + 会话存档启动），保证首条 user 消息之前指令已注入
    await this.initPromise;

    // 处理命令
    if (input.type === 'command') {
      this.handleCommand(input.name);
      return undefined;
    }

    return this.reactLoop.run(input.text, onEvent, { signal: options.signal });
  }

  /** 清空上下文 */
  clearContext(): void {
    this.memory.clear();
  }

  /**
   * 手动触发上下文压缩（`/compact` 命令入口）。
   *
   * 委托 `contextCompactor.forceCompact(this.memory)` 执行第二层压缩（跳过熔断与阈值检查）。
   * 未注入 contextCompactor 时返回 `{ ok: false, message: '上下文压缩未启用' }`。
   * 成功 / 失败均返回结构化结果，由调用方（AgentSession）通过 onStreamEvent 推送提示。
   */
  async compactContext(): Promise<{ ok: boolean; message: string }> {
    if (!this.deps.contextCompactor) {
      return { ok: false, message: '上下文压缩未启用' };
    }
    const ok = await this.deps.contextCompactor.forceCompact(this.memory, {
      sessionId: this.sessionId,
    });
    return ok
      ? { ok: true, message: '上下文已压缩' }
      : { ok: false, message: '上下文压缩失败（摘要生成未成功）' };
  }

  /**
   * 初始化 MCP：拉取连接池中所有 server 的工具并批量注册进 ToolRegistry。
   * - mcpPool 缺省时直接 return（向后兼容）
   * - 幂等：重复调用不重注册
   * - 单个工具注册失败（重名等）跳过并 warn，不影响其他工具
   */
  async initMcp(): Promise<void> {
    if (!this.deps.mcpPool) return;
    if (this.mcpInitialized) return;
    this.mcpInitialized = true;

    const registry = this.deps.tools;
    if (!registry) {
      console.warn('[agent:mcp] ToolRegistry 未注入，跳过 MCP 工具注册');
      return;
    }

    let tools;
    try {
      tools = await this.deps.mcpPool.getTools();
    } catch (e) {
      console.error(
        `[agent:mcp] 拉取 MCP 工具失败: ${(e as Error).message}`,
      );
      return;
    }

    for (const tool of tools) {
      try {
        registry.register(tool);
      } catch (e) {
        console.warn(
          `[agent:mcp] 工具 "${tool.name}" 注册跳过: ${(e as Error).message}`,
        );
      }
    }
  }

  /**
   * 关闭 MCP 连接池：释放所有 stdio 子进程 / HTTP 连接。
   * - mcpPool 缺省时直接 return（向后兼容）
   * - 幂等：重复调用不重复 close
   * - 内部吞异常以避免退出钩子卡死（错误由 McpConnectionPool 内部记录）
   */
  async closeMcp(): Promise<void> {
    if (!this.deps.mcpPool) return;
    if (this.mcpClosed) return;
    this.mcpClosed = true;
    try {
      await this.deps.mcpPool.close();
    } catch (e) {
      console.error(`[agent:mcp] 关闭连接池失败: ${(e as Error).message}`);
    }
  }

  private handleCommand(name: '/exit' | '/clear' | '/help' | '/agent' | '/ask' | '/plan' | '/compact'): void {
    // 命令由外层 UI 分发，此处仅做内部状态变更
    // /compact 由 AgentSession 直接调用 agent.compactContext() 异步处理，不在此同步分支
    if (name === '/clear') {
      this.clearContext();
    } else if (name === '/agent') {
      this.setMode('agent');
    } else if (name === '/ask') {
      this.setMode('ask');
    } else if (name === '/plan') {
      this.setMode('plan');
    }
    // /exit /help /compact 由调用方处理
  }
}
