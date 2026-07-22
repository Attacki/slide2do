/**
 * 规则持久化存储
 *
 * 读写 global + project 两层 config.yaml 的 security 配置段（rules / mode / sandbox）。
 * session 级规则仅内存，不落盘（由 SecurityGate 维护）。
 *
 * - loadRules() 保持分层、不合并（供规则引擎按 session > project > global 优先级匹配）
 * - loadMode()/loadSandbox() 取 project 优先于 global；都缺失时返回默认值
 * - saveRule*() 增量追加并保留其它字段（agent_role/llm/loop/active 等）；
 *   相同 {tool, pattern, action} 三元组不重复追加（去重）
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import * as yaml from 'js-yaml';
import type { SecurityRule, PermissionMode } from '@wuzi/types';

/** 规则存储路径：仅 global 与 project 两层（session 级仅内存，不持久化） */
export interface RuleStorePaths {
  global: string;
  project: string;
}

/** config.yaml 顶层结构（弱类型：保留其它未知字段以增量写回） */
type ConfigYaml = Record<string, unknown> & {
  security?: {
    mode?: PermissionMode;
    sandbox?: string[];
    rules?: SecurityRule[];
  };
};

export class RuleStore {
  constructor(private readonly paths: RuleStorePaths) {}

  /** 读取两层的 security.rules（不合并，保持分层） */
  async loadRules(): Promise<{ global: SecurityRule[]; project: SecurityRule[] }> {
    const global = await this.loadRulesFromPath(this.paths.global);
    const project = await this.loadRulesFromPath(this.paths.project);
    return { global, project };
  }

  /** 读取 security.mode：project 优先于 global；都缺失返回 'default' */
  async loadMode(): Promise<PermissionMode> {
    const project = await this.loadConfig(this.paths.project);
    if (project?.security?.mode) return project.security.mode;
    const global = await this.loadConfig(this.paths.global);
    if (global?.security?.mode) return global.security.mode;
    return 'default';
  }

  /** 读取 security.sandbox：project 优先于 global；都缺失返回 []（运行时由 SecurityGate/app 解析为 [cwd, projectDir]） */
  async loadSandbox(): Promise<string[]> {
    const project = await this.loadConfig(this.paths.project);
    if (Array.isArray(project?.security?.sandbox)) return project!.security!.sandbox!;
    const global = await this.loadConfig(this.paths.global);
    if (Array.isArray(global?.security?.sandbox)) return global!.security!.sandbox!;
    return [];
  }

  /** 增量写入项目级规则（rule.source 设为 'project'） */
  async saveRuleToProject(rule: SecurityRule): Promise<void> {
    await this.saveRuleToPath(this.paths.project, rule, 'project');
  }

  /** 增量写入全局规则（rule.source 设为 'global'） */
  async saveRuleToGlobal(rule: SecurityRule): Promise<void> {
    await this.saveRuleToPath(this.paths.global, rule, 'global');
  }

  private async loadRulesFromPath(path: string): Promise<SecurityRule[]> {
    const config = await this.loadConfig(path);
    const rules = config?.security?.rules;
    return Array.isArray(rules) ? (rules as SecurityRule[]) : [];
  }

  private async loadConfig(path: string): Promise<ConfigYaml | null> {
    if (!existsSync(path)) return null;
    try {
      const raw = await readFile(path, 'utf-8');
      return (yaml.load(raw) ?? null) as ConfigYaml | null;
    } catch {
      return null;
    }
  }

  private async saveRuleToPath(
    path: string,
    rule: SecurityRule,
    source: 'project' | 'global',
  ): Promise<void> {
    const config = ((await this.loadConfig(path)) ?? {}) as ConfigYaml;
    const security = config.security ?? {};
    if (!Array.isArray(security.rules)) security.rules = [];

    // 去重：相同 {tool, pattern, action} 三元组不重复追加
    const exists = security.rules.some(
      (r) =>
        r.tool === rule.tool &&
        r.pattern === rule.pattern &&
        r.action === rule.action,
    );
    if (!exists) {
      security.rules.push({ ...rule, source });
    }
    config.security = security;

    await mkdir(dirname(path), { recursive: true });
    const yamlContent = yaml.dump(config, { indent: 2, lineWidth: 120, noCompatMode: true });
    await writeFile(path, yamlContent, 'utf-8');
  }
}
