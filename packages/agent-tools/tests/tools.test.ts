/**
 * 六个核心工具 + 共享路径解析的单元测试
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readFileTool } from '../read-file/index.ts';
import { writeFileTool } from '../write-file/index.ts';
import { editFileTool } from '../edit-file/index.ts';
import { execCommandTool } from '../exec-command/index.ts';
import { findFilesTool } from '../find-files/index.ts';
import { searchContentTool } from '../search-content/index.ts';
import { safeResolve, PathEscapeError } from '../shared/fs.ts';

// Windows 上 process.execPath 含反斜杠；若环境使用 bash -c 执行，反斜杠会被当作转义符，
// 故统一转为正斜杠，保证跨平台可用。
const bun = process.execPath.replace(/\\/g, '/');

let dir: string;
const ctx = () => ({ cwd: dir });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wuzi-tools-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// —— 路径安全 ——
test('safeResolve 接受工作目录内路径', () => {
  expect(safeResolve(dir, 'a/b.txt')).toBe(join(dir, 'a/b.txt'));
});
test('safeResolve 拒绝越界路径', () => {
  expect(() => safeResolve(dir, '../escape.txt')).toThrow(PathEscapeError);
  expect(() => safeResolve(dir, '/etc/passwd')).toThrow(PathEscapeError);
});

// —— read_file ——
test('read_file 读取已存在文件', async () => {
  const p = join(dir, 'r.txt');
  await writeFile(p, 'hello world', 'utf-8');
  const res = await readFileTool.execute({ path: 'r.txt' }, ctx());
  expect(res.ok).toBe(true);
  expect(res.content).toBe('hello world');
});
test('read_file 读不存在文件返回失败', async () => {
  const res = await readFileTool.execute({ path: 'nope.txt' }, ctx());
  expect(res.ok).toBe(false);
  expect(res.error).toBeTruthy();
});

// —— write_file ——
test('write_file 创建文件并可回读', async () => {
  const res = await writeFileTool.execute({ path: 'sub/w.txt', content: 'xyz' }, ctx());
  expect(res.ok).toBe(true);
  const back = await readFile(join(dir, 'sub/w.txt'), 'utf-8');
  expect(back).toBe('xyz');
});

// —— edit_file ——
test('edit_file 唯一匹配可替换', async () => {
  const p = join(dir, 'e.txt');
  await writeFile(p, 'foo bar foo', 'utf-8');
  const res = await editFileTool.execute(
    { path: 'e.txt', old_string: 'bar', new_string: 'BAZ' },
    ctx(),
  );
  expect(res.ok).toBe(true);
  expect(await readFile(p, 'utf-8')).toBe('foo BAZ foo');
});
test('edit_file 匹配不到报错', async () => {
  const p = join(dir, 'e2.txt');
  await writeFile(p, 'abc', 'utf-8');
  const res = await editFileTool.execute(
    { path: 'e2.txt', old_string: 'zzz', new_string: 'y' },
    ctx(),
  );
  expect(res.ok).toBe(false);
  expect(res.meta?.count).toBe(0);
});
test('edit_file 多次匹配报错', async () => {
  const p = join(dir, 'e3.txt');
  await writeFile(p, 'dup dup dup', 'utf-8');
  const res = await editFileTool.execute(
    { path: 'e3.txt', old_string: 'dup', new_string: 'x' },
    ctx(),
  );
  expect(res.ok).toBe(false);
  expect(res.meta?.count).toBeGreaterThan(1);
});

// —— exec_command ——
test('exec_command 成功命令返回 stdout', async () => {
  const res = await execCommandTool.execute({ command: `${bun} --version` }, ctx());
  expect(res.ok).toBe(true);
  expect(res.meta?.code).toBe(0);
  expect(res.content).toContain('1.3.14');
});
test('exec_command 非零退出码返回失败', async () => {
  const res = await execCommandTool.execute({ command: 'exit 3' }, ctx());
  expect(res.ok).toBe(false);
  expect(res.meta?.code).toBe(3);
});

// —— find_files ——
test('find_files 按 glob 查找', async () => {
  await writeFile(join(dir, 'a.ts'), '', 'utf-8');
  await writeFile(join(dir, 'b.ts'), '', 'utf-8');
  await writeFile(join(dir, 'c.json'), '', 'utf-8');
  const res = await findFilesTool.execute({ pattern: '*.ts' }, ctx());
  expect(res.ok).toBe(true);
  expect(res.content).toContain('a.ts');
  expect(res.content).toContain('b.ts');
  expect(res.content).not.toContain('c.json');
});

// —— search_content ——
test('search_content 按正则搜索', async () => {
  await writeFile(join(dir, 's.txt'), 'alpha\nbeta gamma\ndelta', 'utf-8');
  const res = await searchContentTool.execute({ pattern: 'beta', filePattern: '*.txt' }, ctx());
  expect(res.ok).toBe(true);
  expect(res.content).toContain('s.txt:2: beta gamma');
});
