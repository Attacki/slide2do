/**
 * glob-match 单元测试
 *
 * 覆盖 glob→regex 转换与匹配：
 * - `*` 单层、`**` 跨层、`?` 单字符、`{a,b}` 分支
 * - 特殊字符字面、跨平台分隔符、空串/边界、复合模式
 */
import { describe, it, expect } from 'bun:test';
import { globToRegex, matchGlob } from '../modules/security/glob-match.ts';

describe('matchGlob — `*` 单层匹配（不含路径分隔符）', () => {
  it('匹配同层文件名', () => {
    expect(matchGlob('foo.ts', '*.ts')).toBe(true);
  });
  it('不匹配跨分隔符路径', () => {
    expect(matchGlob('a/foo.ts', '*.ts')).toBe(false);
  });
});

describe('matchGlob — `**` 跨层匹配（含路径分隔符）', () => {
  it('匹配多层路径下的文件', () => {
    expect(matchGlob('a/b/c/foo.ts', '**/foo.ts')).toBe(true);
  });
  it('匹配目录下所有子路径', () => {
    expect(matchGlob('src/x/y', 'src/**')).toBe(true);
  });
});

describe('matchGlob — `?` 单字符匹配', () => {
  it('单字符命中', () => {
    expect(matchGlob('a.ts', '?.ts')).toBe(true);
  });
  it('多字符不命中', () => {
    expect(matchGlob('ab.ts', '?.ts')).toBe(false);
  });
});

describe('matchGlob — `{a,b}` 分支匹配', () => {
  it('命中其中一个分支', () => {
    expect(matchGlob('foo.ts', '*.{ts,js}')).toBe(true);
  });
  it('不命中任何分支', () => {
    expect(matchGlob('foo.py', '*.{ts,js}')).toBe(false);
  });
});

describe('matchGlob — 特殊字符字面匹配', () => {
  it('`.` 按字面匹配', () => {
    expect(matchGlob('foo.bar', 'foo.bar')).toBe(true);
  });
  it('`.` 不匹配任意字符', () => {
    expect(matchGlob('fooXbar', 'foo.bar')).toBe(false);
  });
});

describe('matchGlob — 路径分隔符跨平台', () => {
  it('Windows 反斜杠也视为分隔符', () => {
    expect(matchGlob('a\\b\\c', 'a/**')).toBe(true);
  });
});

describe('matchGlob — 空串/边界', () => {
  it('空串匹配 `*`', () => {
    expect(matchGlob('', '*')).toBe(true);
  });
  it('空串不匹配 `?`', () => {
    expect(matchGlob('', '?')).toBe(false);
  });
});

describe('matchGlob — 复合模式', () => {
  it('`**` + `*` + 字面量组合', () => {
    expect(matchGlob('src/a/b.test.ts', 'src/**/*.test.ts')).toBe(true);
  });
});

describe('globToRegex — 返回 RegExp 实例', () => {
  it('返回全串匹配的 RegExp', () => {
    const re = globToRegex('*.ts');
    expect(re).toBeInstanceOf(RegExp);
    expect(re.test('foo.ts')).toBe(true);
    expect(re.test('a/foo.ts')).toBe(false);
  });
});
