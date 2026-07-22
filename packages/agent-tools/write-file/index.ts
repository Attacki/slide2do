/**
 * write_file — 写入/覆盖文本文件
 *
 * 用于创建新文件或整体重写文件；父目录不存在时自动创建。
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Tool, ToolContext } from '@wuzi/types';
import { safeResolve } from '../shared/fs.ts';
import { okResult, failResult } from '../shared/result.ts';

export const writeFileTool: Tool = {
  name: 'write_file',
  description:
    '将文本内容写入指定文件。若文件已存在则整体覆盖，父目录不存在则自动创建。用于创建新文件或整体重写文件。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目标文件路径' },
      content: { type: 'string', description: '要写入的完整文本内容' },
    },
    required: ['path', 'content'],
  },
  async execute(params, ctx: ToolContext) {
    const path = String(params.path ?? '');
    const content = String(params.content ?? '');
    if (!path) return failResult('缺少参数 path');

    let abs: string;
    try {
      abs = safeResolve(ctx.cwd, path);
    } catch (e) {
      return failResult((e as Error).message);
    }

    try {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf-8');
      const bytes = Buffer.byteLength(content, 'utf-8');
      return okResult(`已写入文件 ${path}（${bytes} 字节）`, { path: abs, bytes });
    } catch (e) {
      return failResult(`写入文件失败: ${(e as Error).message}`);
    }
  },
};
