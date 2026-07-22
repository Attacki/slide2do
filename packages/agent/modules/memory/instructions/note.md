# notes for `packages/agent/modules/memory/instructions/`

> 最后更新: 2026-07-21 — 新增 InstructionLoader：项目指令文件（AGENTS.md）多层级加载与 @include 模块化引用

项目指令文件加载器。在项目根目录放一份手写的 AGENTS.md 记录技术栈 / 编码规范 / 注意事项，
新会话启动时由 Agent 异步加载并作为 `kind:system_supplement` 系统消息注入到 memory 开头（system 之后、user 之前）。

## 文件索引

### `instruction-loader.ts`
- **用途**: 多层级 AGENTS.md 加载 + `@include` 模块化引用展开
- **关键导出**:
  - 类 `InstructionLoader`：构造 `{ projectDir, userLevelPath?, maxIncludeDepth?, reader? }`；`load()` 返回 `{ content, loaded, warnings }`
  - 纯函数 `parseIncludeDirectives(content)`：从文本提取 `@include <path>` 指令
  - 纯函数 `isPathSafe(resolved, rootDir)`：跨平台路径逃逸检查（`path.relative` 判定，`..` 开头或绝对路径视为逃逸）
  - 纯函数 `expandIncludes(content, basePath, depth, maxDepth, rootDir, reader?)`：递归展开 `@include`，超深度 / 逃逸 / 文件缺失均保留原指令文本 + 警告注释
- **加载顺序**: 项目级（`{projectDir}/AGENTS.md`，根 = projectDir）→ 用户级（`userLevelPath`，缺省 `~/.wuzi/AGENTS.md`，根 = userLevelPath 所在目录）；高优先级排前让 LLM 优先遵循；两层间用 `---` 分隔注释标注层级
- **嵌套深度保护**: 缺省 3 层；超限保留原指令 + 警告注释（`<!-- 警告：@include 嵌套深度已达上限 N，停止展开 -->`）
- **路径逃逸拦截**: 解析后路径必须落在所属层级根目录内；逃逸时保留原指令 + 警告注释（`已拦截` 字样）
- **文件缺失处理**: 保留原指令 + 警告注释（`不存在或读取失败` 字样）
- **IO 解耦**: `reader?: (path: string) => Promise<string>` 注入便于测试；默认用 `fs.readFile`
- **依赖**: `node:fs/promises`, `node:path`, `node:os`, `@wuzi/types` (`InstructionConfig`), `../../../utils/config/config-types.ts` (`DEFAULT_INSTRUCTION_CONFIG`)
- **消费者**: `agent.ts`（构造时 `await loader.load()` 后追加为 system_supplement 消息）；`app/index.ts`（装配）
- **注意**: 用 `path.relative` 跨平台判定逃逸（Windows 上 `path.sep` 是 `\`，用 `startsWith(rootDir + sep)` 会误判）；`load()` 移除 `existsSync` 改为 try/catch 以兼容注入的 reader
