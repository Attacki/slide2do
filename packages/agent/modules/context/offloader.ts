/**
 * ToolResultOffloader — 超长 tool 结果磁盘卸载与预览生成
 *
 * 当单条 tool 消息内容超过上下文预算时,将完整内容写入磁盘文件,对话内只保留
 * 首尾预览 + 省略提示 + 文件路径。文件按 sessionId 隔离,命名带 ISO 时间戳与
 * 自增序号,便于跨会话回溯。
 *
 * `buildPreviewText` 为无状态纯函数,可独立单测;`ToolResultOffloader` 类负责
 * 落盘与路径管理,内部按 sessionId 维护自增序号。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** buildPreviewText 中 path 缺省时的占位符 */
const UNKNOWN_PATH_PLACEHOLDER = '(unknown path)';

/**
 * 产出首尾预览文本(纯函数,无副作用)。
 *
 * 行为:
 *  - 总行数 ≤ headLines + tailLines 时返回原文(不含「已省略」字样)
 *  - 总行数 > headLines + tailLines 时返回「首 headLines 行 + 省略提示 + 尾 tailLines 行」
 *  - 省略行数 N = 总行数 - headLines - tailLines
 *  - path 未传时使用占位符 `(unknown path)`
 *
 * @param content 原始文本
 * @param headLines 预览首部行数
 * @param tailLines 预览尾部行数
 * @param path 完整内容文件路径(用于省略提示),缺省时使用占位符
 * @returns 预览文本(可能等于原文)
 */
export function buildPreviewText(
  content: string,
  headLines: number,
  tailLines: number,
  path?: string,
): string {
  if (!content) return content;
  const lines = content.split('\n');
  const total = lines.length;
  const threshold = headLines + tailLines;

  if (total <= threshold) {
    return content;
  }

  const omitted = total - threshold;
  const displayPath = path ?? UNKNOWN_PATH_PLACEHOLDER;
  const head = lines.slice(0, headLines);
  const tail = lines.slice(total - tailLines);
  const notice = `[已省略 ${omitted} 行,完整内容见: ${displayPath}]`;

  return [...head, notice, ...tail].join('\n');
}

/**
 * 工具结果磁盘卸载器。
 *
 * 按 `{baseDir}/{sessionId}/{ISO时间戳}-{序号}.txt` 路径写入完整 content,
 * 内部按 sessionId 维护自增序号(从 1 开始,3 位补零)。写盘失败抛 Error,
 * 由上层 try/catch 归一化处理。
 */
export class ToolResultOffloader {
  /** 落盘根目录(绝对路径) */
  private readonly baseDir: string;
  /** sessionId -> 已写入文件数(用于生成下一序号) */
  private readonly counters = new Map<string, number>();

  /**
   * @param baseDir 落盘根目录,缺省 `.wuzi/context-offload`(相对于 process.cwd())
   */
  constructor(baseDir?: string) {
    this.baseDir = path.resolve(baseDir ?? '.wuzi/context-offload');
  }

  /**
   * 将完整 content 写入磁盘并返回绝对路径。
   *
   * 路径形如 `{baseDir}/{sessionId}/{ISO时间戳}-{序号}.txt`:
   *  - ISO时间戳: `new Date().toISOString().replace(/[:.]/g, '-')`(文件名安全)
   *  - 序号: 该实例对同一 sessionId 已写入文件的自增计数(从 1 开始,3 位补零)
   *
   * @param content 完整文本
   * @param sessionId 会话标识(用于目录隔离)
   * @returns 写入文件的绝对路径
   * @throws Error 写盘失败时抛出,错误信息含原始失败原因
   */
  async offload(content: string, sessionId: string): Promise<string> {
    const seq = (this.counters.get(sessionId) ?? 0) + 1;
    const seqLabel = String(seq).padStart(3, '0');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${timestamp}-${seqLabel}.txt`;
    const dir = path.join(this.baseDir, sessionId);
    const filePath = path.join(dir, filename);

    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, content, 'utf8');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`ToolResultOffloader.offload failed: ${reason}`);
    }

    this.counters.set(sessionId, seq);
    return filePath;
  }
}
