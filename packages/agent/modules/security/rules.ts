/**
 * 规则集匹配引擎
 *
 * 按 session > project > global 优先级遍历规则，同优先级按声明顺序，
 * 首条命中即返回 action。纯函数、无副作用；同步执行。
 *
 * 主参数提取规则：
 * - exec_command：call.arguments.command
 * - read_file / write_file / edit_file / find_files / search_content：call.arguments.path
 * - 其它工具（含 MCP 工具）：主参数未知，pattern 定义时视为不命中（保守策略）
 */
import { matchGlob } from './glob-match.ts';
import type { ToolCall, SecurityRule, RuleAction } from '@wuzi/types';

/** 规则命中结果：包含命中的规则、动作、来源层与匹配模式 */
export interface RuleHit {
  rule: SecurityRule;
  action: RuleAction;
  source: 'session' | 'project' | 'global';
  matchedPattern?: string;
}

/** 规则三层结构：session（最高）> project > global（最低） */
export interface RuleLayers {
  session: SecurityRule[];
  project: SecurityRule[];
  global: SecurityRule[];
}

// 文件类工具：主参数取 arguments.path
const FILE_TOOL_NAMES = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'find_files',
  'search_content',
]);

/**
 * 按 call.name 提取主参数（仅对已知结构的工具返回字符串值）
 *
 * - exec_command：arguments.command（须为字符串）
 * - 文件类工具：arguments.path（须为字符串）
 * - 其它工具（含 MCP）：主参数未知，返回 undefined
 */
function extractMainArg(call: ToolCall): string | undefined {
  if (call.name === 'exec_command') {
    const v = call.arguments.command;
    return typeof v === 'string' ? v : undefined;
  }
  if (FILE_TOOL_NAMES.has(call.name)) {
    const v = call.arguments.path;
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

/**
 * 判定单条规则是否命中当前工具调用
 *
 * a. 工具名匹配：rule.tool === call.name 或 rule.tool === '*'（通配）
 * b. pattern 未定义（undefined / 空串）：工具名匹配即命中
 * c. pattern 已定义：用 matchGlob 匹配 call 的主参数
 *    - 主参数未知（其它工具 / MCP）→ 不命中
 *    - 主参数缺失或非字符串 → 不命中
 */
function isRuleHit(rule: SecurityRule, call: ToolCall): boolean {
  // a. 工具名匹配
  if (rule.tool !== call.name && rule.tool !== '*') {
    return false;
  }
  // b. pattern 未定义或空串：工具名匹配即命中（匹配该工具所有调用）
  if (rule.pattern === undefined || rule.pattern === '') {
    return true;
  }
  // c. pattern 已定义：提取主参数并 glob 匹配
  const mainArg = extractMainArg(call);
  if (mainArg === undefined) {
    return false;
  }
  return matchGlob(mainArg, rule.pattern);
}

/**
 * 按优先级遍历规则层，首条命中即返回
 *
 * 优先级：session（最高）→ project → global（最低）
 * 同层内按数组声明顺序遍历；首条命中即返回 RuleHit；全部未命中返回 null。
 */
export function matchRules(call: ToolCall, layers: RuleLayers): RuleHit | null {
  const order: Array<{ source: 'session' | 'project' | 'global'; rules: SecurityRule[] }> = [
    { source: 'session', rules: layers.session },
    { source: 'project', rules: layers.project },
    { source: 'global', rules: layers.global },
  ];
  for (const layer of order) {
    for (const rule of layer.rules) {
      if (isRuleHit(rule, call)) {
        return {
          rule,
          action: rule.action,
          source: layer.source,
          matchedPattern: rule.pattern,
        };
      }
    }
  }
  return null;
}
