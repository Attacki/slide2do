/**
 * 等待动画（spinner）
 * 依赖：ansi.ts（着色常量）
 */

import { RESET, DIM } from "./ansi.ts";

export const SPINNER_FRAMES = [
    "⠋",
    "⠙",
    "⠹",
    "⠸",
    "⠼",
    "⠴",
    "⠦",
    "⠧",
    "⠇",
    "⠏",
];

/**
 * 单行旋转的等待动画。用 `\r` 原地刷新当前行；stop 时清空该行，
 * 可选地打印一行结束文本（如「完成」「失败」），随后换行让流式输出接续。
 */
export class Spinner {
    private timer: ReturnType<typeof setInterval> | null = null;
    private frame = 0;
    private readonly label: string;

    constructor(label = " 思考中...") {
        this.label = label;
    }

    start(): void {
        if (this.timer) return;
        process.stdout.write(`${DIM}${SPINNER_FRAMES[0]}${RESET} ${this.label}`);
        this.timer = setInterval(() => {
            this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
            process.stdout.write(
                `\r${DIM}${SPINNER_FRAMES[this.frame]}${RESET} ${this.label}`,
            );
        }, 80);
    }

    stop(msg = ""): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        // 清空当前行
        process.stdout.write("\r\x1b[K");
        if (msg) process.stdout.write(`${msg}\n`);
    }
}
