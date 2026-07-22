# notes for `packages/agent-roles/`

> 最后更新: 2026-07-21 — 新建本笔记；roles-registry 注册 loadRole 并暴露 loadStableSystem() 助手

角色包：所有可用 agent 角色的注册中心与各角色实现。本目录为非叶级（每个角色一个子目录，部分角色内部还含 prompts/ 等更深结构）。

## 文件索引

### `roles-registry.ts`
- **用途**: 角色注册中心——按 id 查找并加载角色的稳定 system prompt（角色 prompt 模块拼装结果）
- **关键导出**: `RoleLoader` 接口（含 `meta` / 可选 `loadRole` / `loadSystemPrompt`）, `getRegisteredRoles()`, `getRole(roleId)`, `loadStableSystem(role)`, `registerRole(loader)`
- **关键方法**: `loadStableSystem(role)` 优先调 `loadRole`（新接口，供 PromptComposer 持有作为可缓存稳定段），缺省回退 `loadSystemPrompt`（向后兼容）
- **依赖**: `./coding/index.ts`
- **消费者**: `app/index.ts`（启动链路通过 `getRole` + `loadStableSystem` 加载稳定段并装配 PromptComposer）
- **注意**: 新增角色须在 registry 中 `set()` 注册；`loadRole` 与 `loadSystemPrompt` 语义等价，新角色应优先实现 `loadRole`

## 子目录（各有独立笔记）
- `coding/` → `coding/note.md`

## 叶级子目录（内容直接记于此）

### 子目录 desk-manger/
- `index.ts` — （空 / 待实现）
- `system-prompt.md` — （空 / 待实现）
