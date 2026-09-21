/**
 * Ditto 实施平台 - ID 生成与 ditto:// URI
 *
 * 零依赖：ULID 自己实现（26 字符 Crockford Base32），不引 ulid 包。
 */

import { invalid } from "./errors";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * 生成 ULID：48 位毫秒时间戳 + 80 位随机数，共 26 个 Crockford Base32 字符。
 * 时间前缀让 id 天然按创建顺序排序。
 */
export function ulid(now: number = Date.now()): string {
  let timePart = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    timePart = CROCKFORD[t % 32] + timePart;
    t = Math.floor(t / 32);
  }

  const rand = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(rand);
  } else {
    for (let i = 0; i < rand.length; i++) rand[i] = Math.floor(Math.random() * 256);
  }

  let randPart = "";
  for (let i = 0; i < 16; i++) randPart += CROCKFORD[rand[i] % 32];

  return timePart + randPart;
}

/** 生成带前缀的短 id */
export function prefixedId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

/** 从任意文本生成 slug，用于项目 id */
export function slugify(input: string): string {
  const base = input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    // 保留中日韩字符与字母数字
    .replace(/[^\p{L}\p{N}-]+/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return base || "project";
}

/* ------------------------------------------------------------------ */
/* ditto:// URI                                                        */
/* ------------------------------------------------------------------ */

export const URI_SCHEME = "ditto://";

export type DittoUri =
  | { kind: "workspace" }
  | { kind: "projects" }
  | { kind: "project"; projectId: string }
  | { kind: "project-assets"; projectId: string }
  | { kind: "project-asset-by-path"; projectId: string; path: string }
  | { kind: "project-run"; projectId: string; runId: string }
  | { kind: "project-context"; projectId: string }
  | { kind: "asset"; assetId: string }
  | { kind: "asset-meta"; assetId: string }
  | { kind: "asset-history"; assetId: string }
  | { kind: "asset-version"; assetId: string; version: number }
  | { kind: "capabilities" }
  | { kind: "capability"; packageId: string }
  | { kind: "capability-template"; packageId: string; templateId: string }
  | { kind: "rules" }
  | { kind: "rulepack"; rulePackId: string };

/**
 * 解析 ditto:// URI。返回 null 表示不是本平台的 URI。
 *
 * 注意路径段里的百分号编码：资源模板的 {+path} 会原样传递斜杠，
 * 但客户端可能对单个段做 encodeURIComponent，这里统一解码。
 */
export function parseDittoUri(uri: string): DittoUri | null {
  if (!uri.startsWith(URI_SCHEME)) return null;
  const rest = uri.slice(URI_SCHEME.length);
  const [head, ...tail] = rest.split("/").map(decodeSegment);
  const dec = tail.map(decodeSegment);

  switch (head) {
    case "workspace":
      return { kind: "workspace" };
    case "projects":
      return { kind: "projects" };
    case "capabilities":
      return dec.length === 0
        ? { kind: "capabilities" }
        : dec.length === 2 && dec[0] === "template"
          ? { kind: "capability-template", packageId: dec[1], templateId: "" }
          : { kind: "capability", packageId: dec[0] };
    case "capability": {
      const packageId = dec[0];
      if (!packageId) return null;
      if (dec[1] === "template" && dec[2]) {
        return { kind: "capability-template", packageId, templateId: dec[2] };
      }
      return { kind: "capability", packageId };
    }
    case "rules":
      return { kind: "rules" };
    case "rulepack":
      return dec[0] ? { kind: "rulepack", rulePackId: dec[0] } : null;
    case "project": {
      const projectId = dec[0];
      if (!projectId) return null;
      if (dec.length === 1) return { kind: "project", projectId };
      if (dec[1] === "assets") return { kind: "project-assets", projectId };
      if (dec[1] === "context") return { kind: "project-context", projectId };
      if (dec[1] === "runs" && dec[2]) {
        return { kind: "project-run", projectId, runId: dec[2] };
      }
      if (dec[1] === "asset-by-path") {
        // {+path} 展开后斜杠被保留，需要把剩余段重新拼起来
        const path = dec.slice(2).join("/");
        return path ? { kind: "project-asset-by-path", projectId, path } : null;
      }
      return null;
    }
    case "asset": {
      const assetId = dec[0];
      if (!assetId) return null;
      if (dec.length === 1) return { kind: "asset", assetId };
      if (dec[1] === "meta") return { kind: "asset-meta", assetId };
      if (dec[1] === "history") return { kind: "asset-history", assetId };
      if (dec[1] === "v" && dec[2]) {
        const version = Number.parseInt(dec[2], 10);
        if (!Number.isFinite(version)) return null;
        return { kind: "asset-version", assetId, version };
      }
      return null;
    }
    default:
      return null;
  }
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 构造 ditto:// URI。资产路径里的每一段单独编码，斜杠保留。 */
export function assetUri(assetId: string): string {
  return `${URI_SCHEME}asset/${encodeSegment(assetId)}`;
}

export function assetPathUri(projectId: string, assetPath: string): string {
  const encoded = assetPath.split("/").map(encodeSegment).join("/");
  return `${URI_SCHEME}project/${encodeSegment(projectId)}/asset-by-path/${encoded}`;
}

export function projectUri(projectId: string): string {
  return `${URI_SCHEME}project/${encodeSegment(projectId)}`;
}

function encodeSegment(s: string): string {
  return encodeURIComponent(s).replace(/%2F/gi, "/");
}

/** 校验 ULID 形状（宽松：只校验字符集与长度） */
export function isUlid(value: string): boolean {
  if (value.length !== 26) return false;
  for (const ch of value) {
    if (!CROCKFORD.includes(ch)) return false;
  }
  return true;
}

export function assertAssetId(id: string): string {
  if (!isUlid(id)) {
    throw invalid(`资产 id 格式不合法（应为 26 位 ULID）：${id}`);
  }
  return id;
}
