import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SessionStore,
  serializeMessage,
  parseJsonlLine,
} from '../modules/memory/session/session-store.ts';
import type { ChatMessage } from '../ui-pattern.ts';
import type { SessionMeta } from '@wuzi/types';

function mkMsg(role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { role, content, ...extra };
}

describe('serializeMessage', () => {
  it('should serialize to single-line JSON string', () => {
    const msg = mkMsg('user', 'hello');
    const s = serializeMessage(msg);
    expect(s).toBe('{"role":"user","content":"hello"}');
    expect(s.includes('\n')).toBe(false);
  });

  it('should preserve all ChatMessage fields', () => {
    const msg: ChatMessage = {
      role: 'assistant',
      content: 'text',
      thinking: 'th',
      tool_calls: [{ id: 't1', name: 'read', arguments: '{}' }],
      tool_call_id: 't1',
      kind: 'user',
      compacted: true,
    };
    const s = serializeMessage(msg);
    const parsed = JSON.parse(s);
    expect(parsed.role).toBe('assistant');
    expect(parsed.content).toBe('text');
    expect(parsed.thinking).toBe('th');
    expect(parsed.tool_calls[0].id).toBe('t1');
    expect(parsed.tool_call_id).toBe('t1');
    expect(parsed.kind).toBe('user');
    expect(parsed.compacted).toBe(true);
  });
});

describe('parseJsonlLine', () => {
  it('should parse valid JSON line', () => {
    const r = parseJsonlLine('{"role":"user","content":"hi"}');
    expect(r.ok).toBe(true);
    expect(r.value!.role).toBe('user');
    expect(r.value!.content).toBe('hi');
  });

  it('should return ok=false for invalid JSON', () => {
    expect(parseJsonlLine('{bad json').ok).toBe(false);
    expect(parseJsonlLine('not json at all').ok).toBe(false);
    expect(parseJsonlLine('').ok).toBe(false);
    expect(parseJsonlLine('   ').ok).toBe(false);
  });

  it('should return ok=false for non-ChatMessage structure (missing role)', () => {
    expect(parseJsonlLine('{"content":"hi"}').ok).toBe(false);
    expect(parseJsonlLine('{"role":123,"content":"hi"}').ok).toBe(false);
    expect(parseJsonlLine('null').ok).toBe(false);
    expect(parseJsonlLine('42').ok).toBe(false);
    expect(parseJsonlLine('"string"').ok).toBe(false);
  });
});

describe('SessionStore', () => {
  let baseDir: string;
  let store: SessionStore;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'wuzi-store-'));
    store = new SessionStore({ baseDir });
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('should auto-create baseDir on first write', async () => {
    await store.appendMessage('s1', mkMsg('user', 'hi'));
    const raw = await readFile(join(baseDir, 's1.jsonl'), 'utf-8');
    expect(raw).toBe('{"role":"user","content":"hi"}\n');
  });

  it('appendMessage should append one line per message', async () => {
    await store.appendMessage('s1', mkMsg('user', 'first'));
    await store.appendMessage('s1', mkMsg('assistant', 'second'));
    await store.appendMessage('s1', mkMsg('tool', 'third', { tool_call_id: 't1' }));
    const raw = await readFile(join(baseDir, 's1.jsonl'), 'utf-8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(3);
    expect(JSON.parse(lines[0]!).content).toBe('first');
    expect(JSON.parse(lines[1]!).content).toBe('second');
    expect(JSON.parse(lines[2]!).content).toBe('third');
  });

  it('readMessages should return parsed messages in order', async () => {
    await store.appendMessage('s1', mkMsg('user', 'a'));
    await store.appendMessage('s1', mkMsg('assistant', 'b'));
    const result = await store.readMessages('s1');
    expect(result.messages.length).toBe(2);
    expect(result.messages[0]!.content).toBe('a');
    expect(result.messages[1]!.content).toBe('b');
    expect(result.badLineCount).toBe(0);
  });

  it('readMessages should return empty when session file does not exist', async () => {
    const result = await store.readMessages('nonexistent');
    expect(result.messages).toEqual([]);
    expect(result.badLineCount).toBe(0);
  });

  it('readMessages should skip bad lines and count them', async () => {
    // 手工构造含坏行的文件
    const path = join(baseDir, 'bad.jsonl');
    const content = [
      '{"role":"user","content":"ok1"}',
      '{invalid json',
      '{"role":"assistant","content":"ok2"}',
      '{"no_role":"bad"}',
      '',
      '   ',
    ].join('\n');
    await writeFile(path, content, 'utf-8');
    const result = await store.readMessages('bad');
    expect(result.messages.length).toBe(2);
    expect(result.messages[0]!.content).toBe('ok1');
    expect(result.messages[1]!.content).toBe('ok2');
    expect(result.badLineCount).toBe(2);
  });

  it('writeMeta should atomically write meta file (temp + rename)', async () => {
    const meta: SessionMeta = {
      id: 's1',
      title: 'Test Session',
      summary: 'A summary',
      messageCount: 5,
      createdAt: 1000,
      lastActiveAt: 2000,
    };
    await store.writeMeta('s1', meta);
    const raw = await readFile(join(baseDir, 's1.meta.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.id).toBe('s1');
    expect(parsed.title).toBe('Test Session');
    expect(parsed.messageCount).toBe(5);
  });

  it('readMeta should return parsed meta', async () => {
    const meta: SessionMeta = {
      id: 's1',
      title: 'T',
      summary: 'S',
      messageCount: 1,
      createdAt: 100,
      lastActiveAt: 200,
    };
    await store.writeMeta('s1', meta);
    const read = await store.readMeta('s1');
    expect(read).not.toBeNull();
    expect(read!.id).toBe('s1');
    expect(read!.title).toBe('T');
  });

  it('readMeta should return null when meta file missing', async () => {
    const read = await store.readMeta('nonexistent');
    expect(read).toBeNull();
  });

  it('readMeta should return null for invalid JSON', async () => {
    await writeFile(join(baseDir, 'bad.meta.json'), '{invalid', 'utf-8');
    const read = await store.readMeta('bad');
    expect(read).toBeNull();
  });

  it('listMetas should return all metas in baseDir', async () => {
    await store.writeMeta('s1', { id: 's1', title: 'T1', summary: '', messageCount: 1, createdAt: 1, lastActiveAt: 1 });
    await store.writeMeta('s2', { id: 's2', title: 'T2', summary: '', messageCount: 2, createdAt: 2, lastActiveAt: 2 });
    // 非 meta 文件不应被列入
    await store.appendMessage('s3', mkMsg('user', 'x'));
    const metas = await store.listMetas();
    expect(metas.length).toBe(2);
    const ids = metas.map((m) => m.id).sort();
    expect(ids).toEqual(['s1', 's2']);
  });

  it('listMetas should skip broken meta files', async () => {
    await store.writeMeta('s1', { id: 's1', title: 'T1', summary: '', messageCount: 1, createdAt: 1, lastActiveAt: 1 });
    await writeFile(join(baseDir, 'broken.meta.json'), '{invalid', 'utf-8');
    const metas = await store.listMetas();
    expect(metas.length).toBe(1);
    expect(metas[0]!.id).toBe('s1');
  });

  it('listMetas should return empty array when baseDir does not exist', async () => {
    const emptyStore = new SessionStore({ baseDir: join(baseDir, 'nonexistent-subdir') });
    const metas = await emptyStore.listMetas();
    expect(metas).toEqual([]);
  });

  it('deleteSession should remove both .jsonl and .meta.json', async () => {
    await store.appendMessage('s1', mkMsg('user', 'msg'));
    await store.writeMeta('s1', { id: 's1', title: 'T', summary: '', messageCount: 1, createdAt: 1, lastActiveAt: 1 });
    await store.deleteSession('s1');
    const result = await store.readMessages('s1');
    expect(result.messages).toEqual([]);
    const meta = await store.readMeta('s1');
    expect(meta).toBeNull();
  });

  it('deleteSession should not throw when files do not exist', async () => {
    await store.deleteSession('never-existed');
    // 不抛即通过
  });

  it('deleteSession should clean up residual .tmp files', async () => {
    // 手工构造残留 tmp 文件
    await writeFile(join(baseDir, 's1.meta.json.abc123.tmp'), 'partial', 'utf-8');
    await store.deleteSession('s1');
    // tmp 文件应被清理（readFile 抛 ENOENT 通过）
    let tmpExists = true;
    try {
      await readFile(join(baseDir, 's1.meta.json.abc123.tmp'));
    } catch {
      tmpExists = false;
    }
    expect(tmpExists).toBe(false);
  });

  it('jsonlPath and metaPath should return paths under baseDir', () => {
    expect(store.jsonlPath('s1')).toBe(join(baseDir, 's1.jsonl'));
    expect(store.metaPath('s1')).toBe(join(baseDir, 's1.meta.json'));
  });
});
