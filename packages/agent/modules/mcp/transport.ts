/**
 * Transport — MCP 传输层抽象
 *
 * 职责：
 * - 屏蔽 stdio / http 两种物理通道差异，向上层 McpClient 提供统一的「行 JSON-RPC」收发接口
 * - 子进程 / 连接生命周期管理（启动 / 关闭 / 退出通知）
 *
 * 当前实现：
 * - StdioTransport（spawn 子进程 + stdin/stdout 行协议）
 * - HttpTransport（Streamable HTTP，POST + SSE/JSON 解析）
 */
import type { JsonRpcRequest, JsonRpcNotification } from '@wuzi/types';

/** 传输层统一接口（stdio / http 共享）。 */
export interface Transport {
  /** 启动传输：stdio 场景为 spawn 子进程；http 场景为建立连接占位 */
  start(): Promise<void> | void;
  /** 发送一条 JSON-RPC 消息（request 或 notification） */
  send(message: JsonRpcRequest | JsonRpcNotification): void;
  /** 注册消息回调：收到一行/一条 JSON 字符串时触发 */
  onMessage(cb: (raw: string) => void): void;
  /** 注册连接关闭回调（子进程退出或连接断开时触发，仅一次） */
  onClose(cb: () => void): void;
  /** 关闭传输并释放资源（幂等） */
  close(): Promise<void> | void;
}

/** StdioTransport 构造参数。 */
export interface StdioTransportOptions {
  /** 启动命令（如 'npx' / 'node' / 'bun'） */
  command: string;
  /** 命令参数 */
  args?: string[];
  /** 子进程环境变量；缺省继承父进程 */
  env?: Record<string, string>;
}

/** HttpTransport 构造参数。 */
export interface HttpTransportOptions {
  /** Server URL（POST 端点） */
  url: string;
  /** 用户自定义 headers（如 Authorization）；优先级最高，可覆盖默认 */
  headers?: Record<string, string>;
  /** fetch 注入（主要供测试 mock）；缺省为全局 fetch；生产代码不传 */
  fetchFn?: typeof fetch;
}

/**
 * StdioTransport — 通过 spawn 子进程的 stdin/stdout 通信
 *
 * 协议：每条 JSON-RPC 消息以 `\n` 分隔（行协议）。
 * - 出站：JSON.stringify(message) + '\n' 写入子进程 stdin
 * - 进站：从子进程 stdout 按行解析，每行作为字符串触发 onMessage（维护内部 buffer 处理跨块换行）
 * - stderr：转发到 console.error，前缀 `[mcp:stdio:{command}]`
 * - 子进程退出（proc.exited 或 stdout EOF）→ 触发 onClose（仅一次）
 * - close() 调用 proc.kill()；幂等
 */
export class StdioTransport implements Transport {
  private readonly command: string;
  private readonly args: string[];
  private readonly env?: Record<string, string>;

  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private messageCb: ((raw: string) => void) | null = null;
  private closeCb: (() => void) | null = null;

  private closed = false;
  private closeFired = false;
  private stdoutBuffer = '';

  constructor(opts: StdioTransportOptions) {
    this.command = opts.command;
    this.args = opts.args ?? [];
    this.env = opts.env;
  }

  start(): void {
    if (this.proc) return; // 幂等：已启动
    if (this.closed) return; // 已关闭不重启

    this.proc = Bun.spawn({
      cmd: [this.command, ...this.args],
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: this.env,
    });

    const proc = this.proc;
    if (proc.stdout) {
      this.pumpStdout(proc.stdout as ReadableStream<Uint8Array>);
    }
    if (proc.stderr) {
      this.pumpStderr(proc.stderr as ReadableStream<Uint8Array>);
    }
    // 子进程退出 → 触发 onClose（仅一次）；resolve / reject 都视为退出
    void proc.exited.then(
      () => this.fireClose(),
      () => this.fireClose(),
    );
  }

  /** 从 stdout 行解析：维护 buffer，按 `\n` 切分，每行触发 onMessage */
  private async pumpStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        this.stdoutBuffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = this.stdoutBuffer.indexOf('\n')) >= 0) {
          const line = this.stdoutBuffer.slice(0, idx);
          this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
          if (line.length === 0) continue; // 跳过空行
          if (this.messageCb) {
            try {
              this.messageCb(line);
            } catch {
              // 回调异常静默忽略，避免污染主循环
            }
          }
        }
      }
    } catch {
      // 流读取异常忽略（子进程被 kill 时可能触发）
    } finally {
      try {
        reader.releaseLock();
      } catch {}
      this.fireClose(); // stdout EOF 视为连接关闭
    }
  }

  /** stderr 转发到 console.error，带前缀 */
  private async pumpStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const prefix = `[mcp:stdio:${this.command}]`;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        const text = decoder.decode(value, { stream: true });
        console.error(`${prefix} ${text}`);
      }
    } catch {
      // 忽略
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
  }

  /** 触发 onClose 回调（仅一次） */
  private fireClose(): void {
    if (this.closeFired) return;
    this.closeFired = true;
    try {
      this.closeCb?.();
    } catch {
      // 回调异常静默忽略
    }
  }

  send(message: JsonRpcRequest | JsonRpcNotification): void {
    if (!this.proc) {
      throw new Error('StdioTransport: not started');
    }
    if (this.closed) {
      throw new Error('StdioTransport: already closed');
    }
    const stdin = this.proc.stdin as { write: (s: string) => number | void } | null;
    if (!stdin) {
      throw new Error('StdioTransport: stdin unavailable');
    }
    const line = JSON.stringify(message) + '\n';
    stdin.write(line);
  }

  onMessage(cb: (raw: string) => void): void {
    this.messageCb = cb;
  }

  onClose(cb: () => void): void {
    this.closeCb = cb;
  }

  close(): void {
    if (this.closed) return; // 幂等
    this.closed = true;
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        // 进程已退出或 kill 失败时静默忽略
      }
    }
  }

  /** 是否仍在运行（已启动且未关闭） */
  isRunning(): boolean {
    return !!this.proc && !this.closed;
  }
}

/**
 * HttpTransport — Streamable HTTP 传输（MCP 规范）
 *
 * 协议：每次 send() 以 POST JSON-RPC 到 url。
 * - 响应 `Content-Type: text/event-stream` → 按 SSE 解析：
 *   - 维护 buffer（一次性 await text() 后解析），以 `\n\n` 或 `\r\n\r\n` 切分 event
 *   - 每个 event 内多行 `data:` 按 SSE 规范以 `\n` 拼接为一条 JSON 字符串，触发一次 onMessage
 *   - 忽略 `event:` / `id:` / `retry:` 等其他 SSE 字段
 *   - `data:` 行为空（心跳）跳过
 * - 响应 `Content-Type: application/json` → body 整体作为一条 JSON 字符串触发 onMessage
 * - 其他 Content-Type → 记录错误日志，不触发回调
 * - 首次响应 headers 含 `Mcp-Session-Id` → 缓存到 sessionId，后续请求带上
 * - headers 合并优先级：默认（Content-Type / Accept）→ Mcp-Session-Id（缓存后）→ 用户 headers（最高）
 * - close() 清空 sessionId、回调并触发一次 onClose（HTTP 无主动关闭事件，保持接口一致）；幂等
 */
export class HttpTransport implements Transport {
  private readonly url: string;
  private readonly userHeaders: Record<string, string>;
  private readonly fetchFn: typeof fetch;

  private sessionId: string | null = null;
  private messageCb: ((raw: string) => void) | null = null;
  private closeCb: (() => void) | null = null;

  private closed = false;
  private closeFired = false;

  constructor(opts: HttpTransportOptions) {
    this.url = opts.url;
    this.userHeaders = opts.headers ?? {};
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  /** 启动：仅校验 URL 合法性（HTTP 无需主动建立连接） */
  start(): void {
    if (this.closed) return;
    // URL 合法性校验；非法 URL 抛出
    new URL(this.url);
  }

  send(message: JsonRpcRequest | JsonRpcNotification): void {
    if (this.closed) {
      throw new Error('HttpTransport: already closed');
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };
    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId;
    }
    // 用户 headers 优先级最高，允许覆盖默认 / sessionId
    Object.assign(headers, this.userHeaders);

    const body = JSON.stringify(message);

    // fire-and-forget：send 同步返回；响应解析通过 onMessage 异步触发
    void this.fetchFn(this.url, {
      method: 'POST',
      headers,
      body,
    })
      .then((resp) => this.handleResponse(resp))
      .catch((err) => {
        if (this.closed) return;
        console.error(`[mcp:http] request failed: ${(err as Error).message}`);
      });
  }

  /** 处理 fetch 响应：缓存 Mcp-Session-Id、按 Content-Type 解析、触发 onMessage */
  private async handleResponse(resp: Response): Promise<void> {
    if (this.closed) return;

    // 首次响应缓存 Mcp-Session-Id（不覆盖已缓存值）
    const sessionId = resp.headers.get('mcp-session-id');
    if (sessionId && !this.sessionId && !this.closed) {
      this.sessionId = sessionId;
    }

    const contentType = resp.headers.get('content-type') ?? '';
    const ctLower = contentType.toLowerCase();

    if (ctLower.includes('text/event-stream')) {
      const text = await resp.text();
      if (this.closed) return;
      this.parseSse(text);
    } else if (ctLower.includes('application/json')) {
      const text = await resp.text();
      if (this.closed) return;
      if (text.length > 0 && this.messageCb) {
        try {
          this.messageCb(text);
        } catch {
          // 回调异常静默忽略，避免污染调用方
        }
      }
    } else {
      console.error(`[mcp:http] unsupported content-type: ${contentType}`);
    }
  }

  /**
   * 解析 SSE body：以 `\n\n` / `\r\n\r\n` 切分 event；
   * 每个 event 内多行 `data:` 按 SSE 规范以 `\n` 拼接后触发一次 onMessage
   */
  private parseSse(body: string): void {
    // buffer 概念保留：当前为一次性 await text() 后解析；后续如需流式读取可改为增量 buffer
    const buffer = body;
    const events = buffer.split(/\r?\n\r?\n/);
    for (const evt of events) {
      if (evt.length === 0) continue;
      const lines = evt.split(/\r?\n/);
      const dataLines: string[] = [];
      for (const line of lines) {
        // SSE 字段名大小写不敏感；只处理 data:
        if (line.toLowerCase().startsWith('data:')) {
          // 去掉 `data:` 前缀（5 字符）；SSE 规范：紧跟一个空格则一并去掉
          let payload = line.slice(5);
          if (payload.startsWith(' ')) {
            payload = payload.slice(1);
          }
          dataLines.push(payload);
        }
        // 忽略 event: / id: / retry: 等其他 SSE 字段
      }
      if (dataLines.length === 0) continue; // 心跳 / 无 data 行
      const joined = dataLines.join('\n');
      if (joined.length === 0) continue; // 全空 data → 心跳
      if (this.messageCb) {
        try {
          this.messageCb(joined);
        } catch {
          // 回调异常静默忽略
        }
      }
    }
  }

  onMessage(cb: (raw: string) => void): void {
    this.messageCb = cb;
  }

  onClose(cb: () => void): void {
    this.closeCb = cb;
  }

  close(): void {
    if (this.closed) return; // 幂等
    this.closed = true;
    this.sessionId = null;
    this.messageCb = null; // 防止 in-flight fetch 触发 onMessage
    this.fireClose();
    this.closeCb = null;
  }

  /** 触发 onClose 回调（仅一次） */
  private fireClose(): void {
    if (this.closeFired) return;
    this.closeFired = true;
    try {
      this.closeCb?.();
    } catch {
      // 回调异常静默忽略
    }
  }

  /** 是否已缓存 Mcp-Session-Id（测试 / 状态查询用） */
  hasSessionId(): boolean {
    return this.sessionId !== null;
  }
}
