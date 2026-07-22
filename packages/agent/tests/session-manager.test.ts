import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SessionManager,
  computeMetaUpdate,
} from '../modules/memory/session/session-manger.ts';
import { SessionStore } from '../modules/memory/session/session-store.ts';
import { SessionRecovery } from '../modules/memory/session/session-recovery.ts';
import { SessionCleaner } from '../modules/memory/session/session-cleaner.ts';
import type { ChatMessage } from '../ui-pattern.ts';
import type { SessionMeta } from '@wuzi/types';

function mkMsg(role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { role, content, ...extra };
}

describe('computeMetaUpdate (pure function)', () => {
  const ts = 1_000_000;

  it('should initialize a fresh meta when old is null', () => {
    const userMsg = mkMsg('user', 'hello world');
    const meta = computeMetaUpdate(null, 's1', userMsg, ts);
    expect(meta.id).toBe('s1');
    expect(meta.title).toBe('hello world');
    expect(meta.summary).toBe('');
    expect(meta.messageCount).toBe(1);
    expect(meta.createdAt).toBe(ts);
    expect(meta.lastActiveAt).toBe(ts);
  });

  it('should set title to first user content (trimmed) when old title is default', () => {
    const userMsg = mkMsg('user', '  请帮我做 X  ');
    const meta = computeMetaUpdate(null, 's1', userMsg, ts);
    expect(meta.title).toBe('请帮我做 X');
  });

  it('should truncate title to 50 chars', () => {
    const longContent = 'a'.repeat(120);
    const userMsg = mkMsg('user', longContent);
    const meta = computeMetaUpdate(null, 's1', userMsg, ts);
    expect(meta.title.length).toBe(50);
    expect(meta.title).toBe('a'.repeat(50));
  });

  it('should not overwrite title if old title is not default', () => {
    const old: SessionMeta = {
      id: 's1',
      title: '已有标题',
      summary: '',
      messageCount: 1,
      createdAt: ts,
      lastActiveAt: ts,
    };
    const userMsg = mkMsg('user', '另一条用户消息');
    const meta = computeMetaUpdate(old, 's1', userMsg, ts + 1000);
    expect(meta.title).toBe('已有标题');
  });

  it('should set summary to assistant content (trimmed)', () => {
    const assistantMsg = mkMsg('assistant', '  这是回答  ');
    const meta = computeMetaUpdate(null, 's1', assistantMsg, ts);
    expect(meta.summary).toBe('这是回答');
  });

  it('should truncate summary to 200 chars', () => {
    const longContent = 'b'.repeat(300);
    const assistantMsg = mkMsg('assistant', longContent);
    const meta = computeMetaUpdate(null, 's1', assistantMsg, ts);
    expect(meta.summary.length).toBe(200);
    expect(meta.summary).toBe('b'.repeat(200));
  });

  it('should always increment messageCount regardless of role', () => {
    const old: SessionMeta = {
      id: 's1',
      title: 'T',
      summary: '',
      messageCount: 5,
      createdAt: ts,
      lastActiveAt: ts,
    };
    expect(computeMetaUpdate(old, 's1', mkMsg('user', 'x'), ts + 1).messageCount).toBe(6);
    expect(computeMetaUpdate(old, 's1', mkMsg('assistant', 'y'), ts + 1).messageCount).toBe(6);
    expect(computeMetaUpdate(old, 's1', mkMsg('tool', 'z'), ts + 1).messageCount).toBe(6);
    expect(computeMetaUpdate(old, 's1', mkMsg('system', 'w'), ts + 1).messageCount).toBe(6);
  });

  it('should preserve createdAt from old meta', () => {
    const old: SessionMeta = {
      id: 's1',
      title: 'T',
      summary: '',
      messageCount: 3,
      createdAt: ts,
      lastActiveAt: ts + 5000,
    };
    const meta = computeMetaUpdate(old, 's1', mkMsg('user', 'x'), ts + 10000);
    expect(meta.createdAt).toBe(ts);
    expect(meta.lastActiveAt).toBe(ts + 10000);
  });

  it('should not set title when user content is empty/whitespace (keep default title)', () => {
    const meta = computeMetaUpdate(null, 's1', mkMsg('user', '   '), ts);
    expect(meta.title).toBe('新会话');
  });

  it('should not update summary when assistant content is empty (keep old summary)', () => {
    const old: SessionMeta = {
      id: 's1',
      title: 'T',
      summary: '旧摘要',
      messageCount: 1,
      createdAt: ts,
      lastActiveAt: ts,
    };
    const meta = computeMetaUpdate(old, 's1', mkMsg('assistant', '   '), ts + 1000);
    expect(meta.summary).toBe('旧摘要');
  });
});

describe('SessionManager', () => {
  let baseDir: string;
  let store: SessionStore;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'wuzi-mgr-'));
    store = new SessionStore({ baseDir });
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  describe('C6.1 — four public methods exist', () => {
    it('should expose startSession / appendMessage / loadSession / cleanupExpired', () => {
      const sm = new SessionManager({ store });
      expect(typeof sm.startSession).toBe('function');
      expect(typeof sm.appendMessage).toBe('function');
      expect(typeof sm.loadSession).toBe('function');
      expect(typeof sm.cleanupExpired).toBe('function');
    });
  });

  describe('C6.2 — startSession', () => {
    it('should generate {pid}-{ts} form ID and write empty meta', async () => {
      const fixedTs = 5_000_000;
      const sm = new SessionManager({
        store,
        now: () => fixedTs,
        generateId: () => `12345-${fixedTs}`,
      });
      const id = await sm.startSession();
      expect(id).toBe(`12345-${fixedTs}`);

      const meta = await store.readMeta(id);
      expect(meta).not.toBeNull();
      expect(meta!.id).toBe(id);
      expect(meta!.title).toBe('新会话');
      expect(meta!.summary).toBe('');
      expect(meta!.messageCount).toBe(0);
      expect(meta!.createdAt).toBe(fixedTs);
      expect(meta!.lastActiveAt).toBe(fixedTs);
    });

    it('should use default generateId {pid}-{ts} when not injected', async () => {
      const sm = new SessionManager({ store, now: () => 12345 });
      const id = await sm.startSession();
      // 默认 ID 形式 {pid}-{ts}，至少应包含一个连字符且为字符串
      expect(typeof id).toBe('string');
      expect(id.includes('-')).toBe(true);
      // 形如 {number}-{number}
      expect(/^\d+-\d+$/.test(id)).toBe(true);
    });

    it('should still return id even if writeMeta throws (warn not block)', async () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      // 用 Object.create 继承 store 的原型方法，仅覆盖 writeMeta
      const badStore = Object.create(store) as SessionStore;
      badStore.writeMeta = async () => {
        throw new Error('disk full');
      };
      const sm = new SessionManager({
        store: badStore,
        generateId: () => 'fixed-id',
        now: () => 100,
      });
      const id = await sm.startSession();
      expect(id).toBe('fixed-id');
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('C6.3 — appendMessage updates meta', () => {
    it('should append message to JSONL and update meta (title from first user, summary from last assistant)', async () => {
      const t0 = 1_000_000;
      const sm = new SessionManager({
        store,
        now: () => t0,
        generateId: () => 's1',
      });
      const id = await sm.startSession();

      // 第一条 user：title 应更新为内容前 50 字符
      await sm.appendMessage(id, mkMsg('user', '请帮我实现 memory 系统'));
      let meta = await store.readMeta(id);
      expect(meta!.title).toBe('请帮我实现 memory 系统');
      expect(meta!.summary).toBe('');
      expect(meta!.messageCount).toBe(1);
      expect(meta!.lastActiveAt).toBe(t0);

      // 第二条 assistant：summary 应更新为内容前 200 字符
      await sm.appendMessage(id, mkMsg('assistant', '好的，我来实现 memory 系统'));
      meta = await store.readMeta(id);
      expect(meta!.title).toBe('请帮我实现 memory 系统');
      expect(meta!.summary).toBe('好的，我来实现 memory 系统');
      expect(meta!.messageCount).toBe(2);

      // 第三条 tool：messageCount++ 但 title/summary 不变
      await sm.appendMessage(id, mkMsg('tool', 'tool result', { tool_call_id: 't1' }));
      meta = await store.readMeta(id);
      expect(meta!.title).toBe('请帮我实现 memory 系统');
      expect(meta!.summary).toBe('好的，我来实现 memory 系统');
      expect(meta!.messageCount).toBe(3);

      // 验证 JSONL 文件已追加 3 行
      const read = await store.readMessages(id);
      expect(read.messages.length).toBe(3);
      expect(read.badLineCount).toBe(0);
    });

    it('should truncate title to 50 chars when user content is longer', async () => {
      const sm = new SessionManager({ store, generateId: () => 's1', now: () => 100 });
      const id = await sm.startSession();
      const longContent = 'a'.repeat(120);
      await sm.appendMessage(id, mkMsg('user', longContent));
      const meta = await store.readMeta(id);
      expect(meta!.title.length).toBe(50);
      expect(meta!.title).toBe('a'.repeat(50));
    });

    it('should truncate summary to 200 chars when assistant content is longer', async () => {
      const sm = new SessionManager({ store, generateId: () => 's1', now: () => 100 });
      const id = await sm.startSession();
      const longContent = 'b'.repeat(300);
      await sm.appendMessage(id, mkMsg('user', 'q'));
      await sm.appendMessage(id, mkMsg('assistant', longContent));
      const meta = await store.readMeta(id);
      expect(meta!.summary.length).toBe(200);
      expect(meta!.summary).toBe('b'.repeat(200));
    });

    it('should not overwrite title once set (subsequent user messages do not change title)', async () => {
      const sm = new SessionManager({ store, generateId: () => 's1', now: () => 100 });
      const id = await sm.startSession();
      await sm.appendMessage(id, mkMsg('user', 'first user'));
      await sm.appendMessage(id, mkMsg('assistant', 'reply'));
      await sm.appendMessage(id, mkMsg('user', 'second user should not change title'));
      const meta = await store.readMeta(id);
      expect(meta!.title).toBe('first user');
      expect(meta!.summary).toBe('reply');
      expect(meta!.messageCount).toBe(3);
    });

    it('should update lastActiveAt with current now() on each append', async () => {
      let current = 1000;
      const sm = new SessionManager({
        store,
        generateId: () => 's1',
        now: () => current,
      });
      const id = await sm.startSession();
      expect((await store.readMeta(id))!.lastActiveAt).toBe(1000);

      current = 2000;
      await sm.appendMessage(id, mkMsg('user', 'hi'));
      expect((await store.readMeta(id))!.lastActiveAt).toBe(2000);

      current = 3000;
      await sm.appendMessage(id, mkMsg('assistant', 'hello'));
      expect((await store.readMeta(id))!.lastActiveAt).toBe(3000);
    });

    it('should warn and skip meta update when store.appendMessage throws', async () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      // 用 Object.create 继承 store 的原型方法，仅覆盖 appendMessage
      const badStore = Object.create(store) as SessionStore;
      badStore.appendMessage = async () => {
        throw new Error('append fail');
      };
      const sm = new SessionManager({ store: badStore, generateId: () => 's1', now: () => 100 });
      const id = await sm.startSession();
      // 启动会话成功写空 meta
      const emptyMeta = await store.readMeta(id);
      expect(emptyMeta).not.toBeNull();
      expect(emptyMeta!.messageCount).toBe(0);

      // appendMessage 失败 → 不抛、warn、meta 不变
      await sm.appendMessage(id, mkMsg('user', 'hi'));
      expect(warnSpy).toHaveBeenCalled();
      const meta = await store.readMeta(id);
      expect(meta!.messageCount).toBe(0);
      warnSpy.mockRestore();
    });

    it('should warn and continue when readMeta/writeMeta fails during meta update', async () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      let writeCallCount = 0;
      // 用 Object.create 继承 store 的原型方法，仅覆盖 writeMeta
      const flakyStore = Object.create(store) as SessionStore;
      const realWriteMeta = store.writeMeta.bind(store);
      flakyStore.writeMeta = async (sid: string, meta: SessionMeta) => {
        writeCallCount++;
        // 第二次 writeMeta（appendMessage 之后的更新）失败
        if (writeCallCount === 2) throw new Error('flaky writeMeta');
        return realWriteMeta(sid, meta);
      };
      const sm = new SessionManager({ store: flakyStore, generateId: () => 's1', now: () => 100 });
      const id = await sm.startSession();
      // appendMessage 消息写成功，但 meta 更新失败 → 不抛
      await sm.appendMessage(id, mkMsg('user', 'hi'));
      expect(warnSpy).toHaveBeenCalled();
      // 消息应已写入 jsonl（用未覆盖的 store 直接读）
      const read = await store.readMessages(id);
      expect(read.messages.length).toBe(1);
      warnSpy.mockRestore();
    });
  });

  describe('C6.4 — loadSession', () => {
    it('should read messages and call recovery.recover, returning merged result', async () => {
      const fixedTs = 2_000_000;
      const recovery = new SessionRecovery();
      const sm = new SessionManager({
        store,
        recovery,
        generateId: () => 's1',
        now: () => fixedTs,
      });
      const id = await sm.startSession();
      await sm.appendMessage(id, mkMsg('user', 'hi'));
      await sm.appendMessage(id, mkMsg('assistant', 'hello'));

      const result = await sm.loadSession(id);
      expect(result.messages.length).toBe(2);
      expect(result.messages[0]!.role).toBe('user');
      expect(result.messages[1]!.role).toBe('assistant');
      expect(result.badLineCount).toBe(0);
      expect(result.meta).not.toBeNull();
      expect(result.meta!.id).toBe(id);
      expect(result.meta!.messageCount).toBe(2);
    });

    it('should return timeGapReminder when last active long ago', async () => {
      const oldTs = 1_000_000;
      const newTs = oldTs + 3 * 3600_000; // 3 小时后
      const recovery = new SessionRecovery();
      let now = oldTs;
      const sm = new SessionManager({
        store,
        recovery,
        generateId: () => 's1',
        now: () => now,
      });
      const id = await sm.startSession();
      await sm.appendMessage(id, mkMsg('user', 'hi'));
      await sm.appendMessage(id, mkMsg('assistant', 'hello'));

      now = newTs;
      const result = await sm.loadSession(id);
      expect(result.timeGapReminder).toBeTruthy();
      expect(typeof result.timeGapReminder).toBe('string');
      expect(result.timeGapReminder!.includes('会话恢复提醒')).toBe(true);
    });

    it('should work without recovery injected (returns messages as-is)', async () => {
      const sm = new SessionManager({ store, generateId: () => 's1', now: () => 100 });
      const id = await sm.startSession();
      await sm.appendMessage(id, mkMsg('user', 'hi'));
      await sm.appendMessage(id, mkMsg('assistant', 'hello'));
      const result = await sm.loadSession(id);
      expect(result.messages.length).toBe(2);
      expect(result.timeGapReminder).toBeUndefined();
      // 无 recovery 时 warnings 仅可能含 badLineCount 提示（无坏行则空）
      expect(Array.isArray(result.warnings)).toBe(true);
    });

    it('should report badLineCount when JSONL contains broken lines', async () => {
      const sm = new SessionManager({ store, generateId: () => 's1', now: () => 100 });
      const id = await sm.startSession();
      await sm.appendMessage(id, mkMsg('user', 'hi'));
      await sm.appendMessage(id, mkMsg('assistant', 'hello'));

      // 故意写入坏行到 .jsonl 末尾
      const jsonlPath = (store as unknown as { jsonlPath: (id: string) => string }).jsonlPath(id);
      await writeFile(jsonlPath, 'THIS IS NOT JSON\n', { flag: 'a' });

      const result = await sm.loadSession(id);
      expect(result.badLineCount).toBe(1);
      expect(result.messages.length).toBe(2); // 坏行跳过
      expect(result.warnings.some((w) => w.includes('坏行'))).toBe(true);
    });

    it('should normalize IO exceptions to warn (not throw) when readMessages fails', async () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      // 用 Object.create 继承 store 的原型方法，仅覆盖 readMessages
      const badStore = Object.create(store) as SessionStore;
      badStore.readMessages = async () => {
        throw new Error('read fail');
      };
      const sm = new SessionManager({
        store: badStore,
        recovery: new SessionRecovery(),
        generateId: () => 's1',
        now: () => 100,
      });
      const result = await sm.loadSession('s1');
      expect(result.messages).toEqual([]);
      expect(result.badLineCount).toBe(0);
      expect(result.meta).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('should normalize recovery exceptions to warn (not throw)', async () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      const badRecovery = {
        recover: async () => {
          throw new Error('recovery fail');
        },
      } as unknown as SessionRecovery;
      const sm = new SessionManager({
        store,
        recovery: badRecovery,
        generateId: () => 's1',
        now: () => 100,
      });
      const id = await sm.startSession();
      await sm.appendMessage(id, mkMsg('user', 'hi'));
      const result = await sm.loadSession(id);
      // 异常归一化：返回原消息
      expect(result.messages.length).toBe(1);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('should include meta in result when loadSession succeeds', async () => {
      const sm = new SessionManager({
        store,
        recovery: new SessionRecovery(),
        generateId: () => 's1',
        now: () => 100,
      });
      const id = await sm.startSession();
      await sm.appendMessage(id, mkMsg('user', 'hello world'));
      const result = await sm.loadSession(id);
      expect(result.meta).not.toBeNull();
      expect(result.meta!.title).toBe('hello world');
      expect(result.meta!.messageCount).toBe(1);
    });
  });

  describe('cleanupExpired — delegation', () => {
    it('should throw when cleaner not injected', async () => {
      const sm = new SessionManager({ store });
      expect(sm.cleanupExpired()).rejects.toThrow('SessionCleaner 未注入');
    });

    it('should delegate to cleaner.cleanExpired(now)', async () => {
      const fixedNow = 100_000_000;
      const cleaner = new SessionCleaner({ store, maxAgeDays: 30 });

      // 写两个会话：一个 31 天前活跃（过期）、一个 1 天前活跃（保留）
      const oldTs = fixedNow - 31 * 86400000;
      const recentTs = fixedNow - 1 * 86400000;
      await store.writeMeta('old-session', {
        id: 'old-session',
        title: 'old',
        summary: '',
        messageCount: 1,
        createdAt: oldTs,
        lastActiveAt: oldTs,
      });
      await store.writeMeta('recent-session', {
        id: 'recent-session',
        title: 'recent',
        summary: '',
        messageCount: 1,
        createdAt: recentTs,
        lastActiveAt: recentTs,
      });
      await store.appendMessage('old-session', mkMsg('user', 'old'));
      await store.appendMessage('recent-session', mkMsg('user', 'recent'));

      const sm = new SessionManager({
        store,
        cleaner,
        now: () => fixedNow,
      });
      const result = await sm.cleanupExpired();
      expect(result.deletedCount).toBe(1);
      expect(result.skippedCount).toBe(1);

      // old-session 应已被删除
      const oldRead = await store.readMessages('old-session');
      expect(oldRead.messages.length).toBe(0);
      // recent-session 应保留
      const recentRead = await store.readMessages('recent-session');
      expect(recentRead.messages.length).toBe(1);
    });
  });

  describe('integration — full session lifecycle', () => {
    it('should start → append multiple → load → recover', async () => {
      let now = 1_000_000;
      const sm = new SessionManager({
        store,
        recovery: new SessionRecovery(),
        cleaner: new SessionCleaner({ store, maxAgeDays: 30 }),
        now: () => now,
        generateId: () => 'lifecycle-1',
      });

      // start
      const id = await sm.startSession();
      expect(id).toBe('lifecycle-1');

      // append 5 messages: user → assistant → tool → user → assistant
      now += 1000;
      await sm.appendMessage(id, mkMsg('user', '第一问'));
      now += 1000;
      await sm.appendMessage(id, mkMsg('assistant', '第一答'));
      now += 1000;
      await sm.appendMessage(id, mkMsg('tool', 'r1', { tool_call_id: 'tc1' }));
      now += 1000;
      await sm.appendMessage(id, mkMsg('user', '第二问'));
      now += 1000;
      await sm.appendMessage(id, mkMsg('assistant', '第二答'));

      // meta 状态
      const meta = await store.readMeta(id);
      expect(meta!.messageCount).toBe(5);
      expect(meta!.title).toBe('第一问');
      expect(meta!.summary).toBe('第二答');
      expect(meta!.lastActiveAt).toBe(now);

      // load
      const result = await sm.loadSession(id);
      expect(result.messages.length).toBe(5);
      expect(result.badLineCount).toBe(0);
      expect(result.meta!.messageCount).toBe(5);
      expect(result.timeGapReminder).toBeUndefined(); // 同会话内连续 append 后立即 load，无时间跨度

      // cleanup（无过期）
      const cleanResult = await sm.cleanupExpired();
      expect(cleanResult.deletedCount).toBe(0);
      expect(cleanResult.skippedCount).toBe(1);
    });
  });
});
