/**
 * 档位兜底策略
 *
 * 在规则集全部未命中时，按当前 PermissionMode 档位决定兜底处置。
 * 纯函数、无副作用；同步执行。
 *
 * 兜底矩阵：
 * | 档位        | 读类工具未命中（mutates !== true） | 写类工具未命中（mutates === true） |
 * |------------|--------------------------------------|--------------------------------------|
 * | strict     | ask                                  | ask                                  |
 * | default    | allow                                | ask                                  |
 * | permissive | allow                                | allow                                |
 *
 * 未知工具（未在 tools 中登记）保守视为写类，由档位决定处置。
 */
import type { PermissionMode, Tool } from '@wuzi/types';

/** 兜底处置决策 */
export type FallbackDecision = 'allow' | 'deny' | 'ask';

/**
 * 判断工具是否为写类（会产生副作用 / 修改外部状态）
 *
 * 在 tools 数组中查找 toolName：
 * - 找到且 mutates === true → true（写类）
 * - 找到但 mutates 为 undefined / false → false（读类）
 * - 未找到 → true（保守视为写类，未知工具默认需询问）
 */
export function isWriteTool(toolName: string, tools: Tool[]): boolean {
  for (const t of tools) {
    if (t.name === toolName) {
      return t.mutates === true;
    }
  }
  return true;
}

/**
 * 按档位矩阵返回兜底决策（规则未命中时调用）
 *
 * - strict：无论读写，返回 'ask'
 * - default：写类（isWriteTool=true）返回 'ask'；读类返回 'allow'
 * - permissive：无论读写，返回 'allow'
 */
export function fallbackDecision(
  toolName: string,
  mode: PermissionMode,
  tools: Tool[],
): FallbackDecision {
  switch (mode) {
    case 'strict':
      return 'ask';
    case 'default':
      return isWriteTool(toolName, tools) ? 'ask' : 'allow';
    case 'permissive':
      return 'allow';
  }
}
