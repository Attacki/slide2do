/**
 * ANSI 转义码（终端样式配置）
 *   原理：\x1b（ESC）+ "[" + 参数 + 结尾字母 组成一条控制序列。
 *         颜色/字体类（SGR，以 "m" 结尾）会持续生效，直到用 RESET 关闭，
 *         否则会「染色」后续所有输出，务必成对使用。
 */

// —— 通用控制 ——
export const RESET = "\x1b[0m"; // 关闭所有样式，恢复终端默认前景/背景色

// —— 字体样式 ——
export const BOLD = "\x1b[1m"; // 加粗 / 高亮
export const DIM = "\x1b[2m"; // 变暗，弱化次要信息（thinking、占位符等）
export const ITALIC = "\x1b[3m"; // 斜体（部分终端不支持）
export const UNDERLINE = "\x1b[4m"; // 下划线
export const INVERSE = "\x1b[7m"; // 反显：前景色与背景色互换
export const HIDDEN = "\x1b[8m"; // 隐藏文本（占位但不显示，如密码）
export const STRIKE = "\x1b[9m"; // 删除线（部分终端不支持）

// —— 前景色（文字颜色）——
export const BLACK = "\x1b[30m"; // 黑（用户角色 / 话语，贴合终端主色）
export const RED = "\x1b[31m"; // 红：错误 / 失败
export const GREEN = "\x1b[32m"; // 绿：成功 / 完成
export const YELLOW = "\x1b[33m"; // 黄：警告 / 需注意
export const BLUE = "\x1b[34m"; // 蓝：链接 / 引用
export const MAGENTA = "\x1b[35m"; // 品红：AI 角色标识
export const CYAN = "\x1b[36m"; // 青：横幅 / 装饰边框
export const WHITE = "\x1b[37m"; // 白 / 浅灰
export const GRAY = "\x1b[90m"; // 亮黑（灰）：辅助说明文字

// —— 背景色 ——
export const BG_BLACK = "\x1b[40m";
export const BG_RED = "\x1b[41m"; // 红底：严重错误横幅
export const BG_GREEN = "\x1b[42m"; // 绿底：成功横幅
export const BG_YELLOW = "\x1b[43m";
export const BG_BLUE = "\x1b[44m";
export const BG_MAGENTA = "\x1b[45m";
export const BG_CYAN = "\x1b[46m";
export const BG_WHITE = "\x1b[47m";

// —— 光标 / 行控制（自绘刷新用）——
export const CLEAR_LINE = "\x1b[K"; // 清除光标到行尾
export const CLEAR_LINE_FULL = "\x1b[2K"; // 清除整行
export const CURSOR_HIDE = "\x1b[?25l"; // 隐藏光标（连续重绘时防闪烁）
export const CURSOR_SHOW = "\x1b[?25h"; // 显示光标

/**
 * 终端样式配置汇总表，便于按语义引用与统一维护。
 * 用法示例：`process.stdout.write(`${TERMINAL_STYLES.fg.green}完成${TERMINAL_STYLES.reset}`)`
 */
export const TERMINAL_STYLES = {
    reset: RESET,
    font: { bold: BOLD, dim: DIM, italic: ITALIC, underline: UNDERLINE, inverse: INVERSE, hidden: HIDDEN, strike: STRIKE },
    fg: { black: BLACK, red: RED, green: GREEN, yellow: YELLOW, blue: BLUE, magenta: MAGENTA, cyan: CYAN, white: WHITE, gray: GRAY },
    bg: { black: BG_BLACK, red: BG_RED, green: BG_GREEN, yellow: BG_YELLOW, blue: BG_BLUE, magenta: BG_MAGENTA, cyan: BG_CYAN, white: BG_WHITE },
    cursor: { clearLine: CLEAR_LINE, clearLineFull: CLEAR_LINE_FULL, hide: CURSOR_HIDE, show: CURSOR_SHOW },
} as const;
