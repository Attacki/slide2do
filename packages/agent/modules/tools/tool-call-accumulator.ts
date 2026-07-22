/**
 * ToolCallAccumulator — 流式工具调用累加器
 *
 * 不同 Provider 会把一次工具调用的 JSON 参数拆成多个 SSE 分片下发：
 *   - OpenAI：`delta.tool_calls[].function.arguments` 为增量 JSON 字符串
 *   - Anthropic：`content_block_delta`(input_json_delta) 的 `partial_json` 为增量
 *
 * 该累加器按分片 index 合并 id / name / JSON 参数碎片，最终输出完整工具调用列表，
 * 解决「JSON 参数碎片拼接」问题。纯函数、无副作用，便于单元测试。
 */

/** 已拼接完成的原始工具调用（arguments 为完整 JSON 字符串） */
export interface RawToolCall {
  id: string;
  name: string;
  /** 已拼接的完整 JSON 字符串 */
  arguments: string;
}

/** 单个分片携带的片段（字段均可选，按需合并） */
export interface ToolCallFragment {
  id?: string;
  name?: string;
  json?: string;
}

export class ToolCallAccumulator {
  private readonly entries = new Map<number, RawToolCall>();

  /** 合并一个分片到指定 index */
  push(index: number, fragment: ToolCallFragment): void {
    const current = this.entries.get(index) ?? { id: '', name: '', arguments: '' };
    if (fragment.id !== undefined) current.id = fragment.id;
    if (fragment.name !== undefined) current.name = fragment.name;
    if (fragment.json !== undefined) current.arguments += fragment.json;
    this.entries.set(index, current);
  }

  has(index: number): boolean {
    return this.entries.has(index);
  }

  get(index: number): RawToolCall | undefined {
    return this.entries.get(index);
  }

  /** 移除指定 index 的条目（某块已完整推送后调用，避免后续重复） */
  remove(index: number): void {
    this.entries.delete(index);
  }

  /** 按 index 升序返回所有已累加的工具调用 */
  list(): RawToolCall[] {
    return [...this.entries.keys()]
      .sort((a, b) => a - b)
      .map((i) => this.entries.get(i)!);
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * 将已拼接的 JSON 参数解析为对象。
 *
 * @throws 当 arguments 不是合法 JSON 时抛出清晰错误，便于调用方转为结构化结果让模型调整。
 */
export function parseToolArguments(raw: RawToolCall): {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
} {
  let parsed: Record<string, unknown>;
  try {
    parsed = raw.arguments.trim() ? (JSON.parse(raw.arguments) as Record<string, unknown>) : {};
  } catch (err) {
    throw new Error(`工具「${raw.name}」的参数不是合法 JSON: ${(err as Error).message}`);
  }
  return { id: raw.id, name: raw.name, arguments: parsed };
}
