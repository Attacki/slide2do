/**
 * 边框盒子（横幅 / note / 取消提示共用）
 * 依赖：width.ts（列宽计算）、ansi.ts（着色常量）
 */

import { charWidth, displayWidth } from "./width.ts";
import { RESET, DIM, BOLD } from "./ansi.ts";

/**
 * 按显示宽度（CJK 宽度感知）把一段文本折行到 maxWidth 列以内。
 *   - 保留原有的 "\n" 硬换行；
 *   - 单行超宽时按列宽切分，中文/全角按 2 列计，不会切坏边框对齐。
 */
export function wrapText(text: string, maxWidth: number): string[] {
    const result: string[] = [];
    for (const rawLine of text.split("\n")) {
        let cur = "";
        let curW = 0;
        for (const ch of rawLine) {
            const w = charWidth(ch);
            if (curW + w > maxWidth) {
                result.push(cur);
                cur = ch;
                curW = w;
            } else {
                cur += ch;
                curW += w;
            }
        }
        result.push(cur); // 每个硬换行段至少产出一行（含空行）
    }
    return result;
}

/**
 * 绘制一个 CJK 宽度感知的边框盒子：
 *   ┌─ 标题 ───────────┐
 *   │ 内容行 1         │
 *   │ 内容行 2         │
 *   └──────────────────┘
 * 标题支持内联在顶边；内容按显示宽度对齐，中文不会被算错导致边框错位。
 *
 * @param fixedWidth 可选。传入后使用固定盒宽（总列数），内容超宽自动换行；
 *                   不传则按标题/内容最长行自适应宽度。
 */
export function drawBox(
    title: string,
    body: string,
    accent: string = DIM,
    fixedWidth?: number,
): void {
    let innerW: number;
    let bodyLines: string[];

    if (fixedWidth && fixedWidth > 4) {
        // 固定宽度：内容区 = 总宽 - 4（左右各 "│ " / " │" 占 2 列）
        innerW = fixedWidth - 4;
        bodyLines = body.length > 0 ? wrapText(body, innerW) : [];
    } else {
        // 自适应宽度：取标题与最长内容行的显示宽度
        bodyLines = body.length > 0 ? body.split("\n") : [];
        innerW = Math.max(
            displayWidth(title),
            bodyLines.reduce((max, line) => Math.max(max, displayWidth(line)), 0),
            0,
        );
    }

    const titleW = displayWidth(title);
    const topDashes = Math.max(innerW - titleW + 1, 0);

    const lines: string[] = [];
    lines.push(
        `${accent}╭─${RESET}${BOLD}${title}${RESET}${accent}${"─".repeat(
            topDashes,
        )}╮${RESET}`,
    );
    for (const line of bodyLines) {
        const pad = Math.max(innerW - displayWidth(line), 0);
        lines.push(
            `${accent}│${RESET} ${line}${" ".repeat(pad)} ${accent}│${RESET}`,
        );
    }
    lines.push(`${accent}╰${"─".repeat(innerW + 2)}╯${RESET}`);

    process.stdout.write(lines.join("\n") + "\n");
}
