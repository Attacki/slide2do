/**
 * Agent 工具集成测试
 *
 * 用 FakeProvider 模拟「模型发起一次工具调用」，验证：
 *  - 工具被实际执行
 *  - 结构化结果回灌进对话历史（assistant.tool_calls + tool 消息）
 *  - UI 收到 tool_result 事件
 * （本步不自动循环回查模型）
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../agent.ts';
import { ToolRegistry } from '../modules/tools/tool-registry.ts';
import { readFileTool } from '../../agent-tools/read-file/index.ts';
import type { ILLMProvider, StreamCallback, StreamChatParams } from '../provider/base.ts';
import type { LLMConfig } from '../utils/config/config-types.ts';

class FakeProvider implements ILLMProvider {
  readonly protocol = 'fake';
  async streamChat(_params: StreamChatParams, onEvent: StreamCallback): Promise<void> {
    onEvent({ type: 'text_delta', delta: 'reading…' });
    onEvent({
      type: 'tool_call',
      id: 'call_1',
      name: 'read_file',
      arguments: JSON.stringify({ path: 'note.txt' }),
    });
    onEvent({ type: 'done' });
  }
}

const fakeConfig = {
  protocol: 'fake',
  model: 'm',
  base_url: 'http://localhost',
  api_key: 'k',
} as unknown as LLMConfig;

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wuzi-ba-'));
  await writeFile(join(dir, 'note.txt'), 'NOTE CONTENT', 'utf-8');
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('模型发起工具调用 -> 执行 -> 结果回灌记忆 + UI 事件', async () => {
  const reg = new ToolRegistry();
  reg.register(readFileTool);

  const agent = new Agent({
    provider: new FakeProvider(),
    config: fakeConfig,
    systemPrompt: 'sys',
    tools: reg,
    toolContext: { cwd: dir },
  });

  const events: unknown[] = [];
  await agent.processInput({ type: 'submit', text: 'read note' }, (e) => events.push(e));

  const mem = agent.getMemory();
  const assistant = mem.find((m) => m.role === 'assistant');
  const toolMsg = mem.find((m) => m.role === 'tool');

  // 记忆：assistant 携带工具调用
  expect(assistant?.tool_calls?.[0]?.name).toBe('read_file');
  // 记忆：工具结果以 tool 角色回灌，关联 tool_call_id
  expect(toolMsg?.tool_call_id).toBe('call_1');
  expect(toolMsg?.content).toContain('NOTE CONTENT');

  // UI 事件：tool_result
  const resultEvt = (events as Array<{ type: string }>).find((e) => e.type === 'tool_result');
  expect(resultEvt).toBeTruthy();
});
