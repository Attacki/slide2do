/**
 * read_file — 读取文本文件内容
 *
 * 用于查看文件现有内容，作为后续编辑或分析的依据。路径越界会被拒绝。
 */
import { readFile } from 'node:fs/promises';
import type { Tool, ToolContext } from '@wuzi/types';
import { safeResolve } from '../shared/fs.ts';
import { okResult, failResult } from '../shared/result.ts';

export const readFileTool: Tool = {
  name: 'read_file',
  description:
    '读取指定路径的文本文件内容并返回。是编辑文件前的必备步骤（edit_file 的 old_string 必须与原文逐字符一致，未先读即改会导致匹配失败）。也用于查看、分析文件内容作为回答依据。',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '要读取的文件路径，可为相对工作目录的路径或绝对路径',
      },
    },
    required: ['path'],
  },
  async execute(params, ctx: ToolContext) {
    const path = String(params.path ?? '');
    if (!path) return failResult('缺少参数 path');

    let abs: string;
    try {
      abs = safeResolve(ctx.cwd, path);
    } catch (e) {
      return failResult((e as Error).message);
    }

    try {
      const content = await readFile(abs, 'utf-8');
      const lineCount = content.split('\n').length;
      return okResult(content, { path: abs, lines: lineCount, bytes: Buffer.byteLength(content, 'utf-8') });
    } catch (e) {
      return failResult(`读取文件失败: ${(e as Error).message}`);
    }
  },
};
