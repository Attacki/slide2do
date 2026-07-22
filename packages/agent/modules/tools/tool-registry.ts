/**
 * ToolRegistry — 工具注册中心
 *
 * 集中登记工具，支持按名查找，并能转为「API 认得的工具列表」
 * （中立格式 ToolDefinition[]，由具体 Provider 映射为自身请求格式）。
 */
import type { Tool, ToolDefinition } from '@wuzi/types';

export class ToolRegistry {
  private readonly store = new Map<string, Tool>();

  /** 注册一个工具；同名重复注册将抛错，以便尽早暴露配置冲突。 */
  register(tool: Tool): void {
    if (this.store.has(tool.name)) {
      throw new Error(`工具名冲突: "${tool.name}" 已注册`);
    }
    this.store.set(tool.name, tool);
  }

  /** 注销指定工具，返回是否曾存在 */
  unregister(name: string): boolean {
    return this.store.delete(name);
  }

  /** 按名查找工具 */
  get(name: string): Tool | undefined {
    return this.store.get(name);
  }

  /** 是否存在指定工具 */
  has(name: string): boolean {
    return this.store.has(name);
  }

  /** 列出所有已注册工具 */
  list(): Tool[] {
    return [...this.store.values()];
  }

  /** 转为 API 认得的工具列表（中立格式，丢弃 execute 等执行细节） */
  toDefinitions(): ToolDefinition[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      mutates: t.mutates,
    }));
  }
}
