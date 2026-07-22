/**
 * ToolCallAccumulator + parseToolArguments 单元测试
 *
 * 覆盖「JSON 参数碎片拼接」这一核心能力。
 */
import { test, expect } from 'bun:test';
import { ToolCallAccumulator, parseToolArguments } from '../modules/tools/tool-call-accumulator.ts';

test('按 index 合并 id / name / JSON 碎片', () => {
  const acc = new ToolCallAccumulator();
  acc.push(0, { id: 'c1', name: 'read_file' });
  acc.push(0, { json: '{"path":' });
  acc.push(0, { json: '"x.txt"}' });
  const list = acc.list();
  expect(list).toHaveLength(1);
  expect(list[0]).toEqual({ id: 'c1', name: 'read_file', arguments: '{"path":"x.txt"}' });
});

test('多工具调用按 index 升序输出', () => {
  const acc = new ToolCallAccumulator();
  acc.push(1, { id: 'c2', name: 'b' });
  acc.push(0, { id: 'c1', name: 'a' });
  expect(acc.list().map((r) => r.name)).toEqual(['a', 'b']);
});

test('parseToolArguments 解析合法 JSON', () => {
  const parsed = parseToolArguments({ id: 'c1', name: 'read_file', arguments: '{"path":"x"}' });
  expect(parsed).toEqual({ id: 'c1', name: 'read_file', arguments: { path: 'x' } });
});

test('parseToolArguments 空参数视为 {}', () => {
  const parsed = parseToolArguments({ id: 'c1', name: 't', arguments: '' });
  expect(parsed.arguments).toEqual({});
});

test('parseToolArguments 非法 JSON 抛清晰错误', () => {
  expect(() => parseToolArguments({ id: 'c1', name: 't', arguments: '{bad' })).toThrow(
    /不是合法 JSON/,
  );
});
