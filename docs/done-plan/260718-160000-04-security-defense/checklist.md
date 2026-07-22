# 04-security-defense — 验收清单

所有条目可被命令行 / 脚本 / 单测独立验证。Tester 逐条 ✅ / ❌，不得软化判定。

## 静态结构验收

- [ ] 1. `packages/agent/modules/security/` 目录下存在 7 个文件：`glob-match.ts`、`blacklist.ts`、`sandbox.ts`、`rules.ts`、`policy.ts`、`rule-store.ts`、`security-gate.ts` — 验证命令: `ls packages/agent/modules/security/` 输出包含上述 7 个文件名
- [ ] 2. `packages/agent-types/index.ts` 导出 7 个 security 相关类型 — 验证命令: `grep -E "export (type|interface) (PermissionMode|RuleAction|SecurityRule|SecurityConfig|HitlRequest|HitlResponse|HitlChoice)" packages/agent-types/index.ts` 返回 ≥7 条
- [ ] 3. `packages/agent/utils/config/config-types.ts` 中 `AgentConfig` 包含可选 `security?: SecurityConfig` 字段，并存在 `DEFAULT_SECURITY_CONFIG` 常量 — 验证命令: `grep -E "security\??:|DEFAULT_SECURITY_CONFIG" packages/agent/utils/config/config-types.ts` 返回 ≥2 条
- [ ] 4. `ToolContext` 接口包含可选 `askUser?: (req: HitlRequest) => Promise<HitlResponse>` 字段 — 验证命令: `grep "askUser" packages/agent-types/index.ts` 返回 ≥1 条

## 单元测试验收

- [ ] 5. glob-match 单测通过 — 验证命令: `bun test packages/agent/tests/glob-match.test.ts` 全部通过；用例覆盖 `*` / `**` / `?` / `{a,b}` 至少 8 个用例（含正向命中与反向不命中）
- [ ] 6. blacklist 单测通过 — 验证命令: `bun test packages/agent/tests/blacklist.test.ts` 全部通过；覆盖 shell / git / file 三类，每类 ≥3 正向命中 + ≥2 反向不命中
- [ ] 7. sandbox 单测通过 — 验证命令: `bun test packages/agent/tests/sandbox.test.ts` 全部通过；覆盖沙箱内允许 / 沙箱外拒绝 / `..` 越界 / 符号链接 至少 4 用例
- [ ] 8. rules 单测通过 — 验证命令: `bun test packages/agent/tests/rules.test.ts` 全部通过；覆盖 session > project > global 优先级、通配工具名 `*`、首条命中即止、无命中 至少 5 用例
- [ ] 9. policy 单测通过 — 验证命令: `bun test packages/agent/tests/policy.test.ts` 全部通过；覆盖 strict / default / permissive 三档 × 读类 / 写类工具 至少 6 用例
- [ ] 10. rule-store 单测通过 — 验证命令: `bun test packages/agent/tests/rule-store.test.ts` 全部通过；覆盖 global + project 合并加载、项目级写入、全局写入 至少 4 用例（mock fs）
- [ ] 11. security-gate 单测通过 — 验证命令: `bun test packages/agent/tests/security-gate.test.ts` 全部通过；覆盖黑名单拒绝 / 沙箱拒绝 / 规则命中 allow / HITL once / HITL session / HITL permanent / HITL deny 至少 10 用例（mock askUser）

## 端到端验收

- [ ] 12. **黑名单拦截（shell）**: `gate.check({name:'exec_command', arguments:{command:'rm -rf /'}}, ctx)` 返回 `{decision:'deny', layer:'blacklist'}`，且 `reason` 包含 "blacklist" — 验证方式: security-gate 单测中包含该断言
- [ ] 13. **黑名单拦截（git）**: `gate.check({name:'exec_command', arguments:{command:'git push --force origin main'}}, ctx)` 返回 `{decision:'deny', layer:'blacklist'}`，`reason` 包含 "git" — 验证方式: security-gate 单测中包含该断言
- [ ] 14. **路径沙箱越界拒绝**: sandbox=`[cwd]`，`gate.check({name:'write_file', arguments:{path:'/etc/passwd'}}, ctx)` 返回 `{decision:'deny', layer:'sandbox'}` — 验证方式: security-gate 单测中包含该断言（Windows 用 `C:\Windows\system32\drivers\etc\hosts`）
- [ ] 15. **路径沙箱内允许（读类兜底）**: 无规则 + default 档，`gate.check({name:'read_file', arguments:{path:'./src/foo.ts'}}, ctx)` 返回 `{decision:'allow', layer:'policy'}` — 验证方式: security-gate 单测中包含该断言
- [ ] 16. **规则优先级 session > project > global**: 配置 global 规则 `{tool:'exec_command', pattern:'*', action:'deny'}`、project 规则 `{tool:'exec_command', pattern:'git status*', action:'allow'}`、session 规则 `{tool:'exec_command', pattern:'git push*', action:'allow'}`：
    - 调用 `git push` → 命中 session allow（`layer:'rules', source:'session'`）
    - 调用 `git status` → 命中 project allow（`source:'project'`）
    - 调用 `ls` → 命中 global deny（`source:'global'`）
    - 验证方式: rules 单测 + security-gate 单测联合覆盖
- [ ] 17. **strict 档兜底询问**: 无规则 + strict 档 + 读类工具 → `gate.check` 触发 `ctx.askUser` 回调；mock askUser 返回 `{decision:'allow', scope:'once'}` → check 返回 `{decision:'allow'}` 且 `ruleStore.saveRuleToProject` 未被调用 — 验证方式: security-gate 单测
- [ ] 18. **HITL session scope**: mock askUser 返回 `{decision:'allow', scope:'session'}` → check 返回 allow，且**后续同工具同参数调用不再触发 askUser**（命中会话规则）— 验证方式: security-gate 单测连续两次 check 断言 askUser 仅被调用一次
- [ ] 19. **HITL permanent scope 落盘**: mock askUser 返回 `{decision:'allow', scope:'permanent'}` → check 返回 allow，且 `ruleStore.saveRuleToProject` 被调用一次，参数包含 `{tool, pattern, action:'allow'}` — 验证方式: security-gate 单测断言 mock 调用
- [ ] 20. **HITL deny 路径**: mock askUser 返回 `{decision:'deny', scope:'once'}` → check 返回 `{decision:'deny'}`，`reason` 包含 "user_denied" — 验证方式: security-gate 单测
- [ ] 21. **ToolExecutor 集成拒绝**: 构造带 SecurityGate 的 ToolExecutor，`executeCall({id:'t1', name:'exec_command', arguments:{command:'rm -rf /'}})` 返回 `ToolResult {ok:false, error:'denied_by_security', content: /blacklist/}`，且底层 `tool.execute` 未被调用 — 验证方式: tool-executor 单测（spy on tool.execute 断言未被调用）
- [ ] 22. **向后兼容**: `AgentConfig` 不含 `security` 字段时 `loadConfig` 正常返回；`SecurityGate` 以 `DEFAULT_SECURITY_CONFIG`（default 档 + sandbox=`[cwd, projectDir]`）构造；`ToolExecutor` 不传 gate 时保持原有行为 — 验证方式: config-loader 单测 + tool-executor 单测

## 默认值与阈值（实现时必须遵守）

### 默认权限档位
`default`

### 默认沙箱
`[cwd, projectDir]`（去重后，均为绝对路径）

### 黑名单模式（最小覆盖，可扩展）

**shell 类**:
- `rm -rf /`、`rm -rf ~`、`rm -rf $HOME`、`rm -rf /*`
- `mkfs`（任意参数）
- `dd if=.* of=/dev/.*`
- `:(){:|:&};:`（fork bomb）
- `chmod -R 777 /`
- `curl ... | sh`、`curl ... | bash`、`wget ... | sh`、`wget ... | bash`
- `sudo rm`
- `shutdown`、`reboot`、`halt`、`poweroff`

**git 类**:
- `git push --force`、`git push -f`
- `git reset --hard`
- `git clean -f`、`git clean -fd`、`git clean -fdx`
- `git checkout .`、`git checkout -- .`
- `git restore .`、`git restore --staged .`
- `git branch -D`（强制删除分支）

**file 类**（写向以下路径的 write_file / edit_file）:
- `/etc/`、`/sys/`、`/proc/`、`/boot/`
- `C:\Windows\`、`C:\Program Files\`、`C:\Program Files (x86)\`
- `~/.ssh/`
- `.env`、`credentials`、`id_rsa`、`id_ed25519`

### 档位兜底矩阵

| 档位 | 读类工具未命中（`mutates !== true`） | 写类工具未命中（`mutates === true`） |
|------|--------------------------------------|--------------------------------------|
| `strict` | `ask` | `ask` |
| `default` | `allow` | `ask` |
| `permissive` | `allow` | `allow` |

### HITL 授权范围

| scope | 行为 |
|-------|------|
| `once` | 仅本次允许 / 拒绝，不入规则，不落盘 |
| `session` | 写入 SecurityGate 内存会话规则，本会话内同 tool+pattern 不再询问 |
| `permanent` | 写入项目级 `{projectDir}/.wuzi/config.yaml` 的 `security.rules` 段，跨会话生效 |

### 性能阈值
单次 `SecurityGate.check`（不含 HITL 等待）耗时 < 5ms。

### 拒绝结果结构
`ToolResult { ok:false, error:'denied_by_security', content:<人类可读原因>, meta:{ layer:'blacklist'|'sandbox'|'rules'|'policy'|'hitl', reason:<结构化原因> } }`
