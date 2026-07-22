/**
 * 配置工具集导出
 *
 * 读取层叠路径优先级：本地全局 < 项目配置 < 用户配置（该文件一般需git ignore）
 */

export { resolveConfigPaths, type ConfigPaths } from './config-paths.ts';
export { loadConfig, getActiveProvider, validateProvider, type LoadConfigResult } from './config-loader.ts';
export type { AgentConfig, LLMConfig, LLMProtocol } from './config-types.ts';
