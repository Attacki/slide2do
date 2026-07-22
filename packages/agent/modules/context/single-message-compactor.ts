/**
 * SingleMessageCompactor — 单条 assistant 消息的工具结果压缩
 *
 * 当单条 tool 消息内容超过 `singleToolResultThreshold` 时，把完整内容 offload 到磁盘，
 * 对话内只保留首尾预览 + 文件路径；当一条 assistant 消息内多个 tool 结果合计长度超过
 * `singleMessageTotalThreshold` 时，按「从大到小」依次 offload，直到合计降到阈值内。
 *
 * `planOffloads` 为无状态纯函数，可独立单测；`SingleMessageCompactor` 类负责协调
 * 单条阈值、合计阈值与 offloader 的调用，对已 compacted 的消息幂等返回。
 */

import type { ChatMessage } from '../../ui-pattern.ts';
import { buildPreviewText } from './offloader.ts';

/** 默认预览首部行数 */
const DEFAULT_HEAD_LINES = 10;
/** 默认预览尾部行数 */
const DEFAULT_TAIL_LINES = 10;

/** planOffloads 的输入条目：tool_call_id 与对应 content */
export interface ToolResultEntry {
  id: string;
  content: string;
}

/**
 * offloader 依赖接口（供 mock 注入与解耦）。
 *
 * `ToolResultOffloader` 类在结构上满足此接口，可直接传入；
 * 测试中可实现此接口构造内存版 mock，不实际写盘。
 */
export interface ToolResultOffloaderLike {
  offload(content: string, sessionId: string): Promise<string>;
}

/** SingleMessageCompactor 配置 */
export interface SingleMessageCompactorConfig {
  /** 单条 tool 结果长度阈值，超过则强制 offload */
  singleToolResultThreshold: number;
  /** 单条 assistant 消息内 tool 结果合计长度阈值，超过则按大→小 offload */
  singleMessageTotalThreshold: number;
  /** 预览首部行数，缺省 10 */
  headLines?: number;
  /** 预览尾部行数，缺省 10 */
  tailLines?: number;
}

/** compact 方法返回结构 */
export interface CompactResult {
  assistant: ChatMessage;
  tools: ChatMessage[];
}

/**
 * 计算需 offload 的 tool_call_id 列表（纯函数，无副作用）。
 *
 * 行为：
 *  - 按 content 长度从大到小排序（长度相同时保持原顺序，依赖 Array.prototype.sort 稳定性）
 *  - 计算合计 total = sum(content.length)
 *  - 依次选中（从最大开始），每选中一条 total -= 该条 content.length
 *  - 直到 total ≤ threshold 或全部选中
 *  - threshold ≤ 0 或合计已 ≤ threshold 时返回空数组
 *  - 返回的 id 列表顺序与选中顺序一致（从大到小）
 *
 * @param toolResults 待评估的 tool 结果条目
 * @param threshold 合计长度阈值
 * @returns 需 offload 的 id 列表（从大到小）
 */
export function planOffloads(
  toolResults: ToolResultEntry[],
  threshold: number,
): string[] {
  if (threshold <= 0 || toolResults.length === 0) return [];

  let total = 0;
  for (const item of toolResults) {
    total += item.content.length;
  }
  if (total <= threshold) return [];

  // 按 content 长度从大到小排序（稳定排序，长度相同保持原顺序）
  const sorted = [...toolResults].sort(
    (a, b) => b.content.length - a.content.length,
  );

  const selected: string[] = [];
  for (const item of sorted) {
    if (total <= threshold) break;
    selected.push(item.id);
    total -= item.content.length;
  }

  return selected;
}

/**
 * 单条 assistant 消息压缩器。
 *
 * 对一条 assistant 消息及其同批次 tool 结果执行：
 *  1. 单条阈值检查：content.length > singleToolResultThreshold 的 tool 消息标记 offload
 *  2. 合计阈值检查：若 tool 消息合计 content 长度 > singleMessageTotalThreshold，
 *     调 planOffloads 按大→小选出额外需 offload 的条目，与第 1 步合并
 *  3. 对所有需 offload 的 tool 消息：调 offloader 写盘，用 buildPreviewText 替换 content，
 *     标记 `compacted: true`
 *
 * 幂等：assistantMessage 已标记 `compacted: true` 时直接返回（不重复处理）。
 * 非目标消息（role !== 'assistant' 或无 tool_calls）直接返回。
 * 单条 offload 失败不阻塞其他条目（失败条目保留原文并继续）。
 */
export class SingleMessageCompactor {
  private readonly offloader: ToolResultOffloaderLike;
  private readonly singleToolResultThreshold: number;
  private readonly singleMessageTotalThreshold: number;
  private readonly headLines: number;
  private readonly tailLines: number;

  constructor(
    offloader: ToolResultOffloaderLike,
    config: SingleMessageCompactorConfig,
  ) {
    this.offloader = offloader;
    this.singleToolResultThreshold = config.singleToolResultThreshold;
    this.singleMessageTotalThreshold = config.singleMessageTotalThreshold;
    this.headLines = config.headLines ?? DEFAULT_HEAD_LINES;
    this.tailLines = config.tailLines ?? DEFAULT_TAIL_LINES;
  }

  /**
   * 压缩单条 assistant 消息及其同批次 tool 结果。
   *
   * @param assistantMessage 待压缩的 assistant 消息（需含 tool_calls）
   * @param toolMessages 同批次的 tool 角色消息列表
   * @param sessionId 会话标识（用于 offloader 目录隔离）
   * @returns 压缩后的 assistant 与 tools（若无变化则原样返回）
   */
  async compact(
    assistantMessage: ChatMessage,
    toolMessages: ChatMessage[],
    sessionId: string,
  ): Promise<CompactResult> {
    // 幂等：已 compacted 的 assistant 消息直接返回
    if (assistantMessage.compacted === true) {
      return { assistant: assistantMessage, tools: toolMessages };
    }

    // 非目标消息：非 assistant 或无 tool_calls
    if (
      assistantMessage.role !== 'assistant' ||
      !assistantMessage.tool_calls ||
      assistantMessage.tool_calls.length === 0
    ) {
      return { assistant: assistantMessage, tools: toolMessages };
    }

    // 无 tool 消息：无需处理
    if (toolMessages.length === 0) {
      return { assistant: assistantMessage, tools: toolMessages };
    }

    // 第一步：构造 entry 列表，执行单条阈值检查（content.length > singleToolResultThreshold）
    const entries: Array<ToolResultEntry & { index: number }> = [];
    const singleThresholdIds = new Set<string>();
    let total = 0;
    toolMessages.forEach((msg, index) => {
      const id = msg.tool_call_id ?? '';
      const content = msg.content ?? '';
      entries.push({ id, content, index });
      total += content.length;
      if (content.length > this.singleToolResultThreshold) {
        singleThresholdIds.add(id);
      }
    });

    // 第二步：合计阈值检查，调 planOffloads 算出额外需 offload 的 id 列表
    let plannedIds: string[] = [];
    if (total > this.singleMessageTotalThreshold) {
      plannedIds = planOffloads(
        entries.map(({ id, content }) => ({ id, content })),
        this.singleMessageTotalThreshold,
      );
    }

    // 合并：单条阈值 + planOffloads 合计阈值
    const offloadIds = new Set<string>([...singleThresholdIds, ...plannedIds]);
    if (offloadIds.size === 0) {
      return { assistant: assistantMessage, tools: toolMessages };
    }

    // 按大→小排序需 offload 的条目（稳定处理顺序，与 planOffloads 一致）
    const toOffload = entries
      .filter(e => offloadIds.has(e.id))
      .sort((a, b) => b.content.length - a.content.length);

    // 第三步：对每条执行 offload，失败条目保留原文继续
    const tools = toolMessages.slice();
    for (const entry of toOffload) {
      const original = tools[entry.index];
      if (!original) continue;
      try {
        const filePath = await this.offloader.offload(
          entry.content,
          sessionId,
        );
        const preview = buildPreviewText(
          entry.content,
          this.headLines,
          this.tailLines,
          filePath,
        );
        tools[entry.index] = {
          ...original,
          content: preview,
          compacted: true,
        };
      } catch {
        // 单条 offload 失败：保留原文，继续处理其他条目（不抛出，由上层归一化）
      }
    }

    // assistant 消息自身无变化，原样返回
    return { assistant: assistantMessage, tools };
  }
}
