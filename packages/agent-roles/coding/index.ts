/**
 * Coding 角色
 *
 * 加载 prompts/ 下按职责拆分的模块文件，按文件名优先级拼装为一段稳定 system prompt，
 * 供 PromptComposer 持有作为可缓存稳定段。环境信息、模式提醒等动态内容由核心引擎
 * 通过 kind 标签消息注入，不写入本稳定段。
 */

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROLE_META = {
  id: 'coding',
  name: 'Coding Assistant',
  description: '专业编程助手',
};

/**
 * 加载 coding 角色的稳定 system prompt。
 *
 * 读取 prompts/ 目录下所有 .md 模块文件，按文件名升序排序后用双换行拼装为一段
 * 稳定字符串。文件名前缀（01-/02-/...）控制模块优先级顺序，便于后续插入新模块。
 *
 * 该字符串内容在会话内不变，可被 provider 层挂载 cache_control 实现缓存最大化命中。
 */
export async function loadRole(): Promise<string> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const promptsDir = join(__dirname, 'prompts');

  try {
    const files = (await readdir(promptsDir))
      .filter((f) => f.endsWith('.md'))
      .sort();
    const parts: string[] = [];
    for (const f of files) {
      const content = await readFile(join(promptsDir, f), 'utf-8');
      parts.push(content.trim());
    }
    if (parts.length === 0) {
      return '你是一个专业的编程助手。';
    }
    return parts.join('\n\n');
  } catch {
    // fallback：若 prompts 目录缺失返回默认提示词
    return '你是一个专业的编程助手。';
  }
}

/**
 * 加载 coding 角色的 system prompt（向后兼容接口）。
 *
 * 等价于 loadRole()，供 roles-registry 的旧 RoleLoader 接口调用。
 * 新代码应直接使用 loadRole()。
 */
export async function loadSystemPrompt(): Promise<string> {
  return loadRole();
}
