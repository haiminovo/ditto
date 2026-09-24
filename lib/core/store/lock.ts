/**
 * Ditto 实施平台 - 并发写保护
 *
 * 两层：
 *   1. 进程内 async mutex —— 按 key 链式排队，防止 Next route handler
 *      并发请求互相覆盖。
 *   2. 跨进程 mkdir 锁 —— 多个 Web/脚本进程可能同时写同一个工作区。
 *      mkdir 是原子的、全平台可用、零依赖。
 *
 * ⚠️ 使用 node:fs，只能在服务端使用。
 */

import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "./paths";

/* ------------------------------------------------------------------ */
/* 进程内互斥                                                          */
/* ------------------------------------------------------------------ */

const chains = new Map<string, Promise<unknown>>();

/**
 * 把 fn 排到 key 对应的串行队列尾部。
 * 前一个任务失败不会阻断后续任务（错误已在该任务的调用方处理）。
 */
export function withMutex<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // 队列里只保留"已落定"的信号，避免 Map 无限增长
  chains.set(
    key,
    next.then(
      () => undefined,
      () => undefined
    )
  );
  return next as Promise<T>;
}

/* ------------------------------------------------------------------ */
/* 跨进程 mkdir 锁                                                     */
/* ------------------------------------------------------------------ */

export interface LockOptions {
  /** 锁超过这个毫秒数视为过期，可被抢占 */
  staleMs?: number;
  /** 获取锁的最长等待时间 */
  timeoutMs?: number;
  /** 重试基础间隔 */
  baseDelayMs?: number;
}

const DEFAULT_LOCK: Required<LockOptions> = {
  staleMs: 10_000,
  timeoutMs: 30_000,
  baseDelayMs: 15,
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 以 lockDir 为互斥点执行 fn。
 *
 * 实现：`mkdir` 在目标不存在时原子成功 —— 这就是"拿到锁"。
 * 锁的元数据（pid + 时间）写在锁目录内的 owner.json，用于过期抢占。
 */
export async function withDirLock<T>(
  lockDir: string,
  fn: () => Promise<T> | T,
  options: LockOptions = {}
): Promise<T> {
  const opt = { ...DEFAULT_LOCK, ...options };
  const started = Date.now();
  let acquired = false;

  ensureDir(path.dirname(lockDir));

  while (!acquired) {
    try {
      fs.mkdirSync(lockDir);
      acquired = true;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") throw err;

      // 锁已存在：判断是否过期
      if (isStale(lockDir, opt.staleMs)) {
        try {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue; // 立刻重试，不再等
        } catch {
          /* 别人抢先清理了，继续走退避 */
        }
      }

      if (Date.now() - started > opt.timeoutMs) {
        throw new Error(`获取锁超时（${opt.timeoutMs}ms）：${lockDir}`);
      }

      // 抖动退避，避免多进程同步重试
      const delay = opt.baseDelayMs + Math.floor(Math.random() * opt.baseDelayMs * 2);
      await sleep(delay);
    }
  }

  // 写入持有者信息，供过期判定
  try {
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() })
    );
  } catch {
    /* 拿不到写权限不影响持锁本身 */
  }

  try {
    return await fn();
  } finally {
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {
      /* 已被抢占清理则忽略 */
    }
  }
}

function isStale(lockDir: string, staleMs: number): boolean {
  try {
    const st = fs.statSync(lockDir);
    return Date.now() - st.mtimeMs > staleMs;
  } catch {
    return false;
  }
}

/**
 * 项目级写锁：把「进程内串行」与「跨进程 mkdir 锁」组合起来。
 * 所有针对某个项目的写操作都应包在这一层里。
 */
export function withProjectWriteLock<T>(
  lockDir: string,
  projectId: string,
  fn: () => Promise<T> | T
): Promise<T> {
  return withMutex(`project:${projectId}`, () => withDirLock(lockDir, fn));
}
