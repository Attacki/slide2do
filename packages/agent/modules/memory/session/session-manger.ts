/**
 * SessionManager — 会话生命周期高层协调器
 *
 * 编排 SessionStore（持久化）+ SessionRecovery（异常处理）+ SessionCleaner（过期清理），
 * 对外暴露统一接口供 Agent / app 启动流程使用。
 *
 * 职责：
 *  - startSession(): 生成会话 ID 并写空 meta
 *  - appendMessage(id, msg): 持久化消息 + 异步更新 meta（title/summary/messageCount/lastActiveAt）
 *  - loadSession(id): 读消息 + 触发恢复（截断 / 压缩 / 时间跨度提醒）
 *  - cleanupExpired(): 委托 SessionCleaner 清理过期会话
 *
 * 所有 IO 异常归一化为 console.warn 不阻塞主循环。
 */

import type { ChatMessage } from '../../../ui-pattern.ts';
import type { SessionMeta } from '@wuzi/types';
import type { SessionStore } from './session-store.ts';
import type { SessionRecovery, RecoveryResult } from './session-recovery.ts';
import type { SessionCleaner, CleanResult } from './session-cleaner.ts';

/** 会话标题最大字符数（首条 user 消息前 N 字符） */
const TITLE_MAX_CHARS = 50;
/** 会话摘要最大字符数（末条 assistant 消息前 N 字符） */
const SUMMARY_MAX_CHARS = 200;
/** 默认会话标题 */
const DEFAULT_TITLE = '新会话';

/** SessionManager 构造参数 */
export interface SessionManagerOptions {
  /** SessionStore 实例（持久化层） */
  store: SessionStore;
  /** SessionRecovery 实例（异常处理层）；缺省时不做恢复处理，原样返回 */
  recovery?: SessionRecovery;
  /** SessionCleaner 实例（过期清理层）；缺省时 cleanupExpired 抛错 */
  cleaner?: SessionCleaner;
  /** 当前时间提供者（注入便于测试） */
  now?: () => number;
  /** 会话 ID 生成器（注入便于测试） */
  generateId?: () => string;
}

/** loadSession 返回结构（透传 RecoveryResult） */
export type LoadSessionResult = RecoveryResult & {
  /** 坏行计数（SessionStore.readMessages 返回，便于观测文件损坏情况） */
  badLineCount: number;
  /** 会话 meta（若存在） */
  meta: SessionMeta | null;
};

/**
 * 会话生命周期协调器。
 *
 * 用法：
 *  - 启动：`const sm = new SessionManager({ store, recovery, cleaner })`
 *  - 新会话：`const id = await sm.startSession()`
 *  - 持久化：`await sm.appendMessage(id, msg)` （每轮 assistant/tool 后调用）
 *  - 恢复：`const result = await sm.loadSession(id)`
 *  - 清理：`await sm.cleanupExpired()`
 */
export class SessionManager {
  private readonly store: SessionStore;
  private readonly recovery?: SessionRecovery;
  private readonly cleaner?: SessionCleaner;
  private readonly now: () => number;
  private readonly generateId: () => string;

  constructor(opts: SessionManagerOptions) {
    this.store = opts.store;
    this.recovery = opts.recovery;
    this.cleaner = opts.cleaner;
    this.now = opts.now ?? (() => Date.now());
    this.generateId = opts.generateId ?? (() => defaultGenerateId());
  }

  /**
   * 启动新会话：生成 ID 并写空 meta。
   *
   * @param id 可选会话 ID；缺省时由 generateId 生成。允许外层传入已确定的 ID 复用（如 Agent 已生成的 sessionId）
   * @returns 会话 ID（与传入一致或新生成）
   */
  async startSession(id?: string): Promise<string> {
    const sessionId = id ?? this.generateId();
    const ts = this.now();
    const meta: SessionMeta = {
      id: sessionId,
      title: DEFAULT_TITLE,
      summary: '',
      messageCount: 0,
      createdAt: ts,
      lastActiveAt: ts,
    };
    try {
      await this.store.writeMeta(sessionId, meta);
    } catch (e) {
      console.warn(`[session] startSession 写 meta 失败: ${(e as Error).message}`);
    }
    return sessionId;
  }

  /**
   * 追加一条消息到会话存档，并更新 meta。
   *
   * meta 更新规则：
   *  - 若 msg.role === 'user' 且当前 title 为 DEFAULT_TITLE：title = msg.content 前 50 字符
   *  - 若 msg.role === 'assistant'：summary = msg.content 前 200 字符
   *  - messageCount++
   *  - lastActiveAt = now
   *
   * 异常归一化 warn，不抛出（避免阻塞主循环）。
   *
   * @param sessionId 会话 ID
   * @param msg 消息对象
   */
  async appendMessage(sessionId: string, msg: ChatMessage): Promise<void> {
    // 1. 追加消息到 JSONL
    try {
      await this.store.appendMessage(sessionId, msg);
    } catch (e) {
      console.warn(`[session] appendMessage 写 jsonl 失败: ${(e as Error).message}`);
      return;
    }

    // 2. 更新 meta（读旧 meta → 计算新值 → 原子写）
    try {
      const old = await this.store.readMeta(sessionId);
      const ts = this.now();
      const updated = computeMetaUpdate(old, sessionId, msg, ts);
      await this.store.writeMeta(sessionId, updated);
    } catch (e) {
      console.warn(`[session] appendMessage 更新 meta 失败: ${(e as Error).message}`);
    }
  }

  /**
   * 加载并恢复会话。
   *
   * 流程：
   *  1. 调 store.readMessages 拿到原始消息（坏行已跳过）
   *  2. 调 recovery.recover（若注入）做截断 / 压缩 / 时间跨度提醒
   *  3. 返回恢复结果 + badLineCount + meta
   *
   * IO 异常归一化为返回空结果（messages=空），不抛。
   *
   * @param sessionId 会话 ID
   * @returns 加载结果
   */
  async loadSession(sessionId: string): Promise<LoadSessionResult> {
    let messages: ChatMessage[] = [];
    let badLineCount = 0;
    let meta: SessionMeta | null = null;

    try {
      const read = await this.store.readMessages(sessionId);
      messages = read.messages;
      badLineCount = read.badLineCount;
    } catch (e) {
      console.warn(`[session] loadSession 读消息失败: ${(e as Error).message}`);
      return {
        messages: [],
        warnings: [`读消息失败: ${(e as Error).message}`],
        badLineCount: 0,
        meta: null,
      };
    }

    try {
      meta = await this.store.readMeta(sessionId);
    } catch (e) {
      console.warn(`[session] loadSession 读 meta 失败: ${(e as Error).message}`);
    }

    if (!this.recovery) {
      return {
        messages,
        warnings: badLineCount > 0 ? [`跳过 ${badLineCount} 行坏行`] : [],
        badLineCount,
        meta,
      };
    }

    try {
      const recoveryResult = await this.recovery.recover(messages, {
        lastActiveAt: meta?.lastActiveAt ?? null,
        now: this.now(),
      });
      return {
        ...recoveryResult,
        warnings: badLineCount > 0
          ? [...recoveryResult.warnings, `跳过 ${badLineCount} 行坏行`]
          : recoveryResult.warnings,
        badLineCount,
        meta,
      };
    } catch (e) {
      console.warn(`[session] loadSession 恢复异常: ${(e as Error).message}`);
      return {
        messages,
        warnings: [`恢复异常: ${(e as Error).message}`],
        badLineCount,
        meta,
      };
    }
  }

  /**
   * 清理过期会话。委托 SessionCleaner.cleanExpired。
   * 未注入 cleaner 时抛错（调用方应保证装配）。
   *
   * @returns 清理结果
   */
  async cleanupExpired(): Promise<CleanResult> {
    if (!this.cleaner) {
      throw new Error('SessionCleaner 未注入，无法清理过期会话');
    }
    return this.cleaner.cleanExpired(this.now());
  }
}

/**
 * 根据旧 meta + 新消息计算更新后的 meta。
 *
 * 纯函数，便于单测：
 *  - 若 msg.role === 'user' 且旧 title 为 DEFAULT_TITLE：title = msg.content 前 50 字符
 *  - 若 msg.role === 'assistant'：summary = msg.content 前 200 字符
 *  - messageCount = (旧 messageCount ?? 0) + 1
 *  - lastActiveAt = ts
 *  - createdAt 保留旧值（若旧 meta 不存在则用 ts）
 *  - id 用 sessionId 参数（避免旧 meta 缺失时 id 丢失）
 *
 * @param old 旧 meta（可能为 null，表示会话首次写入）
 * @param sessionId 会话 ID
 * @param msg 新追加的消息
 * @param ts 当前时间戳
 * @returns 更新后的 meta
 */
export function computeMetaUpdate(
  old: SessionMeta | null,
  sessionId: string,
  msg: ChatMessage,
  ts: number,
): SessionMeta {
  const oldTitle = old?.title ?? DEFAULT_TITLE;
  let title = oldTitle;
  if (msg.role === 'user' && oldTitle === DEFAULT_TITLE) {
    const content = (msg.content ?? '').trim();
    if (content.length > 0) {
      title = content.length > TITLE_MAX_CHARS
        ? content.slice(0, TITLE_MAX_CHARS)
        : content;
    }
  }

  let summary = old?.summary ?? '';
  if (msg.role === 'assistant') {
    const content = (msg.content ?? '').trim();
    if (content.length > 0) {
      summary = content.length > SUMMARY_MAX_CHARS
        ? content.slice(0, SUMMARY_MAX_CHARS)
        : content;
    }
  }

  return {
    id: sessionId,
    title,
    summary,
    messageCount: (old?.messageCount ?? 0) + 1,
    createdAt: old?.createdAt ?? ts,
    lastActiveAt: ts,
  };
}

/** 默认会话 ID 生成器：{pid}-{ts} 形式 */
function defaultGenerateId(): string {
  return `${process.pid}-${Date.now()}`;
}
