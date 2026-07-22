/**
 * 输入辅助函数
 * 依赖：node:readline、ansi.ts（着色常量）
 */

import { createInterface } from "node:readline";
import { RESET, DIM, BLACK, YELLOW, RED, BOLD, CYAN } from "./ansi.ts";
import { drawBox } from "./box.ts";
import type { HitlRequest, HitlResponse, HitlChoice } from "@wuzi/types";

/** 用户输入被 Ctrl+C 取消时的哨兵返回值。 */
export const INPUT_CANCELLED = Symbol("tui:input-cancelled");

export interface PromptTextOptions {
    /** 提示语（如 "You:"） */
    message: string;
    /** 可选占位示例（以灰色弱化显示） */
    placeholder?: string;
}

/**
 * 使用 node:readline 采集单行输入，避免 Windows 下
 * 因频繁 ANSI 重绘导致中文输入法候选框偏离光标的问题。
 */
export async function promptText(
    opts: PromptTextOptions,
): Promise<string | typeof INPUT_CANCELLED> {
    const { message, placeholder } = opts;

    // 用户角色行：角色标记与提示语统一用黑色，贴合终端默认配色；
    // 占位符仍用灰色弱化。
    const promptLine = placeholder
        ? `${BLACK}o  ${message}${RESET} ${DIM}${placeholder}${RESET}`
        : `${BLACK}o  ${message}${RESET}`;
    process.stdout.write(`${promptLine}\n`);

    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
        prompt: "",
    });

    let cancelled = false;
    const answer = await new Promise<string>((resolve) => {
        rl.on("SIGINT", () => {
            cancelled = true;
            process.stdout.write(RESET); // 复位，避免黑色染到后续输出
            rl.close();
            resolve("");
        });
        // question 提示串为空，用户从行首直接键入；回车拿到结果后统一 RESET。
        rl.question("   ", (ans) => {
            process.stdout.write(RESET);
            resolve(ans);
            rl.close();
        });
    });

    return cancelled ? INPUT_CANCELLED : answer;
}

/** HITL 授权请求盒子固定宽度（与 coding 角色 BOX_WIDTH 保持一致） */
const HITL_BOX_WIDTH = 60;

/** preview 截断长度（避免长命令/大 diff 撑爆终端） */
const PREVIEW_MAX = 200;

/**
 * HITL 授权询问：渲染 HitlRequest 并收集用户决定。
 *
 * 交互流程（两步）：
 *   1. 用 drawBox 显示「工具 / 原因 / 预览」概要
 *   2. 第一行问「允许？(y/n)」
 *   3. 仅当 y 时再问「范围 (1=本次/2=本会话/3=永久)」，默认 1
 *
 * 取消语义：
 *   - 第一行 Ctrl+C / 非明确 y → 直接拒绝，scope='cancel'
 *   - 第二行 Ctrl+C → 视为 once（已允许但未指定持久化范围，保守不入规则）
 *
 * 返回值映射：
 *   - y + 1 → { decision:'allow', scope:'once' }
 *   - y + 2 → { decision:'allow', scope:'session' }
 *   - y + 3 → { decision:'allow', scope:'permanent' }
 *   - n / Ctrl+C / 其它 → { decision:'deny', scope:'cancel' }
 */
export async function promptHitl(req: HitlRequest): Promise<HitlResponse> {
    // —— 1. 渲染概要 ——
    const previewRaw = req.preview ?? "";
    const preview = previewRaw.length > PREVIEW_MAX
        ? previewRaw.slice(0, PREVIEW_MAX) + `${DIM}…${RESET}`
        : previewRaw;
    const body = [
        `${YELLOW}工具${RESET}: ${BOLD}${req.tool}${RESET}`,
        `${YELLOW}原因${RESET}: ${req.reason}`,
        preview ? `${YELLOW}预览${RESET}: ${preview}` : "",
    ].filter((l) => l.length > 0).join("\n");

    drawBox("安全授权请求", body, CYAN, HITL_BOX_WIDTH);

    // —— 2. 询问是否允许 ——
    const allowAns = await promptText({ message: "允许执行？(y/n):" });
    if (allowAns === INPUT_CANCELLED) {
        return { decision: "deny", scope: "cancel" as HitlChoice };
    }
    const allow = allowAns.trim().toLowerCase();
    if (allow !== "y" && allow !== "yes") {
        // 任何非明确 yes 都视为拒绝（保守）
        return { decision: "deny", scope: "cancel" as HitlChoice };
    }

    // —— 3. 询问范围 ——
    const scopeAns = await promptText({
        message: "范围 (1=本次/2=本会话/3=永久，默认 1):",
        placeholder: "1",
    });
    if (scopeAns === INPUT_CANCELLED) {
        // Ctrl+C 在范围选择阶段：用户已允许但中断，按 once 处理（不入规则）
        return { decision: "allow", scope: "once" as HitlChoice };
    }
    const trimmed = scopeAns.trim();
    const scope: HitlChoice = trimmed === "2"
        ? "session"
        : trimmed === "3"
            ? "permanent"
            : "once"; // 默认与 "1" / 其它输入都按 once

    return { decision: "allow", scope };
}
