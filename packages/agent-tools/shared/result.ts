/**
 * 工具结果构造辅助
 *
 * 统一成功/失败结果的构造，避免每个工具重复样板。
 */
import type { ToolResult } from '@wuzi/types';

/** 构造成功结果 */
export function okResult(content: string, meta?: Record<string, unknown>): ToolResult {
  return meta ? { ok: true, content, meta } : { ok: true, content };
}

/** 构造失败结果（error 与 content 取同一说明文本，模型可读也可程序判别） */
export function failResult(message: string, meta?: Record<string, unknown>): ToolResult {
  return meta
    ? { ok: false, content: message, error: message, meta }
    : { ok: false, content: message, error: message };
}
