/**
 * sandbox 单元测试
 *
 * 覆盖路径沙箱包含判定：
 * - 沙箱内允许 / 沙箱外拒绝 / `..` 越界 / 多沙箱目录 / 符号链接 / 工具名分支
 * - 跨平台：路径分隔符与系统路径自动适配（node:path）
 */
import { describe, it, expect } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPathAllowed, checkSandbox } from '../modules/security/sandbox.ts';

const cwd = process.cwd();
const isWin = process.platform === 'win32';
// 沙箱外系统文件：跨平台选取一个确定存在的系统路径
const outsideSystemFile = isWin
  ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
  : '/etc/passwd';

describe('isPathAllowed — 沙箱内允许', () => {
  it('相对路径落在 cwd 内允许', () => {
    expect(isPathAllowed('./src/foo.ts', cwd, [cwd])).toBe(true);
  });
  it('子目录路径落在 cwd 内允许', () => {
    expect(isPathAllowed('a/b/c.txt', cwd, [cwd])).toBe(true);
  });
  it('绝对路径等于 allowedDir 允许', () => {
    expect(isPathAllowed(cwd, cwd, [cwd])).toBe(true);
  });
});

describe('checkSandbox — 沙箱内允许', () => {
  it('`write_file` 写沙箱内路径返回 null', () => {
    expect(
      checkSandbox('write_file', { path: './src/foo.ts' }, { cwd }, [cwd]),
    ).toBeNull();
  });
  it('`read_file` 读沙箱内路径返回 null', () => {
    expect(
      checkSandbox('read_file', { path: 'a/b/c.txt' }, { cwd }, [cwd]),
    ).toBeNull();
  });
});

describe('isPathAllowed — 沙箱外拒绝', () => {
  it('系统路径不在 cwd 内，拒绝', () => {
    expect(isPathAllowed(outsideSystemFile, cwd, [cwd])).toBe(false);
  });
  it('绝对路径越界到其它盘/根，拒绝', () => {
    const other = isWin ? 'D:\\evil.txt' : '/var/log/x';
    expect(isPathAllowed(other, cwd, [cwd])).toBe(false);
  });
});

describe('checkSandbox — 沙箱外拒绝', () => {
  it('`write_file` 写系统路径返回 violation', () => {
    const v = checkSandbox(
      'write_file',
      { path: outsideSystemFile },
      { cwd },
      [cwd],
    );
    expect(v).not.toBeNull();
    expect(v!.tool).toBe('write_file');
    expect(v!.path).toBe(outsideSystemFile);
    expect(v!.reason).toContain('越界');
  });
});

describe('isPathAllowed — `..` 越界', () => {
  it('`../../etc/passwd` 越界（path.resolve 处理 `..` 后落出 cwd）', () => {
    expect(isPathAllowed('../../etc/passwd', cwd, [cwd])).toBe(false);
  });
  it('`../sibling` 越界到 cwd 兄弟目录', () => {
    expect(isPathAllowed('../sibling/file', cwd, [cwd])).toBe(false);
  });
});

describe('checkSandbox — `..` 越界', () => {
  it('`write_file` 写 `../../etc/passwd` 返回 violation', () => {
    const v = checkSandbox(
      'write_file',
      { path: '../../etc/passwd' },
      { cwd },
      [cwd],
    );
    expect(v).not.toBeNull();
    expect(v!.tool).toBe('write_file');
  });
});

describe('isPathAllowed — 多沙箱目录', () => {
  it('allowedDirs 含 /tmp 时 `/tmp/x` 允许', () => {
    expect(isPathAllowed('/tmp/x', cwd, [cwd, '/tmp'])).toBe(true);
  });
  it('allowedDirs 不含 `/var` 时 `/var/log` 拒绝', () => {
    expect(isPathAllowed('/var/log', cwd, [cwd, '/tmp'])).toBe(false);
  });
});

describe('checkSandbox — 工具名分支', () => {
  it('`exec_command` 不受沙箱管控，返回 null', () => {
    expect(
      checkSandbox('exec_command', { command: 'ls' }, { cwd }, [cwd]),
    ).toBeNull();
  });
  it('未知工具名不受沙箱管控，返回 null', () => {
    expect(
      checkSandbox('unknown_tool', { path: '/etc/passwd' }, { cwd }, [cwd]),
    ).toBeNull();
  });
  it('`read_file` 缺省 path 返回 null（交由后续层处理）', () => {
    expect(checkSandbox('read_file', {}, { cwd }, [cwd])).toBeNull();
  });
  it('`read_file` path 为非字符串时返回 null', () => {
    expect(checkSandbox('read_file', { path: 123 }, { cwd }, [cwd])).toBeNull();
  });
  it('`find_files` 缺省 path 返回 null（搜索根目录缺省视为 ctx.cwd，由后续层处理）', () => {
    expect(checkSandbox('find_files', { pattern: '*.ts' }, { cwd }, [cwd])).toBeNull();
  });
});

describe('checkSandbox — SandboxViolation 字段完整性', () => {
  it('violation 含 tool/path/resolvedPath/allowedDirs/reason', () => {
    const v = checkSandbox(
      'write_file',
      { path: outsideSystemFile },
      { cwd },
      [cwd],
    );
    expect(v).not.toBeNull();
    expect(v!.tool).toBe('write_file');
    expect(v!.path).toBe(outsideSystemFile);
    expect(typeof v!.resolvedPath).toBe('string');
    expect(v!.resolvedPath.length).toBeGreaterThan(0);
    expect(Array.isArray(v!.allowedDirs)).toBe(true);
    expect(v!.allowedDirs).toEqual([cwd]);
    expect(typeof v!.reason).toBe('string');
    expect(v!.reason.length).toBeGreaterThan(0);
  });
});

describe('isPathAllowed — 边界与异常输入', () => {
  it('空 target 拒绝', () => {
    expect(isPathAllowed('', cwd, [cwd])).toBe(false);
  });
  it('空 allowedDirs 拒绝', () => {
    expect(isPathAllowed('./a', cwd, [])).toBe(false);
  });
  it('allowedDirs 含空字符串条目时跳过该条目', () => {
    expect(isPathAllowed('./a', cwd, ['', cwd])).toBe(true);
  });
});

describe('isPathAllowed — 符号链接越界', () => {
  // 检测当前环境是否有创建符号链接的权限（Windows 默认需管理员/开发者模式）
  let canSymlink = false;
  try {
    const probeTmp = mkdtempSync(join(tmpdir(), 'probe-symlink-'));
    const probeTarget = join(probeTmp, 'target.txt');
    const probeLink = join(probeTmp, 'link.txt');
    writeFileSync(probeTarget, 'x');
    symlinkSync(probeTarget, probeLink, 'file');
    rmSync(probeTmp, { recursive: true, force: true });
    canSymlink = true;
  } catch {
    // Windows 无管理员/开发者模式时无法创建符号链接 → 跳过该用例
    canSymlink = false;
  }

  // 无权限时跳过该用例（it.skip）
  const testIt = canSymlink ? it : it.skip;

  testIt('指向沙箱外的符号链接应被拒绝（realpath 解析后越界）', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'sandbox-symlink-'));
    const sandboxDir = join(tmpRoot, 'sandbox');
    const outsideDir = join(tmpRoot, 'outside');
    const outsideFile = join(outsideDir, 'secret.txt');
    const symlinkPath = join(sandboxDir, 'evil-link');

    try {
      mkdirSync(sandboxDir, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(outsideFile, 'secret');
      symlinkSync(outsideFile, symlinkPath, 'file');

      // symlinkPath 物理位于 sandboxDir 内，但 realpath 解析到 outsideFile，应被拒绝
      expect(isPathAllowed(symlinkPath, tmpRoot, [sandboxDir])).toBe(false);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  testIt('指向沙箱内的符号链接应被允许（realpath 解析后仍在沙箱内）', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'sandbox-symlink-ok-'));
    const sandboxDir = join(tmpRoot, 'sandbox');
    const innerFile = join(sandboxDir, 'inner.txt');
    const symlinkPath = join(sandboxDir, 'link-to-inner');

    try {
      mkdirSync(sandboxDir, { recursive: true });
      writeFileSync(innerFile, 'x');
      symlinkSync(innerFile, symlinkPath, 'file');

      // symlink 与其目标都在 sandboxDir 内，应被允许
      expect(isPathAllowed(symlinkPath, tmpRoot, [sandboxDir])).toBe(true);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
