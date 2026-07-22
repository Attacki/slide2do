/**
 * 内存版多轮对话记忆
 *
 * 在进程内存储对话上下文，按轮次累积 user/assistant 消息，提供清空能力。
 */

import type { ChatMessage } from '../../ui-pattern.ts';

export class ConversationMemory {
  private messages: ChatMessage[] = [];

  /** 获取当前完整上下文（含 system 消息） */
  getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  /** 追加一条消息（用户输入 或 AI 回复） */
  append(message: ChatMessage): void {
    this.messages.push(message);
  }

  /** 清空上下文（保留 system 消息） */
  clear(): void {
    // 仅移除 user/assistant，保留 system
    this.messages = this.messages.filter((m) => m.role === 'system');
  }

  /** 完全重置（包括 system） */
  reset(): void {
    this.messages = [];
  }

  /** 设置/替换 system 消息（去重后仅保留最后一份） */
  setSystem(content: string): void {
    this.messages = this.messages.filter((m) => m.role !== 'system');
    this.messages.unshift({ role: 'system', content });
  }
}
