import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../modules/memory/session/session-store.ts';
import { SessionCleaner, isExpired } from '../modules/memory/session/session-cleaner.ts';
import type { SessionMeta } from '@wuzi/types';

const DAY = 86400000;

function mkMeta(id: string, lastActiveAt: number, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: 'T',
    summary: '',
    messageCount: 1,
    createdAt: lastActiveAt,
    lastActiveAt,
    ...extra,
  };
}

describe('isExpired', () => {
  it('should return true when lastActiveAt exceeds maxAgeDays', () => {
    const now = 31 * DAY;
    const meta = mkMeta('s1', 0);
    expect(isExpired(meta, now, 30)).toBe(true);
  });

  it('should return false when lastActiveAt within maxAgeDays', () => {
    const now = 29 * DAY;
    const meta = mkMeta('s1', 0);
    expect(isExpired(meta, now, 30)).toBe(false);
  });

  it('should return false at exactly the boundary (now - lastActiveAt == maxAgeDays)', () => {
    const now = 30 * DAY;
    const meta = mkMeta('s1', 0);
    // 用 > 严格判定，等于阈值不触发
    expect(isExpired(meta, now, 30)).toBe(false);
  });

  it('should return true when now - lastActiveAt == maxAgeDays + 1ms', () => {
    const now = 30 * DAY + 1;
    const meta = mkMeta('s1', 0);
    expect(isExpired(meta, now, 30)).toBe(true);
  });

  it('should return false for non-finite lastActiveAt', () => {
    expect(isExpired(mkMeta('s1', NaN), 1000, 30)).toBe(false);
    expect(isExpired(mkMeta('s1', Infinity), 1000, 30)).toBe(false);
  });

  it('should return false for non-finite now', () => {
    expect(isExpired(mkMeta('s1', 0), NaN, 30)).toBe(false);
  });

  it('should return false for negative maxAgeDays', () => {
    expect(isExpired(mkMeta('s1', 0), 1000, -1)).toBe(false);
  });

  it('should default maxAgeDays to 30', () => {
    const now = 31 * DAY;
    expect(isExpired(mkMeta('s1', 0), now)).toBe(true);
    expect(isExpired(mkMeta('s1', 0), 29 * DAY)).toBe(false);
  });
});

describe('SessionCleaner', () => {
  let baseDir: string;
  let store: SessionStore;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'wuzi-clean-'));
    store = new SessionStore({ baseDir });
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('should return empty result when no sessions exist', async () => {
    const cleaner = new SessionCleaner({ store, maxAgeDays: 30 });
    const r = await cleaner.cleanExpired(1000);
    expect(r.deletedCount).toBe(0);
    expect(r.skippedCount).toBe(0);
    expect(r.warnings).toEqual([]);
  });

  it('should delete only expired sessions and keep recent', async () => {
    const now = 100 * DAY;
    // 31 天前 - 过期
    await store.writeMeta('old1', mkMeta('old1', now - 31 * DAY));
    await store.appendMessage('old1', { role: 'user', content: 'old1' });
    // 1 天前 - 未过期
    await store.writeMeta('recent1', mkMeta('recent1', now - 1 * DAY));
    await store.appendMessage('recent1', { role: 'user', content: 'recent1' });

    const cleaner = new SessionCleaner({ store, maxAgeDays: 30 });
    const r = await cleaner.cleanExpired(now);

    expect(r.deletedCount).toBe(1);
    expect(r.skippedCount).toBe(1);
    expect(r.warnings).toEqual([]);

    // old1 应被删除（meta 与 jsonl 都没了）
    expect(await store.readMeta('old1')).toBeNull();
    expect((await store.readMessages('old1')).messages).toEqual([]);
    // recent1 应保留
    expect((await store.readMeta('recent1'))!.id).toBe('recent1');
    expect((await store.readMessages('recent1')).messages.length).toBe(1);
  });

  it('should delete multiple expired sessions', async () => {
    const now = 100 * DAY;
    await store.writeMeta('old1', mkMeta('old1', now - 31 * DAY));
    await store.writeMeta('old2', mkMeta('old2', now - 60 * DAY));
    await store.writeMeta('recent', mkMeta('recent', now - 5 * DAY));

    const cleaner = new SessionCleaner({ store, maxAgeDays: 30 });
    const r = await cleaner.cleanExpired(now);

    expect(r.deletedCount).toBe(2);
    expect(r.skippedCount).toBe(1);
  });

  it('should not delete anything when all sessions are recent', async () => {
    const now = 100 * DAY;
    await store.writeMeta('r1', mkMeta('r1', now - 1 * DAY));
    await store.writeMeta('r2', mkMeta('r2', now - 5 * DAY));

    const cleaner = new SessionCleaner({ store, maxAgeDays: 30 });
    const r = await cleaner.cleanExpired(now);

    expect(r.deletedCount).toBe(0);
    expect(r.skippedCount).toBe(2);
  });

  it('should use default maxAgeDays=30 when not specified', async () => {
    const now = 100 * DAY;
    await store.writeMeta('boundary', mkMeta('boundary', now - 31 * DAY));

    const cleaner = new SessionCleaner({ store });
    const r = await cleaner.cleanExpired(now);
    expect(r.deletedCount).toBe(1);
  });

  it('should warn but continue when one delete fails', async () => {
    const now = 100 * DAY;
    await store.writeMeta('good-old', mkMeta('good-old', now - 31 * DAY));

    // 构造一个会失败的 store（deleteSession 抛错）
    const failingStore: SessionStore = {
      listMetas: store.listMetas.bind(store),
      deleteSession: async () => {
        throw new Error('permission denied');
      },
    } as unknown as SessionStore;

    const cleaner = new SessionCleaner({ store: failingStore, maxAgeDays: 30 });
    const r = await cleaner.cleanExpired(now);

    expect(r.deletedCount).toBe(0);
    expect(r.skippedCount).toBe(1);
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toContain('permission denied');
  });

  it('should warn and return empty when listMetas fails', async () => {
    const failingStore: SessionStore = {
      listMetas: async () => {
        throw new Error('disk error');
      },
    } as unknown as SessionStore;

    const cleaner = new SessionCleaner({ store: failingStore, maxAgeDays: 30 });
    const r = await cleaner.cleanExpired(1000);

    expect(r.deletedCount).toBe(0);
    expect(r.skippedCount).toBe(0);
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toContain('listMetas 失败');
  });

  it('should use Date.now() when now not provided', async () => {
    // 创建一个明显过期的会话（lastActiveAt 为 31 天前）
    const old = Date.now() - 31 * DAY;
    await store.writeMeta('old', mkMeta('old', old));

    const cleaner = new SessionCleaner({ store, maxAgeDays: 30 });
    const r = await cleaner.cleanExpired();
    expect(r.deletedCount).toBe(1);
  });
});
