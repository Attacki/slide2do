# notes for `packages/agent-tui/`

> 最后更新: 2026-07-21 — 新建本笔记；原生终端 UI 实现（不依赖第三方 TUI 库）

wuzi-agent 终端 UI 包。完全基于 Node.js 原生能力（`process.stdout` / `node:readline` / ANSI 转义码），规避 Windows 下中文输入法候选框偏离光标问题；流式输出自绘按终端宽度做 CJK 宽度感知换行。`coding/` 与 `utils/` 均为叶级子目录，内容直接记于此。

## 叶级子目录（内容直接记于此）

### 子目录 coding/
- `index.ts` — coding 角色 TUI 主循环 `TUI({ onSubmit, eventSource, onExitRequest })`：消费 `StreamEvent` 统一事件循环（thinking_delta / text_delta / tool_call / tool_result / plan_blocked / error / done，未识别事件静默跳过）；首个内容事件到达时才停等待动画 + 打印角色行 + 开启 `StreamWriter`；slash 命令分发（/exit /clear /help /agent /ask /plan）；导出 `printRoleLine(role, color?)` 工具方法
  - 关键导出: `TUI`, `printRoleLine`
  - 依赖: `@wuzi/core/ui-pattern.ts`（StreamEvent / UserInputEvent / CommandEvent）, `../utils/*`
  - 注意: `BOX_WIDTH=50`、`ROLE_NAME="wuzi-coding"` 为本角色专属配置（非通用工具）

### 子目录 utils/
通用终端工具桶文件，其他终端 UI 可直接 `import ... from "../utils"` 复用。
- `ansi.ts` — ANSI 转义码常量（RESET / BOLD / DIM / 颜色等），成对使用避免染色
- `width.ts` — 显示宽度工具：`isWide(code)` / `charWidth(ch)` / `displayWidth(str)`，CJK / 全角占 2 列、转义码不占宽度
- `box.ts` — `drawBox(title, content, color, width)` 边框盒子，按显示宽度 CJK 感知折行
- `stream-writer.ts` — `StreamWriter` 类：增量文本逐字写出，按显示列宽自动换行，转义码不计入宽度并在换行后保持当前着色
- `spinner.ts` — `Spinner` 类 + `SPINNER_FRAMES` 等待动画帧序列
- `input.ts` — `promptText(opts)` 单行输入 + `promptHitl(req)` HITL 授权弹窗 + `INPUT_CANCELLED` 取消哨兵
  - 依赖: `node:readline`, `./ansi.ts`, `./box.ts`, `@wuzi/types`（HitlRequest/HitlResponse/HitlChoice）
- `index.ts` — 桶文件，统一 `export * from` 上述 6 个工具模块
