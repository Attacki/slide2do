/**
 * 通用 IO 消息/事件模型
 *
 * 定义核心层与展示层之间的稳定契约，使 UI 可被替换而不动核心逻辑。
 */

/** 消息角色 */
export type MessageRole = 'system' | 'user' | 'assistant';

/** 一次工具调用的记录（存放于对话历史，arguments 保留原始 JSON 字符串以保真） */
export interface ToolCallMessage {
  id: string;
  name: string;
  /** 模型下发的参数 JSON 字符串（未解析，保真存储） */
  arguments: string;
}

/**
 * 消息种类标签：用于在结构上区分「真实用户输入」与「系统注入的补充消息」。
 *
 * - `user`（默认）：真实用户输入；未标注 kind 时按此处理。
 * - `env_info`：环境信息补充（cwd/OS 等），对话首条系统级补充消息，动态生成不入 memory。
 * - `mode_reminder`：运行模式提醒，按节奏（首轮/模式切换完整、其余精简）注入，不入 memory。
 * - `system_supplement`：通用运行时补充指令（外部工具上线、温和提示等），可入 memory 也可动态注入。
 *
 * buildMessages 按 kind 分流：env_info/mode_reminder/system_supplement 由 provider 适配层按协议路由——
 * Anthropic 转为 user 消息置于 messages 末尾；OpenAI 归入 system 段；均与稳定可缓存段分离以避免污染缓存。
 */
export type MessageKind = 'user' | 'env_info' | 'mode_reminder' | 'system_supplement';

/** 单条对话消息（含可选的思考内容与工具调用/结果） */
export interface ChatMessage {
  role: MessageRole | 'tool';
  content: string;
  /**
   * 消息种类标签（可选）。缺省视为 `user` 语义。
   *
   * 用于 prompt 编排层将环境信息、模式提醒、运行时补充指令与真实用户输入在结构上区分，
   * provider 适配层按 kind 决定归入 system 段还是 messages 段。
   */
  kind?: MessageKind;
  /** 仅 assistant 角色可能携带 */
  thinking?: string;
  /** assistant 消息携带的工具调用（模型请求调用工具时填充） */
  tool_calls?: ToolCallMessage[];
  /** tool 角色消息对应的工具调用 id（工具结果回灌时填充） */
  tool_call_id?: string;
  /**
   * 标记该消息已被 offload 处理（content 已替换为预览+路径）。
   *
   * 由 SingleMessageCompactor 在 offload 后置 true，避免对同一条消息重复 offload；
   * ContextCompactor 调用 compact 前若发现已为 true 则跳过（幂等）。
   */
  compacted?: boolean;
}

/** 流式事件：Provider -> 核心 -> UI */
export type StreamEvent =
  | UserMessageEvent
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | ToolCallEvent
  | ToolCallStartEvent
  | ToolResultEvent
  | PlanBlockedEvent
  | FinalAnswerEvent
  | LoopTerminatedEvent
  | StreamDoneEvent
  | StreamErrorEvent;

/** 用户消息事件（循环开始时回显用户输入，供 UI 统一渲染对话流） */
export interface UserMessageEvent {
  type: 'user_message';
  text: string;
}

/** 文本增量事件（正式回复内容） */
export interface TextDeltaEvent {
  type: 'text_delta';
  delta: string;
}

/** 思考增量事件（extended thinking 内容） */
export interface ThinkingDeltaEvent {
  type: 'thinking_delta';
  delta: string;
}

/** 工具调用事件（参数 JSON 字符串已由客户端拼接完整） */
export interface ToolCallEvent {
  type: 'tool_call';
  id: string;
  name: string;
  /** 完整 JSON 字符串 */
  arguments: string;
}

/** 工具调用开始执行事件（分组调度后、实际执行前推送，标注读/写类别） */
export interface ToolCallStartEvent {
  type: 'tool_call_start';
  id: string;
  name: string;
  /** 是否写类（产生副作用）工具 */
  mutates: boolean;
}

/** 工具执行结果事件（回灌结果后推送，供 UI 展示） */
export interface ToolResultEvent {
  type: 'tool_result';
  tool_call_id: string;
  ok: boolean;
  content: string;
}

/** 只读模式（ask / plan）下写类工具被拦截事件（未执行，提示用户切到 /agent 后重试） */
export interface PlanBlockedEvent {
  type: 'plan_blocked';
  id: string;
  name: string;
  /** 提示文案（含当前模式与切换建议） */
  message: string;
}

/** 最终回复事件（循环终止前，模型给出的收尾文本） */
export interface FinalAnswerEvent {
  type: 'final_answer';
  text: string;
}

/** 循环终止原因 */
export type TerminationReason =
  | 'end_turn'
  | 'no_tool_call'
  | 'max_rounds'
  | 'cancelled'
  | 'timeout'
  | 'error';

/** 循环终止事件（状态机判定终止后推送，携带原因与已执行轮数） */
export interface LoopTerminatedEvent {
  type: 'loop_terminated';
  reason: TerminationReason;
  /** 本次循环已执行的轮数 */
  rounds: number;
  /** 最大允许轮数（供 UI 展示进度） */
  maxRounds?: number;
}

/** 流式完成事件（含用量信息） */
export interface StreamDoneEvent {
  type: 'done';
  usage?: {
    inputTokens: number;
    outputTokens: number;
    /**
     * Anthropic prompt caching 命中的输入 token 数（从缓存读取，不计费或低费率）。
     * 仅 Anthropic provider 解析透传；OpenAI 侧缺省。
     */
    cacheReadInputTokens?: number;
    /**
     * Anthropic prompt caching 本次新写入缓存的输入 token 数。
     * 仅 Anthropic provider 解析透传；OpenAI 侧缺省。
     */
    cacheCreationInputTokens?: number;
  };
}

/** 流式错误事件 */
export interface StreamErrorEvent {
  type: 'error';
  error: Error;
  /** 已输出的文本是否保留供用户查看 */
  recoverable: boolean;
}

/** 用户输入事件：UI -> 核心 */
export type UserInputEvent = SubmitInputEvent | CommandEvent;

/** 用户提交输入 */
export interface SubmitInputEvent {
  type: 'submit';
  text: string;
}

/** Slash 命令 */
export interface CommandEvent {
  type: 'command';
  name: '/exit' | '/clear' | '/help' | '/agent' | '/ask' | '/plan' | '/compact';
}
