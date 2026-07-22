/**
 * RuleStore 单元测试
 *
 * 使用 fs.mkdtempSync 创建临时目录作为 global/project 路径（真实 IO 但隔离）。
 *
 * 覆盖：
 * - 加载合并：global + project 两层 security.rules 分层返回；loadMode()/loadSandbox() 返回 project 优先值
 * - 写入项目级：saveRuleToProject 后重新读 project config.yaml 确认 rule 入库（source='project'），其它字段（agent_role 等）保留
 * - 写入全局：saveRuleToGlobal 后重新读 global config.yaml 确认含 rule（source='global'）
 * - 缺省返回：global/project 文件都不存在时各 load 方法返回默认值
 * - project 优先于 global：global mode='strict'，project mode='permissive'，loadMode() 返回 'permissive'
 * - 去重：两次 saveRule 相同 rule，security.rules 只含一条
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import * as yaml from 'js-yaml';
import { RuleStore, type RuleStorePaths } from '../modules/security/rule-store.ts';
import type { SecurityRule } from '@wuzi/types';

interface TempSetup {
  root: string;
  paths: RuleStorePaths;
}

function setupTemp(): TempSetup {
  const root = mkdtempSync(join(tmpdir(), 'rule-store-'));
  return {
    root,
    paths: {
      global: join(root, 'global', '.wuzi', 'config.yaml'),
      project: join(root, 'project', '.wuzi', 'config.yaml'),
    },
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

function readYaml<T = Record<string, unknown>>(path: string): T {
  return yaml.load(readFileSync(path, 'utf-8')) as T;
}

function rule(
  tool: string,
  action: SecurityRule['action'],
  pattern?: string,
): SecurityRule {
  return pattern === undefined ? { tool, action } : { tool, action, pattern };
}

describe('RuleStore — 加载合并 (global + project 两层)', () => {
  let setup: TempSetup;
  beforeEach(() => {
    setup = setupTemp();
  });
  afterEach(() => {
    rmSync(setup.root, { recursive: true, force: true });
  });

  it('loadRules() 返回两层数组（不合并）', async () => {
    writeYaml(setup.paths.global, {
      agent_role: 'coding',
      security: {
        rules: [
          { tool: 'exec_command', action: 'deny', pattern: 'rm -rf *', source: 'global' },
        ],
      },
    });
    writeYaml(setup.paths.project, {
      active: 'anthropic',
      security: {
        rules: [
          { tool: 'write_file', action: 'ask', pattern: 'src/**', source: 'project' },
        ],
      },
    });

    const store = new RuleStore(setup.paths);
    const result = await store.loadRules();
    expect(result.global).toHaveLength(1);
    expect(result.global[0].tool).toBe('exec_command');
    expect(result.global[0].action).toBe('deny');
    expect(result.project).toHaveLength(1);
    expect(result.project[0].tool).toBe('write_file');
    expect(result.project[0].action).toBe('ask');
  });

  it('loadMode()/loadSandbox() 返回 project 优先值', async () => {
    writeYaml(setup.paths.global, {
      security: { mode: 'strict', sandbox: ['/global/path'] },
    });
    writeYaml(setup.paths.project, {
      security: { mode: 'permissive', sandbox: ['/project/path'] },
    });

    const store = new RuleStore(setup.paths);
    expect(await store.loadMode()).toBe('permissive');
    expect(await store.loadSandbox()).toEqual(['/project/path']);
  });
});

describe('RuleStore — 写入项目级', () => {
  let setup: TempSetup;
  beforeEach(() => {
    setup = setupTemp();
  });
  afterEach(() => {
    rmSync(setup.root, { recursive: true, force: true });
  });

  it('saveRuleToProject(rule) 后重新读取 project config.yaml 确认含 rule（source="project"），其它字段保留', async () => {
    writeYaml(setup.paths.project, {
      agent_role: 'coding',
      active: 'anthropic',
      llm: [
        {
          protocol: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          base_url: 'https://api.anthropic.com',
          api_key: 'k',
        },
      ],
    });

    const store = new RuleStore(setup.paths);
    await store.saveRuleToProject(rule('exec_command', 'ask', 'git push*'));

    const cfg = readYaml<Record<string, any>>(setup.paths.project);
    expect(cfg.agent_role).toBe('coding');
    expect(cfg.active).toBe('anthropic');
    expect(Array.isArray(cfg.llm)).toBe(true);
    expect(cfg.llm[0].protocol).toBe('anthropic');
    expect(cfg.llm[0].api_key).toBe('k');
    expect(Array.isArray(cfg.security?.rules)).toBe(true);
    expect(cfg.security.rules).toHaveLength(1);
    expect(cfg.security.rules[0].tool).toBe('exec_command');
    expect(cfg.security.rules[0].action).toBe('ask');
    expect(cfg.security.rules[0].pattern).toBe('git push*');
    expect(cfg.security.rules[0].source).toBe('project');
  });
});

describe('RuleStore — 写入全局', () => {
  let setup: TempSetup;
  beforeEach(() => {
    setup = setupTemp();
  });
  afterEach(() => {
    rmSync(setup.root, { recursive: true, force: true });
  });

  it('saveRuleToGlobal(rule) 后重新读取 global config.yaml 确认含 rule（source="global"）；文件不存在时自动创建目录与文件', async () => {
    // global 文件初始不存在，验证 mkdir recursive + 自动创建
    expect(existsSync(setup.paths.global)).toBe(false);

    const store = new RuleStore(setup.paths);
    await store.saveRuleToGlobal(rule('write_file', 'deny', '/etc/**'));

    expect(existsSync(setup.paths.global)).toBe(true);
    const cfg = readYaml<Record<string, any>>(setup.paths.global);
    expect(Array.isArray(cfg.security?.rules)).toBe(true);
    expect(cfg.security.rules).toHaveLength(1);
    expect(cfg.security.rules[0].tool).toBe('write_file');
    expect(cfg.security.rules[0].action).toBe('deny');
    expect(cfg.security.rules[0].pattern).toBe('/etc/**');
    expect(cfg.security.rules[0].source).toBe('global');
  });
});

describe('RuleStore — 缺省返回', () => {
  let setup: TempSetup;
  beforeEach(() => {
    setup = setupTemp();
  });
  afterEach(() => {
    rmSync(setup.root, { recursive: true, force: true });
  });

  it('global/project 文件都不存在时，loadRules() 返回 {global:[], project:[]}', async () => {
    const store = new RuleStore(setup.paths);
    const result = await store.loadRules();
    expect(result.global).toEqual([]);
    expect(result.project).toEqual([]);
  });

  it('global/project 文件都不存在时，loadMode() 返回 "default"', async () => {
    const store = new RuleStore(setup.paths);
    expect(await store.loadMode()).toBe('default');
  });

  it('global/project 文件都不存在时，loadSandbox() 返回 []', async () => {
    const store = new RuleStore(setup.paths);
    expect(await store.loadSandbox()).toEqual([]);
  });

  it('security 段缺失时，loadRules/loadMode/loadSandbox 返回默认值', async () => {
    writeYaml(setup.paths.global, { agent_role: 'coding' });
    writeYaml(setup.paths.project, { active: 'anthropic' });

    const store = new RuleStore(setup.paths);
    const result = await store.loadRules();
    expect(result.global).toEqual([]);
    expect(result.project).toEqual([]);
    expect(await store.loadMode()).toBe('default');
    expect(await store.loadSandbox()).toEqual([]);
  });
});

describe('RuleStore — project 优先于 global', () => {
  let setup: TempSetup;
  beforeEach(() => {
    setup = setupTemp();
  });
  afterEach(() => {
    rmSync(setup.root, { recursive: true, force: true });
  });

  it('global mode="strict"，project mode="permissive"，loadMode() 返回 "permissive"', async () => {
    writeYaml(setup.paths.global, { security: { mode: 'strict' } });
    writeYaml(setup.paths.project, { security: { mode: 'permissive' } });

    const store = new RuleStore(setup.paths);
    expect(await store.loadMode()).toBe('permissive');
  });

  it('仅 global 有 mode 时，loadMode() 回退到 global 的值', async () => {
    writeYaml(setup.paths.global, { security: { mode: 'strict' } });
    // project 文件存在但无 security.mode
    writeYaml(setup.paths.project, { agent_role: 'coding' });

    const store = new RuleStore(setup.paths);
    expect(await store.loadMode()).toBe('strict');
  });

  it('仅 global 有 sandbox 时，loadSandbox() 回退到 global 的值', async () => {
    writeYaml(setup.paths.global, { security: { sandbox: ['/global/path'] } });
    writeYaml(setup.paths.project, { agent_role: 'coding' });

    const store = new RuleStore(setup.paths);
    expect(await store.loadSandbox()).toEqual(['/global/path']);
  });
});

describe('RuleStore — 去重', () => {
  let setup: TempSetup;
  beforeEach(() => {
    setup = setupTemp();
  });
  afterEach(() => {
    rmSync(setup.root, { recursive: true, force: true });
  });

  it('saveRule 两次相同 rule，security.rules 只含一条', async () => {
    const store = new RuleStore(setup.paths);
    const r = rule('exec_command', 'allow', 'git status*');
    await store.saveRuleToProject(r);
    await store.saveRuleToProject(r);

    const cfg = readYaml<Record<string, any>>(setup.paths.project);
    expect(cfg.security.rules).toHaveLength(1);
    expect(cfg.security.rules[0].source).toBe('project');
  });

  it('不同 pattern 不去重', async () => {
    const store = new RuleStore(setup.paths);
    await store.saveRuleToProject(rule('exec_command', 'allow', 'git status*'));
    await store.saveRuleToProject(rule('exec_command', 'allow', 'git push*'));

    const cfg = readYaml<Record<string, any>>(setup.paths.project);
    expect(cfg.security.rules).toHaveLength(2);
  });

  it('不同 action 不去重', async () => {
    const store = new RuleStore(setup.paths);
    await store.saveRuleToProject(rule('exec_command', 'allow', 'git status*'));
    await store.saveRuleToProject(rule('exec_command', 'deny', 'git status*'));

    const cfg = readYaml<Record<string, any>>(setup.paths.project);
    expect(cfg.security.rules).toHaveLength(2);
  });

  it('无 pattern 的 rule 与同 tool+action 的无 pattern rule 去重', async () => {
    const store = new RuleStore(setup.paths);
    await store.saveRuleToProject(rule('exec_command', 'allow'));
    await store.saveRuleToProject(rule('exec_command', 'allow'));

    const cfg = readYaml<Record<string, any>>(setup.paths.project);
    expect(cfg.security.rules).toHaveLength(1);
  });
});
