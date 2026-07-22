/**
 * search_content — 在文件内容中按正则搜索
 *
 * 在文件内容中按正则表达式搜索文本，返回匹配的文件路径、行号与行内容。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Tool, ToolContext } from '@wuzi/types';
import { safeResolve } from '../shared/fs.ts';
import { okResult, failResult } from '../shared/result.ts';

const DEFAULT_MAX_RESULTS = 50;

export const searchContentTool: Tool = {
  name: 'search_content',
  description:
    '在文件内容中按正则表达式搜索文本，返回匹配的文件路径、行号与行内容。用于定位代码或配置中的关键字。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式，用于匹配文件内容' },
      dir: { type: 'string', description: '可选，搜索目录（相对工作目录），缺省为工作目录' },
      filePattern: {
        type: 'string',
        description: '可选，限定搜索的文件 glob，如 "**/*.ts"；缺省遍历所有文件',
      },
      maxResults: { type: 'number', description: '最大返回匹配数，缺省 50' },
      caseSensitive: { type: 'boolean', description: '是否区分大小写，缺省 false' },
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

    const filePattern = params.filePattern ? String(params.filePattern) : '**/*';
    const maxResults =
      typeof params.maxResults === 'number' ? params.maxResults : DEFAULT_MAX_RESULTS;
    const flags = params.caseSensitive ? 'g' : 'gi';

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, flags);
    } catch (e) {
      return failResult(`正则表达式无效: ${(e as Error).message}`);
    }

    try {
      const glob = new Bun.Glob(filePattern);
      const matches: string[] = [];
      for await (const file of glob.scan({ cwd: base, onlyFiles: true })) {
        let text: string;
        try {
          text = await readFile(join(base, file), 'utf-8');
        } catch {
          continue; // 跳过无法读取的文件（二进制/无权限）
        }
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          regex.lastIndex = 0;
          if (regex.test(lines[i]!)) {
            matches.push(`${file}:${i + 1}: ${lines[i]!.trim()}`);
            if (matches.length >= maxResults) break;
          }
        }
        if (matches.length >= maxResults) break;
      }

      if (matches.length === 0) {
        return okResult(`未找到匹配 "${pattern}" 的内容`, { count: 0 });
      }
      return okResult(`找到 ${matches.length} 处匹配:\n${matches.join('\n')}`, {
        count: matches.length,
      });
    } catch (e) {
      return failResult(`搜索内容失败: ${(e as Error).message}`);
    }
  },
};
