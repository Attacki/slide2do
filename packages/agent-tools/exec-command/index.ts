/**
 * exec_command — 执行 shell 命令
 *
 * 在工作目录（或其子目录）中执行一条 shell 命令，返回标准输出、标准错误与退出码。
 * 尊重调用方传入的 AbortSignal，超时/取消时终止子进程。
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { Tool, ToolContext } from '@wuzi/types';
import { okResult, failResult } from '../shared/result.ts';

/**
 * 解析 Windows 下应使用的 shell 参数。
 *
 * 优先级：
 *  1. Git Bash（Windows 原生 bash）：既能执行 NT 路径的 Windows 程序，又支持 mkdir -p 等 Unix 语法。
 *  2. 排除 WSL 启动器（C:\Windows\system32\bash.exe）：其 bash 运行在独立的 Linux 文件系统中，
 *     无法按 NT 路径（如 D:\foo.exe）查找 Windows 可执行文件，也无法切换到 Windows 工作目录。
 *  3. 上述均不可用时回退 cmd /c（Windows 原生，正确处理 NT 路径）。
 */
function resolveWindowsShell(command: string): string[] {
  const gitBashCandidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  for (const candidate of gitBashCandidates) {
    if (existsSync(candidate)) return [candidate, '-c', command];
  }
  const bash = Bun.which('bash');
  const isWslLauncher = /^.+[\\/]Windows[\\/](system32|SysWOW64)[\\/]bash\.exe$/i.test(bash ?? '');
  if (bash && !isWslLauncher) return [bash, '-c', command];
  return ['cmd', '/c', command];
}

/** 读取可读流全部文本（流为空/为 fd 数字时返回空串） */
async function readStream(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
): Promise<string> {
  if (!stream || typeof stream === 'number') return '';
  try {
    return await new Response(stream).text();
  } catch {
    return '';
  }
}

export const execCommandTool: Tool = {
  name: 'exec_command',
  description:
    '在工作目录中执行一条 shell 命令，返回标准输出、标准错误与退出码。用于运行构建、测试、git 等操作。命令通过系统 shell 执行（Windows 优先用 bash -c 以支持 mkdir -p 等 Unix 语法，找不到 bash 时回退 cmd /c；其余平台为 sh -c）。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的 shell 命令' },
      cwd: {
        type: 'string',
        description: '可选，命令运行目录（相对工作目录），缺省使用工具工作目录',
      },
    },
    required: ['command'],
  },
  timeoutMs: 60_000,
  async execute(params, ctx: ToolContext) {
    const command = String(params.command ?? '');
    if (!command.trim()) return failResult('command 不能为空');

    const workdir = params.cwd ? resolve(ctx.cwd, String(params.cwd)) : ctx.cwd;
    // Windows 下优先 Git Bash，排除 WSL 启动器后回退 cmd /c；非 Windows 平台使用 sh -c。
    let shellArgs: string[];
    if (process.platform === 'win32') {
      shellArgs = resolveWindowsShell(command);
    } else {
      shellArgs = ['sh', '-c', command];
    }

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(shellArgs, {
        cwd: workdir,
        stdout: 'pipe',
        stderr: 'pipe',
        signal: ctx.signal,
      });
    } catch (e) {
      return failResult(`启动命令失败: ${(e as Error).message}`);
    }

    const [stdout, stderr] = await Promise.all([
      readStream(proc.stdout),
      readStream(proc.stderr),
    ]);

    let code = -1;
    try {
      code = await proc.exited;
    } catch {
      code = -1;
    }

    const out = stdout.slice(0, 8000);
    const err = stderr.slice(0, 4000);

    if (code !== 0) {
      return failResult(
        `命令退出码 ${code}\n--- stdout ---\n${out}\n--- stderr ---\n${err}`,
        { code, stdout: out, stderr: err },
      );
    }
    const tail = err ? `\n--- stderr ---\n${err}` : '';
    return okResult(`命令执行成功（退出码 0）\n${out}${tail}`, {
      code,
      stdout: out,
      stderr: err,
    });
  },
};
