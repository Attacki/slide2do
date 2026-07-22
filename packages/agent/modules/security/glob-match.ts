/**
 * 轻量 glob → regex 转换与匹配
 *
 * 支持的 glob 语法：
 * - `*`  单层任意字符（不含路径分隔符 / 和 \）
 * - `**` 任意层级（含路径分隔符）
 * - `?`  单个任意字符（不含路径分隔符）
 * - `{a,b,c}` 分支（匹配 a 或 b 或 c）
 * - 普通字符按字面匹配；路径分隔符 / 和 \ 跨平台互通
 *
 * 不支持：`[abc]` 字符类、`[a-z]` 范围、`!` 取反
 */

// 正则元字符集合 — 在 glob 中按字面匹配，转 regex 时需转义
const REGEX_META = new Set([
  '\\', '.', '+', '^', '$', '(', ')', '|', '[', ']', '{', '}', '*', '?',
]);

// 路径分隔符类（/ 和 \ 跨平台互通）
const SEP_CLASS = '[/\\\\]'; // regex: [/\\]    匹配 / 或 \
const NON_SEP_STAR = '[^/\\\\]*'; // regex: [^/\\]*  0+ 个非分隔符
const NON_SEP_ONE = '[^/\\\\]'; // regex: [^/\\]   1 个非分隔符
const ANY_STAR = '[\\s\\S]*'; // regex: [\s\S]*  0+ 个任意字符（含换行）

function escapeLiteral(ch: string): string {
  return REGEX_META.has(ch) ? '\\' + ch : ch;
}

/**
 * 将 glob 模式编译为正则表达式（全串匹配 ^...$）
 *
 * 转换规则：
 * - `**` → `[\s\S]*`（任意层级，含分隔符）
 * - `*`  → `[^/\\]*`（单层，不含分隔符）
 * - `?`  → `[^/\\]` （单个非分隔符字符）
 * - `{a,b}` → `(?:a|b)`（分支体按字面转义，不递归通配）
 * - `/` 或 `\` → `[/\\]`（跨平台分隔符类）
 * - 其余字符按字面转义
 */
export function globToRegex(pattern: string): RegExp {
  let src = '';
  let i = 0;
  const len = pattern.length;

  while (i < len) {
    const ch = pattern[i];

    // ** 任意层级（含分隔符）
    if (ch === '*' && pattern[i + 1] === '*') {
      src += ANY_STAR;
      i += 2;
      continue;
    }

    // * 单层（不含分隔符）
    if (ch === '*') {
      src += NON_SEP_STAR;
      i += 1;
      continue;
    }

    // ? 单个非分隔符字符
    if (ch === '?') {
      src += NON_SEP_ONE;
      i += 1;
      continue;
    }

    // 路径分隔符：/ 和 \ 跨平台互通
    if (ch === '/' || ch === '\\') {
      src += SEP_CLASS;
      i += 1;
      continue;
    }

    // {a,b,c} 分支
    if (ch === '{') {
      const end = pattern.indexOf('}', i + 1);
      if (end === -1) {
        // 未闭合：按字面 { 处理
        src += '\\{';
        i += 1;
        continue;
      }
      const body = pattern.slice(i + 1, end);
      const alts = body.split(',').map((opt) => {
        let inner = '';
        for (const c of opt) inner += escapeLiteral(c);
        return inner;
      });
      src += '(?:' + alts.join('|') + ')';
      i = end + 1;
      continue;
    }

    // 普通字符：按字面转义
    src += escapeLiteral(ch);
    i += 1;
  }

  return new RegExp('^(?:' + src + ')$');
}

/**
 * 判断 str 是否匹配 glob 模式（同步纯函数，内部调用 globToRegex）
 */
export function matchGlob(str: string, pattern: string): boolean {
  return globToRegex(pattern).test(str);
}
