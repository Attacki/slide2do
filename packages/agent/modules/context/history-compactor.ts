/**
 * HistoryCompactor — 整体对话历史压缩编排
 *
 * 当对话整体逼近窗口上限时,把中间历史(非 system / 非 user / 非最近 N 轮)交给 Summarizer
 * 生成结构化摘要,再用 `[summary 消息, 边界消息, ...toKeep]` 替换原对话。
 *
 * 设计要点:
 *  - `partitionMessages` 为无状态纯函数,可独立单测;负责识别「轮次」(一条 assistant + 其后
 *    归属该 assistant 的连续 tool 消息),从后往前数 keepRecentRounds 轮归入 toKeep,
 *    system/user 始终入 toKeep,其余 assistant+tool 入 toSummarize。
 *  - `HistoryCompactor` 类协调分区 + 摘要 + 拼装;toSummarize 为空时不调 summarizer,
 *    直接返回原 messages(幂等)。
 *  - 边界消息含「禁止根据摘要脑补」与「请重新读取」语义,提示模型如需文件细节请重新读取,避免脑补。
 */

import type { ChatMessage } from '../../ui-pattern.ts';

/**
 * Summarizer 依赖接口(供 mock 注入与解耦)。
 *
 * `Summarizer` 类在结构上满足此接口,可直接传入;
 * 测试中可实现此接口构造内存版 mock,不实际调用远端 LLM。
 */
export interface SummarizerLike {
  summarize(messages: ChatMessage[], signal?: AbortSignal): Promise<string>;
}

/** HistoryCompactor 配置 */
export interface HistoryCompactorConfig {
  /** 保留的最近轮数(一轮 = 一条 assistant + 其后连续 tool 消息) */
  keepRecentRounds: number;
}

/** partitionMessages 返回结构 */
export interface PartitionResult {
  /** 待摘要的中间历史(未被保留的 assistant + tool 消息) */
  toSummarize: ChatMessage[];
  /** 保留的消息(system + user + 最近 N 轮 assistant+tool) */
  toKeep: ChatMessage[];
}

/**
 * 把对话历史分区为「待摘要」与「保留」两组(纯函数,无副作用)。
 *
 * 保留规则:
 *  - 所有 `role === 'system'` 消息(无论 kind)
 *  - 所有 `role === 'user'` 消息(用户原话强制保留)
 *  - 最近 `keepRecentRounds` 轮 assistant + 其后归属该 assistant 的连续 tool 消息
 *    (一轮 = 一条 assistant + 紧随其后且归属于该 assistant 的所有 tool 消息;
 *     user 消息穿插不打断轮次计数,仅始终入 toKeep)
 *
 * 待摘要规则:
 *  - 其余的 assistant + tool 消息(即不在最近 N 轮内的中间历史)
 *
 * 顺序保持:toSummarize 与 toKeep 内部消息顺序与原 messages 一致。
 *
 * @param messages 完整对话历史
 * @param keepRecentRounds 保留的最近轮数(≤0 时仅 system/user 入 toKeep,其余 assistant+tool 全部入 toSummarize)
 * @returns 分区结果 `{ toSummarize, toKeep }`
 */
export function partitionMessages(
  messages: ChatMessage[],
  keepRecentRounds: number,
): PartitionResult {
  // 第一步:记录所有 assistant 消息的索引(每个 assistant 是一轮的起点)
  const assistantIndices: number[] = [];
  messages.forEach((msg, idx) => {
    if (msg.role === 'assistant') {
      assistantIndices.push(idx);
    }
  });

  // 第二步:确定保留的 assistant 索引集合(最后 keepRecentRounds 个)
  // keepRecentRounds ≤ 0 时保留集合为空;assistant 总数 ≤ keepRecentRounds 时全部保留
  const keepAssistantSet = new Set<number>();
  if (keepRecentRounds > 0) {
    const start = Math.max(0, assistantIndices.length - keepRecentRounds);
    for (let i = start; i < assistantIndices.length; i++) {
      keepAssistantSet.add(assistantIndices[i]);
    }
  }

  // 第三步:为每条消息判定归属
  // 维护 lastAssistantIdx:当前 tool 消息归属的最近 assistant 索引(若存在)
  // user 消息穿插不打断轮次计数(不更新 lastAssistantIdx,也不影响 keepAssistantSet 判定)
  const toSummarize: ChatMessage[] = [];
  const toKeep: ChatMessage[] = [];
  let lastAssistantIdx: number | null = null;

  messages.forEach((msg, idx) => {
    if (msg.role === 'system' || msg.role === 'user') {
      // system 与 user 始终入 toKeep
      toKeep.push(msg);
    } else if (msg.role === 'assistant') {
      lastAssistantIdx = idx;
      if (keepAssistantSet.has(idx)) {
        toKeep.push(msg);
      } else {
        toSummarize.push(msg);
      }
    } else {
      // role === 'tool':归属最近的 assistant(即使中间有 user 穿插)
      const ownerIdx = lastAssistantIdx;
      if (ownerIdx !== null && keepAssistantSet.has(ownerIdx)) {
        toKeep.push(msg);
      } else {
        toSummarize.push(msg);
      }
    }
  });

  return { toSummarize, toKeep };
}

/**
 * 历史压缩器 — 编排分区 + 摘要 + 拼装。
 *
 * compact 流程:
 *  1. 调 `partitionMessages` 把消息分为 `toSummarize` 与 `toKeep`
 *  2. 若 `toSummarize` 为空:直接返回原 messages(不调 summarizer,不注入 summary/边界消息)
 *  3. 否则:调 `summarizer.summarize(toSummarize, signal)` 产出 summaryText
 *  4. 构造 summary 消息:`{ role: 'system', kind: 'system_supplement', content: '## 上下文压缩摘要\n\n' + summaryText }`
 *  5. 构造边界消息:`{ role: 'system', kind: 'system_supplement', content: '上文为压缩摘要,如需文件细节请重新读取,禁止根据摘要脑补不存在的代码' }`
 *  6. 返回 `[summary 消息, 边界消息, ...toKeep]`(toKeep 在后,保持原顺序)
 *
 * summarizer 抛错时:本方法直接抛出(由上层 ContextCompactor 归一化)。
 */
export class HistoryCompactor {
  private readonly summarizer: SummarizerLike;
  private readonly keepRecentRounds: number;

  constructor(summarizer: SummarizerLike, config: HistoryCompactorConfig) {
    this.summarizer = summarizer;
    this.keepRecentRounds = config.keepRecentRounds;
  }

  /**
   * 压缩对话历史。
   *
   * @param messages 完整对话历史
   * @param signal 可选取消信号(透传给 summarizer)
   * @returns 压缩后的消息列表;若无需压缩(toSummarize 为空)则原样返回(同一引用)
   */
  async compact(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): Promise<ChatMessage[]> {
    const { toSummarize, toKeep } = partitionMessages(
      messages,
      this.keepRecentRounds,
    );

    // toSummarize 为空:直接返回原 messages(不调 summarizer,不注入 summary/边界消息)
    if (toSummarize.length === 0) {
      return messages;
    }

    // 调 summarizer 产出摘要(summarizer 抛错时直接抛出,由上层归一化)
    const summaryText = await this.summarizer.summarize(toSummarize, signal);

    // 构造 summary 消息与边界消息
    const summaryMessage: ChatMessage = {
      role: 'system',
      kind: 'system_supplement',
      content: '## 上下文压缩摘要\n\n' + summaryText,
    };
    const boundaryMessage: ChatMessage = {
      role: 'system',
      kind: 'system_supplement',
      content: '上文为压缩摘要,如需文件细节请重新读取,禁止根据摘要脑补不存在的代码',
    };

    // 拼装结果:[summary 消息, 边界消息, ...toKeep]
    return [summaryMessage, boundaryMessage, ...toKeep];
  }
}
