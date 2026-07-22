/**
 * wuzi-agent TUI（原生终端实现） - coding 角色
 *
 * 完全基于 Node.js 原生能力（process.stdout / node:readline / ANSI 转义码），
 * 不依赖任何第三方 TUI 库。相比基于 @clack/prompts 的旧实现：
 *   - 输入沿用 node:readline，规避 Windows 下中文输入法候选框偏离光标的问题；
 *   - 流式输出自绘，按终端宽度做 CJK 宽度感知换行；
 *   - 其余展示（横幅 / 提示框 / 等待动画 / 取消提示）均用 ANSI 自绘，
 *     与流式渲染共用同一套光标控制，避免两套机制抢屏闪烁。
 *
 * 通用终端工具（ANSI 着色、列宽计算、边框、流式写入、spinner、输入、角色行）
 * 已抽离到 ../utils，本文件仅保留 coding 角色专属的主循环与配置。
 *
 * 对外契约（TUIProps / StreamEvent 等）与旧实现完全一致，可直接替换。
 */

import type {
    StreamEvent,
    UserInputEvent,
    CommandEvent,
} from "@wuzi/core/ui-pattern.ts";

// 通用终端工具（供所有终端 UI 复用）
import { CYAN, RED, DIM, RESET, BOLD, BLUE, GREEN } from "../utils/ansi.ts";
import { drawBox } from "../utils/box.ts";
import { StreamWriter } from "../utils/stream-writer.ts";
import { Spinner } from "../utils/spinner.ts";
import { promptText, INPUT_CANCELLED } from "../utils/input.ts";

// —— 应用级配置（角色相关，非通用工具）——
const BOX_WIDTH = 50; // 本角色 drawBox 固定宽度（字符列数），box 内文本超宽自动换行
const ROLE_NAME = "wuzi-coding"; // 当前 AI 角色名，用于回复前的角色标识行

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------
interface MessageBlock {
    id: string;
    role: "user" | "assistant" | "system";
    text: string;
    thinking?: string;
}

interface TUIProps {
    /** 输入回调 */
    onSubmit: (input: UserInputEvent) => void;
    /** 外部事件源（从 AgentSession 推送） */
    eventSource: AsyncIterable<StreamEvent>;
    /** 退出请求回调 */
    onExitRequest: () => void;
}


/** 打印一行「角色标识」，用于 AI 回复正文之前的归属提示。 */
export function printRoleLine(role: string, color: string = BLUE): void {
    process.stdout.write(`${color}${BOLD}o  ${role}${RESET}\n`);
}


// 主循环
export async function TUI({
    onSubmit,
    eventSource,
    onExitRequest,
}: TUIProps): Promise<void> {
    let hasShowTips = false;
    drawBox(
        "wuzi-agent[coding]",
        "输入问题开始对话，/help 查看命令",
        CYAN,
        BOX_WIDTH,
    );

    const messages: MessageBlock[] = [];
    const iter = eventSource[Symbol.asyncIterator]();
    // 运行模式本地状态（与 agent 初始态一致，默认 agent），仅用于命令回显
    let mode: "agent" | "ask" | "plan" = "agent";

    while (true) {
        const answer = await promptText({
            message: "You:",
            placeholder: hasShowTips ? "" : "输入 /exit 退出，/help 查看命令",
        });
        hasShowTips = true;

        if (answer === INPUT_CANCELLED) {
            process.stdout.write(`\n`);
            drawBox("已取消", `${DIM}wuzi-agent已退出${RESET}`, RED, BOX_WIDTH);
            onExitRequest();
            return;
        }

        const input = (answer ?? "").trim();
        if (!input) continue;

        // 分发 slash 命令
        if (input.startsWith("/")) {
            const cmd = input as CommandEvent["name"];
            if (
                cmd === "/exit" ||
                cmd === "/clear" ||
                cmd === "/help" ||
                cmd === "/agent" ||
                cmd === "/ask" ||
                cmd === "/plan"
            ) {
                onSubmit({ type: "command", name: cmd });

                if (cmd === "/exit") {
                    onExitRequest();
                    return;
                }

                if (cmd === "/clear") {
                    messages.length = 0;
                    drawBox("/clear", "对话上下文已清空", DIM, BOX_WIDTH);
                } else if (cmd === "/help") {
                    drawBox(
                        "帮助",
                        "/exit - 退出\n/clear - 清空上下文\n/agent - 执行模式（读写）\n/ask - 只读问答\n/plan - 只读规划\n/help - 帮助",
                        DIM,
                        BOX_WIDTH,
                    );
                } else if (cmd === "/agent" || cmd === "/ask" || cmd === "/plan") {
                    mode = cmd.slice(1) as typeof mode;
                    const desc = {
                        agent: "已切换到 AGENT 模式：读写工具均可用，自主执行任务",
                        ask: "已切换到 ASK 模式：只读问答，写类工具将被拦截",
                        plan: "已切换到 PLAN 模式：只读调研并产出待审批计划，写类工具将被拦截",
                    }[mode];
                    drawBox(`/${mode}`, desc, DIM, BOX_WIDTH);
                }
                continue;
            }
        }

        // 普通用户输入
        const userMsg: MessageBlock = {
            id: `msg-${messages.length + 1}`,
            role: "user",
            text: input,
        };
        messages.push(userMsg);

        onSubmit({ type: "submit", text: input });

        if (!iter) continue;

        let currentRound = 0;
        let maxRounds: number | undefined;
        let terminationReason: string | undefined;
        const spinner = new Spinner(" 思考中...");
        spinner.start();
        let spinnerStopped = false;
        const stopSpinner = (msg: string): void => {
            if (!spinnerStopped) {
                spinner.stop(msg);
                spinnerStopped = true;
            }
        };

        let currentText = "";
        let currentThinking = "";
        let errored: StreamEvent | null = null;
        let thinkingLabeled = false;
        let textStarted = false;
        let writer: StreamWriter | null = null;

        // 首个内容事件到达时才停等待动画、打印角色行、开启流式写入器，
        // 保证每次回复都有归属提示，且不会被前置的非渲染事件（如 user_message）干扰。
        const ensureRenderStarted = (): StreamWriter => {
            if (!writer) {
                stopSpinner("");
                printRoleLine(ROLE_NAME);
                writer = new StreamWriter();
                writer.begin();
            }
            return writer;
        };

        try {
            // 统一事件消费循环：健壮处理 ReAct 循环推送的全部事件类型与顺序，
            // 未识别 / 非渲染事件静默跳过，done/error 结束本轮。
            consume: while (true) {
                const { value } = await iter.next();
                const event = value as StreamEvent;
                switch (event.type) {
                    case "thinking_delta": {
                        const w = ensureRenderStarted();
                        if (!thinkingLabeled) {
                            thinkingLabeled = true;
                            currentThinking += "💭 ";
                            w.write(`${DIM}💭 ${event.delta}${RESET}`);
                        } else {
                            currentThinking += event.delta;
                            w.write(`${DIM}${event.delta}${RESET}`);
                        }
                        break;
                    }
                    case "text_delta": {
                        const w = ensureRenderStarted();
                        currentText += event.delta;
                        // 思考块 → 正式输出切换：插入空行分隔并复位 DIM 着色，
                        // 避免正式回复紧接思考文本同一行输出。
                        if (thinkingLabeled && !textStarted) {
                            textStarted = true;
                            w.write(`${RESET}\n\n`);
                        }
                        w.write(event.delta);
                        break;
                    }
                    case "tool_call": {
                        // 模型发起工具调用：仅展示工具名，不暴露原始参数 JSON
                        const w = ensureRenderStarted();
                        w.write(`${DIM}🔧 调用工具: ${event.name}${RESET}\n`);
                        break;
                    }
                    case "tool_result": {
                        // 工具执行结果：成功绿、失败红，结果过长截断，保持界面清爽
                        const w = ensureRenderStarted();
                        const head = event.ok ? `${GREEN}↳ 完成` : `${RED}✗ 失败`;
                        const detail = event.content.trim().slice(0, 120);
                        w.write(`${head}${detail ? `: ${detail}` : ""}${RESET}\n`);
                        break;
                    }
                    case "plan_blocked": {
                        // plan-only 拦截提示
                        const w = ensureRenderStarted();
                        w.write(`${DIM}🛈 ${event.message}${RESET}\n`);
                        break;
                    }
                    case "loop_terminated": {
                        currentRound = event.rounds;
                        maxRounds = event.maxRounds;
                        terminationReason = event.reason;
                        break;
                    }
                    case "error":
                        errored = event;
                        break consume;
                    case "done":
                        break consume;
                    // user_message / tool_call_start / final_answer：
                    // 非渲染事件（用户输入本地已回显、正文已由 text_delta 呈现），忽略
                    default:
                        break;
                }
            }

            if (writer) (writer as StreamWriter).end();

            const roundInfo = maxRounds !== undefined ? ` (${currentRound}/${maxRounds})` : "";
            const reasonLabel: Record<string, string> = {
                no_tool_call: "完成",
                max_rounds: `达到最大轮数${roundInfo}`,
                cancelled: "已取消",
                timeout: "超时",
                error: "出错",
            };

            if (errored) {
                const errText = errored.error?.message ?? "未知错误";
                if (!writer) stopSpinner("失败");
                drawBox("Error", errText, RED, BOX_WIDTH);
            } else {
                const stopMsg = terminationReason ? reasonLabel[terminationReason] || "完成" : "完成";
                if (!writer) stopSpinner(stopMsg);
                if (currentText || currentThinking) {
                    const assistantMsg: MessageBlock = {
                        id: `msg-${messages.length + 1}`,
                        role: "assistant",
                        text: currentText,
                        thinking: currentThinking || undefined,
                    };
                    messages.push(assistantMsg);
                }
                if (terminationReason === 'max_rounds') {
                    drawBox("已达上限",
                        `循环已执行 ${currentRound} 轮，达到最大轮数 ${maxRounds}`,
                        RED,
                        BOX_WIDTH);
                }
            }
        } catch (err) {
            stopSpinner("失败");
            drawBox(
                "Error",
                err instanceof Error ? err.message : String(err),
                RED,
                BOX_WIDTH,
            );
        }
    }
}
