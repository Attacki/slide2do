/**
 * 路径沙箱包含判定
 *
 * 用于文件类工具（read_file / write_file / edit_file / find_files / search_content）
 * 的目标路径越界检测：解析后的绝对路径必须落在任一允许目录内，否则视为违规。
 *
 * 防护：`..` 越界、绝对路径解析、符号链接规范化、跨平台分隔符。
 * 设计：同步纯函数；安全检查允许 fs.realpathSync 同步 IO 作为必要代价；无外部依赖。
 */
import { resolve as pathResolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';

export interface SandboxViolation {
  tool: string;
  path: string;
  resolvedPath: string;
  allowedDirs: string[];
  reason: string;
}

// 受沙箱管控的文件类工具：提取 args.path 进行判定
const FILE_TOOLS = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'find_files',
  'search_content',
]);

/**
 * 规范化绝对路径：path.resolve 解析为绝对路径，再 best-effort 用 realpathSync 解析符号链接
 *
 * realpath 失败（目标不存在等）时返回未规范化的绝对路径，保持判定可用。
 */
function normalizeRealpath(...segments: string[]): string {
  const abs = pathResolve(...segments);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/**
 * 判断 target 是否落在任一 allowedDir 内（同步纯函数）
 *
 * - 用 path.resolve(cwd, target) 解析为绝对路径（自动处理 `..`、`.`、相对路径）
 * - allowedDirs 中每个目录也 path.resolve 为绝对路径
 * - 符号链接：best-effort 用 realpathSync 规范化 target 与 allowedDirs 后比对
 * - 包含判定：target === allowedDir 或 target 以 allowedDir + path.sep 开头（跨平台）
 */
export function isPathAllowed(
  target: string,
  cwd: string,
  allowedDirs: string[],
): boolean {
  if (
    typeof target !== 'string' ||
    target === '' ||
    !Array.isArray(allowedDirs) ||
    allowedDirs.length === 0
  ) {
    return false;
  }

  const resolvedTarget = normalizeRealpath(cwd, target);

  for (const dir of allowedDirs) {
    if (typeof dir !== 'string' || dir === '') continue;
    const resolvedDir = normalizeRealpath(dir);
    if (resolvedTarget === resolvedDir) return true;
    if (resolvedTarget.startsWith(resolvedDir + sep)) return true;
  }
  return false;
}

/**
 * 从工具调用参数提取目标路径，进行沙箱包含判定
 *
 * 路径提取规则：
 * - read_file / write_file / edit_file / find_files / search_content：取 args.path
 * - exec_command / 其它工具：返回 null（沙箱不管控，由黑名单/HITL 处理）
 * - 提取到的路径为空/非字符串：返回 null（不视为违规，交由后续层处理）
 *
 * 越界返回 SandboxViolation；在沙箱内返回 null。
 */
export function checkSandbox(
  toolName: string,
  args: Record<string, unknown>,
  ctx: { cwd: string },
  allowedDirs: string[],
): SandboxViolation | null {
  if (!FILE_TOOLS.has(toolName)) return null;

  const raw = args.path;
  if (typeof raw !== 'string' || raw === '') return null;

  const resolvedPath = pathResolve(ctx.cwd, raw);
  if (isPathAllowed(raw, ctx.cwd, allowedDirs)) return null;

  return {
    tool: toolName,
    path: raw,
    resolvedPath,
    allowedDirs,
    reason: `路径 '${raw}' 越界：不在沙箱允许目录 [${allowedDirs.join(', ')}] 内`,
  };
}
