/**
 * 角色注册表
 *
 * 管理所有可用 agent 角色，按 id 查找并加载稳定 system prompt（角色 prompt 模块拼装结果）。
 *
 * `loadRole()` 为新接口，返回角色稳定段字符串，供 PromptComposer 持有作为可缓存稳定段；
 * `loadSystemPrompt()` 为向后兼容接口（未改造角色仍可仅实现此方法），二者语义等价。
 */

import { ROLE_META as codingMeta, loadRole as loadCodingRole, loadSystemPrompt as loadCodingPrompt } from './coding/index.ts';

export interface RoleLoader {
    meta: typeof codingMeta,
    /**
     * 加载角色稳定 system prompt（新接口，供 PromptComposer 持有作为可缓存稳定段）。
     * 未改造角色可不实现，由 loadStableSystem() 兜底回退到 loadSystemPrompt()。
     */
    loadRole?: () => Promise<string>,
    /** 加载角色 system prompt（向后兼容接口；新角色应优先实现 loadRole） */
    loadSystemPrompt: () => Promise<string>,
}

// 注册表
const registry = new Map<string, RoleLoader>();


/** 注册 coding 角色 */
registry.set('coding', {
    meta: codingMeta,
    loadRole: loadCodingRole,
    loadSystemPrompt: loadCodingPrompt,
});

/**
 * 获取所有已注册的角色 ID 列表
 */
export function getRegisteredRoles(): string[] {
    return Array.from(registry.keys());
}

/**
 * 根据角色 ID 获取角色加载器
 *
 * @throws 若角色未注册则抛出错误
 */
export function getRole(roleId: string): RoleLoader {
    const loader = registry.get(roleId);
    if (!loader) {
        throw new Error(`未知角色: "${roleId}" (可用: ${getRegisteredRoles().join(', ')})`);
    }
    return loader;
}

/**
 * 加载角色稳定 system prompt（优先 loadRole，缺省回退 loadSystemPrompt）。
 *
 * 供 app 启动链路调用：返回的字符串作为 PromptComposer 的稳定段，由 provider 层
 * 挂载 cache_control 实现缓存最大化命中。
 */
export async function loadStableSystem(role: RoleLoader): Promise<string> {
    if (role.loadRole) return role.loadRole();
    return role.loadSystemPrompt();
}

/**
 * 注册自定义角色（供后续扩展）
 */
export function registerRole(loader: RoleLoader): void {
    registry.set(loader.meta.id, loader);
}
