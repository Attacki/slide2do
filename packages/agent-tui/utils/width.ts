/**
 * 显示宽度工具（CJK / 全角占 2 列，转义码不占宽度）
 * 用于终端列宽计算，支撑 CJK 宽度感知的换行、对齐与边框绘制。
 */

/** 判断一个码点是否为「宽字符」（东亚宽 / 全宽），用于终端列宽计算。 */
export function isWide(code: number): boolean {
    return (
        (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
        (code >= 0x2e80 && code <= 0x303e) || // CJK 部首 / 康熙字典
        (code >= 0x3041 && code <= 0x33ff) || // 平假名 / 片假名 / 带圈字母
        (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展 A
        (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一汉字
        (code >= 0xa000 && code <= 0xa4cf) || // 彝文
        (code >= 0xac00 && code <= 0xd7a3) || // Hangul 音节
        (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容汉字
        (code >= 0xfe30 && code <= 0xfe4f) || // CJK 兼容形式
        (code >= 0xff00 && code <= 0xff60) || // 全角形式
        (code >= 0xffe0 && code <= 0xffe6) || // 全角符号
        (code >= 0x1f300 && code <= 0x1faff) || // 表情符号（多数为宽）
        (code >= 0x20000 && code <= 0x3fffd) // CJK 扩展 B 及以上
    );
}

/** 单个字符的显示列宽。 */
export function charWidth(ch: string): number {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return 0; // 控制字符不占宽度
    return isWide(code) ? 2 : 1;
}

/** 字符串显示宽度（自动剥离 ANSI 转义码）。 */
export function displayWidth(str: string): number {
    const cleaned = str.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    let width = 0;
    for (const ch of cleaned) width += charWidth(ch);
    return width;
}
