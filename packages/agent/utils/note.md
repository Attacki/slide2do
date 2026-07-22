# notes for `packages/agent/utils/`

> 最后更新: 2026-07-17 — config-types 增加 AgentMode 与 LoopConfig.mode（三态运行模式）

工具与基础设施集合。`config/`、`log/` 均为叶级，内容直接记于此。

## 叶级子目录（内容直接记于此）

### 子目录 config/
- `config-types.ts` — 配置数据结构：`LLMProtocol`、`LLMConfig`、`AgentConfig`、`AgentMode`（agent/ask/plan）、`LoopConfig`（含 `mode`；`planOnly` 已弃用，兼容映射为 `mode:'plan'`）、`DEFAULT_LOOP_CONFIG`
- `config-paths.ts` — 三级配置路径解析：`resolveConfigPaths()`。全局 `${HOME}/.wuzi/config.yaml` < 项目 `{projectDir}/.wuzi/config.yaml` < 用户 `{projectDir}/.wuzi/user-config.yaml`
- `config-loader.ts` — 配置加载/合并/首次引导：`loadConfig()`（三级深度合并，全缺失时交互式创建）；`getActiveProvider()` 取生效后端；`validateProvider()` 校验必填项
- `path-sheet.ts` — config 工具集导出桶（重导出上述三个文件）
- **注意**: `api_key` 支持 `${ENV_NAME}` 环境变量插值；密钥按需从环境变量注入，不硬编码

### 子目录 log/
- （空目录，暂无日志模块实现）
