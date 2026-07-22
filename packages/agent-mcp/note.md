# notes for `packages/agent-mcp/`

> 最后更新: 2026-07-21 — 新建本笔记；files-server.rs 当前为空桩

wuzi-mcp 相关定义仓库。MCP 客户端实现位于 `@wuzi/core` 的 `modules/mcp/`，本包仅承载独立 MCP 服务（可非 TS 实现，如 Rust）。本目录为非叶级（含 `files-server/`）。

## 叶级子目录（内容直接记于此）

### 子目录 files-server/
- `files-server.rs` — （空 / 待实现）预期为 Rust 实现的 MCP 文件服务端

> MCP 客户端 / 注册中心 / JSON-RPC / 传输层 / 工具适配等实现见 `packages/agent/modules/mcp/`。
