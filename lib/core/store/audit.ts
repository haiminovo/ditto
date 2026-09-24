/**
 * Ditto 实施平台 - 审计流水
 *
 * 按月分片追加写 JSONL，条目带哈希链：
 *   hash = sha256(prevHash + canonicalJson(不含 hash 字段的条目))
 *
 * 首个条目的 prevHash 为 "genesis"。链跨分片连续，所以 auditVerify
 * 必须按文件名顺序走完所有分片。
 *
 * ⚠️ 使用 node:fs，只能在服务端使用。
 */

import fs from "node:fs";
import path from "node:path";
import { canonicalJson, sha256Hex, writeFileAtomic } from "./fsjson";
import { ensureDir } from "./paths";
import type { Actor, AuditAction, AuditEntry } from "../types";
import { asCoreError } from "../errors";

export const GENESIS_HASH = "genesis";

function shardName(at: Date): string {
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}.jsonl`;
}

/** 按时间顺序列出所有审计分片 */
export function listAuditShards(auditDir: string): string[] {
  if (!fs.existsSync(auditDir)) return [];
  return fs
    .readdirSync(auditDir)
    .filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))
    .sort();
}

export function readAuditEntries(auditDir: string): AuditEntry[] {
  const out: AuditEntry[] = [];
  for (const shard of listAuditShards(auditDir)) {
    const raw = fs.readFileSync(path.join(auditDir, shard), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as AuditEntry);
      } catch {
        // 坏行直接跳过，verify 会把它报成断链
      }
    }
  }
  return out;
}

function lastEntry(auditDir: string): AuditEntry | null {
  const shards = listAuditShards(auditDir);
  for (let i = shards.length - 1; i >= 0; i--) {
    const raw = fs.readFileSync(path.join(auditDir, shards[i]), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    if (lines.length === 0) continue;
    try {
      return JSON.parse(lines[lines.length - 1]) as AuditEntry;
    } catch {
      continue;
    }
  }
  return null;
}

function computeHash(entry: Omit<AuditEntry, "hash">): string {
  return sha256Hex(entry.prevHash + canonicalJson(entry));
}

export interface AuditInput {
  actor: Actor;
  action: AuditAction;
  summary: string;
  projectId?: string;
  assetId?: string;
  targetRev?: number;
  details?: Record<string, unknown>;
}

/**
 * 追加一条审计。调用方通常已经持有项目写锁；即便如此，
 * 这里仍然走"读尾 → 算链 → 追加"的短临界区。
 */
export function appendAudit(auditDir: string, input: AuditInput): AuditEntry {
  ensureDir(auditDir);
  const now = new Date();

  const prev = lastEntry(auditDir);
  const prevHash = prev?.hash ?? GENESIS_HASH;
  const seq = (prev?.seq ?? 0) + 1;

  const base: Omit<AuditEntry, "hash"> = {
    seq,
    at: now.toISOString(),
    actor: input.actor,
    action: input.action,
    projectId: input.projectId,
    assetId: input.assetId,
    targetRev: input.targetRev,
    summary: input.summary,
    details: input.details,
    prevHash,
  };

  const entry: AuditEntry = { ...base, hash: computeHash(base) };

  const shard = path.join(auditDir, shardName(now));
  try {
    fs.appendFileSync(shard, JSON.stringify(entry) + "\n", "utf8");
  } catch (e) {
    throw asCoreError(e, "E_IO");
  }
  return entry;
}

export interface AuditVerifyResult {
  ok: boolean;
  total: number;
  /** 首个断链处的条目序号 */
  brokenAtSeq?: number;
  reason?: string;
}

/**
 * 走完整条哈希链。任何一处 prevHash 对不上、或条目自身被改，
 * 都会在 brokenAtSeq 处报出来。
 */
export function verifyAudit(auditDir: string): AuditVerifyResult {
  const entries = readAuditEntries(auditDir);
  let prevHash = GENESIS_HASH;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.prevHash !== prevHash) {
      return {
        ok: false,
        total: entries.length,
        brokenAtSeq: e.seq,
        reason: `第 ${e.seq} 条的 prevHash 与上一条的 hash 不匹配`,
      };
    }
    const { hash, ...rest } = e;
    const expected = computeHash(rest);
    if (expected !== hash) {
      return {
        ok: false,
        total: entries.length,
        brokenAtSeq: e.seq,
        reason: `第 ${e.seq} 条内容已被篡改（哈希不匹配）`,
      };
    }
    prevHash = hash;
  }

  return { ok: true, total: entries.length };
}

/** 过滤读取：用于 ditto_audit_list */
export interface AuditQuery {
  projectId?: string;
  assetId?: string;
  action?: AuditAction;
  since?: string;
  limit?: number;
}

export function queryAudit(auditDir: string, q: AuditQuery = {}): AuditEntry[] {
  let entries = readAuditEntries(auditDir);

  if (q.projectId) entries = entries.filter((e) => e.projectId === q.projectId);
  if (q.assetId) entries = entries.filter((e) => e.assetId === q.assetId);
  if (q.action) entries = entries.filter((e) => e.action === q.action);
  if (q.since) {
    const since = q.since;
    entries = entries.filter((e) => e.at >= since);
  }

  // 最新在前
  entries = entries.slice().reverse();
  if (q.limit && q.limit > 0) entries = entries.slice(0, q.limit);
  return entries;
}

/** 清空审计（仅供测试脚本使用） */
export function resetAudit(auditDir: string): void {
  for (const shard of listAuditShards(auditDir)) {
    writeFileAtomic(path.join(auditDir, shard), "");
  }
}
