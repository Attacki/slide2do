/**
 * @wuzi/tools — 内置工具集桶文件
 *
 * 集中导出六个核心工具及其工厂，便于核心引擎（@wuzi/core）按需注册，
 * 也便于单元测试单独引用某个工具。
 */
import type { Tool, ToolContext } from '@wuzi/types';
import { readFileTool } from './read-file/index.ts';
import { writeFileTool } from './write-file/index.ts';
import { editFileTool } from './edit-file/index.ts';
import { execCommandTool } from './exec-command/index.ts';
import { findFilesTool } from './find-files/index.ts';
import { searchContentTool } from './search-content/index.ts';

/** 六个核心工具（共享实例，执行时通过 ToolContext 注入 cwd/signal） */
export const builtinTools: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  execCommandTool,
  findFilesTool,
  searchContentTool,
];

/**
 * 获取内置工具列表。
 *
 * @param _ctx 预留：当前内置工具不依赖实例化上下文（cwd 在执行时注入），
 *             保留参数以便未来按上下文定制工具集。
 */
export function getBuiltinTools(_ctx: ToolContext): Tool[] {
  return builtinTools;
}

export {
  readFileTool,
  writeFileTool,
  editFileTool,
  execCommandTool,
  findFilesTool,
  searchContentTool,
};

export type {
  Tool,
  ToolContext,
  ToolResult,
  ToolDefinition,
  ToolCall,
  JSONSchema,
} from '@wuzi/types';
