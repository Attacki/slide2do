/**
 * ReasoningLoop — ReAct 范式多轮推理编排器
 *
 * 一轮 = 调 LLM → 拿到响应 → 有工具调用就执行 → 结果回填 → 下一轮；无工具调用即结束。
 *
 * 职责：
 *  - 以状态机驱动多轮：每轮结束判定「继续 / 终止」，终止原因见 {@link TerminationReason}。
 *  - 对外通过 StreamEvent 事件流暴露过程（用户消息 / 思考 / 文本 / 工具调用 / 工具结果 / 最终回复 / 终止 / 错误）。
 *  - 一轮内多个工具调用按读类（并发）/ 写类（串行）分组执行。
 *  - 运行模式（agent / ask / plan）：ask 与 plan 为只读模式，写类工具被拦截；模式提醒通过
 *    PromptComposer 以 mode_reminder 消息按节奏注入（首轮/模式切换完整、其余精简，三种模式均注入，
 *    保证模型始终知晓当前模式；未装配 composer 时兼容透传 memory 消息，不注入提醒）。
 *  - 双通道取消：外部 AbortSignal + 内置 timeoutMs，任一触发即干净终止且状态一致。
 *
 * 与展示层解耦：仅依赖 provider / 记忆 / 注册中心 / 执行器抽象，不感知具体 UI。
 */
import type { ChatMessage, StreamEvent, TerminationReason } from './ui-pattern.ts';
import type { ILLMProvider } from './provider/base.ts';
import type { AgentMode, LLMConfig, LoopConfig } from './utils/config/config-types.ts';
import { DEFAULT_LOOP_CONFIG } from './utils/config/config-types.ts';
import type { ConversationMemory } from './modules/memory/memory-manger.ts';
import type { ToolExecutor } from './modules/tools/tool-executor.ts';
import type { ToolRegistry } from './modules/tools/tool-registry.ts';
import { parseToolArguments, type RawToolCall } from './modules/tools/tool-call-accumulator.ts';
import type { ToolCall, ToolResult } from '@wuzi/types';
import type { PromptComposer } from './prompt/prompt-composer.ts';
import type { ContextManager } from './modules/context/context-manger.ts';
import type { ContextCompactor } from './modules/context/context-compactor.ts';

/** 一轮工具调用按读 / 写分组的结果 */
export interface GroupedToolCalls {
  /** 读类（无副作用）工具调用，可并发执行 */
  reads: RawToolCall[];
  /** 写类（有副作用）工具调用，须串行执行 */
  writes: RawToolCall[];
}

/**
 * 按「是否产生副作用」将一轮工具调用分为读组（并发）与写组（串行）。
 *
 * 纯函数、无副作用，便于单元测试。保持原始调用顺序不变。
 * 未知工具名（isMutating 返回 false）按读类归入并发组，由执行器返回结构化 unknown_tool 错误。
 *
 * @param calls 本轮模型发起的工具调用
 * @param isMutating 判断某工具名是否为写类
 */
export function groupToolCalls(
  calls: RawToolCall[],
  isMutating: (name: string) => boolean,
): GroupedToolCalls {
  const reads: RawToolCall[] = [];
  const writes: RawToolCall[] = [];
  for (const c of calls) {
    if (isMutating(c.name)) writes.push(c);
    else reads.push(c);
  }
  return { reads, writes };
}

/** ReasoningLoop 依赖（由 Agent 装配注入） */
export interface ReasoningLoopDeps {
  provider: ILLMProvider;
  config: LLMConfig;
  memory: ConversationMemory;
  /** 工具注册中心；缺省表示不启用工具能力 */
  tools?: ToolRegistry;
  /** 工具执行器；缺省表示不执行工具 */
  executor?: ToolExecutor;
  /** 循环配置；缺省使用 DEFAULT_LOOP_CONFIG */
  loop?: LoopConfig;
  /** Prompt 编排器；缺省时直接透传 memory 消息（兼容未装配场景，不注入 env_info / mode_reminder） */
  composer?: PromptComposer;
  /** 环境信息收集器；缺省时不注入 env_info 消息 */
  contextManager?: ContextManager;
  /**
   * 上下文压缩编排器；缺省时不启用自动压缩。
   * 注入后：
   *  - `run` 方法开始时调 `contextCompactor.reset()` 重置熔断状态（供新 run 使用）
   *  - `streamOneRound` 在调 `provider.streamChat` 之前调 `contextCompactor.runCompaction(memory)`，
   *    对 memory 做原地压缩（预防层 offload + 兜底层摘要）
   */
  contextCompactor?: ContextCompactor;
  /**
   * 消息持久化回调；缺省时不持久化。
   * 注入后，ReasoningLoop 在每次 `memory.append()` 后调用此回调，将消息透传给
   * SessionManager 持久化到 JSONL 存档。回调内部应 fire-and-forget（异步不阻塞主循环），
   * 异常归一化由回调实现方负责。
   */
  onMessagePersisted?: (msg: ChatMessage) => void;
}

/** 单次 run 的运行期选项 */
export interface RunOptions {
  /** 外部取消信号；触发即终止循环（reason = cancelled） */
  signal?: AbortSignal;
}

/** 单轮流式结果（内部使用） */
interface RoundResult {
  assistantContent: string;
  thinking: string;
  toolCalls: RawToolCall[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    /** Anthropic prompt caching 命中读取的输入 token 数（OpenAI 侧缺省） */
    cacheReadInputTokens?: number;
    /** Anthropic prompt caching 本次新写入的输入 token 数（OpenAI 侧缺省） */
    cacheCreationInputTokens?: number;
  };
  error: boolean;
}

/** 在 signal abort 时 resolve 的 Promise（用于与耗时操作 race） */
function waitAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

export class ReasoningLoop {
  private readonly deps: ReasoningLoopDeps;
  private readonly maxRounds: number;
  private readonly timeoutMs?: number;
  private mode: AgentMode;
  /** 本次 run 的环境信息消息（run 开始时现取，会话内稳定，跨 run 变化） */
  private currentEnvInfo?: ChatMessage;
  /** 当前 run 内的轮次计数（run 开始时重置为 0，每轮 +1；用于模式提醒节奏控制） */
  private roundInRun = 0;
  /** 自上次注入 mode_reminder 以来是否发生过模式切换（setMode 实际切换时置 true，注入后置 false） */
  private modeChanged = false;

  constructor(deps: ReasoningLoopDeps) {
    this.deps = deps;
    this.maxRounds = deps.loop?.maxRounds ?? DEFAULT_LOOP_CONFIG.maxRounds;
    this.timeoutMs = deps.loop?.timeoutMs;
    // 优先 mode；未显式设置时回退兼容旧 planOnly（true→plan），否则默认 agent
    this.mode =
      deps.loop?.mode ?? (deps.loop?.planOnly ? 'plan' : DEFAULT_LOOP_CONFIG.mode);
  }

  /** 当前运行模式 */
  getMode(): AgentMode {
    return this.mode;
  }

  /** 设置运行模式（即时生效；仅模式实际变化时标记 modeChanged，触发下一轮完整提醒注入） */
  setMode(mode: AgentMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.modeChanged = true;
  }

  /** 当前模式是否为只读（ask / plan 均拦截写类工具） */
  private isReadOnly(): boolean {
    return this.mode !== 'agent';
  }

  /**
   * 运行一次完整的 ReAct 循环（处理单条用户输入直至终止）。
   *
   * @param userText 用户输入文本
   * @param onEvent 事件流回调
   * @param options 运行期选项（外部取消信号）
   * @returns 终止原因
   */
  async run(
    userText: string,
    onEvent: (event: StreamEvent) => void,
    options: RunOptions = {},
  ): Promise<TerminationReason> {
    const text = userText.trim();
    onEvent({ type: 'user_message', text });
    if (!text) {
      onEvent({ type: 'loop_terminated', reason: 'no_tool_call', rounds: 0 });
      onEvent({ type: 'done' });
      return 'no_tool_call';
    }

    this.deps.memory.append({ role: 'user', content: text });
    this.deps.onMessagePersisted?.({ role: 'user', content: text });

    // 收集本次 run 的环境信息（动态段，会话内稳定，跨 run 变化；不入 memory）
    this.currentEnvInfo = this.deps.contextManager
      ? await this.deps.contextManager.toMessage()
      : undefined;

    // 重置上下文压缩熔断状态（新 run 不继承上次失败计数，避免一次失败永久禁用）
    this.deps.contextCompactor?.reset();

    // 重置本次 run 的轮次计数（首轮注入完整模式提醒）
    this.roundInRun = 0;

    const { signal, timeoutSignal } = this.buildSignal(options.signal);

    let inputTokens = 0;
    let outputTokens = 0;
    // cache 字段仅在首次出现的轮次记录（同一次 run 内稳定 system + tools 不变，多轮之间命中状态一致；
    // 取首次非空值作为本次 run 的代表，便于 UI/日志观测缓存策略是否生效）
    let cacheReadInputTokens: number | undefined;
    let cacheCreationInputTokens: number | undefined;
    let reason: TerminationReason = 'no_tool_call';

    try {
      while (true) {
        if (signal?.aborted) {
          reason = this.abortReason(timeoutSignal);
          break;
        }
        if (this.roundInRun >= this.maxRounds) {
          reason = 'max_rounds';
          break;
        }
        this.roundInRun++;

        const round = await this.streamOneRound(onEvent, signal);
        if (round.usage) {
          inputTokens += round.usage.inputTokens;
          outputTokens += round.usage.outputTokens;
          if (cacheReadInputTokens === undefined && round.usage.cacheReadInputTokens !== undefined) {
            cacheReadInputTokens = round.usage.cacheReadInputTokens;
          }
          if (cacheCreationInputTokens === undefined && round.usage.cacheCreationInputTokens !== undefined) {
            cacheCreationInputTokens = round.usage.cacheCreationInputTokens;
          }
        }

        // 记录 assistant 消息（含思考与工具调用请求）
        if (round.assistantContent || round.thinking || round.toolCalls.length > 0) {
          const assistantMsg: ChatMessage = {
            role: 'assistant',
            content: round.assistantContent,
            thinking: round.thinking || undefined,
            tool_calls: round.toolCalls.length
              ? round.toolCalls.map((r) => ({ id: r.id, name: r.name, arguments: r.arguments }))
              : undefined,
          };
          this.deps.memory.append(assistantMsg);
          this.deps.onMessagePersisted?.(assistantMsg);
        }

        if (signal?.aborted) {
          reason = this.abortReason(timeoutSignal);
          break;
        }
        if (round.error) {
          reason = 'error';
          break;
        }

        // 无工具调用 → 终止（本轮即最终回复）
        if (round.toolCalls.length === 0) {
          if (round.assistantContent) {
            onEvent({ type: 'final_answer', text: round.assistantContent });
          }
          reason = 'no_tool_call';
          break;
        }

        // 有工具调用 → 分组执行并回灌，然后进入下一轮
        const aborted = await this.executeGrouped(round.toolCalls, onEvent, signal);
        if (aborted) {
          reason = this.abortReason(timeoutSignal);
          break;
        }
      }
    } catch (err) {
      onEvent({
        type: 'error',
        error: err instanceof Error ? err : new Error(String(err)),
        recoverable: false,
      });
      reason = 'error';
    }

    onEvent({ type: 'loop_terminated', reason, rounds: this.roundInRun, maxRounds: this.maxRounds });
    onEvent({
      type: 'done',
      usage:
        inputTokens || outputTokens
          ? {
              inputTokens,
              outputTokens,
              ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
              ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
            }
          : undefined,
    });
    return reason;
  }

  /** 组合外部取消信号与内置超时信号 */
  private buildSignal(external?: AbortSignal): {
    signal?: AbortSignal;
    timeoutSignal?: AbortSignal;
  } {
    const parts: AbortSignal[] = [];
    if (external) parts.push(external);
    let timeoutSignal: AbortSignal | undefined;
    if (this.timeoutMs && this.timeoutMs > 0) {
      timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      parts.push(timeoutSignal);
    }
    let signal: AbortSignal | undefined;
    if (parts.length === 1) signal = parts[0];
    else if (parts.length > 1) signal = AbortSignal.any(parts);
    return { signal, timeoutSignal };
  }

  /** 判定 abort 是超时还是外部取消 */
  private abortReason(timeoutSignal?: AbortSignal): TerminationReason {
    return timeoutSignal?.aborted ? 'timeout' : 'cancelled';
  }

  /**
   * 生成本轮发送给 LLM 的 messages。
   *
   * 装配了 PromptComposer 时，委托 composer 按结构化顺序拼装：
   *   稳定 system（可缓存）→ env_info（动态）→ 对话历史（过滤旧稳定 system）→ mode_reminder（按节奏注入）
   * 未装配 composer 时（兼容旧测试/未改造角色），直接透传 memory 消息，不注入任何提醒。
   *
   * 仅作用于副本，不写入 ConversationMemory —— 保持记忆干净、模式切换即时生效。
   */
  private buildMessages(): ChatMessage[] {
    const messages = this.deps.memory.getMessages();
    if (!this.deps.composer) return messages;
    const modeReminder = this.buildModeReminder();
    const composed = this.deps.composer.compose(messages, {
      envInfo: this.currentEnvInfo,
      modeReminder,
    });
    if (modeReminder) this.modeChanged = false; // 已注入本轮模式提醒，清切换标志
    return composed;
  }

  /**
   * 产出当前轮的模式提醒消息（kind:mode_reminder）。
   *
   * 节奏：首轮（roundInRun===1）或模式切换后（modeChanged）返回完整指令；
   * 其余轮次返回精简指令（仅模式名 + 一行核心约束）。三种模式均注入，
   * 以保证模型始终明确当前运行模式（否则 agent 模式下模型无从知晓自身模式，易误判为 ask）。
   */
  private buildModeReminder(): ChatMessage | null {
    const full = this.roundInRun === 1 || this.modeChanged;
    const content = full ? this.fullModeDirective() : this.conciseModeDirective();
    return { role: 'system', kind: 'mode_reminder', content };
  }

  /** 完整模式指令（首轮 / 模式切换后第一轮注入） */
  private fullModeDirective(): string {
    if (this.mode === 'agent') {
      return [
        '[系统提示 · 当前模式：AGENT（读写执行）]',
        '你现在处于 AGENT 模式：读类与写类工具均可用，可按计划自主执行任务（修改文件、执行命令等）。',
        '请按任务拆解逐步推进，每步做最小验证；遇到需用户决策的问题（密钥、选型、设计取舍）及时求助，不臆测。',
      ].join('\n');
    }
    if (this.mode === 'ask') {
      return [
        '[系统提示 · 当前模式：ASK（只读问答）]',
        '你现在处于 ASK 模式：仅能使用读类工具（查看 / 检索），所有写类工具（修改文件、执行有副作用的命令等）',
        '会被系统拦截、不会生效。请专注于理解与回答用户问题，不要尝试改动工程。',
        '若任务确需改动，请提示用户用 /agent 切换到执行模式。',
      ].join('\n');
    }
    return [
      '[系统提示 · 当前模式：PLAN（只读规划）]',
      '你现在处于 PLAN 模式：仅能使用读类工具收集信息，所有写类工具会被系统拦截、不会生效。',
      '请先充分调研，然后输出一份清晰、可执行的实施计划（分步骤、涉及文件、验证方式）交用户审批。',
      '计划完成后提示用户：确认后用 /agent 切换到执行模式，或 /ask 继续讨论。',
    ].join('\n');
  }

  /** 精简模式指令（首轮 / 模式切换之外的轮次注入） */
  private conciseModeDirective(): string {
    if (this.mode === 'agent') {
      return '[模式提醒 · AGENT（读写执行）] 读写工具均可用，可自主执行任务；逐步推进并做最小验证。';
    }
    if (this.mode === 'ask') {
      return '[模式提醒 · ASK（只读问答）] 仅读类工具可用，写类工具会被拦截；专注回答，勿改动工程。';
    }
    return '[模式提醒 · PLAN（只读规划）] 仅读类工具可用，写类工具会被拦截；输出可执行计划交审批。';
  }

  /** 执行一轮 provider 流式调用，累积文本 / 思考 / 工具调用 / 用量 */
  private async streamOneRound(
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<RoundResult> {
    // 在 buildMessages 之前对 memory 做原地压缩（预防层 offload + 兜底层摘要），
    // 确保 provider 拿到的 messages 已经过治理；异常已由 ContextCompactor 内部归一化为「跳过本轮压缩」
    if (this.deps.contextCompactor) {
      await this.deps.contextCompactor.runCompaction(this.deps.memory, { signal });
    }

    const messages = this.buildMessages();
    const toolDefs = this.deps.tools ? this.deps.tools.toDefinitions() : undefined;

    let assistantContent = '';
    let thinking = '';
    const toolCalls: RawToolCall[] = [];
    // 用对象属性承载，避免闭包内赋值被控制流收窄
    const acc: {
      usage?: {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens?: number;
        cacheCreationInputTokens?: number;
      };
      error: boolean;
      stopped: boolean;
    } = {
      usage: undefined,
      error: false,
      stopped: false,
    };

    const cb = (ev: {
      type: string;
      delta?: string;
      id?: string;
      name?: string;
      arguments?: string;
      usage?: {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens?: number;
        cacheCreationInputTokens?: number;
      };
      error?: Error;
    }): void => {
      if (acc.stopped) return; // abort 后不再推送，保持状态一致
      switch (ev.type) {
        case 'text_delta':
          assistantContent += ev.delta ?? '';
          onEvent({ type: 'text_delta', delta: ev.delta! });
          break;
        case 'thinking_delta':
          thinking += ev.delta ?? '';
          onEvent({ type: 'thinking_delta', delta: ev.delta! });
          break;
        case 'tool_call':
          toolCalls.push({ id: ev.id!, name: ev.name!, arguments: ev.arguments! });
          onEvent({ type: 'tool_call', id: ev.id!, name: ev.name!, arguments: ev.arguments! });
          break;
        case 'done':
          acc.usage = ev.usage;
          break;
        case 'error':
          acc.error = true;
          onEvent({ type: 'error', error: ev.error!, recoverable: true });
          break;
      }
    };

    const streamPromise = this.deps.provider.streamChat(
      { messages, config: this.deps.config, tools: toolDefs },
      cb,
    );

    if (signal) {
      await Promise.race([streamPromise, waitAbort(signal)]);
      if (signal.aborted) {
        acc.stopped = true;
        streamPromise.catch(() => {}); // 避免后台流的潜在未处理拒绝
      }
    } else {
      await streamPromise;
    }

    return { assistantContent, thinking, toolCalls, usage: acc.usage, error: acc.error };
  }

  /**
   * 分组执行一轮工具调用：读类并发、写类串行。
   * 保证每个被请求的工具调用都产生一条 tool 结果回灌记忆（含取消 / 拦截情形），
   * 维持「每个 assistant.tool_call 都有对应 tool 结果」的记忆不变量。
   *
   * @returns 是否因取消 / 超时中断
   */
  private async executeGrouped(
    calls: RawToolCall[],
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const isMutating = (name: string): boolean => this.deps.tools?.get(name)?.mutates ?? false;
    const { reads, writes } = groupToolCalls(calls, isMutating);
    let sawAbort = false;

    // 读类：并发执行，按原始顺序回灌结果（保证事件确定性）
    for (const c of reads) {
      onEvent({ type: 'tool_call_start', id: c.id, name: c.name, mutates: false });
    }
    const readResults = await Promise.all(reads.map((c) => this.executeOne(c, signal)));
    for (let i = 0; i < reads.length; i++) {
      this.appendToolResult(reads[i]!, readResults[i]!, onEvent);
    }
    if (signal?.aborted) sawAbort = true;

    // 写类：串行执行（互斥）
    for (const c of writes) {
      onEvent({ type: 'tool_call_start', id: c.id, name: c.name, mutates: true });

      if (sawAbort || signal?.aborted) {
        sawAbort = true;
        this.appendToolResult(
          c,
          { ok: false, content: `工具「${c.name}」因循环终止被取消，未执行`, error: 'cancelled' },
          onEvent,
        );
        continue;
      }

      // 只读模式（ask / plan）：拦截写类工具，不执行，回灌结构化「被拦截」结果
      if (this.isReadOnly()) {
        const modeLabel = this.mode.toUpperCase();
        const message = `当前处于 ${modeLabel} 只读模式，写类工具「${c.name}」被拦截未执行。请用 /agent 切换到执行模式后重试，或据此输出规划交审批。`;
        onEvent({ type: 'plan_blocked', id: c.id, name: c.name, message });
        this.appendToolResult(
          c,
          { ok: false, content: message, error: 'plan_blocked' },
          onEvent,
        );
        continue;
      }

      const result = await this.executeOne(c, signal);
      this.appendToolResult(c, result, onEvent);
      if (signal?.aborted) sawAbort = true;
    }

    return sawAbort;
  }

  /** 执行单个工具调用；永不抛出，取消时返回结构化 cancelled 结果 */
  private async executeOne(raw: RawToolCall, signal?: AbortSignal): Promise<ToolResult> {
    let call: ToolCall;
    try {
      call = parseToolArguments(raw);
    } catch (err) {
      return { ok: false, content: (err as Error).message, error: 'invalid_arguments' };
    }

    if (!this.deps.executor) {
      return { ok: false, content: '工具执行器未装配，无法执行工具', error: 'no_executor' };
    }

    if (!signal) {
      return this.deps.executor.executeCall(call);
    }

    const result = await Promise.race([
      this.deps.executor.executeCall(call),
      waitAbort(signal).then(() => null),
    ]);
    if (result === null || signal.aborted) {
      return { ok: false, content: `工具「${call.name}」因循环终止被取消，未完成`, error: 'cancelled' };
    }
    return result;
  }

  /** 回灌工具结果到记忆并推送 UI 事件 */
  private appendToolResult(
    raw: RawToolCall,
    result: ToolResult,
    onEvent: (event: StreamEvent) => void,
  ): void {
    const message: ChatMessage = { role: 'tool', content: result.content, tool_call_id: raw.id };
    this.deps.memory.append(message);
    this.deps.onMessagePersisted?.(message);
    onEvent({ type: 'tool_result', tool_call_id: raw.id, ok: result.ok, content: result.content });
  }
}
