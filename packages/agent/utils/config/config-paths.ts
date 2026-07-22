/**
 * 三级配置路径解析
 *
 * 层级优先级（低→高）：全局 < 项目 < 用户
 * - 全局级：${HOME}/.wuzi/config.yaml
 * - 项目级：{projectDir}/.wuzi/config.yaml
 * - 用户级：{projectDir}/.wuzi/user-config.yaml
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';

export interface ConfigPaths {
  global: string;   // ${HOME}/.wuzi/config.yaml
  project: string;  // {projectDir}/.wuzi/config.yaml
  user: string;     // {projectDir}/.wuzi/user-config.yaml
}

/** 解析三级配置路径 */
export function resolveConfigPaths(projectDir = process.cwd()): ConfigPaths {
  return {
    global: resolve(homedir(), '.wuzi', 'config.yaml'),
    project: resolve(projectDir, '.wuzi', 'config.yaml'),
    user: resolve(projectDir, '.wuzi', 'user-config.yaml'),
  };
}
