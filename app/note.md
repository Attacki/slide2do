# notes for `app/`

> 最后更新: 2026-07-21 — 新建本笔记；装配 ContextCompactor 六件套

wuzi-agent CLI 入口包（`@wuzi/agent`）。承担启动流程编排：配置加载 → 后端校验 → 角色稳定段加载 → Provider 创建 → 工具注册 → MCP 连接池装配 → 环境信息收集器 + Prompt 编排器 + SecurityGate + 上下文压缩编排器装配 → Agent + AgentSession 初始化 → MCP 工具拉取注册 → TUI 启动。本目录为叶级。

## 文件索引

### `index.ts`
- **用途**: CLI 主入口（`bun start` / `bun dev`），按 6 步顺序装配全部组件并启动交互循环
- **关键导出**: 无（脚本入口，`main()` 顶层调用）
- **关键方法**: `main()` 串行执行 Step 1~6：loadConfig → validateProvider → loadStableSystem → createProvider → ToolRegistry + getBuiltinTools → McpConnectionPool（懒握手）→ ContextManager + PromptComposer → RuleStore + SecurityGate（sandbox 缺省 = [cwd]）→ ContextCompactor 六件套（TokenCounter / ToolResultOffloader / SingleMessageCompactor / Summarizer / HistoryCompactor / ContextCompactor，sessionId=`{pid}-{Date.now()}`）→ Agent + AgentSession → `agent.initMcp()` → TUI
- **依赖**: `@wuzi/core`（Agent / AgentSession / 工具系统 / Provider / 上下文压缩六件套 / Security）, `@wuzi/roles`（getRole / loadStableSystem）, `@wuzi/tools`（getBuiltinTools）, `@wuzi/tui/coding`（TUI）, `@wuzi/tui/utils`（promptHitl）, `@wuzi/types`（ContextConfig / HitlRequest / HitlResponse）
- **消费者**: 无（顶层入口）
- **注意**: `askUser` 回调对接 TUI `promptHitl`；事件队列 `eventQueue` + `eventResolve` 实现 Loop → TUI 的 AsyncIterable 推送；`onExit` / `onExitRequest` 都先 `agent.closeMcp()` 释放 stdio 子进程 / HTTP 连接再 `process.exit`；`thinking` 仅 anthropic 支持，其他后端配置时 warn 并忽略；`sessionId` 用于 offloader 落盘目录隔离
