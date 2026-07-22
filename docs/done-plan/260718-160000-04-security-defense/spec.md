# 04-security-defense — 纵深防御安全检查机制

## 背景

当前 wuzi-agent 的工具执行器（`ToolExecutor.executeCall`）在收到模型发起的 `ToolCall` 后直接派发给具体工具执行，缺少执行前的安全校验层。这意味着：

- 模型可能执行 `rm -rf /`、`git push --force` 等破坏性命令而不被拦截
- 文件读写工具可任意访问沙箱外的敏感路径（如 `~/.ssh/`、`/etc/`、`C:\Windows\`）
- 没有「让用户在执行前介入决定」的机制，agent 自主模式下风险面不可控

需要一套纵深防御的安全检查机制，作为工具执行前的前置闸门，按多层策略（黑名单 → 路径沙箱 → 显式规则 → 档位兜底 → HITL）逐层判定，把不可逆的危险操作拦截在执行前。

## 目标用户

- **wuzi-agent 的使用者（开发者）**：希望 agent 在自主执行任务时不至于造成不可逆破坏
- **首次接入或不熟悉风险面的用户**：希望以最严格档位起步，逐步放权

## 核心能力清单

1. **危险操作黑名单**：对 `exec_command` 工具的命令串匹配已知高危模式（破坏性 shell、远程脚本即执行、git 破坏性子命令），命中即无条件拒绝（不被档位/规则覆盖）
2. **路径沙箱**：文件类工具（`read_file`/`write_file`/`edit_file`/`find_files`/`search_content`）的目标路径必须落在沙箱允许目录内，越界即拒绝
3. **可配置允许/拒绝/询问规则**：按「工具名 + 参数 glob 模式」声明 `allow`/`deny`/`ask`，支持通配工具名 `*`
4. **多档权限模式**：`strict`/`default`/`permissive` 三档，覆盖在规则之上，决定「规则未命中」时的兜底行为
5. **人在回路（HITL）**：规则命中 `ask` 或档位兜底为 `ask` 时，通过 `ToolContext.askUser` 回调把决定权交回用户，支持「本次 / 本会话 / 永久」三种授权范围
6. **规则优先级**：会话级临时规则 > 项目级固定规则 > 用户全局默认；同优先级按声明顺序匹配，首条命中即终止
7. **永久规则落盘**：「永久」授权写入项目级或用户全局 security 配置段，下次会话自动加载

## 非功能要求

- **性能**：单次 `SecurityGate.check` 耗时 < 5ms（黑名单 / 沙箱 / 规则匹配均为同步纯函数，HITL 仅在必要时触发）
- **解耦**：security 模块不得反向依赖 UI 层；HITL 通过 `ToolContext` 注入的回调实现，可被任意 UI 适配
- **可测试性**：黑名单 / 沙箱 / 规则 / 档位 / 规则存储均为纯函数或独立类，可独立单测；HITL 回调可 mock
- **配置兼容**：扩展 `AgentConfig` 增加 `security` 字段，缺省时不影响现有行为（向后兼容）
- **可观测**：每次拒绝 / 询问都附带结构化原因（哪一层、哪条规则、匹配了什么片段），写入 `ToolResult.meta` 供调试
- **工具覆盖**：内置 6 个工具 + 注册到 `ToolRegistry` 的 MCP 工具；MCP 工具路径语义不可控，仅走黑名单 + HITL，不走沙箱

## 设计骨架

- **类型层（`@wuzi/types`）**：新增 `PermissionMode`/`RuleAction`/`SecurityRule`/`SecurityConfig`/`HitlRequest`/`HitlResponse`/`HitlChoice`；扩展 `ToolContext` 增加可选 `askUser` 回调
- **配置层（`@wuzi/core/utils/config`）**：`AgentConfig` 增加 `security` 字段；复用现有三级路径（global/project/user）加载与合并
- **安全模块（`@wuzi/core/modules/security`）**：
  - `glob-match.ts` — 轻量 glob→regex 匹配（支持 `*`/`**`/`?`/`{a,b}`）
  - `blacklist.ts` — 危险命令模式匹配（shell / git / file 三类）
  - `sandbox.ts` — 路径沙箱包含判定（resolve + `path.relative` 判定 + `..` 越界防护）
  - `rules.ts` — 规则匹配引擎（session > project > global 优先级，首条命中即止）
  - `policy.ts` — 档位兜底策略（strict = ask / default = 写类 ask 读类 allow / permissive = allow）
  - `rule-store.ts` — 规则持久化（读写 global + project 两层 security 配置段，session 仅内存）
  - `security-gate.ts` — 主入口 `SecurityGate`，串联上述组件，实现 `check()` 决策流
- **集成层**：
  - `tool-executor.ts`：在 `executeCall` 派发前调用 `SecurityGate.check`，`deny` 则直接返回结构化拒绝 `ToolResult`
  - `app/index.ts`：装配 `SecurityGate`，构造带 `askUser` 回调的 `ToolContext`，注入 `ToolExecutor`

## Out of Scope

- 子 agent（sub-agents）发起的工具调用拦截（本次仅覆盖内置 + MCP 工具）
- MCP 工具的路径沙箱（MCP 工具路径语义不可控，仅纳入黑名单 + HITL）
- 加密签名 / 规则防篡改（假定本地配置文件可信）
- 规则版本迁移机制（首次实现，无历史版本）
- 规则编辑 TUI 界面（用户直接编辑 YAML 配置文件）
- 命令语义级动态分析（如 `rm -rf $(pwd)` 的展开、管道嵌套求值），仅做字符串模式匹配
- 网络出口管控（不限制 agent 访问哪些网络地址）

## 版本完成标准

- 内置 6 个工具 + MCP 工具的调用均经过 `SecurityGate` 前置检查
- 黑名单至少覆盖：root 删除、`mkfs`、fork bomb、远程脚本即执行、`git push --force`、`git reset --hard`、`git clean -f`、`git branch -D`
- 路径沙箱默认 = `[cwd, projectDir]`，越界写操作被拒绝
- 三档模式可切换，`strict` 档下所有写类工具未命中规则即询问
- HITL 三种授权范围（本次 / 本会话 / 永久）均落地，「永久」规则可跨会话生效
- 规则优先级 session > project > global 可验证
- `checklist.md` 全部端到端项通过（Tester 独立判定）
- 现有 `bun test` 全量不回归
