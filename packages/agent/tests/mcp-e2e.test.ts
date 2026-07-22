/**
 * MCP 端到端测试（checklist [T9]）
 *
 * 覆盖 6 个场景：
 *  - [T9-1] stdio E2E：真实 stdio mock MCP server（bun -e 内联脚本），
 *    McpConnectionPool 拉取工具 → adapter.execute → ToolResult.content 含回声
 *  - [T9-2] http E2E：Bun.serve mock MCP server，同上链路验证 echo 工具
 *  - [T9-3] 同名工具无冲突：srv1 / srv2 都暴露 echo，注册后 ToolRegistry.list 同时包含
 *    mcp__srv1__echo 与 mcp__srv2__echo，且可独立调用
 *  - [T9-4] server 崩溃容忍：stdio 子进程被外部 kill → 下次 execute 返回 { ok:false, error }
 *    结构化结果，不抛异常
 *  - [T9-5] closeMcp 终止子进程：agent.closeMcp() 后 proc.killed === true 或 exitCode 非 null
 *  - [T9-6] HTTP 复用：两次连续调用间复用同一 McpClient（server 端 initializeCount === 1）
 *
 * 设计要点：
 *  - 使用 McpConnectionPool 的 defaultFactory，由 StdioTransport 内部调用 Bun.spawn
 *    起子进程（命令为 `bun -e <SCRIPT>`），完整覆盖 stdio 链路
 *  - HTTP server 用 Bun.serve({ port: 0 }) 监听随机端口，结束后 server.stop() 清理
 *  - 每个用例独立 spawn / 起 server，try/finally 保证清理
 *  - withTimeout helper 兜底所有异步操作（5s），避免子进程卡死拖垮测试
 *  - 白盒访问 pool.clients / client.transport.proc 验证子进程生命周期
 */
import { test, expect } from 'bun:test';
import type { McpServerConfig, ToolContext } from '@wuzi/types';
import { McpConnectionPool } from '../modules/mcp/mcp-registry.ts';
import type { McpClient } from '../modules/mcp/mcp-client.ts';
import { ToolRegistry } from '../modules/tools/tool-registry.ts';
import { Agent } from '../agent.ts';
import type { ILLMProvider, StreamCallback, StreamChatParams } from '../provider/base.ts';
import type { LLMConfig } from '../utils/config/config-types.ts';

// ============== stdio mock server 单行脚本 ==============
// 协议：读 stdin 一行 JSON → JSON.parse → 按 method 分派 → JSON.stringify + '\n' 写回 stdout
//  - initialize          → 回包 { protocolVersion, serverInfo, capabilities }
//  - notifications/initialized → 不回包（notification）
//  - tools/list           → 回包 { tools: [echo] }
//  - tools/call (echo)    → 回包 { content: [{type:'text', text: params.arguments.text}] }
// 单行 -e 脚本，避免 Windows 多行 quoting 问题；用 `;` 分隔语句
const STDIO_SERVER_SCRIPT =
  "process.stdin.setEncoding('utf8');let buf='';process.stdin.on('data',c=>{buf+=c;let i;while((i=buf.indexOf('\\n'))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);if(!l)continue;try{const m=JSON.parse(l);const id=m.id;if(m.method==='initialize'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:id,result:{protocolVersion:'2024-11-05',serverInfo:{name:'mock-stdio',version:'1.0.0'},capabilities:{tools:{}}}})+'\\n');}else if(m.method==='notifications/initialized'){}else if(m.method==='tools/list'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:id,result:{tools:[{name:'echo',description:'Echo input',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]}})+'\\n');}else if(m.method==='tools/call'){const t=(m.params&&m.params.arguments&&m.params.arguments.text)||'';process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:id,result:{content:[{type:'text',text:t}]}})+'\\n');}}catch(e){}}});";

// ============== helpers ==============
const ctx: ToolContext = { cwd: process.cwd() };

/** stdio 形态 McpServerConfig：用 bun -e 内联脚本起 mock server */
function stdioConfig(name: string, timeoutMs = 5000): McpServerConfig {
  return {
    type: 'stdio',
    name,
    command: process.execPath,
    args: ['-e', STDIO_SERVER_SCRIPT],
    timeoutMs,
  };
}

/** http 形态 McpServerConfig */
function httpConfig(name: string, url: string, timeoutMs = 5000): McpServerConfig {
  return {
    type: 'http',
    name,
    url,
    timeoutMs,
  };
}

/** race 一个 promise 与超时，避免子进程 / fetch 卡死拖垮测试 */
function withTimeout<T>(p: Promise<T>, ms: number, msg = 'timeout'): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
  ]);
}

/** 启动 HTTP mock MCP server：监听随机端口，记录 initialize 调用次数 */
function startHttpServer(): {
  server: ReturnType<typeof Bun.serve>;
  url: string;
  getInitializeCount: () => number;
} {
  let initializeCount = 0;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const body = await req.text();
      let m: { id?: string | number; method?: string; params?: { arguments?: { text?: string } } };
      try {
        m = JSON.parse(body);
      } catch {
        return new Response('bad json', { status: 400 });
      }
      const id = m.id;
      let result: unknown = null;
      if (m.method === 'initialize') {
        initializeCount++;
        result = {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'mock-http', version: '1.0.0' },
          capabilities: { tools: {} },
        };
      } else if (m.method === 'notifications/initialized') {
        // notification 无需回包；返回空 JSON body 避免客户端日志噪音
        return new Response('', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      } else if (m.method === 'tools/list') {
        result = {
          tools: [
            {
              name: 'echo',
              description: 'Echo input',
              inputSchema: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
              },
            },
          ],
        };
      } else if (m.method === 'tools/call') {
        const t = m.params?.arguments?.text ?? '';
        result = { content: [{ type: 'text', text: t }] };
      } else {
        return new Response('not found', { status: 404 });
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  return {
    server,
    url: `http://127.0.0.1:${server.port}/`,
    getInitializeCount: () => initializeCount,
  };
}

/** 白盒：从 pool 取出已缓存的 McpClient */
function getInternalClient(pool: McpConnectionPool, name: string): McpClient {
  const internal = pool as unknown as { clients: Map<string, McpClient> };
  const client = internal.clients.get(name);
  if (!client) throw new Error(`client "${name}" not found in pool`);
  return client;
}

/** 白盒：从 McpClient 取出 transport.proc（StdioTransport 内部子进程句柄） */
function getInternalProc(client: McpClient): {
  killed: boolean;
  exitCode: number | null;
  exited: Promise<number | null>;
  kill: () => void;
} {
  const ci = client as unknown as {
    transport: {
      proc: {
        killed: boolean;
        exitCode: number | null;
        exited: Promise<number | null>;
        kill: () => void;
      } | null;
    };
  };
  const proc = ci.transport.proc;
  if (!proc) throw new Error('transport.proc is null');
  return proc;
}

/** 空 streamChat 的 fake provider（用于构造最小可运行 Agent） */
class EmptyFakeProvider implements ILLMProvider {
  readonly protocol = 'fake';
  async streamChat(_params: StreamChatParams, _onEvent: StreamCallback): Promise<void> {
    /* no-op */
  }
}

const fakeConfig = {
  protocol: 'fake',
  model: 'm',
  base_url: 'http://localhost',
  api_key: 'k',
} as unknown as LLMConfig;

// ============== tests ==============

test('[T9-1] stdio E2E：McpConnectionPool.getTools → echo.execute → content 含回声', async () => {
  const pool = new McpConnectionPool([stdioConfig('srv1')]);
  try {
    const tools = await withTimeout(pool.getTools(), 5000, 'getTools timeout');
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('mcp__srv1__echo');

    const result = await withTimeout(
      tools[0]!.execute({ text: 'hello-stdio' }, ctx),
      5000,
      'execute timeout',
    );
    expect(result.ok).toBe(true);
    expect(result.content).toBe('hello-stdio');
  } finally {
    await pool.close();
  }
});

test('[T9-2] http E2E：Bun.serve mock → echo 工具 → 正确结果', async () => {
  const { server, url } = startHttpServer();
  try {
    const pool = new McpConnectionPool([httpConfig('srv-http', url)]);
    const tools = await withTimeout(pool.getTools(), 5000, 'getTools timeout');
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('mcp__srv-http__echo');

    const result = await withTimeout(
      tools[0]!.execute({ text: 'hello-http' }, ctx),
      5000,
      'execute timeout',
    );
    expect(result.ok).toBe(true);
    expect(result.content).toBe('hello-http');
    await pool.close();
  } finally {
    server.stop();
  }
});

test('[T9-3] 同名工具无冲突：srv1 / srv2 都暴露 echo → 注册后两者皆可独立调用', async () => {
  const pool = new McpConnectionPool([stdioConfig('srv1'), stdioConfig('srv2')]);
  try {
    const tools = await withTimeout(pool.getTools(), 5000, 'getTools timeout');
    expect(tools).toHaveLength(2);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['mcp__srv1__echo', 'mcp__srv2__echo']);

    // 注册进 ToolRegistry（验证 register 不抛错，list 同时包含两者）
    const reg = new ToolRegistry();
    for (const t of tools) reg.register(t);
    expect(reg.list()).toHaveLength(2);
    expect(reg.has('mcp__srv1__echo')).toBe(true);
    expect(reg.has('mcp__srv2__echo')).toBe(true);

    // 两者皆可独立调用，结果互不干扰
    const r1 = await withTimeout(
      reg.get('mcp__srv1__echo')!.execute({ text: 'from-srv1' }, ctx),
      5000,
    );
    const r2 = await withTimeout(
      reg.get('mcp__srv2__echo')!.execute({ text: 'from-srv2' }, ctx),
      5000,
    );
    expect(r1.ok).toBe(true);
    expect(r1.content).toBe('from-srv1');
    expect(r2.ok).toBe(true);
    expect(r2.content).toBe('from-srv2');
  } finally {
    await pool.close();
  }
});

test('[T9-4] server 崩溃容忍：stdio 子进程被外部 kill → 下次 execute 返回 { ok:false, error }，不抛异常', async () => {
  // 用较短超时，让 kill 后的 pending 请求快速失败（无论走 timeout 还是 client closed 路径）
  const pool = new McpConnectionPool([stdioConfig('srv-crash', 1500)]);
  try {
    const tools = await withTimeout(pool.getTools(), 5000, 'getTools timeout');
    expect(tools).toHaveLength(1);
    const echo = tools[0]!;

    // 正常调用一次，确认 server 健康
    const ok = await withTimeout(echo.execute({ text: 'before-kill' }, ctx), 5000);
    expect(ok.ok).toBe(true);
    expect(ok.content).toBe('before-kill');

    // 取出内部 proc 并 kill（模拟外部崩溃）
    const client = getInternalClient(pool, 'srv-crash');
    const proc = getInternalProc(client);
    proc.kill();

    // 下次 execute 应返回结构化错误，不抛异常
    // 超时兜底 5s（覆盖 client closed reject ~100ms 与 timeout 1.5s 两种路径）
    const result = await withTimeout(
      echo.execute({ text: 'after-kill' }, ctx),
      5000,
      'post-kill execute timeout',
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);

    // 等待子进程完全退出，避免影响后续测试
    await proc.exited.catch(() => {});
  } finally {
    await pool.close();
  }
});

test('[T9-5] closeMcp 终止子进程：agent.closeMcp() 后 proc.killed=true 或 exitCode 非 null', async () => {
  const pool = new McpConnectionPool([stdioConfig('srv-close')]);
  const agent = new Agent({
    provider: new EmptyFakeProvider(),
    config: fakeConfig,
    systemPrompt: 'sys',
    tools: new ToolRegistry(),
    toolContext: { cwd: process.cwd() },
    mcpPool: pool,
  });

  // 触发握手与缓存
  await withTimeout(agent.initMcp(), 5000, 'initMcp timeout');

  // close 前拿到 proc 引用
  const client = getInternalClient(pool, 'srv-close');
  const proc = getInternalProc(client);

  await agent.closeMcp();
  // 等待子进程退出（kill 后异步退出）
  await proc.exited.catch(() => {});

  // 满足任一条件即视为 kill 生效：proc.killed === true 或 exitCode 非 null
  // exitCode === null 表示被信号终止，也视为 kill 生效，故 !== null 即可
  const killed = proc.killed === true || proc.exitCode !== null;
  expect(killed).toBe(true);

  // 幂等：再次调用不抛错
  await expect(agent.closeMcp()).resolves.toBeUndefined();
});

test('[T9-6] HTTP 复用：两次连续调用间复用同一 McpClient（server 端 initializeCount === 1）', async () => {
  const { server, url, getInitializeCount } = startHttpServer();
  try {
    const pool = new McpConnectionPool([httpConfig('srv-reuse', url)]);
    const tools = await withTimeout(pool.getTools(), 5000, 'getTools timeout');
    expect(tools).toHaveLength(1);

    // 第一次调用
    const r1 = await withTimeout(tools[0]!.execute({ text: 'call-1' }, ctx), 5000);
    expect(r1.ok).toBe(true);
    expect(r1.content).toBe('call-1');

    // 第二次连续调用
    const r2 = await withTimeout(tools[0]!.execute({ text: 'call-2' }, ctx), 5000);
    expect(r2.ok).toBe(true);
    expect(r2.content).toBe('call-2');

    // 复用验证：initialize 仍为 1 次（首次握手后未重连）
    expect(getInitializeCount()).toBe(1);

    await pool.close();
  } finally {
    server.stop();
  }
});
