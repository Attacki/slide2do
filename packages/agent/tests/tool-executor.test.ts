/**
 * ToolExecutor 单元测试：未知工具、成功、异常、超时、结构化结果
 *
 * 任务10 追加：SecurityGate 集成场景（向后兼容、黑名单拒绝、allow 放行、sandbox 拒绝）
 */
import { test, expect } from 'bun:test';
import type { Tool, ToolResult } from '@wuzi/types';
import { ToolRegistry } from '../modules/tools/tool-registry.ts';
import { ToolExecutor } from '../modules/tools/tool-executor.ts';
import type { SecurityGate, SecurityDecision } from '../modules/security/security-gate.ts';

function tool(name: string, execute: Tool['execute'], timeoutMs?: number): Tool {
  return { name, description: 'd', parameters: {}, timeoutMs, execute };
}

const okResult: ToolResult = { ok: true, content: 'done' };
const okTool = tool('ok', async () => okResult);
const throwTool = tool('err', async () => {
  throw new Error('boom');
});
const badShapeTool = tool('bad', async () => 'not a result' as unknown as ToolResult);
const slowTool = tool(
  'slow',
  async () => new Promise<ToolResult>(() => {}),
  50,
);

test('未知工具返回结构化错误', async () => {
  const reg = new ToolRegistry();
  const ex = new ToolExecutor(reg, { cwd: '/' });
  const res = await ex.executeCall({ id: '1', name: 'ghost', arguments: {} });
  expect(res.ok).toBe(false);
  expect(res.error).toBe('unknown_tool');
});

test('成功工具返回结果', async () => {
  const reg = new ToolRegistry();
  reg.register(okTool);
  const ex = new ToolExecutor(reg, { cwd: '/' });
  const res = await ex.executeCall({ id: '1', name: 'ok', arguments: {} });
  expect(res.ok).toBe(true);
  expect(res.content).toBe('done');
});

test('工具抛异常被包成结构化失败', async () => {
  const reg = new ToolRegistry();
  reg.register(throwTool);
  const ex = new ToolExecutor(reg, { cwd: '/' });
  const res = await ex.executeCall({ id: '1', name: 'err', arguments: {} });
  expect(res.ok).toBe(false);
  expect(res.content).toContain('boom');
});

test('工具返回非法结构被归一化为失败', async () => {
  const reg = new ToolRegistry();
  reg.register(badShapeTool);
  const ex = new ToolExecutor(reg, { cwd: '/' });
  const res = await ex.executeCall({ id: '1', name: 'bad', arguments: {} });
  expect(res.ok).toBe(false);
  expect(res.error).toBe('invalid_result');
});

test('超时工具返回 timeout 结构化结果', async () => {
  const reg = new ToolRegistry();
  reg.register(slowTool);
  const ex = new ToolExecutor(reg, { cwd: '/' });
  const start = Date.now();
  const res = await ex.executeCall({ id: '1', name: 'slow', arguments: {} });
  const elapsed = Date.now() - start;
  expect(res.ok).toBe(false);
  expect(res.error).toBe('timeout');
  // 不应明显超过设定超时
  expect(elapsed).toBeLessThan(2000);
});

// ===== 任务10：SecurityGate 集成场景 =====

test('向后兼容 — 不传 securityGate 时保持原有行为', async () => {
  const reg = new ToolRegistry();
  reg.register(okTool);
  // 不传第 4 个参数 securityGate
  const ex = new ToolExecutor(reg, { cwd: '/' });
  const res = await ex.executeCall({ id: '1', name: 'ok', arguments: {} });
  expect(res.ok).toBe(true);
  expect(res.content).toBe('done');
});

test('黑名单拒绝 — exec_command rm -rf / 不执行底层工具', async () => {
  let execCalls = 0;
  const spyTool = tool('exec_command', async () => {
    execCalls++;
    return okResult;
  });
  const reg = new ToolRegistry();
  reg.register(spyTool);

  const denyDecision: SecurityDecision = {
    decision: 'deny',
    reason: 'blacklist(shell): 拒绝：根目录递归删除',
    layer: 'blacklist',
  };
  const gate = { check: async () => denyDecision } as unknown as SecurityGate;

  const ex = new ToolExecutor(reg, { cwd: '/' }, undefined, gate);
  const res = await ex.executeCall({
    id: '1',
    name: 'exec_command',
    arguments: { command: 'rm -rf /' },
  });

  expect(res.ok).toBe(false);
  expect(res.error).toBe('denied_by_security');
  expect(res.content).toContain('blacklist');
  expect(res.meta?.layer).toBe('blacklist');
  expect(res.meta?.reason).toBe(denyDecision.reason);
  // 关键：底层工具未被调用
  expect(execCalls).toBe(0);
});

test('allow 时正常派发到 tool.execute', async () => {
  let execCalls = 0;
  const spyTool = tool('exec_command', async () => {
    execCalls++;
    return okResult;
  });
  const reg = new ToolRegistry();
  reg.register(spyTool);

  const allowDecision: SecurityDecision = {
    decision: 'allow',
    reason: 'ok',
    layer: 'policy',
  };
  const gate = { check: async () => allowDecision } as unknown as SecurityGate;

  const ex = new ToolExecutor(reg, { cwd: '/' }, undefined, gate);
  const res = await ex.executeCall({
    id: '1',
    name: 'exec_command',
    arguments: { command: 'ls' },
  });

  expect(res.ok).toBe(true);
  expect(res.content).toBe('done');
  // 关键：底层工具被调用一次
  expect(execCalls).toBe(1);
});

test('sandbox 拒绝 — 路径越界返回 denied_by_security', async () => {
  let execCalls = 0;
  const spyTool = tool('write_file', async () => {
    execCalls++;
    return okResult;
  });
  const reg = new ToolRegistry();
  reg.register(spyTool);

  const denyDecision: SecurityDecision = {
    decision: 'deny',
    reason: '路径越界',
    layer: 'sandbox',
  };
  const gate = { check: async () => denyDecision } as unknown as SecurityGate;

  const ex = new ToolExecutor(reg, { cwd: '/' }, undefined, gate);
  const res = await ex.executeCall({
    id: '1',
    name: 'write_file',
    arguments: { path: '/etc/passwd', content: 'hacked' },
  });

  expect(res.ok).toBe(false);
  expect(res.error).toBe('denied_by_security');
  expect(res.meta?.layer).toBe('sandbox');
  // 关键：底层工具未被调用
  expect(execCalls).toBe(0);
});
