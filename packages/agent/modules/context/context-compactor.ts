/**
 * ContextCompactor — 上下文压缩编排器
 *
 * 串联两层压缩与熔断机制,对 ConversationMemory 执行自动压缩:
 *  - 第一层(预防,不调 LLM):管单条消息大小,对超长 tool 结果执行 offload,把完整内容
 *    写入磁盘文件,对话内只保留首尾预览 + 文件路径
 *  - 第二层(兜底,调 LLM):管累积历史长度,当总 token 估算 ≥ 阈值时,调 Summarizer 生成
 *    结构化摘要替换中间历史
 *  - 熔断:摘要连续失败达 `summaryFailureThreshold` 次后,自动触发被跳过(手动触发仍可用)
 *
 * 异常归一化:offload 与摘要失败均归一化为「跳过本轮压缩」,不向调用方抛出,
 * 绝不中断 ReasoningLoop。
 */

import type { ChatMessage } from '../../ui-pattern.ts';
import type { ContextConfig } from '@wuzi/types';
import type { ConversationMemory } from '../memory/memory-manger.ts';
import type { TokenCounter } from './token-counter.ts';
import type { ToolResultOffloader } from './offloader.ts';
import type { SingleMessageCompactor } from './single-message-compactor.ts';
import type { HistoryCompactor } from './history-compactor.ts';

/** ContextCompactor 依赖 */
export interface ContextCompactorDeps {
  config: Required<ContextConfig>;
  tokenCounter: TokenCounter;
  offloader: ToolResultOffloader;
  singleMessageCompactor: SingleMessageCompactor;
  historyCompactor: HistoryCompactor;
}

/** runCompaction / forceCompact 的可选参数 */
export interface CompactionOptions {
  sessionId?: string;
  signal?: AbortSignal;
}

/**
 * 上下文压缩编排器。
 *
 * 维护 `consecutiveFailures` 计数与 `tripped` 熔断标志;`runCompaction` 按序执行两层
 * (先轻量预防,再昂贵兜底),失败归一化为跳过本轮压缩;`forceCompact` 手动触发第二层
 * (跳过熔断与阈值检查,失败不计入熔断计数);`reset` 重置熔断状态(供新 run 调用)。
 *
 * 熔断状态会话内有效,新 run 不继承(避免一次失败永久禁用)。
 */
export class ContextCompactor {
  private readonly deps: ContextCompactorDeps;
  private consecutiveFailures: number = 0;
  private tripped: boolean = false;

  constructor(deps: ContextCompactorDeps) {
    this.deps = deps;
  }

  /**
   * 自动压缩入口:按序执行两层压缩。
   *
   * 第一层(预防,管单条消息大小,不调 LLM):
   *  - `config.offloadEnabled === false` 时跳过
   *  - 否则遍历 memory 中所有 assistant(含 tool_calls)+ 紧随其后的连续 tool 消息为一组,
   *    对每组调 `singleMessageCompactor.compact`;若发生 offload,把新 assistant 的
   *    `compacted` 置 true 后用新结果替换原消息(用 reset + append 重建 memory)
   *  - 异常归一化为「跳过第一层」,继续第二层
   *
   * 第二层(兜底,管累积历史长度,调 LLM):
   *  - `config.compactionEnabled === false` 时跳过
   *  - `tripped === true` 时跳过自动触发
   *  - 否则计算 memory 总 token 估算,若 ≥ `windowUsageThreshold * windowHardLimit`,
   *    调 `historyCompactor.compact`;成功则替换 memory 内容、`consecutiveFailures = 0`;
   *    失败则 `consecutiveFailures++`,达 `summaryFailureThreshold` 则 `tripped = true`
   *  - 异常归一化(同失败处理),不向调用方抛出
   *
   * @param memory 对话记忆
   * @param opts 可选参数(sessionId / signal)
   */
  async runCompaction(
    memory: ConversationMemory,
    opts?: CompactionOptions,
  ): Promise<void> {
    const sessionId = opts?.sessionId ?? 'default';
    const signal = opts?.signal;

    // 第一层:预防(管单条消息大小,不调 LLM)
    try {
      await this.runFirstLayer(memory, sessionId);
    } catch {
      // 异常归一化为「跳过第一层」,继续第二层
    }

    // 第二层:兜底(管累积历史长度,调 LLM)
    try {
      await this.runSecondLayer(memory, signal);
    } catch {
      // 异常归一化(同失败处理),不向调用方抛出
      // 注:runSecondLayer 内部已 try/catch,此处 catch 仅为双保险
      this.consecutiveFailures++;
      if (
        this.consecutiveFailures >= this.deps.config.summaryFailureThreshold
      ) {
        this.tripped = true;
      }
    }
  }

  /**
   * 手动触发第二层压缩。
   *
   * 跳过熔断检查(tripped 不阻止)与阈值检查(无论 memory 大小都触发)。
   * 成功则替换 memory 内容、返回 true;失败则返回 false。
   * 失败不计入 consecutiveFailures,不影响 tripped 状态。
   *
   * @param memory 对话记忆
   * @param opts 可选参数(sessionId / signal)
   * @returns 是否成功
   */
  async forceCompact(
    memory: ConversationMemory,
    opts?: CompactionOptions,
  ): Promise<boolean> {
    const signal = opts?.signal;

    try {
      const original = memory.getMessages();
      const compacted = await this.deps.historyCompactor.compact(
        original,
        signal,
      );
      // 用结果替换 memory 内容(reset + append)
      memory.reset();
      for (const msg of compacted) {
        memory.append(msg);
      }
      return true;
    } catch {
      // 失败不计入 consecutiveFailures,不影响 tripped 状态
      return false;
    }
  }

  /**
   * 重置熔断状态(供新 run 调用)。
   *
   * 熔断状态会话内有效,新 run 不继承(避免一次失败永久禁用)。
   */
  reset(): void {
    this.consecutiveFailures = 0;
    this.tripped = false;
  }

  /** 返回当前 tripped 状态(供观测) */
  isTripped(): boolean {
    return this.tripped;
  }

  /** 返回当前连续失败次数(供观测) */
  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  /**
   * 第一层:遍历 memory,对每组 assistant(含 tool_calls)+ 紧随其后的连续 tool 消息
   * 调 singleMessageCompactor.compact;若发生 offload,把新 assistant 的 compacted
   * 置 true,然后用 reset + append 重建 memory。
   *
   * 若 `config.offloadEnabled === false` 跳过第一层。
   * 异常向外抛出,由 runCompaction 归一化为「跳过第一层」。
   */
  private async runFirstLayer(
    memory: ConversationMemory,
    sessionId: string,
  ): Promise<void> {
    if (this.deps.config.offloadEnabled === false) return;

    const original = memory.getMessages();
    if (original.length === 0) return;

    // 识别 assistant(含 tool_calls,未 compacted)+ 紧随其后的连续 tool 消息为一组
    // 对每组调 compact,收集新的消息列表
    const newMessages: ChatMessage[] = [];
    let i = 0;
    while (i < original.length) {
      const msg = original[i];
      if (
        msg.role === 'assistant' &&
        msg.tool_calls &&
        msg.tool_calls.length > 0 &&
        msg.compacted !== true
      ) {
        // 收集紧随其后的连续 tool 消息
        const tools: ChatMessage[] = [];
        let j = i + 1;
        while (j < original.length && original[j].role === 'tool') {
          tools.push(original[j]);
          j++;
        }

        // 调 compact
        const result = await this.deps.singleMessageCompactor.compact(
          msg,
          tools,
          sessionId,
        );

        // 判断是否发生了 offload:
        //  - result.tools 引用不同,或任一 tool 的 compacted 标记从 undefined 变为 true
        let offloaded = result.tools !== tools;
        if (!offloaded) {
          for (let k = 0; k < tools.length; k++) {
            if (
              result.tools[k]?.compacted === true &&
              tools[k]?.compacted !== true
            ) {
              offloaded = true;
              break;
            }
          }
        }

        if (offloaded) {
          // 把新 assistant 的 compacted 置 true(避免重复处理,符合任务陷阱提示)
          newMessages.push({ ...result.assistant, compacted: true });
        } else {
          newMessages.push(result.assistant);
        }
        for (const t of result.tools) {
          newMessages.push(t);
        }
        i = j;
      } else {
        // 非目标消息(已 compacted / 非 assistant / 无 tool_calls / 其他角色)
        newMessages.push(msg);
        i++;
      }
    }

    // 用 reset + append 重建 memory(newMessages 中已包含原 system 消息,无需额外保留)
    memory.reset();
    for (const m of newMessages) {
      memory.append(m);
    }
  }

  /**
   * 第二层:计算 memory 总 token 估算,若 ≥ 阈值调 historyCompactor.compact。
   *
   * 若 `config.compactionEnabled === false` 或 `tripped === true` 跳过。
   * 成功则替换 memory 内容、`consecutiveFailures = 0`;
   * 失败则 `consecutiveFailures++`,达 `summaryFailureThreshold` 则 `tripped = true`。
   * 异常归一化(同失败处理),不向调用方抛出。
   */
  private async runSecondLayer(
    memory: ConversationMemory,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (this.deps.config.compactionEnabled === false) return;
    if (this.tripped) return;

    const messages = memory.getMessages();
    const totalText = messages.map(m => m.content ?? '').join('\n');
    const totalTokens = this.deps.tokenCounter.estimate(totalText);

    const threshold =
      this.deps.config.windowUsageThreshold * this.deps.config.windowHardLimit;
    if (totalTokens < threshold) return;

    try {
      const compacted = await this.deps.historyCompactor.compact(
        messages,
        signal,
      );
      // 用结果替换 memory 内容(reset + append)
      memory.reset();
      for (const m of compacted) {
        memory.append(m);
      }
      this.consecutiveFailures = 0;
    } catch {
      // 失败:计数 + 熔断判定
      this.consecutiveFailures++;
      if (
        this.consecutiveFailures >= this.deps.config.summaryFailureThreshold
      ) {
        this.tripped = true;
      }
    }
  }
}
