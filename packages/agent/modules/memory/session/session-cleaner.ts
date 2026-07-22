/**
 * SessionCleaner — 过期会话自动清理
 *
 * spec §核心能力清单 第 7 条：
 *  - agent 启动后扫描 sessions 目录
 *  - 删除 lastActiveAt 超 maxAgeDays（默认 30 天）的会话（.jsonl + .meta.json 同删）
 *  - 单条删除失败 warn 不阻塞其余
 */

import type { SessionMeta } from '@wuzi/types';
import type { SessionStore } from './session-store.ts';

/** 一天的毫秒数 */
export const ONE_DAY_MS = 86400000;

/**
 * 判定会话是否过期。
 *
 * @param meta 会话元信息
 * @param now 当前时间戳（毫秒）
 * @param maxAgeDays 过期天数（缺省 30）
 * @returns true 表示已过期（应被清理）
 *
 * 纯函数，便于单测。
 */
export function isExpired(meta: SessionMeta, now: number, maxAgeDays: number = 30): boolean {
  if (!Number.isFinite(meta.lastActiveAt)) return false;
  if (!Number.isFinite(now)) return false;
  if (maxAgeDays < 0) return false;
  return now - meta.lastActiveAt > maxAgeDays * ONE_DAY_MS;
}

/** SessionCleaner 构造参数 */
export interface SessionCleanerOptions {
  /** SessionStore 实例（用于 listMetas 与 deleteSession） */
  store: SessionStore;
  /** 过期天数；缺省 30 */
  maxAgeDays?: number;
}

/** cleanExpired 返回结构 */
export interface CleanResult {
  /** 删除的会话数 */
  deletedCount: number;
  /** 跳过的会话数（未过期或删除失败） */
  skippedCount: number;
  /** 删除失败产生的警告 */
  warnings: string[];
}

/**
 * 过期会话清理器。
 *
 * 构造时注入 SessionStore 与 maxAgeDays；`cleanExpired(now)` 扫描全部 meta，
 * 命中过期的逐个删除，单条失败 warn 不阻塞其余。
 */
export class SessionCleaner {
  private readonly store: SessionStore;
  private readonly maxAgeDays: number;

  constructor(opts: SessionCleanerOptions) {
    this.store = opts.store;
    this.maxAgeDays = opts.maxAgeDays ?? 30;
  }

  /**
   * 扫描并清理过期会话。
   *
   * @param now 当前时间戳（毫秒）；缺省 Date.now()，便于测试注入
   * @returns 清理结果（删除数 / 跳过数 / 警告）
   */
  async cleanExpired(now: number = Date.now()): Promise<CleanResult> {
    const warnings: string[] = [];
    let deletedCount = 0;
    let skippedCount = 0;

    let metas: SessionMeta[];
    try {
      metas = await this.store.listMetas();
    } catch (e) {
      warnings.push(`listMetas 失败，跳过清理: ${(e as Error).message}`);
      return { deletedCount: 0, skippedCount: 0, warnings };
    }

    for (const meta of metas) {
      const expired = isExpired(meta, now, this.maxAgeDays);
      if (!expired) {
        skippedCount++;
        continue;
      }
      try {
        await this.store.deleteSession(meta.id);
        deletedCount++;
      } catch (e) {
        warnings.push(`删除会话 ${meta.id} 失败: ${(e as Error).message}`);
        skippedCount++;
      }
    }

    return { deletedCount, skippedCount, warnings };
  }
}
