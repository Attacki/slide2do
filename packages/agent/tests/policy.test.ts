/**
 * policy 兜底策略单元测试
 *
 * 覆盖：
 * - fallbackDecision 三档 × 读类/写类 = 6 组合
 * - isWriteTool 边界：未找到 / mutates=undefined / mutates=true / mutates=false
 */
import { describe, it, expect } from 'bun:test';
import {
  isWriteTool,
  fallbackDecision,
  type FallbackDecision,
} from '../modules/security/policy.ts';
import type { Tool } from '@wuzi/types';

// 测试用工具集：read_tool（读类，mutates 缺省）、write_tool（写类）、explicit_read（mutates=false）
const tools: Tool[] = [
  {
    name: 'read_tool',
    description: 'read',
    parameters: {},
    mutates: undefined,
    execute: async () => ({ ok: true, content: '' }),
  },
  {
    name: 'write_tool',
    description: 'write',
    parameters: {},
    mutates: true,
    execute: async () => ({ ok: true, content: '' }),
  },
  {
    name: 'explicit_read',
    description: 'explicit read',
    parameters: {},
    mutates: false,
    execute: async () => ({ ok: true, content: '' }),
  },
];

describe('fallbackDecision — strict 档位', () => {
  it('strict + 读类（mutates=undefined）→ ask', () => {
    expect(fallbackDecision('read_tool', 'strict', tools)).toBe('ask');
  });
  it('strict + 读类（mutates=false）→ ask', () => {
    expect(fallbackDecision('explicit_read', 'strict', tools)).toBe('ask');
  });
  it('strict + 写类（mutates=true）→ ask', () => {
    expect(fallbackDecision('write_tool', 'strict', tools)).toBe('ask');
  });
});

describe('fallbackDecision — default 档位', () => {
  it('default + 读类（mutates=undefined）→ allow', () => {
    expect(fallbackDecision('read_tool', 'default', tools)).toBe('allow');
  });
  it('default + 读类（mutates=false）→ allow', () => {
    expect(fallbackDecision('explicit_read', 'default', tools)).toBe('allow');
  });
  it('default + 写类（mutates=true）→ ask', () => {
    expect(fallbackDecision('write_tool', 'default', tools)).toBe('ask');
  });
});

describe('fallbackDecision — permissive 档位', () => {
  it('permissive + 读类（mutates=undefined）→ allow', () => {
    expect(fallbackDecision('read_tool', 'permissive', tools)).toBe('allow');
  });
  it('permissive + 读类（mutates=false）→ allow', () => {
    expect(fallbackDecision('explicit_read', 'permissive', tools)).toBe('allow');
  });
  it('permissive + 写类（mutates=true）→ allow', () => {
    expect(fallbackDecision('write_tool', 'permissive', tools)).toBe('allow');
  });
});

describe('fallbackDecision — 未知工具保守视为写类', () => {
  it('strict + 未知工具 → ask', () => {
    expect(fallbackDecision('unknown_tool', 'strict', tools)).toBe('ask');
  });
  it('default + 未知工具 → ask（按写类处理）', () => {
    expect(fallbackDecision('unknown_tool', 'default', tools)).toBe('ask');
  });
  it('permissive + 未知工具 → allow', () => {
    expect(fallbackDecision('unknown_tool', 'permissive', tools)).toBe('allow');
  });
});

describe('fallbackDecision — 矩阵完整性（3 档 × 2 类 = 6 组合）', () => {
  const matrix: Array<{
    mode: 'strict' | 'default' | 'permissive';
    tool: 'read_tool' | 'write_tool';
    expected: FallbackDecision;
  }> = [
    { mode: 'strict', tool: 'read_tool', expected: 'ask' },
    { mode: 'strict', tool: 'write_tool', expected: 'ask' },
    { mode: 'default', tool: 'read_tool', expected: 'allow' },
    { mode: 'default', tool: 'write_tool', expected: 'ask' },
    { mode: 'permissive', tool: 'read_tool', expected: 'allow' },
    { mode: 'permissive', tool: 'write_tool', expected: 'allow' },
  ];

  for (const { mode, tool, expected } of matrix) {
    it(`${mode} + ${tool} → ${expected}`, () => {
      expect(fallbackDecision(tool, mode, tools)).toBe(expected);
    });
  }
});

describe('isWriteTool — 边界', () => {
  it('工具找到且 mutates=true → true（写类）', () => {
    expect(isWriteTool('write_tool', tools)).toBe(true);
  });
  it('工具找到但 mutates=undefined → false（读类）', () => {
    expect(isWriteTool('read_tool', tools)).toBe(false);
  });
  it('工具找到且 mutates=false → false（读类）', () => {
    expect(isWriteTool('explicit_read', tools)).toBe(false);
  });
  it('工具未找到 → true（保守视为写类）', () => {
    expect(isWriteTool('not_registered', tools)).toBe(true);
  });
  it('空 tools 数组 + 任意工具名 → true（保守）', () => {
    expect(isWriteTool('any_tool', [])).toBe(true);
  });
});
