import { describe, it, expect, afterEach } from 'bun:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildPreviewText, ToolResultOffloader } from '../modules/context/offloader.ts';

describe('buildPreviewText', () => {
  it('returns original content (no omit notice) when lines ≤ headLines + tailLines', () => {
    const content = ['line1', 'line2', 'line3'].join('\n');
    const result = buildPreviewText(content, 2, 2, '/tmp/file.txt');
    expect(result).toBe(content);
    expect(result).not.toContain('已省略');
  });

  it('returns head + notice + tail with correct omitted count when lines exceed threshold', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    const content = lines.join('\n');
    const result = buildPreviewText(content, 2, 2, '/tmp/file.txt');

    const expected = [
      'line1',
      'line2',
      '[已省略 6 行,完整内容见: /tmp/file.txt]',
      'line9',
      'line10',
    ].join('\n');
    expect(result).toBe(expected);
  });

  it('returns original content when lines exactly equal headLines + tailLines (no omit)', () => {
    const content = Array.from({ length: 4 }, (_, i) => `line${i + 1}`).join('\n');
    const result = buildPreviewText(content, 2, 2, '/tmp/file.txt');
    expect(result).toBe(content);
    expect(result).not.toContain('已省略');
  });

  it('omits exactly 1 line when lines = headLines + tailLines + 1', () => {
    const content = Array.from({ length: 5 }, (_, i) => `line${i + 1}`).join('\n');
    const result = buildPreviewText(content, 2, 2, '/tmp/file.txt');

    const expected = [
      'line1',
      'line2',
      '[已省略 1 行,完整内容见: /tmp/file.txt]',
      'line4',
      'line5',
    ].join('\n');
    expect(result).toBe(expected);
  });

  it('uses placeholder when path is not provided', () => {
    const content = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
    const result = buildPreviewText(content, 2, 2);
    expect(result).toContain('[已省略 6 行,完整内容见: (unknown path)]');
  });
});

describe('ToolResultOffloader', () => {
  const tmpRoot = path.join(os.tmpdir(), `wuzi-offload-test-${Date.now()}-${process.pid}`);
  const createdPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(
      createdPaths.splice(0).map(p => fs.rm(p, { recursive: true, force: true }).catch(() => {})),
    );
  });

  function makeTmpBaseDir(): string {
    const dir = path.join(
      tmpRoot,
      `case-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    createdPaths.push(dir);
    return dir;
  }

  it('writes file to correct path with content matching and returns absolute path', async () => {
    const baseDir = makeTmpBaseDir();
    const offloader = new ToolResultOffloader(baseDir);
    const content = 'hello\nworld\n';
    const sessionId = 'session-A';

    const filePath = await offloader.offload(content, sessionId);

    // 返回绝对路径
    expect(path.isAbsolute(filePath)).toBe(true);

    // 文件存在且为普通文件
    const stat = await fs.stat(filePath);
    expect(stat.isFile()).toBe(true);

    // 路径结构: {baseDir}/{sessionId}/{ISO时间戳}-{序号}.txt
    const expectedDir = path.join(baseDir, sessionId);
    expect(filePath.startsWith(expectedDir)).toBe(true);

    // 文件名格式: {ISO时间戳}-{序号}.txt
    const filename = path.basename(filePath);
    expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d{3}\.txt$/);

    // 内容与传入 content 完全一致
    const readBack = await fs.readFile(filePath, 'utf8');
    expect(readBack).toBe(content);
  });

  it('increments sequence number on multiple calls with same sessionId', async () => {
    const baseDir = makeTmpBaseDir();
    const offloader = new ToolResultOffloader(baseDir);
    const sessionId = 'session-seq';

    const p1 = await offloader.offload('content1', sessionId);
    const p2 = await offloader.offload('content2', sessionId);
    const p3 = await offloader.offload('content3', sessionId);

    const seqOf = (p: string): string | undefined =>
      path.basename(p).match(/-(\d{3})\.txt$/)?.[1];

    expect(seqOf(p1)).toBe('001');
    expect(seqOf(p2)).toBe('002');
    expect(seqOf(p3)).toBe('003');

    // 内容各自正确
    expect(await fs.readFile(p1, 'utf8')).toBe('content1');
    expect(await fs.readFile(p2, 'utf8')).toBe('content2');
    expect(await fs.readFile(p3, 'utf8')).toBe('content3');
  });

  it('maintains independent sequence counters for different sessionIds', async () => {
    const baseDir = makeTmpBaseDir();
    const offloader = new ToolResultOffloader(baseDir);

    const a1 = await offloader.offload('a1', 'session-A');
    const b1 = await offloader.offload('b1', 'session-B');
    const a2 = await offloader.offload('a2', 'session-A');
    const b2 = await offloader.offload('b2', 'session-B');

    const seqOf = (p: string): string | undefined =>
      path.basename(p).match(/-(\d{3})\.txt$/)?.[1];

    // 各自序号独立递增
    expect(seqOf(a1)).toBe('001');
    expect(seqOf(b1)).toBe('001');
    expect(seqOf(a2)).toBe('002');
    expect(seqOf(b2)).toBe('002');

    // 不同 sessionId 落在各自隔离的目录
    expect(path.dirname(a1)).toBe(path.dirname(a2));
    expect(path.dirname(b1)).toBe(path.dirname(b2));
    expect(path.dirname(a1)).not.toBe(path.dirname(b1));
  });

  it('throws Error with reason when write fails (target dir not writable)', async () => {
    // 创建一个普通文件作为 baseDir —— mkdir 会因路径中间组件是文件而非目录失败
    const blockerFile = path.join(
      os.tmpdir(),
      `wuzi-offload-blocker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
    );
    await fs.writeFile(blockerFile, 'blocker');
    createdPaths.push(blockerFile);

    const offloader = new ToolResultOffloader(blockerFile);

    let caught: unknown;
    try {
      await offloader.offload('content', 'session-fail');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    // 包装前缀
    expect(msg).toMatch(/ToolResultOffloader\.offload failed/i);
    // 错误信息含原始失败原因(长度大于包装前缀本身)
    expect(msg.length).toBeGreaterThan('ToolResultOffloader.offload failed: '.length);
  });
});
