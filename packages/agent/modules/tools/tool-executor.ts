/**
 * ToolExecutor — 工具执行器
 *
 * 负责把一次模型发起的 ToolCall 交给注册中心里的具体工具执行，并保证：
 *  1. 未知工具返回结构化错误而非抛异常；
 *  2. 执行受超时约束（超时即中断 signal 并返回结构化超时结果）；
 *  3. 工具抛出的任何异常都被包成结构化 ToolResult，让模型能据此调整；
 *  4. 可选注入 SecurityGate，在派发到 tool.execute 之前做安全决策拦截，
 *     deny 时直接返回结构化拒绝结果，不执行底层工具。
 */
import type { Tool, ToolContext, ToolResult, ToolCall } from '@wuzi/types';
import type { ToolRegistry } from './tool-registry.ts';
import type { SecurityGate } from '../security/security-gate.ts';

/** 单次工具执行的缺省超时（毫秒） */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

export class ToolExecutor {
  private readonly registry: ToolRegistry;
  private readonly baseCtx: ToolContext;
  private readonly defaultTimeoutMs: number;
  /** 可选安全门，缺省时不做拦截（保持向后兼容） */
  private readonly securityGate?: SecurityGate;

  constructor(
    registry: ToolRegistry,
    baseCtx: ToolContext,
    defaultTimeoutMs: number = DEFAULT_TOOL_TIMEOUT_MS,
    securityGate?: SecurityGate,
  ) {
    this.registry = registry;
    this.baseCtx = baseCtx;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.securityGate = securityGate;
  }

  /** 执行一次工具调用，返回结构化结果（永不抛出） */
  async executeCall(call: ToolCall): Promise<ToolResult> {
    const tool = this.registry.get(call.name);
    if (!tool) {
      const available = this.registry.list().map((t) => t.name).join(', ');
      return {
        ok: false,
        content: `未知工具: "${call.name}"，可用工具: ${available || '(无)'}`,
        error: 'unknown_tool',
        meta: { available: this.registry.list().map((t) => t.name) },
      };
    }

    const timeoutMs = tool.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    let timedOut = false;

    // 超时：标记并中断 signal（协助支持 signal 的工具/子进程及时终止）
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const callCtx: ToolContext = { ...this.baseCtx, signal: controller.signal };

      // 安全门拦截：deny 时立即返回结构化拒绝，不调用 tool.execute
      if (this.securityGate) {
        const decision = await this.securityGate.check(call, callCtx);
        if (decision.decision === 'deny') {
          return {
            ok: false,
            error: 'denied_by_security',
            content: decision.reason,
            meta: {
              layer: decision.layer,
              reason: decision.reason,
              source: decision.source,
              rule: decision.rule,
            },
          };
        }
        // decision.decision === 'allow' 则继续走超时与执行流程
      }

      const result = await Promise.race([
        tool.execute(call.arguments, callCtx),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('timeout')), timeoutMs);
        }),
      ]);
      return normalizeResult(result, call.name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (timedOut || controller.signal.aborted) {
        return {
          ok: false,
          content: `工具「${call.name}」执行超时（>${timeoutMs}ms），已被中断`,
          error: 'timeout',
          meta: { timeoutMs },
        };
      }
      return {
        ok: false,
        content: `工具「${call.name}」执行异常: ${message}`,
        error: message,
        meta: { timeoutMs },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 校验并归一化工具返回值，防止工具返回非法结构导致上游崩溃 */
function normalizeResult(result: unknown, name: string): ToolResult {
  if (!result || typeof result !== 'object' || typeof (result as ToolResult).ok !== 'boolean') {
    return {
      ok: false,
      content: `工具「${name}」返回值格式错误（需包含布尔型 ok 字段）`,
      error: 'invalid_result',
    };
  }
  const r = result as ToolResult;
  return { ok: r.ok, content: r.content ?? '', error: r.error, meta: r.meta };
}
