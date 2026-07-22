/**
 * 流式输出写入器（自动换行，无左侧竖线）
 * 依赖：width.ts（列宽计算）、ansi.ts（着色常量）
 *
 * 把增量文本逐字写出，并在到达终端右边界时按显示列宽自动换行。
 * 关键点：
 *   - 按「显示列宽」而非字符数换行，正确处理中文/全角占 2 列；
 *   - 转义码（DIM/RESET）不计入宽度，并在换行后保持当前着色状态。
 */

import { charWidth, displayWidth } from "./width.ts";
import { DIM } from "./ansi.ts";

export class StreamWriter {
    private col = 0;
    private dimOn = false;
    // 行首/续行前缀：当前为空（不再输出左竖线）。保留该字段以便需要时恢复缩进。
    private readonly bar = "   ";
    private readonly barWidth = displayWidth(this.bar); // 竖线区实际占用列宽（已剥离转义码）
    private readonly contentWidth: number;

    constructor() {
        const cols = process.stdout.columns ?? 80;
        // 完全依据终端最大宽度：一行显示不下就换行；
        // 内容区 = 终端宽 - 安全余量 1 列，避免宽字符恰好顶满时被终端二次折行。
        this.contentWidth = Math.max(20, cols - this.barWidth - 1);
    }

    /** 在首行写入左竖线，准备接收内容。 */
    begin(): void {
        this.col = 0;
        process.stdout.write(this.bar);
    }

    /** 写出一段增量文本（可能含 DIM/RESET 转义码）。 */
    write(chunk: string): void {
        const cps = Array.from(chunk); // 按码点遍历，正确处理代理对
        for (let i = 0; i < cps.length; i++) {
            const ch = cps[i]!;
            const code = ch.codePointAt(0)!;

            // 转义序列：整段写出，不计入宽度，并跟踪 DIM 状态以便换行后延续
            if (code === 0x1b) {
                let seq = ch;
                i++;
                while (i < cps.length && cps[i]! !== "m") {
                    seq += cps[i]!;
                    i++;
                }
                if (i < cps.length) seq += "m";
                process.stdout.write(seq);
                if (seq === "\x1b[2m") this.dimOn = true;
                else if (seq === "\x1b[0m") this.dimOn = false;
                continue;
            }

            // 显式换行：另起一行并续接竖线
            if (ch === "\n") {
                process.stdout.write("\n");
                this.col = 0;
                this.newLineBar();
                continue;
            }

            const w = charWidth(ch);
            if (this.col > 0 && this.col + w > this.contentWidth) {
                process.stdout.write("\n");
                this.col = 0;
                this.newLineBar();
            }
            process.stdout.write(ch);
            this.col += w;
        }
    }

    /** 换行时续接前缀（当前为空），并延续当前 DIM 着色。 */
    private newLineBar(): void {
        process.stdout.write(this.bar);
        if (this.dimOn) process.stdout.write(DIM);
    }

    /** 结束当前流式块，落一个换行。 */
    end(): void {
        process.stdout.write("\n");
        this.col = 0;
        this.dimOn = false;
    }
}
