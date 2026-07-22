/**
 * AgentSession - 会话协调器
 *
 * 管理完整的交互生命周期：初始化 → 循环接收输入 → 调用 Agent → 输出事件 → 终止。
 * 持有每次请求的 AbortController，支持外部取消（/exit / stop / cancel），
 * 并分发 slash 命令（含运行时 /agent /ask /plan 切换运行模式）。
 */

import type { Agent } from './agent.ts';
import type { StreamEvent, UserInputEvent } from './ui-pattern.ts';
import type { AgentMode } from './utils/config/config-types.ts';

export interface LoopCallbacks {
  /** 流式事件回调（UI 层订阅） */
  onStreamEvent: (event: StreamEvent) => void;
  /** /exit 命令触发时回调 */
  onExit: () => void;
  /** /help 命令触发时回调 */
  onHelp: () => void;
  /** /clear 已执行后回调 */
  onCleared: () => void;
  /** /agent /ask /plan 切换后回调，参数为切换后的运行模式 */
  onModeChanged?: (mode: AgentMode) => void;
}

const HELP_TEXT = `
可用命令:
  /exit   - 退出程序
  /clear  - 清空对话上下文
  /agent  - 切换到 AGENT 模式（读写执行）
  /ask    - 切换到 ASK 模式（只读问答）
  /plan   - 切换到 PLAN 模式（只读规划）
  /compact - 手动触发上下文压缩
  /help   - 显示此帮助信息
`.trimStart();

export class AgentSession {
  private readonly agent: Agent;
  private readonly callbacks: LoopCallbacks;
  private running = false;
  /** 当前正在进行的请求的取消控制器 */
  private currentAbort: AbortController | null = null;

  constructor(agent: Agent, callbacks: LoopCallbacks) {
    this.agent = agent;
    this.callbacks = callbacks;
  }

  /** 是否正在运行 */
  isRunning(): boolean {
    return this.running;
  }

  /** 启动循环 */
  start(): void {
    this.running = true;
  }

  /** 停止循环（并取消进行中的请求） */
  stop(): void {
    this.running = false;
    this.currentAbort?.abort();
  }

  /** 取消当前进行中的请求（保持循环存活，供 UI 主动打断） */
  cancel(): void {
    this.currentAbort?.abort();
  }

  /** 帮助文本 */
  static helpText(): string {
    return HELP_TEXT;
  }

  /**
   * 提交用户输入到循环
   *
   * @returns 若收到 /exit 则返回 false 表示应终止循环
   */
  async submit(input: UserInputEvent): Promise<boolean> {
    if (!this.running) return false;

    // 预处理命令
    if (input.type === 'command') {
      switch (input.name) {
        case '/exit':
          this.currentAbort?.abort();
          this.callbacks.onExit();
          return false; // 信号终止

        case '/help':
          this.callbacks.onHelp();
          return true;

        case '/clear':
          this.agent.clearContext();
          this.callbacks.onCleared();
          return true;

        case '/agent':
        case '/ask':
        case '/plan': {
          const mode: AgentMode = input.name.slice(1) as AgentMode;
          this.agent.setMode(mode);
          this.callbacks.onModeChanged?.(mode);
          return true;
        }

        case '/compact': {
          // 手动触发上下文压缩：调 agent.compactContext() 并通过 onStreamEvent 推送提示
          // 用 loop_terminated (reason='no_tool_call', rounds=0) + 文本提示保持事件流一致
          const result = await this.agent.compactContext();
          this.callbacks.onStreamEvent({
            type: 'loop_terminated',
            reason: 'no_tool_call',
            rounds: 0,
          });
          // 文本提示用 text_delta + done 组合，便于 UI 直接渲染
          this.callbacks.onStreamEvent({ type: 'text_delta', delta: result.message });
          this.callbacks.onStreamEvent({ type: 'done' });
          return true;
        }
      }
    }

    // 委托给 Agent 处理，透传取消信号
    const controller = new AbortController();
    this.currentAbort = controller;
    try {
      await this.agent.processInput(
        input,
        (event) => this.callbacks.onStreamEvent(event),
        { signal: controller.signal },
      );
    } finally {
      if (this.currentAbort === controller) this.currentAbort = null;
    }

    return true;
  }
}
