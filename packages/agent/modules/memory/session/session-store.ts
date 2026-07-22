/**
 * SessionStore — 会话 JSONL 持久化与 meta 文件管理
 *
 * 设计原则（对齐 spec §核心能力清单 4、5）：
 *  - JSONL 追加写入（O(1) append）：每条消息序列化为一行 JSON 后追加到 .jsonl 末尾
 *  - 崩溃只丢最后一行：appendFile 在大多数 OS 上是原子单次写入，崩溃时至多丢最后一行
 *  - 恢复时坏行可跳过：readMessages 逐行解析，坏行 ok=false 不抛、计入 badLineCount
 *  - meta 原子写：用 temp 文件 + rename 原子替换，避免崩溃时 meta 半写
 *  - 列表展示无需扫整个 JSONL：meta 文件含概要信息，listMetas 仅扫 .meta.json
 *
 * 所有 IO 失败抛 Error 由上层归一化（warn 不阻塞主循环）。
 */

import { appendFile, readFile, writeFile, readdir, unlink, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ChatMessage } from '../../../ui-pattern.ts';
import type { SessionMeta } from '@wuzi/types';

/**
 * 把单条消息序列化为单行 JSON 字符串（不含换行）。
 *
 * 纯函数，便于单测。失败抛错（理论上 JSON.stringify 对 ChatMessage 不会失败）。
 */
export function serializeMessage(msg: ChatMessage): string {
  return JSON.stringify(msg);
}

/**
 * 解析单行 JSON 为 ChatMessage。
 *
 * 纯函数，不抛错：合法 JSON 行返回 `{ok:true, value}`；
 * 非法 JSON 行返回 `{ok:false}`，由调用方跳过继续。
 */
export function parseJsonlLine(line: string): { ok: boolean; value?: ChatMessage } {
  if (!line || line.trim().length === 0) return { ok: false };
  try {
    const value = JSON.parse(line) as ChatMessage;
    if (typeof value !== 'object' || value === null || typeof value.role !== 'string') {
      return { ok: false };
    }
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

/** readMessages 返回结构 */
export interface ReadMessagesResult {
  /** 解析成功的消息列表（按写入顺序） */
  messages: ChatMessage[];
  /** 跳过的坏行数（解析失败 / 非 ChatMessage 结构） */
  badLineCount: number;
}

/** SessionStore 构造参数 */
export interface SessionStoreOptions {
  /** 会话存档根目录（绝对路径），每会话 .jsonl 与 .meta.json 都在此目录下 */
  baseDir: string;
}

/**
 * 会话持久化存储。
 *
 * 文件布局：
 *  - {baseDir}/{sessionId}.jsonl       ← 消息流，每行一条 ChatMessage JSON
 *  - {baseDir}/{sessionId}.meta.json   ← 元信息（SessionMeta）
 *
 * 所有方法均为异步，IO 失败抛 Error。构造时自动创建 baseDir（递归）。
 */
export class SessionStore {
  private readonly baseDir: string;
  /** 标记 baseDir 是否已确保创建（避免每次 IO 都调 mkdir） */
  private ensured = false;

  constructor(opts: SessionStoreOptions) {
    this.baseDir = resolve(opts.baseDir);
  }

  /** 确保 baseDir 存在（递归创建，幂等） */
  private async ensureDir(): Promise<void> {
    if (this.ensured) return;
    await mkdir(this.baseDir, { recursive: true });
    this.ensured = true;
  }

  /** 拼装指定会话的 .jsonl 路径 */
  jsonlPath(sessionId: string): string {
    return join(this.baseDir, `${sessionId}.jsonl`);
  }

  /** 拼装指定会话的 .meta.json 路径 */
  metaPath(sessionId: string): string {
    return join(this.baseDir, `${sessionId}.meta.json`);
  }

  /** 拼装指定会话的 .meta.json 临时文件路径（用于原子写） */
  private tempMetaPath(sessionId: string): string {
    return join(this.baseDir, `${sessionId}.meta.json.${randomBytes(6).toString('hex')}.tmp`);
  }

  /**
   * 追加一条消息到会话 JSONL。
   *
   * 用 `appendFile` 追加单行（serializeMessage + '\n'），崩溃时至多丢最后一行。
   * 自动 ensureDir。
   *
   * @param sessionId 会话 ID
   * @param msg 消息对象
   */
  async appendMessage(sessionId: string, msg: ChatMessage): Promise<void> {
    await this.ensureDir();
    const line = serializeMessage(msg) + '\n';
    await appendFile(this.jsonlPath(sessionId), line, 'utf-8');
  }

  /**
   * 读取会话全部消息（逐行解析跳过坏行）。
   *
   * 文件不存在时返回空列表 + badLineCount=0（视为新会话）。
   * 空行与纯空白行静默跳过不计坏行；含内容但解析失败的行计入 badLineCount。
   * 坏行不抛错，调用方可观测告警。
   */
  async readMessages(sessionId: string): Promise<ReadMessagesResult> {
    const path = this.jsonlPath(sessionId);
    if (!existsSync(path)) {
      return { messages: [], badLineCount: 0 };
    }
    const raw = await readFile(path, 'utf-8');
    const lines = raw.split('\n');
    const messages: ChatMessage[] = [];
    let badLineCount = 0;
    for (const line of lines) {
      // 空行与纯空白行静默跳过不计坏行（末尾换行产生的空行、跨平台空白行）
      if (line.trim().length === 0) continue;
      const result = parseJsonlLine(line);
      if (result.ok && result.value) {
        messages.push(result.value);
      } else {
        badLineCount++;
      }
    }
    return { messages, badLineCount };
  }

  /**
   * 原子写入会话 meta 文件。
   *
   * 流程：写到 .tmp 临时文件 → rename 替换原文件。
   * rename 在同分区下是原子操作，崩溃时至多保留旧 meta 或新 meta 之一，不会半写。
   */
  async writeMeta(sessionId: string, meta: SessionMeta): Promise<void> {
    await this.ensureDir();
    const finalPath = this.metaPath(sessionId);
    const tmpPath = this.tempMetaPath(sessionId);
    const content = JSON.stringify(meta, null, 2);
    await writeFile(tmpPath, content, 'utf-8');
    await rename(tmpPath, finalPath);
  }

  /**
   * 读取会话 meta 文件。
   *
   * 文件不存在或解析失败时返回 null（调用方可视为新会话）。
   */
  async readMeta(sessionId: string): Promise<SessionMeta | null> {
    const path = this.metaPath(sessionId);
    if (!existsSync(path)) return null;
    try {
      const raw = await readFile(path, 'utf-8');
      const meta = JSON.parse(raw) as SessionMeta;
      if (typeof meta !== 'object' || meta === null || typeof meta.id !== 'string') {
        return null;
      }
      return meta;
    } catch {
      return null;
    }
  }

  /**
   * 列出 baseDir 下所有会话的 meta。
   *
   * 扫描 `*.meta.json` 文件，逐个解析返回 SessionMeta 列表。
   * 单个 meta 解析失败跳过不抛。
   */
  async listMetas(): Promise<SessionMeta[]> {
    if (!existsSync(this.baseDir)) return [];
    const entries = await readdir(this.baseDir);
    const metas: SessionMeta[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.meta.json')) continue;
      const sessionId = entry.slice(0, -'.meta.json'.length);
      const meta = await this.readMeta(sessionId);
      if (meta) metas.push(meta);
    }
    return metas;
  }

  /**
   * 删除指定会话的全部文件（.jsonl + .meta.json + 残留 .tmp）。
   *
   * 单文件删除失败不阻塞另一文件删除。
   * 不存在的文件忽略（unlink 抛 ENOENT 时吞掉）。
   */
  async deleteSession(sessionId: string): Promise<void> {
    const files = [
      this.jsonlPath(sessionId),
      this.metaPath(sessionId),
    ];
    for (const f of files) {
      try {
        await unlink(f);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT') throw err;
      }
    }
    // 清理可能残留的 .tmp 文件（写 meta 崩溃遗留）
    if (existsSync(this.baseDir)) {
      const entries = await readdir(this.baseDir);
      for (const entry of entries) {
        if (entry.startsWith(`${sessionId}.meta.json.`) && entry.endsWith('.tmp')) {
          try {
            await unlink(join(this.baseDir, entry));
          } catch {
            // 残留 tmp 删除失败忽略
          }
        }
      }
    }
  }
}
