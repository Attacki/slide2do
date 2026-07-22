/**
 * find_files — 按 glob 模式查找文件
 *
 * 在工作目录中按 glob 模式查找文件，返回匹配的相对路径列表。
 */
import type { Tool, ToolContext } from '@wuzi/types';
import { safeResolve } from '../shared/fs.ts';
import { okResult, failResult } from '../shared/result.ts';

const MAX_RESULTS = 200;

export const findFilesTool: Tool = {
  name: 'find_files',
  description:
    '按 glob 模式在工作目录中查找文件，返回匹配的相对路径列表。用于定位文件位置，例如 "**/*.ts"、"src/*.json"。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式，如 "**/*.ts"、"src/*.json"' },
      dir: { type: 'string', description: '可选，搜索子目录（相对工作目录），缺省为工作目录' },
      recursive: {
        type: 'boolean',
        description: '是否递归子目录，缺省 true；设为 false 仅搜索指定目录顶层',
      },
    },
    required: ['pattern'],
  },
  async execute(params, ctx: ToolContext) {
    const pattern = String(params.pattern ?? '');
    if (!pattern) return failResult('缺少参数 pattern');

    let base: string;
    try {
      base = safeResolve(ctx.cwd, String(params.dir ?? ''));
    } catch (e) {
      return failResult((e as Error).message);
    }

    const recursive = params.recursive === undefined ? true : Boolean(params.recursive);

    try {
      const glob = new Bun.Glob(pattern);
      const matches: string[] = [];
      for await (const file of glob.scan({ cwd: base, onlyFiles: true })) {
        // 非递归：仅保留顶层文件（路径中不含路径分隔符）
        if (!recursive && file.includes('/')) continue;
        matches.push(file);
        if (matches.length >= MAX_RESULTS) break;
      }
      matches.sort();

      if (matches.length === 0) {
        return okResult(`未找到匹配 "${pattern}" 的文件`, { count: 0 });
      }
      const note = matches.length >= MAX_RESULTS ? `\n（仅显示前 ${MAX_RESULTS} 条）` : '';
      return okResult(
        `找到 ${matches.length} 个匹配文件:\n${matches.join('\n')}${note}`,
        { count: matches.length },
      );
    } catch (e) {
      return failResult(`查找文件失败: ${(e as Error).message}`);
    }
  },
};
