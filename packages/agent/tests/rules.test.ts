/**
 * rules 规则匹配引擎单元测试
 *
 * 覆盖：
 * - 优先级 session > project > global（三层逐级回退）
 * - 通配工具名 `*`
 * - pattern 匹配 exec_command / file 工具
 * - 首条命中即止
 * - 无命中返回 null
 * - pattern 定义但主参数未知（MCP 工具）→ 不命中
 * - pattern 空串视为匹配所有
 */
import { describe, it, expect } from 'bun:test';
import { matchRules } from '../modules/security/rules.ts';
import type { ToolCall, SecurityRule, RuleLayers } from '@wuzi/types';

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: 'test-call', name, arguments: args };
}

function rule(
  tool: string,
  action: SecurityRule['action'],
  pattern?: string,
): SecurityRule {
  return pattern === undefined ? { tool, action } : { tool, action, pattern };
}

function layers(session: SecurityRule[] = [], project: SecurityRule[] = [], global: SecurityRule[] = []): RuleLayers {
  return { session, project, global };
}

describe('matchRules — 优先级 session > project > global', () => {
  const sessionRule = rule('exec_command', 'deny');
  const projectRule = rule('exec_command', 'ask');
  const globalRule = rule('exec_command', 'allow');
  const c = call('exec_command', { command: 'ls' });

  it('三层都有命中规则时 session 先命中', () => {
    const hit = matchRules(c, layers([sessionRule], [projectRule], [globalRule]));
    expect(hit).not.toBeNull();
    expect(hit!.source).toBe('session');
    expect(hit!.action).toBe('deny');
    expect(hit!.rule).toBe(sessionRule);
  });

  it('移除 session 后 project 命中', () => {
    const hit = matchRules(c, layers([], [projectRule], [globalRule]));
    expect(hit).not.toBeNull();
    expect(hit!.source).toBe('project');
    expect(hit!.action).toBe('ask');
  });

  it('移除 project 后 global 命中', () => {
    const hit = matchRules(c, layers([], [], [globalRule]));
    expect(hit).not.toBeNull();
    expect(hit!.source).toBe('global');
    expect(hit!.action).toBe('allow');
  });
});

describe('matchRules — 通配工具名 `*`', () => {
  const wildcard = rule('*', 'deny');
  it('匹配任意工具调用（exec_command）', () => {
    const hit = matchRules(call('exec_command', { command: 'ls' }), layers([wildcard]));
    expect(hit).not.toBeNull();
    expect(hit!.action).toBe('deny');
    expect(hit!.rule).toBe(wildcard);
  });
  it('匹配任意工具调用（write_file）', () => {
    const hit = matchRules(call('write_file', { path: 'a.ts' }), layers([wildcard]));
    expect(hit).not.toBeNull();
    expect(hit!.action).toBe('deny');
  });
});

describe('matchRules — pattern 匹配 exec_command', () => {
  const r = rule('exec_command', 'allow', 'git status*');
  it('命中 {command:"git status"}', () => {
    const hit = matchRules(call('exec_command', { command: 'git status' }), layers([r]));
    expect(hit).not.toBeNull();
    expect(hit!.action).toBe('allow');
    expect(hit!.matchedPattern).toBe('git status*');
  });
  it('不命中 {command:"git push"}', () => {
    const hit = matchRules(call('exec_command', { command: 'git push' }), layers([r]));
    expect(hit).toBeNull();
  });
});

describe('matchRules — pattern 匹配 file 工具', () => {
  const r = rule('write_file', 'ask', 'src/**');
  it('命中 {path:"src/a.ts"}', () => {
    const hit = matchRules(call('write_file', { path: 'src/a.ts' }), layers([r]));
    expect(hit).not.toBeNull();
    expect(hit!.action).toBe('ask');
    expect(hit!.matchedPattern).toBe('src/**');
  });
  it('不命中 {path:"build/x.ts"}', () => {
    const hit = matchRules(call('write_file', { path: 'build/x.ts' }), layers([r]));
    expect(hit).toBeNull();
  });
});

describe('matchRules — 首条命中即止', () => {
  it('同层内多条规则都能命中，返回第一条', () => {
    const r1 = rule('exec_command', 'allow');
    const r2 = rule('exec_command', 'deny');
    const r3 = rule('*', 'ask');
    const hit = matchRules(call('exec_command', { command: 'ls' }), layers([r1, r2, r3]));
    expect(hit).not.toBeNull();
    expect(hit!.rule).toBe(r1);
    expect(hit!.action).toBe('allow');
  });
  it('session 层命中后不再遍历 project / global', () => {
    const sessionRule = rule('exec_command', 'deny');
    const projectRule = rule('exec_command', 'allow');
    const globalRule = rule('exec_command', 'ask');
    const hit = matchRules(
      call('exec_command', { command: 'ls' }),
      layers([sessionRule], [projectRule], [globalRule]),
    );
    expect(hit!.rule).toBe(sessionRule);
    expect(hit!.action).toBe('deny');
  });
});

describe('matchRules — 无命中返回 null', () => {
  it('所有层无匹配规则返回 null', () => {
    const r = rule('exec_command', 'allow', 'git status*');
    const hit = matchRules(call('exec_command', { command: 'ls' }), layers([r]));
    expect(hit).toBeNull();
  });
  it('空层全部跳过返回 null', () => {
    const hit = matchRules(call('exec_command', { command: 'ls' }), layers());
    expect(hit).toBeNull();
  });
});

describe('matchRules — pattern 定义但主参数未知（MCP 工具）', () => {
  it('rule {tool:mcp_tool, pattern:foo*} 对 mcp_tool 调用不命中', () => {
    const r = rule('mcp_tool', 'allow', 'foo*');
    const hit = matchRules(call('mcp_tool', {}), layers([r]));
    expect(hit).toBeNull();
  });
  it('通配 * + pattern 对未知主参数工具也不命中', () => {
    const r = rule('*', 'allow', 'foo*');
    const hit = matchRules(call('mcp_tool', {}), layers([r]));
    expect(hit).toBeNull();
  });
});

describe('matchRules — pattern 空串视为匹配所有', () => {
  it('rule {tool:exec_command, pattern:""} 命中任意 exec_command 调用', () => {
    const r = rule('exec_command', 'deny', '');
    const hit = matchRules(call('exec_command', { command: 'anything' }), layers([r]));
    expect(hit).not.toBeNull();
    expect(hit!.action).toBe('deny');
    expect(hit!.matchedPattern).toBe('');
  });
});

describe('matchRules — 主参数缺失/非字符串', () => {
  it('pattern 定义但主参数缺失（无 command 字段）→ 不命中', () => {
    const r = rule('exec_command', 'allow', 'git*');
    const hit = matchRules(call('exec_command', {}), layers([r]));
    expect(hit).toBeNull();
  });
  it('pattern 定义但主参数非字符串（数字）→ 不命中', () => {
    const r = rule('exec_command', 'allow', 'git*');
    const hit = matchRules(call('exec_command', { command: 123 }), layers([r]));
    expect(hit).toBeNull();
  });
  it('pattern 定义但 path 缺失 → 不命中', () => {
    const r = rule('write_file', 'ask', 'src/**');
    const hit = matchRules(call('write_file', {}), layers([r]));
    expect(hit).toBeNull();
  });
});

describe('matchRules — RuleHit 结构字段', () => {
  it('返回的 RuleHit 含 rule / action / source / matchedPattern', () => {
    const r = rule('write_file', 'ask', 'src/**');
    const hit = matchRules(
      call('write_file', { path: 'src/x.ts' }),
      layers([], [r], []),
    );
    expect(hit).not.toBeNull();
    expect(hit!.rule).toBe(r);
    expect(hit!.action).toBe('ask');
    expect(hit!.source).toBe('project');
    expect(hit!.matchedPattern).toBe('src/**');
  });
});
