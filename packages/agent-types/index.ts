/**
 * wuzi-agent 工具系统共享类型
 *
 * 这些类型被「工具实现（@wuzi/tools）」「核心引擎（@wuzi/core 的注册中心/执行器/Provider）」
 * 共同依赖，抽离到独立的 @wuzi/types 包，避免跨包重复定义。
 */

/** JSON Schema 对象（参数描述）。约定为顶层 `type: 'object'` 的合法 JSON Schema。 */
export type JSONSchema = Record<string, unknown>;

/** 工具执行上下文：由调用方注入，工具实现不应对全局状态做假设。 */
export interface ToolContext {
  /** 工具操作的基准工作目录（绝对路径），相对路径以此为基准解析 */
  cwd: string;
  /** 超时/取消信号（由执行器在超时或用户取消时 abort），可中断耗时操作（如命令执行） */
  signal?: AbortSignal;
  /** HITL 回调：当工具需要用户授权时由执行器调用，由 UI 层注入具体实现（security 模块不反向依赖 UI） */
  askUser?: (req: HitlRequest) => Promise<HitlResponse>;
}

/** 权限模式：决定 security 模块的默认拦截策略。 */
export type PermissionMode = 'strict' | 'default' | 'permissive';

/** 规则动作：单条 security 规则的处置策略。 */
export type RuleAction = 'allow' | 'deny' | 'ask';

/** HITL 选择范围：用户授权决定的生效范围。 */
export type HitlChoice = 'once' | 'session' | 'permanent' | 'cancel';

/** Security 规则：针对特定工具（可带参数模式匹配）的处置规则。 */
export interface SecurityRule {
  /** 工具名称（与 Tool.name 匹配） */
  tool: string;
  /** 可选参数匹配模式（如文件路径 glob 等），缺省表示匹配该工具所有调用 */
  pattern?: string;
  /** 处置动作 */
  action: RuleAction;
  /** 规则来源层级：global（全局默认）/ project（项目配置）/ session（会话级临时） */
  source?: 'global' | 'project' | 'session';
  /** 规则说明（供 UI 展示与调试） */
  reason?: string;
}

/** Security 配置：注入到 security 模块的整体配置结构。 */
export interface SecurityConfig {
  /** 权限模式（缺省由 security 模块决定默认值） */
  mode?: PermissionMode;
  /** 沙箱约束（如限制可访问的路径/网络/命令前缀，具体语义由实现解释） */
  sandbox?: string[];
  /** 规则列表（按顺序匹配，先命中先生效） */
  rules?: SecurityRule[];
}

/** HITL 请求：执行器向 UI 发起的授权请求。 */
export interface HitlRequest {
  /** 触发授权的工具名称 */
  tool: string;
  /** 工具调用参数（供 UI 展示具体操作内容） */
  arguments: Record<string, unknown>;
  /** 请求授权的原因（如匹配到某条 ask 规则、模式为 strict 等） */
  reason: string;
  /** 可选的操作预览（如即将执行的命令文本、待写入文件 diff 等） */
  preview?: string;
}

/** HITL 响应：UI 返回给执行器的授权决定。 */
export interface HitlResponse {
  /** 决定：allow 放行 / deny 拒绝 */
  decision: 'allow' | 'deny';
  /** 决定生效范围 */
  scope: HitlChoice;
}

/** 工具执行结果（结构化）：无论成功失败都返回该结构，失败以 `ok: false` 表达，便于模型调整。 */
export interface ToolResult {
  /** 是否成功 */
  ok: boolean;
  /** 返回给模型的人类可读结果文本（成功为结果，失败为错误说明） */
  content: string;
  /** 失败时的简短错误标识（ok 为 false 时建议填写），如 'no_match' / 'timeout' */
  error?: string;
  /** 可选的附加结构化元信息（仅供调试/扩展，不影响模型阅读） */
  meta?: Record<string, unknown>;
}

/** 统一工具接口：每个工具都实现它。 */
export interface Tool {
  /** 工具唯一名称（模型调用时使用的标识，需与注册/API 定义一致） */
  name: string;
  /** 工具用途说明（注入给模型的工具描述） */
  description: string;
  /** 参数 JSON Schema（用于生成 API 工具定义与参数校验） */
  parameters: JSONSchema;
  /** 单次执行的超时时间（毫秒），缺省由执行器兜底 */
  timeoutMs?: number;
  /** 是否会产生副作用 / 修改外部状态（写类 = true，将与其它写类串行执行）；缺省 false（读类） */
  mutates?: boolean;
  /** 执行方法：接收已解析的参数与上下文，返回结构化结果 */
  execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** 注册中心对外暴露的「API 认得的工具列表」条目（中立格式，由各 Provider 映射为自身格式）。 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema;
  /** 是否会产生副作用 / 修改外部状态（写类 = true）；缺省 false（读类） */
  mutates?: boolean;
}

/** 模型发起的一次工具调用（参数 JSON 已拼合并解析为对象）。 */
export interface ToolCall {
  id: string;
  name: string;
  /** 解析后的参数对象 */
  arguments: Record<string, unknown>;
}

/* ==================== Memory（记忆系统）相关类型 ==================== */

/**
 * Instruction（项目指令文件）配置：控制 AGENTS.md 自动加载与 @include 展开。
 * 与 `AgentConfig.instructions` 对应，缺省值见 `DEFAULT_INSTRUCTION_CONFIG`。
 */
export interface InstructionConfig {
  /** @include 嵌套深度上限；缺省 3 */
  maxIncludeDepth?: number;
  /** 用户级 AGENTS.md 路径（绝对路径或 ~ 开头）；缺省 '~/.wuzi/AGENTS.md' */
  userLevelPath?: string;
}

/**
 * Session（会话存档）配置：控制会话 JSONL 持久化、恢复与过期清理。
 * 与 `AgentConfig.session` 对应，缺省值见 `DEFAULT_SESSION_CONFIG`。
 */
export interface SessionConfig {
  /** 是否启用会话持久化；缺省 true */
  enabled?: boolean;
  /** 会话存档目录（绝对路径）；缺省 `{projectDir}/.wuzi/sessions`，由装配层解析 */
  dir?: string;
  /** 过期清理最大天数；缺省 30 */
  maxAgeDays?: number;
  /** 时间跨度提醒阈值（毫秒），距上次活跃超此值插入提醒；缺省 3600000（1 小时） */
  timeGapMs?: number;
  /** 恢复时 token 超限触发压缩的阈值；缺省复用 context.windowHardLimit */
  tokenLimit?: number;
}

/** 会话元信息：与每会话 .meta.json 文件一一对应，列表展示无需扫整个 JSONL */
export interface SessionMeta {
  /** 会话 ID（同时是 .jsonl / .meta.json 文件名前缀） */
  id: string;
  /** 会话标题（首条 user 消息前 50 字符，缺省 '新会话'） */
  title: string;
  /** 会话摘要（末条 assistant 消息前 200 字符，缺省空串） */
  summary: string;
  /** 消息总数（user + assistant + tool，不含 system） */
  messageCount: number;
  /** 创建时间（毫秒时间戳） */
  createdAt: number;
  /** 最后活跃时间（毫秒时间戳） */
  lastActiveAt: number;
}

/* ==================== Context（上下文窗口管理）相关类型 ==================== */

/**
 * Context 配置：控制上下文窗口压缩 / 卸载 / 阈值触发等行为。
 * 与 `AgentConfig.context` 对应，缺省值见 `DEFAULT_CONTEXT_CONFIG`。
 */
export interface ContextConfig {
  /** 是否启用上下文压缩（compaction）；缺省 true */
  compactionEnabled?: boolean;
  /** 是否启用 tool 结果卸载（offload，将大块结果转为摘要/引用）；缺省 true */
  offloadEnabled?: boolean;
  /** 单条 tool 结果字符数阈值，超出则触发卸载；缺省 8000 */
  singleToolResultThreshold?: number;
  /** 单条 assistant 消息内 tool 结果合计字符数阈值，超出则触发卸载；缺省 20000 */
  singleMessageTotalThreshold?: number;
  /** 上下文窗口使用率阈值（0~1），超出触发压缩；缺省 0.8 */
  windowUsageThreshold?: number;
  /** 上下文窗口硬上限（字符数），达到则强制压缩；缺省 160000 */
  windowHardLimit?: number;
  /** 压缩时保留的最近对话轮数；缺省 4 */
  keepRecentRounds?: number;
  /** 压缩摘要的最大 token 数；缺省 2000 */
  summaryMaxTokens?: number;
  /** 摘要生成连续失败次数阈值，超出则关闭压缩；缺省 3 */
  summaryFailureThreshold?: number;
}

/* ==================== MCP（Model Context Protocol）相关类型 ==================== */

/** MCP Server 公共字段（stdio 与 http 两种形态共享）。 */
export interface McpServerBase {
  /** Server 唯一标识（用于注册中心索引、日志与错误定位） */
  name: string;
  /** 是否启用；缺省 true */
  enabled?: boolean;
  /** 工具调用超时（毫秒）；缺省 30000 */
  timeoutMs?: number;
}

/** stdio 形态 MCP Server：通过子进程标准输入输出通信。 */
export interface McpStdioServerConfig extends McpServerBase {
  type: 'stdio';
  /** 启动命令（如 'npx' / 'node'） */
  command: string;
  /** 命令参数 */
  args?: string[];
  /** 子进程环境变量 */
  env?: Record<string, string>;
}

/** http 形态 MCP Server：通过 HTTP/SSE 通信。 */
export interface McpHttpServerConfig extends McpServerBase {
  type: 'http';
  /** Server URL */
  url: string;
  /** 自定义请求头（用户自行填 Authorization 等） */
  headers?: Record<string, string>;
}

/** MCP Server 配置：联合类型，按 `type` 区分 stdio / http 两种形态。 */
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

/** MCP 远端工具描述（由 server 通过 tools/list 返回）。 */
export interface McpTool {
  name: string;
  description: string;
  /** 工具参数 JSON Schema */
  inputSchema: JSONSchema;
}

/** JSON-RPC 2.0 错误对象。 */
export interface JsonRpcError {
  code: number;
  message: string;
  /** 附加数据（可选） */
  data?: unknown;
}

/** JSON-RPC 2.0 请求（含 id，期待响应）。 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

/** JSON-RPC 2.0 响应（与请求 id 对应；成功返回 result，失败返回 error）。 */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

/** JSON-RPC 2.0 通知（无 id，不期待响应）。 */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}
