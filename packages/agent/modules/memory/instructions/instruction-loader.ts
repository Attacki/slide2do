/**
 * InstructionLoader — 项目指令文件（AGENTS.md）多层级加载与 @include 展开
 *
 * 职责：
 *  - 按「项目级（{projectDir}/AGENTS.md）→ 用户级（userLevelPath，缺省 ~/.wuzi/AGENTS.md）」
 *    顺序加载并合并，高优先级排前让 LLM 优先遵循
 *  - 支持 `@include ./relative/path.md` 语法内联引用其他文件
 *  - 嵌套深度上限保护（缺省 3），超限保留原指令文本 + 警告注释
 *  - 路径逃逸拦截：解析后路径必须落在所属层级根目录内，逃逸路径整条拦截并保留原文本
 *  - 文件不存在时保留原指令文本 + 警告注释
 *
 * 所有 IO 异常归一化为「跳过该层 / 该指令」，不向调用方抛出。
 */

import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute, sep, relative } from 'node:path';
import { homedir } from 'node:os';
import type { InstructionConfig } from '@wuzi/types';
import { DEFAULT_INSTRUCTION_CONFIG } from '../../../utils/config/config-types.ts';

/** @include 指令解析结果 */
export interface IncludeDirective {
  /** 在原文中的行号（0-based） */
  line: number;
  /** 原始整行文本（含 @include 关键字） */
  raw: string;
  /** 提取出的路径参数（去除首尾空白） */
  path: string;
}

/** expandIncludes 的递归深度默认值 */
export const DEFAULT_MAX_INCLUDE_DEPTH = 3;

/**
 * 从内容中提取所有 @include 指令。
 *
 * 语法：`@include <path>`，必须独占一行（去除首尾空白后整行匹配）。
 * path 可为相对路径（相对当前文件所属根目录）或绝对路径。
 *
 * 纯函数，无副作用，便于单测。
 *
 * @param content 待解析的文本
 * @returns 指令列表（按行号顺序）
 */
export function parseIncludeDirectives(content: string): IncludeDirective[] {
  const directives: IncludeDirective[] = [];
  const lines = content.split('\n');
  // 正则：行首可选空白，紧接 @include，后跟至少一个空白，再跟路径（到行尾，去除首尾空白）
  // 路径支持字母数字 / 下划线 / 连字符 / 斜杠 / 反斜杠 / 点 / 波浪号 / 冒号（Windows 盘符）
  const re = /^\s*@include\s+(.+?)\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const m = re.exec(line);
    if (m && m[1]) {
      directives.push({ line: i, raw: line, path: m[1] });
    }
  }
  return directives;
}

/**
 * 判断解析后的绝对路径是否安全（未逃逸根目录）。
 *
 * 安全定义：resolved 等于 rootDir 或位于 rootDir 子树内。
 * 用 `path.relative` 跨平台判定：相对路径以 `..` 开头表示逃逸；
 * Windows 上跨盘符时 relative 返回绝对路径，同样视为逃逸。
 *
 * 纯函数，便于单测。
 *
 * @param resolved 已解析为绝对路径的待检查路径
 * @param rootDir 根目录绝对路径
 * @returns true 表示安全（未逃逸）
 */
export function isPathSafe(resolved: string, rootDir: string): boolean {
  if (resolved === rootDir) return true;
  const rel = relative(rootDir, resolved);
  if (rel === '') return true;
  // 相对路径以 .. 开头 → 逃逸；为绝对路径 → Windows 跨盘符，逃逸
  if (rel.startsWith('..') || isAbsolute(rel)) return false;
  return true;
}

/**
 * 把 ~ 开头的路径展开为家目录绝对路径。
 * 非 ~ 开头原样返回。
 */
function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~' + sep) || p.startsWith('~/')) {
    return resolve(homedir(), p.slice(2));
  }
  if (p.startsWith('~')) {
    // 形如 ~user 的他人家目录不支持，原样返回
    return p;
  }
  return p;
}

/**
 * 递归展开 @include 指令。
 *
 * - 相对路径以 `basePath`（当前文件所在目录）为基准解析
 * - 绝对路径原样使用
 * - 解析后用 `isPathSafe` 检查是否逃逸 `rootDir`，逃逸则保留原指令文本 + 警告注释
 * - 嵌套深度超 `maxDepth` 时停止展开，保留原指令文本 + 警告注释
 * - 文件不存在时保留原指令文本 + 警告注释
 * - 单个 @include 展开失败不影响其他指令
 *
 * 纯函数（IO 通过注入的 reader 解耦），便于单测。
 *
 * @param content 待展开的文本
 * @param basePath 当前文件所在目录（用于解析相对路径）
 * @param depth 当前递归深度（首次调用传 0）
 * @param maxDepth 最大递归深度
 * @param rootDir 所属层级根目录（用于路径逃逸检查）
 * @param reader 文件读取函数（注入便于测试，缺省用 fs.readFile）
 * @returns 展开后的文本（同位置替换 @include 行为被引用文件内容）
 */
export async function expandIncludes(
  content: string,
  basePath: string,
  depth: number,
  maxDepth: number,
  rootDir: string,
  reader: (path: string) => Promise<string> = defaultReader,
): Promise<string> {
  const directives = parseIncludeDirectives(content);
  if (directives.length === 0) return content;

  const lines = content.split('\n');
  // 逐个指令处理（按行号从大到小替换，避免索引偏移）
  for (let i = directives.length - 1; i >= 0; i--) {
    const d = directives[i];
    if (!d) continue;
    const originalLine = lines[d.line];

    // 嵌套深度检查
    if (depth >= maxDepth) {
      lines[d.line] = `${originalLine}\n<!-- 警告：@include 嵌套深度已达上限 ${maxDepth}，停止展开 -->`;
      continue;
    }

    // 路径解析
    const rawPath = expandHome(d.path);
    const resolved = isAbsolute(rawPath)
      ? resolve(rawPath)
      : resolve(basePath, rawPath);

    // 路径逃逸检查
    if (!isPathSafe(resolved, rootDir)) {
      lines[d.line] = `${originalLine}\n<!-- 警告：@include 路径逃逸根目录 ${rootDir}（解析为 ${resolved}），已拦截 -->`;
      continue;
    }

    // 读取文件
    let included: string;
    try {
      included = await reader(resolved);
    } catch {
      lines[d.line] = `${originalLine}\n<!-- 警告：@include 文件不存在或读取失败（${resolved}），已跳过 -->`;
      continue;
    }

    // 递归展开被引用文件内的 @include（深度 +1）
    const includedBase = resolved.substring(0, resolved.lastIndexOf(sep)) || basePath;
    const expanded = await expandIncludes(
      included,
      includedBase,
      depth + 1,
      maxDepth,
      rootDir,
      reader,
    );

    // 用被引用文件内容替换原指令行（保留缩进：在被引用内容前补原指令行首空白）
    const indent = (originalLine ?? '').match(/^\s*/)?.[0] ?? '';
    const indented = indent
      ? expanded
          .split('\n')
          .map((l) => (l.length > 0 ? indent + l : l))
          .join('\n')
      : expanded;
    lines[d.line] = indented;
  }

  return lines.join('\n');
}

/** 默认文件读取函数：fs.readFile UTF-8 */
async function defaultReader(path: string): Promise<string> {
  return readFile(path, 'utf-8');
}

/** InstructionLoader 构造参数 */
export interface InstructionLoaderOptions {
  /** 项目根目录（项目级 AGENTS.md 所在目录） */
  projectDir: string;
  /** 用户级 AGENTS.md 路径；缺省 '~/.wuzi/AGENTS.md' */
  userLevelPath?: string;
  /** @include 嵌套深度上限；缺省 3 */
  maxIncludeDepth?: number;
  /** 文件读取函数（注入便于测试） */
  reader?: (path: string) => Promise<string>;
}

/** InstructionLoader 加载结果 */
export interface InstructionLoadResult {
  /** 拼装后的指令文本（项目级 + 用户级，层间有分隔注释） */
  content: string;
  /** 是否成功加载到至少一层（true 表示至少一层存在且非空） */
  loaded: boolean;
  /** 加载过程产生的警告（路径逃逸、文件缺失等，不影响加载） */
  warnings: string[];
}

/**
 * 项目指令文件多层级加载器。
 *
 * 加载顺序：项目级（{projectDir}/AGENTS.md）→ 用户级（userLevelPath）。
 * 高优先级排前让 LLM 优先遵循。每层独立展开 @include（项目级根 = projectDir，
 * 用户级根 = userLevelPath 所在目录），层间用分隔注释标注层级。
 *
 * 任一层缺失或读取失败时跳过该层，不报错。
 */
export class InstructionLoader {
  private readonly projectDir: string;
  private readonly userLevelPath: string;
  private readonly maxIncludeDepth: number;
  private readonly reader: (path: string) => Promise<string>;

  constructor(opts: InstructionLoaderOptions) {
    this.projectDir = resolve(opts.projectDir);
    const cfg: Required<InstructionConfig> = {
      ...DEFAULT_INSTRUCTION_CONFIG,
      ...(opts.userLevelPath !== undefined ? { userLevelPath: opts.userLevelPath } : {}),
      ...(opts.maxIncludeDepth !== undefined ? { maxIncludeDepth: opts.maxIncludeDepth } : {}),
    };
    this.userLevelPath = expandHome(cfg.userLevelPath);
    this.maxIncludeDepth = opts.maxIncludeDepth ?? DEFAULT_INSTRUCTION_CONFIG.maxIncludeDepth;
    this.reader = opts.reader ?? defaultReader;
  }

  /**
   * 加载并合并两层指令文件。
   *
   * 项目级根目录 = `projectDir`，用户级根目录 = `userLevelPath` 所在目录。
   * @include 路径逃逸检查基于各自层级根目录。
   *
   * @returns 加载结果（content 为拼装文本，loaded 表示至少一层成功）
   */
  async load(): Promise<InstructionLoadResult> {
    const warnings: string[] = [];
    const parts: string[] = [];

    // 项目级：{projectDir}/AGENTS.md
    const projectPath = resolve(this.projectDir, 'AGENTS.md');
    try {
      const raw = await this.reader(projectPath);
      const expanded = await expandIncludes(
        raw,
        this.projectDir,
        0,
        this.maxIncludeDepth,
        this.projectDir,
        this.reader,
      );
      if (expanded.trim().length > 0) {
        parts.push('<!-- 项目级指令（AGENTS.md） -->\n' + expanded);
      }
    } catch {
      // 项目级缺失或读取失败：跳过该层（注入 reader 时缺失由 reader 抛错）
    }

    // 用户级：userLevelPath
    try {
      const raw = await this.reader(this.userLevelPath);
      const userRoot = this.userLevelPath.substring(
        0,
        this.userLevelPath.lastIndexOf(sep),
      );
      const root = userRoot || homedir();
      const expanded = await expandIncludes(
        raw,
        root,
        0,
        this.maxIncludeDepth,
        root,
        this.reader,
      );
      if (expanded.trim().length > 0) {
        parts.push('<!-- 用户级指令（' + this.userLevelPath + '） -->\n' + expanded);
      }
    } catch {
      // 用户级缺失或读取失败：跳过该层
    }

    const content = parts.join('\n\n---\n\n');
    return {
      content,
      loaded: content.trim().length > 0,
      warnings,
    };
  }
}
