/**
 * 配置加载、合并与首次引导
 *
 * 1. 检测三级路径是否存在
 * 2. 存在则加载 YAML 并按 protocol 深度合并
 * 3. 全缺失则在全局级创建 .wuzi/config.yaml 并交互引导
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import * as yaml from 'js-yaml'; // TODO: 确认依赖是否已安装
import type { AgentConfig, LLMConfig, LLMProtocol } from './config-types.ts';
import { resolveConfigPaths, type ConfigPaths } from './config-paths.ts';

/** YAML 解析辅助 */
async function loadYaml<T>(path: string): Promise<T | null> {
    try {
        const raw = await readFile(path, 'utf-8');
        return yaml.load(raw) as T;
    } catch {
        return null;
    }
}

/** 环境变量插值：api_key 支持 ${ENV_NAME} */
function interpolateEnvVars(value: string): string {
    return value.replace(/\$\{([^}]+)\}/g, (_, envName) => {
        return process.env[envName] ?? '';
    });
}

/** 递归插值对象中的字符串字段 */
function interpolateObject(obj: unknown): void {
    if (!obj || typeof obj !== 'object') return;
    for (const val of Object.values(obj as Record<string, unknown>)) {
        if (typeof val === 'string') {
            Object.setPrototypeOf(
                { value: interpolateEnvVars(val) },
                Object.getPrototypeOf(val)
            );
        } else if (typeof val === 'object' && val !== null) {
            interpolateObject(val);
        }
    }
}

/** 深度合并：同 protocol 字段高层级覆盖，新 protocol 追加 */
function mergeLLMConfigs(base: LLMConfig[], override: LLMConfig[]): LLMConfig[] {
    const map = new Map<string, LLMConfig>();
    for (const item of base) {
        map.set(item.protocol, { ...item });
    }
    for (const item of override) {
        if (map.has(item.protocol)) {
            // 深度合并：高层级覆盖低层级字段
            const existing = map.get(item.protocol)!;
            map.set(item.protocol, { ...existing, ...item });
        } else {
            map.set(item.protocol, { ...item });
        }
    }
    return Array.from(map.values());
}

/** 首次引导：三级全缺失时在全局级交互式创建配置 */
async function interactiveFirstSetup(globalPath: string): Promise<AgentConfig> {
    console.log('欢迎使用 wuzi-agent！首次使用需要配置 LLM 后端。\n');

    // 引导选择 protocol
    console.log('请选择 LLM 协议:');
    console.log('1. anthropic (Claude)');
    console.log('2. openai');
    const protocolChoice = prompt('> 请输入选项 (1/2): ');
    const protocol: LLMProtocol = protocolChoice?.trim() === '2' ? 'openai' : 'anthropic';

    // 引导填写 base_url
    const defaultBaseUrl =
        protocol === 'anthropic'
            ? 'https://api.anthropic.com'
            : 'https://api.openai.com';
    const base_url = (prompt(`> base_url [${defaultBaseUrl}]: `) ?? '').trim() || defaultBaseUrl;
    
    // 引导填写 model
    const defaultModel = protocol === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o';
    const model = (prompt(`> model [${defaultModel}]: `) ?? '').trim() || defaultModel;


    // 引导填写 api_key（不回显）
    const api_key = prompt('> api_key: ') ?? '';

    // 构建配置
    const config: AgentConfig = {
        agent_role: 'coding',
        active: protocol,
        llm: [{ protocol, model, base_url, api_key }],
    };

    // 所有参数已收集完毕，创建目录并写入配置文件
    // 使用写入锁防止写入过程中 Ctrl+C 导致配置文件损坏
    const dir = dirname(globalPath);

    let writing = false;
    let pendingExit = false;

    const sigHandler = () => {
        if (writing) {
            pendingExit = true;
            console.log('\n正在保存配置，请勿中断...');
        } else {
            process.exit(0);
        }
    };

    process.on('SIGINT', sigHandler);
    process.on('SIGTERM', sigHandler);

    writing = true;
    try {
        await mkdir(dir, { recursive: true });
        const yamlContent = yaml.dump(config, { indent: 2, lineWidth: 120, noCompatMode: true });
        await writeFile(globalPath, yamlContent, 'utf-8');
    } finally {
        writing = false;
        process.off('SIGINT', sigHandler);
        process.off('SIGTERM', sigHandler);
        if (pendingExit) {
            process.exit(0);
        }
    }

    console.log('\n✓ 配置已写入:', globalPath);
    return config;
}

/** 公开 API */
export interface LoadConfigResult {
    config: AgentConfig;
    source: ConfigPaths & { activeLayers: ('global' | 'project' | 'user')[] };
}

/** 加载并合并三级配置，三级全缺失时进入首次引导。 */
export async function loadConfig(projectDir?: string): Promise<LoadConfigResult> {
    const paths = resolveConfigPaths(projectDir);

    // 检测各级是否存在
    const exists = {
        global: existsSync(paths.global),
        project: existsSync(paths.project),
        user: existsSync(paths.user),
    };

    // 全部缺失 → 首次引导
    if (!exists.global && !exists.project && !exists.user) {
        const config = await interactiveFirstSetup(paths.global);
        return { config, source: { ...paths, activeLayers: ['global'] } };
    }

    // 逐级加载
    const layers: Array<{ layer: 'global' | 'project' | 'user'; data: AgentConfig | null }> = [
        { layer: 'global', data: exists.global ? await loadYaml<AgentConfig>(paths.global) : null },
        { layer: 'project', data: exists.project ? await loadYaml<AgentConfig>(paths.project) : null },
        { layer: 'user', data: exists.user ? await loadYaml<AgentConfig>(paths.user) : null },
    ];

    // 合并
    let mergedLlm: LLMConfig[] = [];
    let agent_role = 'coding';
    let active: string | undefined;
    const activeLayers: LoadConfigResult['source']['activeLayers'] = [];

    for (const { layer, data } of layers) {
        if (!data) continue;

        activeLayers.push(layer);

        if (data.agent_role) agent_role = data.agent_role;
        if (data.active !== undefined) active = data.active;
        if (Array.isArray(data.llm)) {
            // 插值环境变量
            interpolateObject(data.llm);
            mergedLlm = mergeLLMConfigs(mergedLlm, data.llm as LLMConfig[]);
        }
    }

    // active 缺省取首个 protocol
    if (!active && mergedLlm.length > 0) {
        active = mergedLlm[0]?.protocol;
    }

    const config: AgentConfig = { agent_role, active, llm: mergedLlm };
    return { config, source: { ...paths, activeLayers } };
}

/** 根据协议名从合并后的列表中提取生效后端 */
export function getActiveProvider(config: AgentConfig): LLMConfig {
    const target = config.active ?? config.llm[0]?.protocol;
    const found = config.llm.find((p) => p.protocol === target);
    if (!found) {
        throw new Error(`active 协议 "${target}" 未在任何层级配置`);
    }
    return found;
}

/** 校验生效后端的必填项 */
export function validateProvider(provider: LLMConfig, sourceLayers: string[]): void {
    const errors: string[] = [];
    if (!provider.model) errors.push('model');
    if (!provider.api_key) errors.push('api_key');

    if (errors.length > 0) {
        throw new Error(
            `生效后端 (${sourceLayers.join('/')}) 缺失必填字段: ${errors.join(', ')}`
        );
    }
}
