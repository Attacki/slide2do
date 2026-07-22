/**
 * StdioTransport 单元测试
 *
 * 使用 `bun -e` 内联脚本作为 echo server：
 * - 读取 stdin 一行 → 原样回写 stdout（+ '\n'）
 * - 收到 method === 'exit' 的消息 → process.exit(0)
 *
 * Windows 兼容：使用 process.execPath（bun 可执行文件路径）+ `-e` 单行脚本，避免依赖系统 shell。
 */
import { test, expect } from 'bun:test';
import { StdioTransport } from '../modules/mcp/transport.ts';

// 单行 echo server 脚本（避免 Windows 命令行多行 / quoting 问题）
// 流程：setEncoding → 维护 buf → 按 \n 切分 → JSON.parse 检测 method==='exit' → 否则原样回写
const ECHO_SCRIPT =
  "process.stdin.setEncoding('utf8');let buf='';process.stdin.on('data',c=>{buf+=c;let i;while((i=buf.indexOf('\\n'))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);if(!l)continue;try{const m=JSON.parse(l);if(m.method==='exit'){process.exit(0);}}catch(e){}process.stdout.write(l+'\\n');}});";

function spawnEchoTransport(): StdioTransport {
  return new StdioTransport({
    command: process.execPath,
    args: ['-e', ECHO_SCRIPT],
  });
}

/** 等待 promise，超时则 reject（用于测试异步回调） */
function withTimeout<T>(p: Promise<T>, ms: number, msg = 'timeout'): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
  ]);
}

test('echo server: send JSON → onMessage 收到回包', async () => {
  const transport = spawnEchoTransport();
  let resolveMsg!: (raw: string) => void;
  const received = new Promise<string>((r) => {
    resolveMsg = r;
  });
  transport.onMessage((raw) => resolveMsg(raw));
  transport.start();
  transport.send({ jsonrpc: '2.0', id: 1, method: 'echo', params: { x: 1 } });

  const raw = await withTimeout(received, 2000, 'echo timeout');
  expect(raw).toContain('"method":"echo"');
  expect(raw).toContain('"id":1');
  transport.close();
});

test('子进程主动退出 → onClose 触发', async () => {
  const transport = spawnEchoTransport();
  let resolveClose!: () => void;
  const closed = new Promise<void>((r) => {
    resolveClose = r;
  });
  transport.onClose(() => resolveClose());
  transport.start();
  // 发送 exit 消息 → 子进程 process.exit(0)
  transport.send({ jsonrpc: '2.0', method: 'exit' });

  await withTimeout(closed, 2000, 'onClose timeout');
  // 清理（子进程已退出，close 幂等）
  transport.close();
});

test('close() → 子进程被 kill，重复调用不报错', async () => {
  const transport = spawnEchoTransport();
  transport.start();
  // 等待子进程启动
  await new Promise((r) => setTimeout(r, 100));

  const internal = transport as unknown as {
    proc: {
      killed: boolean;
      kill: () => void;
      exited: Promise<number | null>;
      exitCode: number | null;
    } | null;
  };
  const proc = internal.proc;
  expect(proc).toBeDefined();

  transport.close();
  // 等待子进程退出（kill 后异步退出）
  await proc!.exited.catch(() => {});
  // 满足任一条件即视为 kill 生效：proc.killed === true 或 exitCode 非 0
  // （exitCode 为 null 表示被信号终止，也视为 kill 生效，故 !== 0 即可）
  const killed = proc!.killed === true || proc!.exitCode !== 0;
  expect(killed).toBe(true);
  // 重复调用不报错
  expect(() => transport.close()).not.toThrow();
});
