/**
 * 文件工具安全路径解析
 *
 * 工具接收的相对路径以工作目录（cwd）为基准解析，并强制限制在工作目录之内，
 * 防止通过 `../` 或绝对路径逃逸到项目之外（最小可行沙箱）。
 */
import { resolve, isAbsolute, relative } from 'node:path';

/** 路径越界错误（解析后位于工作目录之外时抛出） */
export class PathEscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathEscapeError';
  }
}

/**
 * 将输入路径解析为工作目录内的绝对路径。
 *
 * @throws PathEscapeError 当解析结果位于 cwd 之外时
 */
export function safeResolve(cwd: string, input: string): string {
  const resolvedCwd = resolve(cwd);
  const abs = isAbsolute(input) ? resolve(input) : resolve(resolvedCwd, input);
  // 相对 cwd 计算：以 '..' 开头表示向上越界；跨盘符时 relative 返回绝对路径，
  // 此时 isAbsolute 为真同样视为越界。
  const rel = relative(resolvedCwd, abs);
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new PathEscapeError(`路径越界: "${input}" 解析为 ${abs}，超出工作目录 ${resolvedCwd}`);
  }
  return abs;
}
