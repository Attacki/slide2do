/**
 * ToolRegistry 单元测试
 */
import { test, expect } from 'bun:test';
import type { Tool } from '@wuzi/types';
import { ToolRegistry } from '../modules/tools/tool-registry.ts';

function makeTool(name: string): Tool {
  return {
    name,
    description: `desc of ${name}`,
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      return { ok: true, content: 'ok' };
    },
  };
}

test('register / get / has / list', () => {
  const reg = new ToolRegistry();
  const t = makeTool('foo');
  reg.register(t);
  expect(reg.has('foo')).toBe(true);
  expect(reg.get('foo')).toBe(t);
  expect(reg.list()).toEqual([t]);
});

test('重复注册同名工具抛错', () => {
  const reg = new ToolRegistry();
  reg.register(makeTool('foo'));
  expect(() => reg.register(makeTool('foo'))).toThrow();
});

test('unregister 移除工具', () => {
  const reg = new ToolRegistry();
  reg.register(makeTool('foo'));
  expect(reg.unregister('foo')).toBe(true);
  expect(reg.has('foo')).toBe(false);
});

test('toDefinitions 输出中立格式（不含 execute）', () => {
  const reg = new ToolRegistry();
  reg.register(makeTool('bar'));
  const defs = reg.toDefinitions();
  expect(defs).toEqual([
    { name: 'bar', description: 'desc of bar', parameters: { type: 'object', properties: {}, required: [] } },
  ]);
  expect('execute' in defs[0]!).toBe(false);
});
