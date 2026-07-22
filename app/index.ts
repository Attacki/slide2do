#!/usr/bin/env bun
/**
 * wuzi-agent CLI 入口
 *
 * 启动流程：
 * 1. 加载配置（三级合并或首次引导）
 * 2. 校验生效后端必填项
 * 3. 加载角色 system prompt
 * 4. 创建 Provider 实例
 * 5. 初始化 Agent + Loop
 * 6. 启动 TUI 进入交互循环
 */

import { loadConfig, validateProvider } from '@wuzi/core/utils/config/path-sheet.ts';
import { resolveConfigPaths } from '@wuzi/core/utils/config/config-paths.ts';
import { createProvider } from '@wuzi/core/provider/client.ts';
import { getRole, loadStableSystem } from '@wuzi/roles/roles-registry.ts';
import {
  Agent,
  ToolRegistry,
  PromptComposer,
  ContextManager,
  RuleStore,
  SecurityGate,
  McpConnectionPool,
  TokenCounter,
  ToolResultOffloader,
  SingleMessageCompactor,
  Summarizer,
  HistoryCompactor,
  ContextCompactor,
  InstructionLoader,
  SessionStore,
  SessionRecovery,
  SessionCleaner,
  SessionManager,
} from '@wuzi/core';
import {
  DEFAULT_SECURITY_CONFIG,
  DEFAULT_CONTEXT_CONFIG,
  DEFAULT_INSTRUCTION_CONFIG,
  DEFAULT_SESSION_CONFIG,
} from '@wuzi/core/utils/config/config-types.ts';
import { AgentSession } from '@wuzi/core/agent-session.ts';
import { getBuiltinTools } from '@wuzi/tools';
import { TUI } from '@wuzi/tui/coding/index.ts';
import { promptHitl } from '@wuzi/tui/utils/input.ts';
import type { StreamEvent, UserInputEvent } from '@wuzi/core/ui-pattern.ts';
import type { ContextConfig, HitlRequest, HitlResponse } from '@wuzi/types';
import { resolve } from 'node:path';

async function main(): Promise<void> {
  try {
    // Step 1: 加载配置（三级合并 或 首次引导）
    console.log('⏳ 正在加载配置...\n');
    const { config, source } = await loadConfig();
    console.log(`✓ 配置已加载 (来源: ${source.activeLayers.join(', ')})`);

    // Step 2: 提取并校验生效后端
    const activeConfig = (() => {
      try {
        const cfg = config.llm.find((p) => p.protocol === config.active) ?? config.llm[0];
        validateProvider(cfg!, source.activeLayers);
        return cfg!;
      } catch (err) {
        console.error('\n✗ 配置错误:', err instanceof Error ? err.message : err);
        process.exit(1);
      }
    })();

    // thinking 告警（仅 openai 时）
    if (activeConfig.thinking && activeConfig.protocol !== 'anthropic') {
      console.warn('⚠ thinking 仅 anthropic 支持，已忽略');
      activeConfig.thinking = false;
    }

    console.log(`✓ 后端: ${activeConfig.protocol} / ${activeConfig.model}`);

    // Step 3: 加载角色稳定 system prompt（模块化拼装结果，会话内不变，可缓存）
    const roleId = config.agent_role || 'coding';
    let systemPrompt: string;
    try {
      const role = getRole(roleId);
      systemPrompt = await loadStableSystem(role);
      console.log(`✓ 角色: ${role.meta.name}`);
    } catch (err) {
      console.error('\n✗ 角色错误:', err instanceof Error ? err.message : err);
      process.exit(1);
    }

    // Step 4: 创建 Provider
    const provider = createProvider(activeConfig);

    // Step 4.5: 装配内置工具注册中心（按工作目录注入上下文）
    const cwd = process.cwd();
    const toolRegistry = new ToolRegistry();
    for (const tool of getBuiltinTools({ cwd })) {
      try {
        toolRegistry.register(tool);
      } catch (err) {
        console.warn(`⚠ 工具注册跳过: ${(err as Error).message}`);
      }
    }
    console.log(`✓ 工具: 已注册 ${toolRegistry.list().length} 个`);

    // Step 4.5b: 装配 MCP 连接池（若配置了 mcp.servers）
    // - 创建 McpConnectionPool 持有所有 server config（懒握手，首次 getTools 时才连接）
    // - 实际工具拉取与注册在 Agent 构造后通过 agent.initMcp() 完成
    // - 退出时通过 agent.closeMcp() 释放 stdio 子进程 / HTTP 连接
    const mcpServers = config.mcp?.servers ?? [];
    const mcpPool = mcpServers.length > 0 ? new McpConnectionPool(mcpServers) : undefined;
    if (mcpPool) {
      console.log(`✓ MCP: 已配置 ${mcpServers.length} 个 server（懒握手）`);
    }

    // Step 4.6: 装配环境信息收集器 + Prompt 编排器
    // - ContextManager 收集 cwd/OS 等环境信息，每次 run 现取注入 env_info 动态段
    // - PromptComposer 持有角色稳定段，按「稳定 system → env_info → 历史 → mode_reminder」拼装
    //   便于 provider 层挂载 cache_control 实现缓存最大化命中
    const contextManager = new ContextManager();
    const composer = new PromptComposer(systemPrompt);

    // Step 4.7: 装配 SecurityGate（前置安全检查）
    // - ruleStore 持有 global + project 两层 config.yaml 的 security 配置
    // - sandbox 缺省 = [cwd]（项目根 = cwd）；显式配置时按配置（去重绝对路径）
    // - askUser 回调对接 TUI input 层 promptHitl，渲染 HitlRequest 并收集 HitlResponse
    const configPaths = resolveConfigPaths(cwd);
    const ruleStore = new RuleStore({ global: configPaths.global, project: configPaths.project });
    const securityConfig = config.security ?? DEFAULT_SECURITY_CONFIG;
    const sandboxDirs = Array.isArray(securityConfig.sandbox) && securityConfig.sandbox.length > 0
      ? Array.from(new Set(securityConfig.sandbox))
      : [cwd];
    const securityGate = await SecurityGate.create({
      ruleStore,
      mode: securityConfig.mode,
      sandbox: sandboxDirs,
      tools: toolRegistry.list(),
    });
    console.log(`✓ 安全: mode=${securityConfig.mode ?? 'default'}, sandbox=${sandboxDirs.length} 项`);

    // askUser 回调：对接 TUI input 层渲染 HitlRequest 并收集 HitlResponse
    const askUser = async (req: HitlRequest): Promise<HitlResponse> => promptHitl(req);

    // Step 4.8: 装配上下文压缩编排器（ContextCompactor）
    // - 合并 DEFAULT_CONTEXT_CONFIG 与用户配置（config.context）得到 Required<ContextConfig>
    // - TokenCounter 字符近似估算 + EMA 校正
    // - ToolResultOffloader 落盘根目录缺省 .wuzi/context-offload（相对于 cwd）
    // - SingleMessageCompactor 协调单条阈值 / 合计阈值 / offloader 调用
    // - Summarizer 复用 provider 与 activeConfig，内部强制 thinking:false、不挂 tools
    // - HistoryCompactor 编排分区 + 摘要 + 拼装，保留最近 4 轮
    // - sessionId 用于 offloader 落盘目录隔离与压缩流程透传
    const contextConfig = {
      ...DEFAULT_CONTEXT_CONFIG,
      ...config.context,
    } as Required<ContextConfig>;
    const tokenCounter = new TokenCounter();
    const offloader = new ToolResultOffloader();
    const singleMessageCompactor = new SingleMessageCompactor(offloader, {
      singleToolResultThreshold: contextConfig.singleToolResultThreshold,
      singleMessageTotalThreshold: contextConfig.singleMessageTotalThreshold,
    });
    const summarizer = new Summarizer(provider, activeConfig);
    const historyCompactor = new HistoryCompactor(summarizer, {
      keepRecentRounds: contextConfig.keepRecentRounds,
    });
    const contextCompactor = new ContextCompactor({
      config: contextConfig,
      tokenCounter,
      offloader,
      singleMessageCompactor,
      historyCompactor,
    });
    const sessionId = `${process.pid}-${Date.now()}`;
    console.log(`✓ 上下文: compaction=${contextConfig.compactionEnabled}, offload=${contextConfig.offloadEnabled}`);

    // Step 4.9: 装配项目指令加载器（AGENTS.md 多层级 + @include）
    // - 项目级：{cwd}/AGENTS.md
    // - 用户级：~/.wuzi/AGENTS.md（缺省）
    // - @include 嵌套深度缺省 3，路径逃逸各自层级根目录拦截
    const instructionConfig = {
      ...DEFAULT_INSTRUCTION_CONFIG,
      ...(config.instructions ?? {}),
    };
    const instructionLoader = new InstructionLoader({
      projectDir: cwd,
      userLevelPath: instructionConfig.userLevelPath,
      maxIncludeDepth: instructionConfig.maxIncludeDepth,
    });

    // Step 4.10: 装配会话存档与恢复（SessionManager = Store + Recovery + Cleaner）
    // - sessions 目录与 config.yaml 同位置（{cwd}/.wuzi/sessions/）
    // - SessionRecovery 复用 tokenCounter + contextCompactor 做 token 超限压缩
    // - SessionCleaner 启动后自动清理 30 天前未活跃会话
    const sessionConfig = {
      ...DEFAULT_SESSION_CONFIG,
      ...(config.session ?? {}),
    };
    const sessionsDir = resolve(cwd, '.wuzi', 'sessions');
    const sessionStore = new SessionStore({ baseDir: sessionsDir });
    const sessionRecovery = new SessionRecovery({
      contextCompactor,
      tokenCounter,
      tokenLimit: config.session?.tokenLimit,
    });
    const sessionCleaner = new SessionCleaner({
      store: sessionStore,
      maxAgeDays: sessionConfig.maxAgeDays,
    });
    const sessionManager = new SessionManager({
      store: sessionStore,
      recovery: sessionRecovery,
      cleaner: sessionCleaner,
    });

    // 启动后立即清理过期会话（spec §核心能力清单 第 7 条；超过 maxAgeDays 未活跃的会话）
    // 失败不阻塞启动（warn 由 SessionCleaner 内部归一化）
    if (sessionConfig.enabled) {
      try {
        const cleanResult = await sessionManager.cleanupExpired();
        if (cleanResult.deletedCount > 0) {
          console.log(`✓ 会话清理: 删除 ${cleanResult.deletedCount} 个过期会话（> ${sessionConfig.maxAgeDays} 天未活跃）`);
        }
      } catch (e) {
        console.warn(`⚠ 会话清理失败（不阻塞启动）: ${(e as Error).message}`);
      }
    }

    // Step 5: 初始化 Agent + Loop（透传 ReAct 循环配置：最大轮数 / 运行模式 / 超时 + Prompt 编排 + 上下文压缩）
    const agent = new Agent({
      provider,
      config: activeConfig,
      systemPrompt,
      tools: toolRegistry,
      toolContext: { cwd, askUser },
      loop: config.loop,
      composer,
      contextManager,
      securityGate,
      mcpPool,
      contextCompactor,
      instructionLoader: sessionConfig.enabled ? instructionLoader : undefined,
      sessionManager: sessionConfig.enabled ? sessionManager : undefined,
      sessionId,
    });

    // Step 5.1: 拉取并注册 MCP 工具（必须在 Agent 构造之后、TUI 启动之前）
    // - agent.initMcp() 幂等；mcpPool 未注入时直接 return
    // - 单个工具注册失败（重名等）跳过并 warn，不影响其他工具
    if (mcpPool) {
      const before = toolRegistry.list().length;
      await agent.initMcp();
      const after = toolRegistry.list().length;
      console.log(`✓ MCP 工具: 已注册 ${after - before} 个`);
    }

    const startupMode = agent.getMode();
    if (startupMode !== 'agent') {
      console.log(`✓ 模式: ${startupMode}（只读，写类工具将被拦截）`);
    }

    // 创建事件队列（用于从 Loop 推送到 TUI）
    const eventQueue: StreamEvent[] = [];
    let eventResolve: (() => void) | null = null;
    const eventSource: AsyncIterable<StreamEvent> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (eventQueue.length === 0) {
              await new Promise<void>((resolve) => {
                eventResolve = resolve;
              });
            }
            return { done: false, value: eventQueue.shift()! };
          },
        };
      },
    };

    const loop = new AgentSession(agent, {
      onStreamEvent(event: StreamEvent) {
        eventQueue.push(event);
        eventResolve?.();
        eventResolve = null;
      },
      onExit() {
        // /exit 命令触发；先 await closeMcp 释放 MCP 子进程 / HTTP 连接再 exit
        // 注意：回调签名是 () => void，但内部允许 fire-and-forget 异步；process.exit 同步终止
        void agent.closeMcp().catch(() => {}).finally(() => process.exit(0));
      },
      onHelp() {
        // 由 TUI 内部处理显示
      },
      onCleared() {
        eventQueue.length = 0;
      },
      onModeChanged(mode) {
        // TUI 已本地回显切换结果，此处仅记录状态变更
        console.log(`运行模式已切换: ${mode}`);
      },
    });

    loop.start();

    // Step 6: 启动 TUI 进入交互循环
    await TUI({
      onSubmit(input: UserInputEvent) {
        loop.submit(input).catch((err: any) => {
          console.error('循环错误:', err);
        });
      },
      eventSource,
      onExitRequest() {
        // 用户主动退出（Ctrl+C / 关闭）；先停循环再 await closeMcp 释放 MCP 资源
        loop.stop();
        void agent.closeMcp().catch(() => {}).finally(() => process.exit(0));
      },
    });
  } catch (err) {
    console.error('\n✗ 启动失败:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
