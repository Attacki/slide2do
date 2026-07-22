/**
 * PromptComposer — 结构化 prompt 拼装器
 *
 * 将「稳定可缓存段」与「动态对话通道」分流拼装，是 prompt 编排架构的核心：
 *
 *   稳定 system（可缓存）→ env_info（动态）→ 对话历史 → mode_reminder（动态，按节奏）
 *
 * - 稳定 system 段由角色层模块化拼装后传入（PromptComposer 持有），内容在会话内不变，
 *   便于 provider 层（如 Anthropic）挂载 cache_control 实现缓存最大化命中。
 * - env_info 由 ContextManager 动态产出，环境变化只影响此段，不波及稳定段缓存。
 * - mode_reminder 由 ReasoningLoop.buildModeReminder 按节奏（首轮/模式切换完整、其余精简）决策后传入，
 *   三种模式均会注入，保证模型始终知晓当前运行模式。
 * - 对话历史中的旧稳定 system（无 kind 标记的 system 消息）会被过滤，避免与稳定段重复。
 *
 * 节奏控制选项（round/modeChanged/firstRound）作为元数据保留在接口中，便于调用方传递与未来扩展；
 * 当前节奏决策由 ReasoningLoop 完成，PromptComposer 仅做拼装。
 */

import type { ChatMessage } from '../ui-pattern.ts';

/** compose 方法的运行期选项 */
export interface ComposeOptions {
  /** 环境信息消息（由 ContextManager.toMessage() 产出），注入到稳定 system 之后 */
  envInfo?: ChatMessage;
  /** 模式提醒消息（由 buildModeReminder 产出），null/undefined 表示不注入 */
  modeReminder?: ChatMessage | null;
  /** 当前轮次（元数据，便于调用方传递；当前不影响拼装逻辑，节奏决策在 ReasoningLoop） */
  round?: number;
  /** 本轮是否发生模式切换（元数据） */
  modeChanged?: boolean;
  /** 是否首轮（元数据） */
  firstRound?: boolean;
}

/**
 * 结构化 prompt 拼装器。
 *
 * 构造时接收角色稳定段（由角色层模块化拼装的 system 字符串），
 * 每次 compose 调用产出完整的发送给 provider 的消息序列。
 */
export class PromptComposer {
  /**
   * @param stableSystem 角色稳定 system 段（模块化拼装后的字符串），会话内不变
   */
  constructor(private readonly stableSystem: string) {}

  /**
   * 拼装发送给 provider 的完整消息序列。
   *
   * 输出顺序：稳定 system → env_info（若有）→ 对话历史（过滤旧稳定 system）→ mode_reminder（若有）。
   *
   * @param messages 对话历史（通常为 memory.getMessages()，可能含旧的稳定 system，会被过滤）
   * @param opts 运行期选项（env_info / mode_reminder / 节奏元数据）
   * @returns 完整消息序列，可直接传入 provider.streamChat
   */
  compose(messages: ChatMessage[], opts: ComposeOptions = {}): ChatMessage[] {
    const result: ChatMessage[] = [];

    // 1. 稳定 system 段（可缓存）—— 由 PromptComposer 持有，会话内不变
    result.push({ role: 'system', content: this.stableSystem });

    // 2. env_info（动态，不缓存）—— 环境信息，每次现取
    if (opts.envInfo) {
      result.push(opts.envInfo);
    }

    // 3. 对话历史 —— 过滤掉旧的稳定 system（无 kind 标记的 system 消息），避免与稳定段重复
    for (const m of messages) {
      if (m.role === 'system' && m.kind === undefined) {
        continue;
      }
      result.push(m);
    }

    // 4. mode_reminder（动态，按节奏）—— 由 ReasoningLoop 决策后传入，null/undefined 不注入
    if (opts.modeReminder) {
      result.push(opts.modeReminder);
    }

    return result;
  }

  /** 获取稳定 system 段（供 provider 层判断缓存断点等） */
  getStableSystem(): string {
    return this.stableSystem;
  }
}
