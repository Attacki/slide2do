# Checklist — Agent 运行模式系统

## 类型与配置
- [x] `AgentMode = 'agent' | 'ask' | 'plan'` 已定义并导出
- [x] `LoopConfig.mode` 生效，`DEFAULT_LOOP_CONFIG.mode = 'agent'`
- [x] 旧配置 `loop.planOnly:true` 兼容映射为 `mode:'plan'`

## 循环行为
- [x] `agent` 模式：写类工具正常执行（不拦截）
- [x] `ask` 模式：写类工具被拦截，读类正常
- [x] `plan` 模式：写类工具被拦截，读类正常
- [x] 模式指令追加到 messages 最后一条（agent 不注入），且不写入记忆
- [x] 每个被请求工具仍有对应 tool 结果（记忆不变量）

## 命令与切换
- [x] `/agent` `/ask` `/plan` 直接设定模式并即时生效
- [x] 切到 `/agent` 或 `/ask` 可退出 plan
- [x] 帮助文本含三模式命令

## 验证
- [x] `bun --check` 关键文件通过
- [x] `bun test packages/agent packages/agent-tools` 全绿（48 pass / 0 fail，含新增用例）
