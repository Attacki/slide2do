/**
 * SessionRecovery — 会话恢复异常处理编排器
 *
 * 处理 spec §核心能力清单 第 6 条四类异常：
 *  ① 解析失败的行：由 SessionStore.readMessages 已处理（跳过坏行 + 计数）
 *  ② tool_use 未配 tool_result：调 truncateToCompleteMessages 截断到末尾完整位置
 *  ③ token 超限：构造临时 ConversationMemory 调 ContextCompactor.forceCompact 压缩一次
 *  ④ 距上次活跃超阈值：detectTimeGap 计算时间跨度，返回 timeGapReminder 文案
 *
 * 所有异常归一化为「跳过该步 + warn」，不向调用方抛出。
 */

import type { ChatMessage } from '../../../ui-pattern.ts';
import { ConversationMemory } from '../memory-manger.ts';
import type { ContextCompactor } from '../../context/context-compactor.ts';
import type { TokenCounter } from '../../context/token-counter.ts';

/** truncateToCompleteMessages 返回结构 */
export interface TruncateResult {
  /** 截断后的消息列表（保留至末尾完整位置） */
  messages: ChatMessage[];
  /** 是否发生了截断 */
  truncated: boolean;
  /** 被截断的消息数（含未配对 tool_use 的 assistant 及其后的孤立消息） */
  truncatedCount: number;
}

/**
 * 截断末尾未配对 tool_use 的消息。
 *
 * 扫描规则（从尾向前）：
 *  - 收集末尾所有 assistant(含 tool_calls) 与 tool 消息
 *  - 找到最后一个「有 tool_calls 但其所有 id 没有对应 tool_result」的 assistant
 *  - 截断到该 assistant 之前（不含该 assistant）
 *  - 若末尾 assistant 的 tool_calls 全部有配对 tool_result，不截断
 *
 * 纯函数，便于单测。
 *
 * @param messages 待检查的消息列表
 * @returns 截断结果
 */
export function truncateToCompleteMessages(messages: ChatMessage[]): TruncateResult {
  if (messages.length === 0) {
    return { messages, truncated: false, truncatedCount: 0 };
  }

  // 收集所有 tool_result 对应的 tool_call_id
  const toolResultIds = new Set<string>();
  for (const m of messages) {
    if (m.role === 'tool' && m.tool_call_id) {
      toolResultIds.add(m.tool_call_id);
    }
  }

  // 从尾向前找第一个「有未配对 tool_calls」的 assistant
  // 截断到该 assistant 之前（丢弃该 assistant 及其后所有消息）
  let cutIndex = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) break;
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      // 检查该 assistant 的所有 tool_calls 是否都有配对 tool_result
      const allMatched = m.tool_calls.every((tc) => toolResultIds.has(tc.id));
      if (!allMatched) {
        cutIndex = i;
        break;
      }
      // 该 assistant 的 tool_calls 全部配对，向前继续找
      // 但只有末尾的连续 assistant+tool 块才需要检查；一旦遇到配对完整的 assistant，
      // 前面的更老的消息必定已配对（否则历史早就损坏了），可以停止
      break;
    }
    // 非 assistant 含 tool_calls 的消息（user / tool / 无 tool_calls 的 assistant）继续向前
  }

  if (cutIndex === messages.length) {
    return { messages, truncated: false, truncatedCount: 0 };
  }

  return {
    messages: messages.slice(0, cutIndex),
    truncated: true,
    truncatedCount: messages.length - cutIndex,
  };
}

/**
 * 检测时间跨度是否超阈值。
 *
 * @param lastActiveAt 上次活跃时间戳（毫秒）；null 表示未知
 * @param now 当前时间戳（毫秒）
 * @param thresholdMs 阈值（毫秒）
 * @returns 超阈值时返回提醒文案，否则返回 null
 *
 * 纯函数，便于单测。
 */
export function detectTimeGap(
  lastActiveAt: number | null,
  now: number,
  thresholdMs: number,
): string | null {
  if (lastActiveAt === null || !Number.isFinite(lastActiveAt)) return null;
  const gap = now - lastActiveAt;
  if (gap <= thresholdMs) return null;

  // 格式化时间跨度为人类可读
  const human = formatDuration(gap);
  return [
    `[会话恢复提醒] 距上次活跃已过去 ${human}。`,
    '上下文可能已过时，请确认当前任务进展后再继续；如需查看历史请向上滚动。',
  ].join('\n');
}

/** 把毫秒时长格式化为人类可读（如「2 小时 15 分钟」「3 天 4 小时」） */
function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0) parts.push(`${hours} 小时`);
  if (minutes > 0 && days === 0) parts.push(`${minutes} 分钟`);
  if (parts.length === 0) parts.push(`${sec} 秒`);
  return parts.join(' ');
}

/** SessionRecovery 构造参数 */
export interface SessionRecoveryOptions {
  /** 上下文压缩编排器；缺省时跳过 token 超限压缩步骤 */
  contextCompactor?: ContextCompactor;
  /** token 估算器；缺省时跳过 token 超限压缩步骤 */
  tokenCounter?: TokenCounter;
  /** token 超限阈值；缺省时跳过 token 超限压缩步骤 */
  tokenLimit?: number;
}

/** recover 方法的运行期选项 */
export interface RecoverOptions {
  /** 上次活跃时间戳（毫秒）；缺省视为未知，跳过时间跨度提醒 */
  lastActiveAt?: number | null;
  /** 当前时间戳（毫秒）；缺省取 Date.now()，便于测试注入 */
  now?: number;
  /** 外部取消信号（透传给 contextCompactor.forceCompact） */
  signal?: AbortSignal;
  /** 会话 ID（透传给 contextCompactor.forceCompact） */
  sessionId?: string;
}

/** recover 返回结构 */
export interface RecoveryResult {
  /** 恢复后的消息列表（已截断 + 已压缩） */
  messages: ChatMessage[];
  /** 恢复过程产生的警告 */
  warnings: string[];
  /** 时间跨度提醒文案（超阈值时非空），由调用方决定如何注入对话 */
  timeGapReminder?: string;
}

/**
 * 会话恢复异常处理编排器。
 *
 * 编排顺序：① 截断未配对 tool_use → ② token 超限压缩 → ③ 时间跨度提醒。
 * 所有步骤异常归一化为 warn，不抛出。
 */
export class SessionRecovery {
  private readonly contextCompactor?: ContextCompactor;
  private readonly tokenCounter?: TokenCounter;
  private readonly tokenLimit?: number;

  constructor(opts: SessionRecoveryOptions = {}) {
    this.contextCompactor = opts.contextCompactor;
    this.tokenCounter = opts.tokenCounter;
    this.tokenLimit = opts.tokenLimit;
  }

  /**
   * 恢复会话消息。
   *
   * @param messages 从 SessionStore.readMessages 读到的原始消息（坏行已跳过）
   * @param opts 运行期选项
   * @returns 恢复结果
   */
  async recover(messages: ChatMessage[], opts: RecoverOptions = {}): Promise<RecoveryResult> {
    const warnings: string[] = [];
    const now = opts.now ?? Date.now();
    let current = messages;

    // ① 截断未配对 tool_use
    const trunc = truncateToCompleteMessages(current);
    if (trunc.truncated) {
      warnings.push(`末尾检测到未配对的 tool_use，已截断 ${trunc.truncatedCount} 条消息`);
      current = trunc.messages;
    }

    // ② token 超限压缩
    if (this.canCompact()) {
      try {
        const totalTokens = this.estimateTokens(current);
        if (totalTokens > (this.tokenLimit as number)) {
          warnings.push(`token 估算 ${totalTokens} 超限 ${this.tokenLimit}，触发一次压缩`);
          const compacted = await this.runCompact(current, opts);
          if (compacted !== null) {
            current = compacted;
          } else {
            warnings.push('压缩失败，保留原消息');
          }
        }
      } catch (e) {
        warnings.push(`token 压缩步骤异常: ${(e as Error).message}`);
      }
    }

    // ③ 时间跨度提醒
    const gap = detectTimeGap(
      opts.lastActiveAt ?? null,
      now,
      // 阈值在调用方注入更合适；此处用默认 1 小时（避免再传一个参数）
      // 若调用方需要自定义阈值，可在 SessionManager 层调用 detectTimeGap 后传入
      3600000,
    );

    return {
      messages: current,
      warnings,
      timeGapReminder: gap ?? undefined,
    };
  }

  /** 是否具备 token 压缩条件（三件套齐全且 tokenLimit > 0） */
  private canCompact(): boolean {
    return (
      this.contextCompactor !== undefined &&
      this.tokenCounter !== undefined &&
      this.tokenLimit !== undefined &&
      this.tokenLimit > 0
    );
  }

  /** 估算消息列表总 token 数 */
  private estimateTokens(messages: ChatMessage[]): number {
    if (!this.tokenCounter) return 0;
    let total = 0;
    for (const m of messages) {
      total += this.tokenCounter.estimate(m.content ?? '');
      if (m.thinking) total += this.tokenCounter.estimate(m.thinking);
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          total += this.tokenCounter.estimate(tc.arguments ?? '');
        }
      }
    }
    return total;
  }

  /**
   * 调 ContextCompactor.forceCompact 压缩消息列表。
   *
   * 构造临时 ConversationMemory → 调 forceCompact → 提取压缩后消息。
   * 成功返回新消息列表，失败返回 null。
   */
  private async runCompact(
    messages: ChatMessage[],
    opts: RecoverOptions,
  ): Promise<ChatMessage[] | null> {
    if (!this.contextCompactor) return null;
    const tempMemory = new ConversationMemory();
    for (const m of messages) {
      tempMemory.append(m);
    }
    const ok = await this.contextCompactor.forceCompact(tempMemory, {
      sessionId: opts.sessionId,
      signal: opts.signal,
    });
    if (!ok) return null;
    return tempMemory.getMessages();
  }
}
