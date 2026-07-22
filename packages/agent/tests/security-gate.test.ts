/**
 * SecurityGate 单元测试
 *
 * 覆盖五层决策流（blacklist → sandbox → rules → policy → HITL）与 HITL 四种 scope。
 *
 * 测试组织：
 * - 用 mkdtempSync 创建临时目录构造真实 RuleStore（真实 IO 但隔离）
 * - mock askUser：用数组记录调用参数，返回预设 HitlResponse
 * - spy saveRuleToProject：包裹原方法计数调用与参数
 *
 * 覆盖 checklist 第 12~20 条端到端验收项。
 */
import { describe, it, expect, afterEach } from 'bun:test';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import * as yaml from 'js-yaml';
import { SecurityGate } from '../modules/security/security-gate.ts';
import { RuleStore, type RuleStorePaths } from '../modules/security/rule-store.ts';
import type {
  PermissionMode,
  Tool,
  ToolCall,
  ToolContext,
  SecurityRule,
  HitlRequest,
  HitlResponse,
} from '@wuzi/types';

// 测试用工具集：read_file（读类）、write_file / edit_file（写类）
const testTools: Tool[] = [
  {
    name: 'read_file',
    description: 'read file',
    parameters: {},
    mutates: false,
    execute: async () => ({ ok: true, content: '' }),
  },
  {
    name: 'write_file',
    description: 'write file',
    parameters: {},
    mutates: true,
    execute: async () => ({ ok: true, content: '' }),
  },
  {
    name: 'edit_file',
    description: 'edit file',
    parameters: {},
    mutates: true,
    execute: async () => ({ ok: true, content: '' }),
  },
];

interface SetupOptions {
  mode?: PermissionMode;
  sandbox?: string[];
  tools?: Tool[];
  globalRules?: SecurityRule[];
  projectRules?: SecurityRule[];
}

interface SetupResult {
  gate: SecurityGate;
  store: RuleStore;
  saveCalls: SecurityRule[];
  root: string;
  cwd: string;
  paths: RuleStorePaths;
  cleanup: () => void;
}

/**
 * 创建临时目录 + 真实 RuleStore + SecurityGate 实例
 *
 * - sandbox 未提供时默认 [cwd]，避免文件类工具被沙箱拦截
 * - saveRuleToProject 被 spy，调用参数记录到 saveCalls
 */
async function setupGate(opts: SetupOptions = {}): Promise<SetupResult> {
  const root = mkdtempSync(join(tmpdir(), 'security-gate-'));
  const cwd = join(root, 'project');
  mkdirSync(cwd, { recursive: true });

  const paths: RuleStorePaths = {
    global: join(root, 'global', '.wuzi', 'config.yaml'),
    project: join(root, 'project', '.wuzi', 'config.yaml'),
  };

  if (opts.globalRules) {
    writeYaml(paths.global, { security: { rules: opts.globalRules } });
  }
  if (opts.projectRules) {
    writeYaml(paths.project, { security: { rules: opts.projectRules } });
  }

  const store = new RuleStore(paths);
  const saveCalls: SecurityRule[] = [];
  const originalSave = store.saveRuleToProject.bind(store);
  store.saveRuleToProject = async (rule: SecurityRule) => {
    saveCalls.push(rule);
    return originalSave(rule);
  };

  const gate = await SecurityGate.create({
    ruleStore: store,
    mode: opts.mode,
    sandbox: opts.sandbox ?? [cwd],
    tools: opts.tools ?? testTools,
  });

  return {
    gate,
    store,
    saveCalls,
    root,
    cwd,
    paths,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeYaml(path: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    yaml.dump(data, { indent: 2, lineWidth: 120, noCompatMode: true }),
    'utf-8',
  );
}

function makeCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: 'test-call', name, arguments: args };
}

/** 创建 mock askUser：记录调用参数到 calls 数组，返回预设 response */
function makeAskUser(
  response: HitlResponse,
  calls: HitlRequest[] = [],
): (req: HitlRequest) => Promise<HitlResponse> {
  return async (req: HitlRequest): Promise<HitlResponse> => {
    calls.push(req);
    return response;
  };
}

function makeCtx(
  cwd: string,
  askUser?: (req: HitlRequest) => Promise<HitlResponse>,
): ToolContext {
  return askUser ? { cwd, askUser } : { cwd };
}

// 收集所有 setup 以便统一清理
const setups: SetupResult[] = [];
afterEach(() => {
  while (setups.length) {
    const s = setups.pop();
    try {
      s?.cleanup();
    } catch {
      // 忽略清理错误
    }
  }
});

async function setup(opts: SetupOptions = {}): Promise<SetupResult> {
  const s = await setupGate(opts);
  setups.push(s);
  return s;
}

describe('SecurityGate — 黑名单拦截', () => {
  it('shell: exec_command + "rm -rf /" → deny(layer:blacklist)', async () => {
    const { gate, cwd } = await setup({ mode: 'permissive' });
    const decision = await gate.check(
      makeCall('exec_command', { command: 'rm -rf /' }),
      makeCtx(cwd),
    );
    expect(decision.decision).toBe('deny');
    expect(decision.layer).toBe('blacklist');
    expect(decision.reason).toContain('blacklist');
  });

  it('git: exec_command + "git push --force origin main" → deny(layer:blacklist), reason 含 git', async () => {
    const { gate, cwd } = await setup({ mode: 'permissive' });
    const decision = await gate.check(
      makeCall('exec_command', { command: 'git push --force origin main' }),
      makeCtx(cwd),
    );
    expect(decision.decision).toBe('deny');
    expect(decision.layer).toBe('blacklist');
    expect(decision.reason.toLowerCase()).toContain('git');
  });
});

describe('SecurityGate — 沙箱', () => {
  it('越界路径 → deny(layer:sandbox)', async () => {
    // sandbox 未传时 setupGate 默认 [cwd]，无需显式传参（避免 cwd 解构前引用）
    const { gate, cwd } = await setup({ mode: 'permissive' });
    // Windows 用系统路径；其它平台用 /etc/passwd
    const outsidePath =
      process.platform === 'win32'
        ? 'C:\\Windows\\system32\\drivers\\etc\\hosts'
        : '/etc/passwd';
    const decision = await gate.check(
      makeCall('write_file', { path: outsidePath, content: 'x' }),
      makeCtx(cwd),
    );
    expect(decision.decision).toBe('deny');
    expect(decision.layer).toBe('sandbox');
  });

  it('沙箱内读类兜底 → allow(layer:policy)', async () => {
    const { gate, cwd } = await setup({ mode: 'default' });
    // 在 cwd 下创建文件（spec 要求 cwd 下存在该文件）
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'foo.ts'), '// test', 'utf-8');

    const decision = await gate.check(
      makeCall('read_file', { path: './src/foo.ts' }),
      makeCtx(cwd),
    );
    expect(decision.decision).toBe('allow');
    expect(decision.layer).toBe('policy');
    expect(decision.reason).toBe('档位兜底放行');
  });
});

describe('SecurityGate — 规则匹配', () => {
  it('project 规则 allow → allow(layer:rules, source:project)', async () => {
    const { gate, cwd } = await setup({
      mode: 'strict',
      projectRules: [
        { tool: 'exec_command', pattern: 'git status*', action: 'allow', source: 'project' },
      ],
    });
    const decision = await gate.check(
      makeCall('exec_command', { command: 'git status' }),
      makeCtx(cwd),
    );
    expect(decision.decision).toBe('allow');
    expect(decision.layer).toBe('rules');
    expect(decision.source).toBe('project');
    expect(decision.rule?.action).toBe('allow');
  });

  it('global 规则 deny → deny(layer:rules, source:global)', async () => {
    const { gate, cwd } = await setup({
      mode: 'permissive',
      globalRules: [
        { tool: 'exec_command', pattern: '*', action: 'deny', source: 'global' },
      ],
    });
    const decision = await gate.check(
      makeCall('exec_command', { command: 'ls' }),
      makeCtx(cwd),
    );
    expect(decision.decision).toBe('deny');
    expect(decision.layer).toBe('rules');
    expect(decision.source).toBe('global');
    expect(decision.rule?.action).toBe('deny');
  });

  it('优先级 session > project > global：git push 命中 session allow，git status 命中 project allow，ls 命中 global deny', async () => {
    const { gate, cwd } = await setup({
      mode: 'default',
      globalRules: [
        { tool: 'exec_command', pattern: '*', action: 'deny', source: 'global' },
      ],
      projectRules: [
        { tool: 'exec_command', pattern: 'git status*', action: 'allow', source: 'project' },
      ],
    });
    // 添加 session 规则
    gate.addSessionRule({
      tool: 'exec_command',
      pattern: 'git push*',
      action: 'allow',
      source: 'session',
    });

    // git push → session allow
    const d1 = await gate.check(
      makeCall('exec_command', { command: 'git push' }),
      makeCtx(cwd),
    );
    expect(d1.decision).toBe('allow');
    expect(d1.layer).toBe('rules');
    expect(d1.source).toBe('session');

    // git status → project allow
    const d2 = await gate.check(
      makeCall('exec_command', { command: 'git status' }),
      makeCtx(cwd),
    );
    expect(d2.decision).toBe('allow');
    expect(d2.layer).toBe('rules');
    expect(d2.source).toBe('project');

    // ls → global deny
    const d3 = await gate.check(
      makeCall('exec_command', { command: 'ls' }),
      makeCtx(cwd),
    );
    expect(d3.decision).toBe('deny');
    expect(d3.layer).toBe('rules');
    expect(d3.source).toBe('global');
  });
});

describe('SecurityGate — HITL', () => {
  it('once: strict + read_file + allow(once) → allow(layer:hitl)，不入规则，saveRuleToProject 未调用', async () => {
    const { gate, cwd, saveCalls } = await setup({ mode: 'strict' });
    const askUserCalls: HitlRequest[] = [];
    const ctx = makeCtx(cwd, makeAskUser({ decision: 'allow', scope: 'once' }, askUserCalls));

    const decision = await gate.check(
      makeCall('read_file', { path: './foo.ts' }),
      ctx,
    );
    expect(decision.decision).toBe('allow');
    expect(decision.layer).toBe('hitl');
    expect(decision.reason).toContain('once');
    expect(askUserCalls).toHaveLength(1);
    expect(saveCalls).toHaveLength(0);
    expect(gate.getSessionRules()).toHaveLength(0);
  });

  it('session: allow(session) → 第一次 hitl 放行；第二次命中 session 规则，askUser 不再调用', async () => {
    const { gate, cwd } = await setup({ mode: 'strict' });
    const askUserCalls: HitlRequest[] = [];
    const ctx = makeCtx(
      cwd,
      makeAskUser({ decision: 'allow', scope: 'session' }, askUserCalls),
    );
    const call = makeCall('read_file', { path: './foo.ts' });

    // 第一次：进入 HITL，askUser 被调用，加入 session 规则
    const d1 = await gate.check(call, ctx);
    expect(d1.decision).toBe('allow');
    expect(d1.layer).toBe('hitl');
    expect(d1.reason).toContain('session');
    expect(askUserCalls).toHaveLength(1);
    expect(gate.getSessionRules()).toHaveLength(1);

    // 第二次：命中 session 规则，askUser 不再调用
    const d2 = await gate.check(call, ctx);
    expect(d2.decision).toBe('allow');
    expect(d2.layer).toBe('rules');
    expect(d2.source).toBe('session');
    expect(askUserCalls).toHaveLength(1); // 仍然是 1，未增加
  });

  it('permanent: allow(permanent) → saveRuleToProject 被调用一次，参数含 {tool, pattern, action:allow}', async () => {
    const { gate, cwd, saveCalls } = await setup({ mode: 'strict' });
    const ctx = makeCtx(cwd, makeAskUser({ decision: 'allow', scope: 'permanent' }));

    const decision = await gate.check(
      makeCall('exec_command', { command: 'ls' }),
      ctx,
    );
    expect(decision.decision).toBe('allow');
    expect(decision.layer).toBe('hitl');
    expect(decision.reason).toContain('permanent');
    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0].tool).toBe('exec_command');
    expect(saveCalls[0].pattern).toBe('ls');
    expect(saveCalls[0].action).toBe('allow');
    expect(saveCalls[0].reason).toBe('user_allowed');
  });

  it('deny: deny(once) → deny(layer:hitl)，reason 含 user_denied，不入规则', async () => {
    const { gate, cwd, saveCalls } = await setup({ mode: 'strict' });
    const ctx = makeCtx(cwd, makeAskUser({ decision: 'deny', scope: 'once' }));

    const decision = await gate.check(
      makeCall('read_file', { path: './foo.ts' }),
      ctx,
    );
    expect(decision.decision).toBe('deny');
    expect(decision.layer).toBe('hitl');
    expect(decision.reason).toContain('user_denied');
    expect(saveCalls).toHaveLength(0);
    expect(gate.getSessionRules()).toHaveLength(0);
  });

  it('askUser 未定义 + strict + 写类工具 → deny(layer:hitl)，reason 含 "未提供 askUser"', async () => {
    const { gate, cwd } = await setup({ mode: 'strict' });
    // ctx 不传 askUser
    const ctx = makeCtx(cwd);

    const decision = await gate.check(
      makeCall('write_file', { path: './foo.ts', content: 'x' }),
      ctx,
    );
    expect(decision.decision).toBe('deny');
    expect(decision.layer).toBe('hitl');
    expect(decision.reason).toContain('未提供 askUser');
  });
});

describe('SecurityGate — reload 与 session 规则管理', () => {
  it('reload() 重新加载 project/global 规则；session 规则不受影响', async () => {
    const { gate, cwd, paths } = await setup({
      mode: 'default',
      projectRules: [
        { tool: 'exec_command', pattern: 'ls*', action: 'allow', source: 'project' },
      ],
    });

    // 初始：ls 命中 project allow
    const d1 = await gate.check(
      makeCall('exec_command', { command: 'ls' }),
      makeCtx(cwd),
    );
    expect(d1.decision).toBe('allow');
    expect(d1.source).toBe('project');

    // 添加 session 规则
    gate.addSessionRule({
      tool: 'exec_command',
      pattern: 'ls*',
      action: 'deny',
      source: 'session',
    });
    expect(gate.getSessionRules()).toHaveLength(1);

    // 修改 project 规则文件（移除规则）
    writeYaml(paths.project, { security: { rules: [] } });

    // reload：project 规则清空，但 session 规则保留
    await gate.reload();
    expect(gate.getSessionRules()).toHaveLength(1);

    // ls 现在命中 session deny（project 规则已清空）
    const d2 = await gate.check(
      makeCall('exec_command', { command: 'ls' }),
      makeCtx(cwd),
    );
    expect(d2.decision).toBe('deny');
    expect(d2.layer).toBe('rules');
    expect(d2.source).toBe('session');
  });
});
