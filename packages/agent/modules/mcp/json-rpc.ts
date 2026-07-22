/**
 * JsonRpcClient — JSON-RPC 2.0 异步匹配客户端
 *
 * 职责：
 * - 自增 id 分配（从 1 开始）
 * - 维护 `Map<id, {resolve, reject, timer}>` 异步匹配表
 * - request 默认 30s 超时自动 reject 并清理条目（防内存泄漏）
 * - notification 单独回调，不挂 Promise
 *
 * 不引入 transport 依赖：构造时注入 `send` 投递函数，进站消息由上层 transport
 * 调用 `handleMessage()` 喂入。
 */
import type {
  JsonRpcError,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from '@wuzi/types';

/** 出站消息投递函数（由 transport 层注入，负责把消息发往对端） */
export type JsonRpcSendFn = (message: JsonRpcRequest | JsonRpcNotification) => void;

/** 默认请求超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 30000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * JSON-RPC error response 抛出的 Error。
 * 携带原始 `code` / `data`，便于上层按错误码分支处理。
 */
export class JsonRpcErrorThrown extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(err: JsonRpcError) {
    super(err.message);
    this.name = 'JsonRpcError';
    this.code = err.code;
    this.data = err.data;
  }
}

export class JsonRpcClient {
  private readonly send: JsonRpcSendFn;
  private readonly defaultTimeoutMs: number;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private notificationCb: ((method: string, params?: unknown) => void) | null = null;

  /**
   * @param send 出站消息投递函数（transport 注入）
   * @param defaultTimeoutMs 默认请求超时（毫秒），缺省 30000
   */
  constructor(send: JsonRpcSendFn, defaultTimeoutMs: number = DEFAULT_TIMEOUT_MS) {
    if (typeof send !== 'function') {
      throw new Error('JsonRpcClient: send 必须为函数');
    }
    this.send = send;
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  /**
   * 发送 request（带 id），返回 server 的 result；
   * error 时 reject；超时未收到响应时 reject（message 含 'timeout'）。
   * @param timeoutMs 覆盖默认超时
   */
  sendRequest(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    const id = this.nextId++;
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const timeout = timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`JsonRpc request "${method}" (id=${id}) timeout after ${timeout}ms`));
        }
      }, timeout);

      this.pending.set(id, { resolve, reject, timer });

      try {
        this.send(request);
      } catch (err) {
        // 发送失败：清理 pending 并 reject，避免泄漏
        if (this.pending.delete(id)) {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
  }

  /** 发送 notification（无 id），不挂 Promise */
  sendNotification(method: string, params?: unknown): void {
    const notification: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    this.send(notification);
  }

  /**
   * 处理进站消息：按 id 匹配 pending 表 resolve/reject；
   * 无 id 字段视为 notification，触发已注册回调。
   * 支持 string（先 JSON.parse）或 object；解析失败静默忽略。
   */
  handleMessage(raw: string | object): void {
    let msg: unknown;
    if (typeof raw === 'string') {
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
    } else {
      msg = raw;
    }

    if (!msg || typeof msg !== 'object') return;
    const obj = msg as Record<string, unknown>;

    // notification：无 id 字段
    if (!('id' in obj)) {
      const method = typeof obj.method === 'string' ? obj.method : undefined;
      if (method && this.notificationCb) {
        try {
          this.notificationCb(method, obj.params);
        } catch {
          // 回调异常静默忽略，避免污染 transport 主循环
        }
      }
      return;
    }

    // response：含 id 字段（我们仅发出 numeric id，故只匹配数字）
    const id = obj.id;
    if (typeof id !== 'number') return;

    const pending = this.pending.get(id);
    if (!pending) return; // 无匹配（可能已超时被清理），静默忽略

    clearTimeout(pending.timer);
    this.pending.delete(id);

    if (obj.error !== undefined) {
      pending.reject(new JsonRpcErrorThrown(obj.error as JsonRpcError));
    } else {
      pending.resolve((obj as JsonRpcResponse).result);
    }
  }

  /** 注册 notification 回调（单槽位，后注册覆盖前者） */
  onNotification(cb: (method: string, params?: unknown) => void): void {
    this.notificationCb = cb;
  }

  /**
   * 关闭：reject 所有 pending 为 'client closed' 并清空 Map / timer。
   * 用于 transport 断开或客户端销毁场景，防止 Promise 永挂。
   */
  close(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`JsonRpc request (id=${id}) aborted: client closed`));
    }
    this.pending.clear();
    this.notificationCb = null;
  }
}
