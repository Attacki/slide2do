# notes for `packages/agent-tools/`

> 最后更新: 2026-07-17 — 新建本笔记；read_file/edit_file 工具描述强化「编辑前必须先读」规则，与 coding 角色 03-tool-usage.md 双重呼应（03-coding-prompt-arch 任务 5）

agent 内置工具集。本目录为非叶级（含 6 个工具子目录 + shared/，均为叶级）；`tests/` 由 Tester 维护，不在此记录。

## 文件索引

### `index.ts`
- **用途**: 工具集桶文件，集中导出六个核心工具及其工厂，便于核心引擎按需注册
- **关键导出**: `builtinTools`（6 个工具的共享实例数组）, `getBuiltinTools(ctx)`（工厂，预留按上下文定制）, 各工具具名导出（readFileTool 等）
- **依赖**: `@wuzi/types`, 各工具子目录
- **消费者**: `@wuzi/core`（agent.ts 装配 ToolRegistry 时引用）
- **注意**: 工具实例共享，cwd/signal 在执行时通过 ToolContext 注入；新增工具须同时在此桶文件注册

### 子目录 read-file/
- `index.ts` — `read_file` 工具：读取文本文件内容。描述层强化「是编辑文件前的必备步骤」，与全局指令双重呼应

### 子目录 write-file/
- `index.ts` — `write_file` 工具：写入/覆盖文本文件，父目录不存在自动创建

### 子目录 edit-file/
- `index.ts` — `edit_file` 工具：原文唯一匹配替换（old_string 须在文件中唯一）。描述层强化「调用前必须先用 read_file 读取」，与全局指令双重呼应

### 子目录 exec-command/
- `index.ts` — `exec_command` 工具：在工作目录执行 shell 命令。Windows 优先 Git Bash（排除 WSL 启动器）回退 cmd /c；其余平台 sh -c

### 子目录 find-files/
- `index.ts` — `find_files` 工具：按 glob 模式查找文件，返回相对路径列表（上限 200）

### 子目录 search-content/
- `index.ts` — `search_content` 工具：在文件内容中按正则搜索，返回 `文件:行号: 行内容` 列表（上限 50）

### 子目录 shared/
- `fs.ts` — `safeResolve(cwd, input)` 路径越界防护（最小沙箱），`PathEscapeError` 异常类
- `result.ts` — `okResult(content, meta?)` / `failResult(message, meta?)` 工具结果构造辅助
