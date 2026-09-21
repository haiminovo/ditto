/**
 * Ditto 实施平台 - 原子文件读写
 *
 * ⚠️ 不变量：**只有本模块允许调用 fs.writeFile / fs.writeFileSync**。
 *    其余任何地方想落盘都必须经过这里的原子写，否则就可能留下半截文件。
 *
 * ⚠️ 使用 node:fs，只能在服务端使用。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CoreError, asCoreError } from "../errors";

/** 临时文件后缀，便于识别与清理 */
const TMP_PREFIX = ".tmp-";

function tmpName(target: string): string {
  const rand = crypto.randomBytes(6).toString("hex");
  return path.join(
    path.dirname(target),
    `${TMP_PREFIX}${path.basename(target)}-${process.pid}-${rand}`
  );
}

/**
 * 原子写文件：写临时文件 → fsync → rename → fsync 目录。
 * rename 在同一文件系统上是原子的，所以读者永远看不到半截内容。
 */
export function writeFileAtomic(target: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = tmpName(target);

  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, "w");
    if (typeof data === "string") {
      fs.writeFileSync(fd, data, { encoding: "utf8" });
    } else {
      fs.writeFileSync(fd, data);
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    fs.renameSync(tmp, target);
    fsyncDir(path.dirname(target));
  } catch (e) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw asCoreError(e, "E_IO");
  }
}

/** 把目录项的元数据刷到磁盘，保证 rename 结果持久 */
function fsyncDir(dir: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch {
    // 某些平台/文件系统不支持对目录 fsync，忽略即可
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

export function writeJsonAtomic(target: string, value: unknown): void {
  writeFileAtomic(target, JSON.stringify(value, null, 2) + "\n");
}

export function readJson<T>(target: string): T {
  const raw = fs.readFileSync(target, "utf8");
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    throw new CoreError("E_IO", `JSON 解析失败：${target} —— ${(e as Error).message}`);
  }
}

export function readJsonOrNull<T>(target: string): T | null {
  if (!fs.existsSync(target)) return null;
  return readJson<T>(target);
}

export function readTextOrNull(target: string): string | null {
  if (!fs.existsSync(target)) return null;
  return fs.readFileSync(target, "utf8");
}

export function readBufferOrNull(target: string): Buffer | null {
  if (!fs.existsSync(target)) return null;
  return fs.readFileSync(target);
}

export function exists(target: string): boolean {
  return fs.existsSync(target);
}

export function removeIfExists(target: string): void {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* 哈希                                                                */
/* ------------------------------------------------------------------ */

export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * 规范化 JSON：对象键按字典序排序，保证同一逻辑内容得到同一字符串。
 * 审计哈希链依赖这个性质。
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return out;
}

export function shortHash(hash: string): string {
  return hash.slice(0, 8);
}
