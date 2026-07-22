/**
 * ContextManager — 运行时环境信息收集与消息化
 *
 * 将工作目录、操作系统等环境信息从全局指令中剥离，作为对话首条
 * 系统级补充消息（kind:'env_info'）动态注入。环境变化不再导致稳定 system 段缓存失效。
 *
 * 预留 `registerField(name, provider)` 扩展点，允许后续注入 Git 状态、项目技术栈等
 * 进阶环境字段，无需改动本模块核心逻辑。
 */

import type { ChatMessage } from '../../ui-pattern.ts';

/** 自定义环境字段提供者：同步或异步返回字符串值 */
export type EnvFieldProvider = () => string | Promise<string>;

/** 环境信息结构 */
export interface EnvInfo {
  /** 当前工作目录 */
  cwd: string;
  /** 操作系统平台（process.platform，如 'win32' / 'darwin' / 'linux'） */
  platform: string;
  /** CPU 架构（process.arch，如 'x64' / 'arm64'） */
  arch: string;
  /** 自定义扩展字段（name -> 值） */
  custom: Record<string, string>;
}

/**
 * 收集并对外提供运行时环境信息。
 *
 * 基础字段（cwd/platform/arch）每次调用现取，保证时效性；
 * 自定义字段通过 `registerField` 注册的 provider 异步采集。
 */
export class ContextManager {
  /** 自定义字段注册表：name -> provider */
  private readonly fields = new Map<string, EnvFieldProvider>();

  /**
   * 注册自定义环境字段。
   *
   * 后续 `getEnvInfo()` 调用时会执行 provider 采集值，注入到 `EnvInfo.custom`。
   * 同名字段重复注册将覆盖前者。
   *
   * @param name 字段名（如 'gitBranch' / 'nodeVersion'）
   * @param provider 值提供者，同步返回字符串或返回 Promise
   */
  registerField(name: string, provider: EnvFieldProvider): void {
    this.fields.set(name, provider);
  }

  /**
   * 收集当前环境信息（含自定义字段）。
   *
   * 自定义字段的 provider 按 registration 顺序串行执行（避免并发竞态，
   * 如多个 provider 都调用 git 命令）。
   */
  async getEnvInfo(): Promise<EnvInfo> {
    const custom: Record<string, string> = {};
    for (const [name, provider] of this.fields) {
      try {
        const value = await provider();
        custom[name] = value;
      } catch {
        // 单个自定义字段采集失败不应阻塞其余字段；跳过该字段。
      }
    }

    return {
      cwd: process.cwd(),
      platform: process.platform,
      arch: process.arch,
      custom,
    };
  }

  /**
   * 产出 `kind:'env_info'` 的对话消息，作为对话首条系统级补充消息注入。
   *
   * content 渲染为模型可读的 markdown 列表，便于模型定位上下文。
   */
  async toMessage(): Promise<ChatMessage> {
    const info = await this.getEnvInfo();
    return {
      role: 'system',
      kind: 'env_info',
      content: this.render(info),
    };
  }

  /** 将 EnvInfo 渲染为模型可读的 markdown 文本 */
  private render(info: EnvInfo): string {
    const lines: string[] = [
      '# 环境信息',
      `- 工作目录: ${info.cwd}`,
      `- 操作系统: ${info.platform} (${info.arch})`,
    ];
    for (const [name, value] of Object.entries(info.custom)) {
      lines.push(`- ${name}: ${value}`);
    }
    return lines.join('\n');
  }
}
