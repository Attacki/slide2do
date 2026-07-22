/**
 * memory-system 端到端测试
 *
 * 覆盖 checklist §九 端到端验收 E2E-1 至 E2E-5：
 *  - E2E-1: AGENTS.md 注入 system_supplement（通过 Agent + InstructionLoader 验证）
 *  - E2E-2: @include 展开 + 路径逃逸拦截（直接测 InstructionLoader）
 *  - E2E-3: tool_use 未配 tool_result 时 SessionRecovery 截断
 *  - E2E-4: 过期会话清理（31 天前删除、1 天前保留）
 *  - E2E-5: SessionManager 写入 + 读回 + loadSession 恢复链路
 *
 * 全部离线，使用 tmpdir 隔离文件 IO，不依赖网络。
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../agent.ts';
import { InstructionLoader } from '../modules/memory/instructions/instruction-loader.ts';
import { SessionStore } from '../modules/memory/session/session-store.ts';
import { SessionRecovery } from '../modules/memory/session/session-recovery.ts';
import { SessionCleaner } from '../modules/memory/session/session-cleaner.ts';
import { SessionManager } from '../modules/memory/session/session-manger.ts';
import type { ILLMProvider, StreamCallback, StreamChatParams } from '../provider/base.ts';
import type { LLMConfig } from '../utils/config/config-types.ts';
import type { ChatMessage, StreamEvent } from '../ui-pattern.ts';
import type { SessionMeta } from '@wuzi/types';

const DAY = 86400000;

const fakeConfig = {
  protocol: 'mock',
  model: 'm',
  base_url: 'http://localhost',
  api_key: 'k',
} as unknown as LLMConfig;

/** 不调任何网络的 stub provider；E2E-1 用空输入触发 initPromise 不会触发 provider */
class StubProvider implements ILLMProvider {
  readonly protocol = 'mock';
  async streamChat(_params: StreamChatParams, onEvent: StreamCallback): Promise<void> {
    onEvent({ type: 'done' });
  }
}

/** 构造一条消息的辅助函数 */
function mkMsg(role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { role, content, ...extra };
}

/** 构造含 tool_calls 的 assistant 消息 */
function mkAssistantWithTools(
  content: string,
  toolCalls: Array<{ id: string; name: string; arguments: string }>,
): ChatMessage {
  return { role: 'assistant', content, tool_calls: toolCalls };
}

/** 构造 tool 结果消息 */
function mkToolResult(toolCallId: string, content: string): ChatMessage {
  return { role: 'tool', content, tool_call_id: toolCallId };
}

/** 收集事件流的辅助函数 */
function collectEvents(): { onEvent: (e: StreamEvent) => void; events: StreamEvent[] } {
  const events: StreamEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

// =====================================================================
// E2E-1: AGENTS.md 存在时 Agent.getMemory() 首条 system 之后存在 system_supplement
// =====================================================================
describe('E2E-1: AGENTS.md → system_supplement 注入', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'wuzi-e2e1-'));
    await writeFile(
      join(projectDir, 'AGENTS.md'),
      [
        '# 项目指令',
        '',
        '- 技术栈：TypeScript + Bun',
        '- 编码规范：ESM 模块',
        '- 注意事项：禁止 any',
      ].join('\n'),
      'utf-8',
    );
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('Agent 启动后应将 AGENTS.md 内容作为 system_supplement 注入 memory', async () => {
    const instructionLoader = new InstructionLoader({
      projectDir,
      // 指向不存在的用户级文件，跳过用户级（验证缺省跳过不报错）
      userLevelPath: join(projectDir, 'nonexistent-user-agents.md'),
    });

    const agent = new Agent({
      provider: new StubProvider(),
      config: fakeConfig,
      systemPrompt: '你是 wuzi-agent',
      instructionLoader,
      // 不注入 sessionManager，避免触发文件 IO
    });

    // 用空文本触发 processInput → 内部 await initPromise（加载 AGENTS.md）
    // 空输入会立即返回 'no_tool_call'，不调用 provider、不修改 memory
    const { onEvent } = collectEvents();
    const reason = await agent.processInput({ type: 'text', text: '' }, onEvent);
    expect(reason).toBe('no_tool_call');

    const memory = agent.getMemory();
    // 至少有：[0]=system(systemPrompt)，[1]=system_supplement(AGENTS.md)
    expect(memory.length).toBeGreaterThanOrEqual(2);
    expect(memory[0]!.role).toBe('system');
    expect(memory[0]!.content).toBe('你是 wuzi-agent');

    // 找到 system_supplement 消息
    const supplement = memory.find(
      (m) => m.role === 'system' && m.kind === 'system_supplement',
    );
    expect(supplement).toBeDefined();
    expect(supplement!.content).toContain('项目指令');
    expect(supplement!.content).toContain('TypeScript + Bun');
    expect(supplement!.content).toContain('禁止 any');
  });

  it('未注入 instructionLoader 时不应注入 system_supplement', async () => {
    const agent = new Agent({
      provider: new StubProvider(),
      config: fakeConfig,
      systemPrompt: '你是 wuzi-agent',
    });

    const { onEvent } = collectEvents();
    await agent.processInput({ type: 'text', text: '' }, onEvent);

    const memory = agent.getMemory();
    expect(memory.length).toBe(1);
    expect(memory[0]!.role).toBe('system');
    expect(memory[0]!.kind).toBeUndefined();
    const hasSupplement = memory.some((m) => m.kind === 'system_supplement');
    expect(hasSupplement).toBe(false);
  });
});

// =====================================================================
// E2E-2: @include 展开与路径逃逸拦截
// =====================================================================
describe('E2E-2: @include 展开 + 路径逃逸拦截', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'wuzi-e2e2-'));
    await mkdir(join(projectDir, 'docs'), { recursive: true });
    await writeFile(
      join(projectDir, 'docs', 'NOTE.md'),
      ['# NOTE', '', '这是被 @include 引用的笔记内容'].join('\n'),
      'utf-8',
    );
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('合法 @include 应被展开为被引用文件内容', async () => {
    const agentsContent = [
      '# 项目指令',
      '',
      '@include ./docs/NOTE.md',
      '',
      '- 主指令结束',
    ].join('\n');
    await writeFile(join(projectDir, 'AGENTS.md'), agentsContent, 'utf-8');

    const loader = new InstructionLoader({
      projectDir,
      userLevelPath: join(projectDir, 'nonexistent.md'),
    });
    const result = await loader.load();

    expect(result.loaded).toBe(true);
    expect(result.content).toContain('项目指令');
    expect(result.content).toContain('NOTE');
    expect(result.content).toContain('被 @include 引用的笔记内容');
    expect(result.content).toContain('主指令结束');
    // 不应再出现原 @include 指令文本（已被替换为内容）
    expect(result.content).not.toMatch(/^@include\s+\.\.\/docs\/NOTE\.md$/m);
  });

  it('路径逃逸的 @include 应保留原文本 + 警告注释（含「逃逸」字样）', async () => {
    const agentsContent = [
      '# 项目指令',
      '',
      '@include ../../../etc/passwd',
      '',
      '- 主指令结束',
    ].join('\n');
    await writeFile(join(projectDir, 'AGENTS.md'), agentsContent, 'utf-8');

    const loader = new InstructionLoader({
      projectDir,
      userLevelPath: join(projectDir, 'nonexistent.md'),
    });
    const result = await loader.load();

    expect(result.loaded).toBe(true);
    // 原指令文本保留
    expect(result.content).toContain('@include ../../../etc/passwd');
    // 警告注释存在（含「逃逸」或「escape」字样）
    expect(result.content).toMatch(/逃逸|escape/);
    // 主指令内容仍存在
    expect(result.content).toContain('主指令结束');
  });
});

// =====================================================================
// E2E-3: tool_use 未配 tool_result 时 SessionRecovery.recover 截断
// =====================================================================
describe('E2E-3: SessionRecovery 截断未配对 tool_use', () => {
  it('末尾 assistant 含 tool_calls 但无 tool_result 时截断到该 assistant 之前', async () => {
    const messages: ChatMessage[] = [
      mkMsg('user', '请帮我读取文件'),
      mkAssistantWithTools('正在调用 read 工具', [
        { id: 'call_1', name: 'read', arguments: '{"path":"./a.ts"}' },
      ]),
      // 缺对应的 tool_result(call_1)
    ];

    const recovery = new SessionRecovery({}); // 不注入 contextCompactor，跳过压缩
    const result = await recovery.recover(messages);

    expect(result.messages.length).toBe(1);
    expect(result.messages[0]!.role).toBe('user');
    // warnings 含截断说明
    const truncationWarning = result.warnings.find((w) => w.includes('截断'));
    expect(truncationWarning).toBeDefined();
    expect(truncationWarning).toContain('1');
  });

  it('末尾消息完整时不应截断', async () => {
    const messages: ChatMessage[] = [
      mkMsg('user', '请帮我读取文件'),
      mkAssistantWithTools('调用中', [
        { id: 'call_1', name: 'read', arguments: '{}' },
      ]),
      mkToolResult('call_1', '文件内容'),
      mkMsg('assistant', '读取完成'),
    ];

    const recovery = new SessionRecovery({});
    const result = await recovery.recover(messages);

    expect(result.messages.length).toBe(4);
    expect(result.warnings.some((w) => w.includes('截断'))).toBe(false);
  });
});

// =====================================================================
// E2E-4: 过期会话清理（31 天前删除、1 天前保留）
// =====================================================================
describe('E2E-4: SessionCleaner 清理过期会话', () => {
  let baseDir: string;
  let store: SessionStore;
  const now = 100 * DAY; // 固定 now 避免时间漂移

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'wuzi-e2e4-'));
    store = new SessionStore({ baseDir });
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('31 天前的会话被删除、1 天前的保留，返回删除数 = 1', async () => {
    // 会话 A：31 天前活跃（已过期）
    const oldId = 'session-old';
    const oldMeta: SessionMeta = {
      id: oldId,
      title: '旧会话',
      summary: '',
      messageCount: 2,
      createdAt: now - 40 * DAY,
      lastActiveAt: now - 31 * DAY,
    };
    await store.writeMeta(oldId, oldMeta);
    await store.appendMessage(oldId, mkMsg('user', '旧消息'));

    // 会话 B：1 天前活跃（未过期）
    const recentId = 'session-recent';
    const recentMeta: SessionMeta = {
      id: recentId,
      title: '近期会话',
      summary: '',
      messageCount: 2,
      createdAt: now - 2 * DAY,
      lastActiveAt: now - 1 * DAY,
    };
    await store.writeMeta(recentId, recentMeta);
    await store.appendMessage(recentId, mkMsg('user', '近期消息'));

    const cleaner = new SessionCleaner({ store, maxAgeDays: 30 });
    const result = await cleaner.cleanExpired(now);

    expect(result.deletedCount).toBe(1);
    expect(result.skippedCount).toBe(1);

    // 旧会话 .jsonl 与 .meta.json 均被删除
    const oldJsonlExists = await fileExists(store.jsonlPath(oldId));
    const oldMetaExists = await fileExists(store.metaPath(oldId));
    expect(oldJsonlExists).toBe(false);
    expect(oldMetaExists).toBe(false);

    // 近期会话保留
    const recentJsonlExists = await fileExists(store.jsonlPath(recentId));
    const recentMetaExists = await fileExists(store.metaPath(recentId));
    expect(recentJsonlExists).toBe(true);
    expect(recentMetaExists).toBe(true);
  });
});

/** 判断文件是否存在（异步） */
async function fileExists(path: string): Promise<boolean> {
  try {
    const { stat } = await import('node:fs/promises');
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// =====================================================================
// E2E-5: SessionManager 完整链路（startSession + appendMessage + loadSession）
// =====================================================================
describe('E2E-5: SessionManager 完整写入读回链路', () => {
  let baseDir: string;
  let store: SessionStore;
  let manager: SessionManager;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'wuzi-e2e5-'));
    store = new SessionStore({ baseDir });
    const recovery = new SessionRecovery({});
    manager = new SessionManager({
      store,
      recovery,
      // 不注入 cleaner，本组用例不测清理
      now: () => 5_000_000, // 固定时间避免漂移
      generateId: () => 'fixed-id',
    });
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('startSession + 多次 appendMessage 后 loadSession 能拿回全部消息；meta messageCount 一致', async () => {
    const sessionId = await manager.startSession();
    expect(sessionId).toBe('fixed-id');

    // 写入完整对话：user → assistant(tool_calls) → tool_result → assistant(最终回复)
    await manager.appendMessage(sessionId, mkMsg('user', '请帮我读取 a.ts'));
    await manager.appendMessage(
      sessionId,
      mkAssistantWithTools('正在调用 read', [
        { id: 'call_1', name: 'read', arguments: '{}' },
      ]),
    );
    await manager.appendMessage(sessionId, mkToolResult('call_1', '文件内容'));
    await manager.appendMessage(sessionId, mkMsg('assistant', '读取完成，文件内容是 ...'));

    // 读回：loadSession 应能拿回全部 4 条消息（最后无未配对 tool_use，不应截断）
    const result = await manager.loadSession(sessionId);
    expect(result.messages.length).toBe(4);
    expect(result.messages[0]!.role).toBe('user');
    expect(result.messages[1]!.role).toBe('assistant');
    expect(result.messages[2]!.role).toBe('tool');
    expect(result.messages[3]!.role).toBe('assistant');

    // meta messageCount 与实际写入消息数一致
    expect(result.meta).not.toBeNull();
    expect(result.meta!.messageCount).toBe(4);
    expect(result.meta!.title).toBe('请帮我读取 a.ts');
    expect(result.meta!.summary).toBe('读取完成，文件内容是 ...');
  });

  it('末尾未配对 tool_use 时 loadSession 应截断且 messageCount 反映写入数（含被截断的）', async () => {
    const sessionId = await manager.startSession();

    // 写入：user → assistant(tool_calls 缺 result)
    await manager.appendMessage(sessionId, mkMsg('user', '调用工具但未完成'));
    await manager.appendMessage(
      sessionId,
      mkAssistantWithTools('调用中', [
        { id: 'call_x', name: 'read', arguments: '{}' },
      ]),
    );

    // 读回：截断掉 assistant，只剩 user
    const result = await manager.loadSession(sessionId);
    expect(result.messages.length).toBe(1);
    expect(result.messages[0]!.role).toBe('user');
    // warnings 含截断说明
    expect(result.warnings.some((w) => w.includes('截断'))).toBe(true);

    // meta messageCount 仍反映写入数（2 条），不会被截断逻辑回退
    expect(result.meta).not.toBeNull();
    expect(result.meta!.messageCount).toBe(2);
  });
});
