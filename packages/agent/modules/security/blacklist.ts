/**
 * 危险命令黑名单匹配器
 *
 * 覆盖三类高危模式：
 * - shell：破坏性 shell 命令（rm -rf /、mkfs、fork bomb 等）
 * - git：git 破坏性子命令（push --force、reset --hard、clean -f 等）
 * - file：敏感文件路径（.env、私钥、凭证等，通过 matchGlob 全串匹配）
 *
 * 设计：纯函数、无副作用；正则/glob 模式在模块顶部用 const 数组声明，
 * matchBlacklist 遍历匹配。性能：同步纯函数。
 */
import { matchGlob } from './glob-match.ts';

export type BlacklistCategory = 'shell' | 'git' | 'file';

export interface BlacklistHit {
  category: BlacklistCategory;
  pattern: string;
  matched: string;
  reason: string;
}

interface RegexPatternEntry {
  category: BlacklistCategory;
  pattern: RegExp;
  reason: string;
}

interface GlobPatternEntry {
  category: 'file';
  pattern: string;
  reason: string;
}

// shell 类：破坏性 shell 命令（大小写不敏感，substring 匹配，不锚定）
const SHELL_PATTERNS: RegexPatternEntry[] = [
  { category: 'shell', pattern: /rm\s+-rf\s+\/(\s|$)/i, reason: '拒绝：根目录递归删除' },
  { category: 'shell', pattern: /rm\s+-rf\s+(~|\$HOME)/i, reason: '拒绝：家目录递归删除' },
  { category: 'shell', pattern: /mkfs\b/i, reason: '拒绝：文件系统格式化' },
  { category: 'shell', pattern: /dd\s+if=.*\s+of=\/dev\//i, reason: '拒绝：裸设备写入' },
  { category: 'shell', pattern: /:\(\)\s*\{\s*:\|:&\s*\};?\s*:/i, reason: '拒绝：fork bomb' },
  { category: 'shell', pattern: /chmod\s+-R\s+777\s+\//i, reason: '拒绝：根目录递归授权 777' },
  { category: 'shell', pattern: /curl\s+.*\|\s*(sh|bash)\b/i, reason: '拒绝：远程脚本即执行（curl | sh）' },
  { category: 'shell', pattern: /wget\s+.*\|\s*(sh|bash)\b/i, reason: '拒绝：远程脚本即执行（wget | sh）' },
  { category: 'shell', pattern: /sudo\s+rm\b/i, reason: '拒绝：sudo 提权删除' },
  { category: 'shell', pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: '拒绝：系统关机/重启' },
];

// git 类：git 破坏性子命令（大小写不敏感，substring 匹配）
const GIT_PATTERNS: RegexPatternEntry[] = [
  { category: 'git', pattern: /git\s+push\s+(-f|--force)\b/i, reason: '拒绝：git 强制推送' },
  { category: 'git', pattern: /git\s+reset\s+--hard\b/i, reason: '拒绝：git 硬重置（覆盖未提交改动）' },
  { category: 'git', pattern: /git\s+clean\s+-f[a-z]*\b/i, reason: '拒绝：git 强制清理未跟踪文件' },
  { category: 'git', pattern: /git\s+checkout\s+\.\s*$/i, reason: '拒绝：git 还原工作区所有改动' },
  { category: 'git', pattern: /git\s+restore\s+\.\s*$/i, reason: '拒绝：git 还原工作区所有改动' },
  { category: 'git', pattern: /git\s+branch\s+-D\b/i, reason: '拒绝：git 强制删除分支' },
];

// file 类：敏感文件 glob 模式（通过 matchGlob 全串匹配 args.path）
// 注：绝对系统路径（/etc/、/sys/、C:\Windows\ 等）由路径沙箱负责拦截，此处不重复
const FILE_PATTERNS: GlobPatternEntry[] = [
  { category: 'file', pattern: '**/.env', reason: '拒绝：环境变量文件（含敏感配置）' },
  { category: 'file', pattern: '.env', reason: '拒绝：环境变量文件（含敏感配置）' },
  { category: 'file', pattern: '**/.env.*', reason: '拒绝：环境变量文件变体（如 .env.local）' },
  { category: 'file', pattern: '.env.*', reason: '拒绝：环境变量文件变体（如 .env.local）' },
  { category: 'file', pattern: '**/id_rsa', reason: '拒绝：SSH 私钥' },
  { category: 'file', pattern: '**/id_ed25519', reason: '拒绝：SSH ed25519 私钥' },
  { category: 'file', pattern: '**/credentials', reason: '拒绝：凭证文件' },
  { category: 'file', pattern: '**/.ssh/**', reason: '拒绝：SSH 目录下任意文件' },
];

// exec_command 走 shell + git 双类匹配（按声明顺序短路返回）
const EXEC_PATTERNS: RegexPatternEntry[] = [...SHELL_PATTERNS, ...GIT_PATTERNS];

// write_file / edit_file 走 file 类匹配
const WRITE_TOOL_NAMES = new Set(['write_file', 'edit_file']);

/**
 * 匹配危险命令黑名单（纯函数，无副作用）
 *
 * - exec_command：取 args.command（String() 转换），依次匹配 shell + git 正则（substring 匹配，不锚定）
 * - write_file / edit_file：取 args.path（String() 转换），用 matchGlob 全串匹配 file 类模式
 * - 其它工具名：返回 null
 *
 * 命中任一模式即返回 BlacklistHit；全部未命中返回 null。
 */
export function matchBlacklist(
  toolName: string,
  args: Record<string, unknown>,
): BlacklistHit | null {
  if (toolName === 'exec_command') {
    const command = String(args.command ?? '');
    for (const entry of EXEC_PATTERNS) {
      if (entry.pattern.test(command)) {
        return {
          category: entry.category,
          pattern: entry.pattern.source,
          matched: command,
          reason: entry.reason,
        };
      }
    }
    return null;
  }

  if (WRITE_TOOL_NAMES.has(toolName)) {
    const path = String(args.path ?? '');
    for (const entry of FILE_PATTERNS) {
      if (matchGlob(path, entry.pattern)) {
        return {
          category: 'file',
          pattern: entry.pattern,
          matched: path,
          reason: entry.reason,
        };
      }
    }
    return null;
  }

  return null;
}
