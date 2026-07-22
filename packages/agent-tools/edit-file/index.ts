/**
 * edit_file — 原文唯一匹配替换
 *
 * 用 new_string 替换 old_string，要求 old_string 在文件中恰好出现一次。
 * 匹配不到或匹配多次都给出清晰报错，让模型调整上下文后重试。
 */
import { readFile, writeFile } from 'node:fs/promises';
import type { Tool, ToolContext } from '@wuzi/types';
import { safeResolve } from '../shared/fs.ts';
import { okResult, failResult } from '../shared/result.ts';

/** 统计 needle 在 haystack 中的出现次数 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let idx = haystack.indexOf(needle, 0);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    '对文件做「原文唯一匹配替换」：用 new_string 替换 old_string。要求 old_string 在文件中恰好出现一次，否则报错。调用前必须先用 read_file 读取该文件，确保 old_string 与原文逐字符一致（含缩进与空白）。用于精确修改文件中某一段内容。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要修改的文件路径' },
      old_string: {
        type: 'string',
        description: '待替换的原始文本片段，必须与文件中某处完全一致且唯一',
      },
      new_string: { type: 'string', description: '替换后的新文本' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async execute(params, ctx: ToolContext) {
    const path = String(params.path ?? '');
    const oldString = String(params.old_string ?? '');
    const newString = String(params.new_string ?? '');
    if (!path) return failResult('缺少参数 path');
    if (oldString === '') return failResult('old_string 不能为空');

    let abs: string;
    try {
      abs = safeResolve(ctx.cwd, path);
    } catch (e) {
      return failResult((e as Error).message);
    }

    let content: string;
    try {
      content = await readFile(abs, 'utf-8');
    } catch (e) {
      return failResult(`读取文件失败: ${(e as Error).message}`);
    }

    const count = countOccurrences(content, oldString);
    if (count === 0) {
      return failResult(
        `未在文件 ${path} 中找到匹配文本，请检查 old_string 是否与原文逐字符一致`,
        { count: 0 },
      );
    }
    if (count > 1) {
      return failResult(
        `在文件 ${path} 中匹配到 ${count} 处相同文本，请提供更唯一的上下文以准确定位`,
        { count },
      );
    }

    const updated = content.replace(oldString, newString);
    try {
      await writeFile(abs, updated, 'utf-8');
    } catch (e) {
      return failResult(`写回文件失败: ${(e as Error).message}`);
    }
    return okResult(`已在 ${path} 替换 1 处文本`, { path: abs, replaced: 1 });
  },
};
