/**
 * SecurityGate — 安全决策主入口
 *
 * 串联 blacklist → sandbox → rules → policy → HITL 五层决策流，
 * 对每次 ToolCall 返回 allow/deny 决定及人类可读原因。
 *
 * 设计要点：
 * - 构造函数不能 await（TS 限制），通过 static async create() 工厂方法初始化
 * - session 规则纯内存（不落盘），project/global 规则由 RuleStore 持久化
 * - HITL 回调由 ctx.askUser 注入，未提供时保守拒绝
 * - options.mode / options.sandbox 为显式覆盖，优先于 ruleStore 中的配置
 */
import type {
  PermissionMode,
  Tool,
  ToolCall,
  ToolContext,
  SecurityRule,
  HitlRequest,
  HitlResponse,
} from '@wuzi/types';
import { matchBlacklist } from './blacklist.ts';
import { checkSandbox } from './sandbox.ts';
import { matchRules } from './rules.ts';
import { fallbackDecision } from './policy.ts';
import type { RuleStore } from './rule-store.ts';

/** SecurityGate 决策结果 */
export interface SecurityDecision {
  decision: 'allow' | 'deny';
  reason: string;
  layer: 'blacklist' | 'sandbox' | 'rules' | 'policy' | 'hitl';
  /** 规则来源层（仅 rules 层有值） */
  source?: 'session' | 'project' | 'global';
  /** 命中的规则（仅 rules 层有值） */
  rule?: SecurityRule;
}

/** SecurityGate 构造选项 */
export interface SecurityGateOptions {
  /** 规则持久化存储（任务8 实现） */
  ruleStore: RuleStore;
  /** 权限档位（显式覆盖 ruleStore；缺省 'default'） */
  mode?: PermissionMode;
  /** 沙箱允许的绝对路径数组（显式覆盖 ruleStore；缺省 []） */
  sandbox?: string[];
  /** 工具列表（用于档位兜底判定写类工具；缺省 []） */
  tools?: Tool[];
}

// 文件类工具集合（与 rules.ts 保持一致，用于主参数提取）
const FILE_TOOL_NAMES = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'find_files',
  'search_content',
]);

/**
 * 提取工具调用的主参数（用于 HITL 规则的 pattern 与 preview）
 *
 * 与 rules.ts 的提取规则保持一致：
 * - exec_command：arguments.command
 * - 文件类工具：arguments.path
 * - 其它工具：undefined（表示该工具所有调用都匹配）
 */
function extractMainArg(call: ToolCall): string | undefined {
  if (call.name === 'exec_command') {
    const v = call.arguments.command;
    return typeof v === 'string' ? v : undefined;
  }
  if (FILE_TOOL_NAMES.has(call.name)) {
    const v = call.arguments.path;
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

export class SecurityGate {
  private readonly ruleStore: RuleStore;
  /** 构造时显式提供的 mode（优先于 ruleStore）；undefined 表示从 ruleStore 加载 */
  private readonly modeOverride?: PermissionMode;
  /** 构造时显式提供的 sandbox（优先于 ruleStore）；undefined 表示从 ruleStore 加载 */
  private readonly sandboxOverride?: string[];
  private readonly tools: Tool[];

  private sessionRules: SecurityRule[] = [];
  private projectRules: SecurityRule[] = [];
  private globalRules: SecurityRule[] = [];
  private mode: PermissionMode = 'default';
  private sandbox: string[] = [];

  private constructor(options: SecurityGateOptions) {
    this.ruleStore = options.ruleStore;
    this.modeOverride = options.mode;
    this.sandboxOverride = options.sandbox;
    this.tools = options.tools ?? [];
  }

  /**
   * 异步工厂方法：构造实例并从 ruleStore 加载初始配置
   *
   * 因构造函数不能 await，通过此方法完成 reload 初始化。
   */
  static async create(options: SecurityGateOptions): Promise<SecurityGate> {
    const gate = new SecurityGate(options);
    await gate.reload();
    return gate;
  }

  /**
   * 重新从 ruleStore 加载 project/global 规则与 mode/sandbox
   *
   * - rules 总是从 ruleStore 重新加载
   * - mode/sandbox：若构造时显式提供（override），保持不变；否则从 ruleStore 加载
   * - session 规则纯内存，reload 不清空（由调用方按需管理）
   */
  async reload(): Promise<void> {
    const { global, project } = await this.ruleStore.loadRules();
    this.globalRules = global;
    this.projectRules = project;
    this.mode = this.modeOverride ?? (await this.ruleStore.loadMode());
    this.sandbox = this.sandboxOverride ?? (await this.ruleStore.loadSandbox());
  }

  /** 添加会话级规则（纯内存，不落盘） */
  addSessionRule(rule: SecurityRule): void {
    this.sessionRules.push(rule);
  }

  /** 返回当前会话规则的副本（供测试断言） */
  getSessionRules(): SecurityRule[] {
    return [...this.sessionRules];
  }

  /**
   * 串联决策流：blacklist → sandbox → rules → policy → HITL
   *
   * 任一层命中即短路返回；未命中进入下一层。
   * HITL 仅在 rules.action='ask' 或 policy='ask' 时触发。
   */
  async check(call: ToolCall, ctx: ToolContext): Promise<SecurityDecision> {
    // 1. blacklist：危险命令黑名单
    const blacklistHit = matchBlacklist(call.name, call.arguments);
    if (blacklistHit) {
      return {
        decision: 'deny',
        reason: `blacklist(${blacklistHit.category}): ${blacklistHit.reason}`,
        layer: 'blacklist',
      };
    }

    // 2. sandbox：路径沙箱越界检测
    const sandboxViolation = checkSandbox(
      call.name,
      call.arguments,
      { cwd: ctx.cwd },
      this.sandbox,
    );
    if (sandboxViolation) {
      return {
        decision: 'deny',
        reason: sandboxViolation.reason,
        layer: 'sandbox',
      };
    }

    // 3. rules：规则匹配（session > project > global）
    const ruleHit = matchRules(call, {
      session: this.sessionRules,
      project: this.projectRules,
      global: this.globalRules,
    });
    if (ruleHit) {
      if (ruleHit.action === 'deny') {
        return {
          decision: 'deny',
          reason: ruleHit.rule.reason ?? `规则拒绝(${ruleHit.source})`,
          layer: 'rules',
          source: ruleHit.source,
          rule: ruleHit.rule,
        };
      }
      if (ruleHit.action === 'allow') {
        return {
          decision: 'allow',
          reason: ruleHit.rule.reason ?? `规则放行(${ruleHit.source})`,
          layer: 'rules',
          source: ruleHit.source,
          rule: ruleHit.rule,
        };
      }
      // action === 'ask' → 进入 HITL
      return this.handleHitl(call, ctx, ruleHit.rule.reason ?? '规则要求询问用户');
    }

    // 4. policy：档位兜底
    const fallback = fallbackDecision(call.name, this.mode, this.tools);
    if (fallback === 'allow') {
      return {
        decision: 'allow',
        reason: '档位兜底放行',
        layer: 'policy',
      };
    }
    if (fallback === 'deny') {
      return {
        decision: 'deny',
        reason: '档位兜底拒绝',
        layer: 'policy',
      };
    }
    // fallback === 'ask' → 进入 HITL
    return this.handleHitl(call, ctx, '档位兜底需询问');
  }

  /**
   * HITL 处理：构造请求 → 调用 askUser → 按决策与 scope 处理
   *
   * - 未提供 askUser：保守拒绝
   * - allow + once：不入规则，放行
   * - allow + session：加入会话规则，放行
   * - allow + permanent：落盘到 project 规则，放行
   * - allow + cancel：保守拒绝
   * - deny + 任意 scope：拒绝（session/permanent 入规则）
   */
  private async handleHitl(
    call: ToolCall,
    ctx: ToolContext,
    reason: string,
  ): Promise<SecurityDecision> {
    if (!ctx.askUser) {
      return {
        decision: 'deny',
        reason: '需要用户授权但未提供 askUser 回调',
        layer: 'hitl',
      };
    }

    const pattern = extractMainArg(call);
    const req: HitlRequest = {
      tool: call.name,
      arguments: call.arguments,
      reason,
      preview: pattern,
    };

    const resp: HitlResponse = await ctx.askUser(req);

    // deny 决策：所有 scope 都返回拒绝
    if (resp.decision === 'deny') {
      if (resp.scope === 'session') {
        this.addSessionRule({
          tool: call.name,
          pattern,
          action: 'deny',
          source: 'session',
        });
      } else if (resp.scope === 'permanent') {
        await this.ruleStore.saveRuleToProject({
          tool: call.name,
          pattern,
          action: 'deny',
          reason: 'user_denied',
        });
      }
      // once / cancel：不入规则
      return {
        decision: 'deny',
        reason: '用户拒绝(user_denied)',
        layer: 'hitl',
      };
    }

    // allow 决策
    if (resp.scope === 'cancel') {
      // 保守视为 deny
      return {
        decision: 'deny',
        reason: '用户拒绝(user_denied)',
        layer: 'hitl',
      };
    }

    if (resp.scope === 'once') {
      return {
        decision: 'allow',
        reason: '用户授权(once)',
        layer: 'hitl',
      };
    }

    if (resp.scope === 'session') {
      this.addSessionRule({
        tool: call.name,
        pattern,
        action: 'allow',
        source: 'session',
      });
      return {
        decision: 'allow',
        reason: '用户授权(session)',
        layer: 'hitl',
      };
    }

    // permanent：落盘到 project 规则
    await this.ruleStore.saveRuleToProject({
      tool: call.name,
      pattern,
      action: 'allow',
      reason: 'user_allowed',
    });
    return {
      decision: 'allow',
      reason: '用户授权(permanent)',
      layer: 'hitl',
    };
  }
}
