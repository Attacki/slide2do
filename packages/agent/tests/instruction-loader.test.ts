import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InstructionLoader,
  parseIncludeDirectives,
  isPathSafe,
  expandIncludes,
} from '../modules/memory/instructions/instruction-loader.ts';

describe('parseIncludeDirectives', () => {
  it('should return empty array when no @include directives', () => {
    const result = parseIncludeDirectives('hello world\nno includes here');
    expect(result).toEqual([]);
  });

  it('should parse single @include directive', () => {
    const content = '@include ./foo.md';
    const result = parseIncludeDirectives(content);
    expect(result.length).toBe(1);
    expect(result[0]!.path).toBe('./foo.md');
    expect(result[0]!.line).toBe(0);
    expect(result[0]!.raw).toBe('@include ./foo.md');
  });

  it('should parse multiple directives preserving order and line numbers', () => {
    const content = 'line0\n@include ./a.md\nline2\n@include ./b.md';
    const result = parseIncludeDirectives(content);
    expect(result.length).toBe(2);
    expect(result[0]!.line).toBe(1);
    expect(result[0]!.path).toBe('./a.md');
    expect(result[1]!.line).toBe(3);
    expect(result[1]!.path).toBe('./b.md');
  });

  it('should handle leading whitespace before @include', () => {
    const content = '  @include ./foo.md';
    const result = parseIncludeDirectives(content);
    expect(result.length).toBe(1);
    expect(result[0]!.path).toBe('./foo.md');
  });

  it('should not match @include inline (must be on its own line)', () => {
    const content = 'some text @include ./foo.md more text';
    const result = parseIncludeDirectives(content);
    expect(result).toEqual([]);
  });

  it('should not match @includex (no word boundary)', () => {
    const content = '@includex ./foo.md';
    const result = parseIncludeDirectives(content);
    expect(result).toEqual([]);
  });

  it('should trim whitespace around path', () => {
    const content = '@include    ./foo.md   ';
    const result = parseIncludeDirectives(content);
    expect(result.length).toBe(1);
    expect(result[0]!.path).toBe('./foo.md');
  });
});

describe('isPathSafe', () => {
  it('should return true when path equals rootDir', () => {
    expect(isPathSafe('/foo', '/foo')).toBe(true);
  });

  it('should return true when path is inside rootDir', () => {
    expect(isPathSafe('/foo/bar/baz.md', '/foo')).toBe(true);
    expect(isPathSafe('/foo/bar', '/foo')).toBe(true);
  });

  it('should return false when path escapes rootDir (prefix attack)', () => {
    expect(isPathSafe('/foobar', '/foo')).toBe(false);
    expect(isPathSafe('/foobar/baz.md', '/foo')).toBe(false);
  });

  it('should return false when path is sibling of rootDir', () => {
    expect(isPathSafe('/baz', '/foo')).toBe(false);
  });

  it('should return false when path is parent of rootDir', () => {
    expect(isPathSafe('/', '/foo')).toBe(false);
  });
});

describe('expandIncludes', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'wuzi-instr-test-'));
    await mkdir(tmpRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('should return content unchanged when no @include directives', async () => {
    const result = await expandIncludes('hello\nworld', tmpRoot, 0, 3, tmpRoot);
    expect(result).toBe('hello\nworld');
  });

  it('should inline expand relative @include path', async () => {
    const includedPath = join(tmpRoot, 'foo.md');
    await writeFile(includedPath, 'foo content', 'utf-8');
    const result = await expandIncludes('@include ./foo.md', tmpRoot, 0, 3, tmpRoot);
    expect(result).toBe('foo content');
  });

  it('should inline expand absolute @include path inside root', async () => {
    const includedPath = join(tmpRoot, 'bar.md');
    await writeFile(includedPath, 'bar content', 'utf-8');
    const result = await expandIncludes(`@include ${includedPath}`, tmpRoot, 0, 3, tmpRoot);
    expect(result).toBe('bar content');
  });

  it('should preserve original line and add warning when file missing', async () => {
    const result = await expandIncludes('@include ./missing.md', tmpRoot, 0, 3, tmpRoot);
    expect(result).toContain('@include ./missing.md');
    expect(result).toContain('文件不存在或读取失败');
  });

  it('should preserve original line and add warning when path escapes root', async () => {
    const result = await expandIncludes('@include ../../../etc/passwd', tmpRoot, 0, 3, tmpRoot);
    expect(result).toContain('@include ../../../etc/passwd');
    expect(result).toContain('逃逸根目录');
  });

  it('should recursively expand nested @include within depth limit', async () => {
    const inner = join(tmpRoot, 'inner.md');
    const outer = join(tmpRoot, 'outer.md');
    await writeFile(inner, 'inner-content', 'utf-8');
    await writeFile(outer, '@include ./inner.md', 'utf-8');
    const result = await expandIncludes('@include ./outer.md', tmpRoot, 0, 3, tmpRoot);
    expect(result).toBe('inner-content');
  });

  it('should stop expanding when maxDepth exceeded and add warning', async () => {
    const inner = join(tmpRoot, 'inner.md');
    const outer = join(tmpRoot, 'outer.md');
    await writeFile(inner, 'inner-content', 'utf-8');
    await writeFile(outer, '@include ./inner.md', 'utf-8');
    // depth=0, maxDepth=0 → 立即停止，保留原指令
    const result = await expandIncludes('@include ./outer.md', tmpRoot, 0, 0, tmpRoot);
    expect(result).toContain('@include ./outer.md');
    expect(result).toContain('嵌套深度已达上限');
  });

  it('should preserve surrounding lines when expanding', async () => {
    const included = join(tmpRoot, 'foo.md');
    await writeFile(included, 'INCLUDED', 'utf-8');
    const content = 'before\n@include ./foo.md\nafter';
    const result = await expandIncludes(content, tmpRoot, 0, 3, tmpRoot);
    const lines = result.split('\n');
    expect(lines[0]).toBe('before');
    expect(lines[1]).toBe('INCLUDED');
    expect(lines[2]).toBe('after');
  });

  it('should preserve indentation when expanding (apply indent to included content)', async () => {
    const included = join(tmpRoot, 'foo.md');
    await writeFile(included, 'line1\nline2', 'utf-8');
    const content = '  @include ./foo.md';
    const result = await expandIncludes(content, tmpRoot, 0, 3, tmpRoot);
    const lines = result.split('\n');
    expect(lines[0]).toBe('  line1');
    expect(lines[1]).toBe('  line2');
  });

  it('should not be affected by other @include failures', async () => {
    const ok = join(tmpRoot, 'ok.md');
    await writeFile(ok, 'OK', 'utf-8');
    const content = '@include ./missing.md\n@include ./ok.md';
    const result = await expandIncludes(content, tmpRoot, 0, 3, tmpRoot);
    // missing 保留原指令 + 警告，ok 被展开
    expect(result).toContain('OK');
    expect(result).toContain('文件不存在或读取失败');
  });
});

describe('InstructionLoader', () => {
  let tmpProject: string;

  beforeEach(async () => {
    tmpProject = await mkdtemp(join(tmpdir(), 'wuzi-loader-test-'));
    await mkdir(tmpProject, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpProject, { recursive: true, force: true });
  });

  it('should load project-level AGENTS.md when present', async () => {
    const agentsPath = join(tmpProject, 'AGENTS.md');
    await writeFile(agentsPath, '# Project Agents\nThis is project-level.', 'utf-8');
    const loader = new InstructionLoader({ projectDir: tmpProject });
    const result = await loader.load();
    expect(result.loaded).toBe(true);
    expect(result.content).toContain('# Project Agents');
    expect(result.content).toContain('This is project-level.');
    expect(result.content).toContain('项目级指令');
  });

  it('should return loaded=false when both levels missing', async () => {
    const loader = new InstructionLoader({ projectDir: tmpProject });
    const result = await loader.load();
    expect(result.loaded).toBe(false);
    expect(result.content).toBe('');
  });

  it('should load user-level AGENTS.md when present', async () => {
    const userPath = join(tmpProject, 'user-agents.md');
    await writeFile(userPath, '# User Agents\nThis is user-level.', 'utf-8');
    const loader = new InstructionLoader({ projectDir: tmpProject, userLevelPath: userPath });
    const result = await loader.load();
    expect(result.loaded).toBe(true);
    expect(result.content).toContain('# User Agents');
    expect(result.content).toContain('用户级指令');
  });

  it('should load both levels with project first, then user, separated by ---', async () => {
    const projectAgents = join(tmpProject, 'AGENTS.md');
    await writeFile(projectAgents, 'PROJECT_CONTENT', 'utf-8');
    const userAgents = join(tmpProject, 'user-agents.md');
    await writeFile(userAgents, 'USER_CONTENT', 'utf-8');
    const loader = new InstructionLoader({
      projectDir: tmpProject,
      userLevelPath: userAgents,
    });
    const result = await loader.load();
    expect(result.loaded).toBe(true);
    const projectIdx = result.content.indexOf('PROJECT_CONTENT');
    const userIdx = result.content.indexOf('USER_CONTENT');
    expect(projectIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeGreaterThan(-1);
    expect(projectIdx).toBeLessThan(userIdx);
    expect(result.content).toContain('---');
  });

  it('should expand @include in project-level relative to projectDir', async () => {
    const included = join(tmpProject, 'extra.md');
    await writeFile(included, 'EXTRA_CONTENT', 'utf-8');
    const agentsPath = join(tmpProject, 'AGENTS.md');
    await writeFile(agentsPath, '@include ./extra.md', 'utf-8');
    const loader = new InstructionLoader({ projectDir: tmpProject });
    const result = await loader.load();
    expect(result.content).toContain('EXTRA_CONTENT');
    expect(result.content).not.toContain('@include ./extra.md');
  });

  it('should block @include path escaping projectDir', async () => {
    // 在 projectDir 外部创建文件
    const outside = await mkdtemp(join(tmpdir(), 'wuzi-outside-'));
    try {
      const outsideFile = join(outside, 'secret.md');
      await writeFile(outsideFile, 'SECRET', 'utf-8');
      const agentsPath = join(tmpProject, 'AGENTS.md');
      await writeFile(agentsPath, `@include ${outsideFile}`, 'utf-8');
      const loader = new InstructionLoader({ projectDir: tmpProject });
      const result = await loader.load();
      // 应保留原指令 + 警告
      expect(result.content).toContain('@include');
      expect(result.content).toContain('逃逸根目录');
      expect(result.content).not.toContain('SECRET');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('should skip empty content layer (whitespace only)', async () => {
    const agentsPath = join(tmpProject, 'AGENTS.md');
    await writeFile(agentsPath, '   \n  \n  ', 'utf-8');
    const loader = new InstructionLoader({ projectDir: tmpProject });
    const result = await loader.load();
    expect(result.loaded).toBe(false);
  });

  it('should respect maxIncludeDepth option', async () => {
    const inner = join(tmpProject, 'inner.md');
    const outer = join(tmpProject, 'outer.md');
    await writeFile(inner, 'INNER', 'utf-8');
    await writeFile(outer, '@include ./inner.md', 'utf-8');
    const agentsPath = join(tmpProject, 'AGENTS.md');
    await writeFile(agentsPath, '@include ./outer.md', 'utf-8');
    // maxIncludeDepth=1: 只展开一层（AGENTS.md → outer.md），outer 内的 @include 保留
    const loader = new InstructionLoader({ projectDir: tmpProject, maxIncludeDepth: 1 });
    const result = await loader.load();
    expect(result.content).toContain('@include ./inner.md');
    expect(result.content).toContain('嵌套深度已达上限');
    expect(result.content).not.toContain('INNER');
  });

  it('should accept injected reader for testing without real IO', async () => {
    const fakeFiles = new Map<string, string>([
      [join(tmpProject, 'AGENTS.md'), 'FAKE_PROJECT'],
    ]);
    const reader = async (p: string) => {
      const v = fakeFiles.get(p);
      if (v === undefined) throw new Error('not found: ' + p);
      return v;
    };
    const loader = new InstructionLoader({
      projectDir: tmpProject,
      reader,
    });
    const result = await loader.load();
    expect(result.loaded).toBe(true);
    expect(result.content).toContain('FAKE_PROJECT');
  });
});
