/**
 * Ditto 实施平台 - 资产读写（纯 I/O）
 *
 * 磁盘布局（每个项目下）：
 *   assets/<逻辑路径>             活跃版本真实文件，人类与 git 直接可读
 *   assets.json                   资产索引（元数据唯一来源）
 *   versions/<assetId>/v<N>.<ext> 不可变历史快照
 *
 * ⚠️ 使用 node:fs，只能在服务端使用。
 */

import fs from "node:fs";
import path from "node:path";
import {
  SCHEMA_VERSION,
  formatForPath,
  isTextPath,
  mimeForPath,
  extOf,
  type Asset,
  type AssetVersion,
} from "../types";
import {
  ensureDir,
  projectPaths,
  resolveInside,
  normalizeLogicalPath,
} from "./paths";
import {
  readBufferOrNull,
  readJsonOrNull,
  readTextOrNull,
  sha256Hex,
  writeFileAtomic,
  writeJsonAtomic,
} from "./fsjson";
import { CoreError, invalid, notFound } from "../errors";

/* ------------------------------------------------------------------ */
/* 索引                                                                */
/* ------------------------------------------------------------------ */

interface AssetIndex {
  schemaVersion: number;
  assets: Asset[];
}

export function readAssets(wsRoot: string, projectId: string): Asset[] {
  const p = projectPaths(wsRoot, projectId);
  const idx = readJsonOrNull<AssetIndex>(p.assetsIndex);
  return idx?.assets ?? [];
}

export function writeAssets(wsRoot: string, projectId: string, assets: Asset[]): void {
  const p = projectPaths(wsRoot, projectId);
  ensureDir(p.root);
  writeJsonAtomic(p.assetsIndex, {
    schemaVersion: SCHEMA_VERSION,
    assets: assets.slice().sort((a, b) => a.path.localeCompare(b.path)),
  } satisfies AssetIndex);
}

export function findAssetById(assets: Asset[], assetId: string): Asset | null {
  return assets.find((a) => a.id === assetId) ?? null;
}

export function findAssetByPath(assets: Asset[], logicalPath: string): Asset | null {
  return assets.find((a) => a.path === logicalPath) ?? null;
}

export function requireAssetById(assets: Asset[], assetId: string): Asset {
  const asset = findAssetById(assets, assetId);
  if (!asset) throw notFound("资产", assetId);
  return asset;
}

export function requireAssetByPath(assets: Asset[], logicalPath: string): Asset {
  const asset = findAssetByPath(assets, logicalPath);
  if (!asset) throw notFound("资产（按路径）", logicalPath);
  return asset;
}

/* ------------------------------------------------------------------ */
/* 内容读写                                                            */
/* ------------------------------------------------------------------ */

export function assetFilePath(wsRoot: string, projectId: string, logicalPath: string): string {
  const p = projectPaths(wsRoot, projectId);
  return resolveInside(p.assetsDir, logicalPath, "资产路径");
}

/** 读取活跃版本的文本内容；二进制返回 null */
export function readAssetText(
  wsRoot: string,
  projectId: string,
  asset: Asset
): string | null {
  if (asset.isBinary) return null;
  return readTextOrNull(assetFilePath(wsRoot, projectId, asset.path));
}

/** 读取活跃版本的原始字节 */
export function readAssetBuffer(
  wsRoot: string,
  projectId: string,
  asset: Asset
): Buffer | null {
  return readBufferOrNull(assetFilePath(wsRoot, projectId, asset.path));
}

/** 读取指定历史版本的文本内容 */
export function readVersionText(
  wsRoot: string,
  projectId: string,
  assetId: string,
  version: number
): string | null {
  const file = versionSnapshotPath(wsRoot, projectId, assetId, version);
  return file ? readTextOrNull(file) : null;
}

export function readVersionBuffer(
  wsRoot: string,
  projectId: string,
  assetId: string,
  version: number
): Buffer | null {
  const file = versionSnapshotPath(wsRoot, projectId, assetId, version);
  return file ? readBufferOrNull(file) : null;
}

function versionSnapshotPath(
  wsRoot: string,
  projectId: string,
  assetId: string,
  version: number
): string | null {
  const versions = readVersions(wsRoot, projectId, assetId);
  const v = versions.find((x) => x.version === version);
  if (!v) return null;
  const p = projectPaths(wsRoot, projectId);
  return path.join(p.root, v.snapshot);
}

export function readVersions(
  wsRoot: string,
  projectId: string,
  assetId: string
): AssetVersion[] {
  const p = projectPaths(wsRoot, projectId);
  const dir = path.join(p.versionsDir, assetId);
  if (!fs.existsSync(dir)) return [];
  const f = readJsonOrNull<AssetVersion[]>(path.join(dir, "index.json"));
  return f ?? [];
}

export function writeVersions(
  wsRoot: string,
  projectId: string,
  assetId: string,
  versions: AssetVersion[]
): void {
  const p = projectPaths(wsRoot, projectId);
  const dir = path.join(p.versionsDir, assetId);
  ensureDir(dir);
  writeJsonAtomic(
    path.join(dir, "index.json"),
    versions.slice().sort((a, b) => a.version - b.version)
  );
}

/* ------------------------------------------------------------------ */
/* 构造资产                                                            */
/* ------------------------------------------------------------------ */

export interface CreateAssetInput {
  projectId: string;
  id: string;
  path: string;
  name?: string;
  kind?: Asset["kind"];
  format?: Asset["format"];
  content: string | Buffer;
  author: AssetVersion["author"];
  message: string;
  capabilityPackageId?: string;
  templateId?: string;
  vars?: Record<string, string>;
  owner?: string;
  tags?: string[];
  dependsOn?: string[];
}

export function buildAsset(input: CreateAssetInput): { asset: Asset; version: AssetVersion } {
  const logicalPath = normalizeLogicalPath(input.path, "资产路径");
  const buf = toBuffer(input.content);
  const hash = sha256Hex(buf);
  const now = new Date().toISOString();
  const isBinary = !isTextPath(logicalPath);

  const asset: Asset = {
    schemaVersion: SCHEMA_VERSION,
    id: input.id,
    projectId: input.projectId,
    path: logicalPath,
    name: input.name ?? path.basename(logicalPath),
    kind: input.kind ?? "other",
    format: input.format ?? formatForPath(logicalPath),
    mimeType: mimeForPath(logicalPath),
    capabilityPackageId: input.capabilityPackageId,
    templateId: input.templateId,
    vars: input.vars,
    status: "draft",
    owner: input.owner,
    tags: input.tags ?? [],
    dependsOn: input.dependsOn ?? [],
    currentVersion: 1,
    rev: 1,
    hash,
    size: buf.byteLength,
    isBinary,
    createdAt: now,
    updatedAt: now,
  };

  const version: AssetVersion = {
    assetId: asset.id,
    version: 1,
    rev: 1,
    hash,
    size: buf.byteLength,
    mimeType: asset.mimeType,
    createdAt: now,
    author: input.author,
    message: input.message,
    snapshot: snapshotRelPath(asset, 1),
  };

  return { asset, version };
}

/**
 * 落盘一个新资产或新版本。
 *
 * 崩溃安全的写序：
 *   ① 写 versions/<id>/v<N> 快照   → ② 原子替换活跃文件 → ③ 写版本索引 → ④ 更新 assets.json
 * ①~④ 之间任一崩溃，最坏情况是留下孤儿快照，绝不会留下撕裂的活跃文件。
 */
export function persistAssetContent(
  wsRoot: string,
  projectId: string,
  asset: Asset,
  content: string | Buffer,
  version: AssetVersion
): void {
  const p = projectPaths(wsRoot, projectId);
  const buf = toBuffer(content);

  // ① 快照
  const snapshotAbs = path.join(p.root, version.snapshot);
  writeFileAtomic(snapshotAbs, buf);

  // ② 活跃文件
  writeFileAtomic(assetFilePath(wsRoot, projectId, asset.path), buf);

  // ③ 版本索引
  const versions = readVersions(wsRoot, projectId, asset.id).filter(
    (v) => v.version !== version.version
  );
  versions.push(version);
  writeVersions(wsRoot, projectId, asset.id, versions);

  // ④ 资产索引由调用方在锁内统一写（要与其他资产一起提交）
}

function snapshotRelPath(asset: Asset, version: number): string {
  const ext = extOf(asset.path);
  const suffix = ext ? `.${ext}` : "";
  return `versions/${asset.id}/v${version}${suffix}`;
}

export function nextSnapshotRelPath(asset: Asset, version: number): string {
  return snapshotRelPath(asset, version);
}

/* ------------------------------------------------------------------ */
/* 变更资产                                                            */
/* ------------------------------------------------------------------ */

export interface UpdateContentResult {
  asset: Asset;
  version: AssetVersion;
  contentChanged: boolean;
}

/**
 * 在内存中把资产更新到新内容。不落盘 —— 落盘由 persistAssetContent 负责。
 *
 * `rev` 在任何变更时都 +1；`currentVersion` 只在内容哈希变化时 +1。
 * 闸门判定 run 是否过期用的是 rev。
 */
export function applyContentUpdate(
  asset: Asset,
  content: string | Buffer,
  author: AssetVersion["author"],
  message: string,
  runId?: string,
  approvalId?: string
): UpdateContentResult {
  const buf = toBuffer(content);
  const hash = sha256Hex(buf);
  const contentChanged = hash !== asset.hash;
  const now = new Date().toISOString();

  const nextVersion = asset.currentVersion + 1;
  const nextRev = asset.rev + 1;

  const updated: Asset = {
    ...asset,
    hash,
    size: buf.byteLength,
    currentVersion: nextVersion,
    rev: nextRev,
    mimeType: mimeForPath(asset.path),
    isBinary: !isTextPath(asset.path),
    updatedAt: now,
    // 内容或元数据变了，之前的审批作废
    latestApprovalId: undefined,
    latestRunId: runId ?? asset.latestRunId,
  };

  const version: AssetVersion = {
    assetId: asset.id,
    version: nextVersion,
    rev: nextRev,
    hash,
    size: buf.byteLength,
    mimeType: updated.mimeType,
    createdAt: now,
    author,
    message,
    runId,
    approvalId,
    snapshot: nextSnapshotRelPath(asset, nextVersion),
  };

  return { asset: updated, version, contentChanged };
}

/** 只改元数据（owner / tags / name / dependsOn），内容不动 */
export function applyMetaUpdate(asset: Asset, patch: Partial<Asset>): Asset {
  const now = new Date().toISOString();
  return {
    ...asset,
    ...patch,
    // 这几个字段不允许被 patch 覆盖
    id: asset.id,
    projectId: asset.projectId,
    path: asset.path,
    schemaVersion: asset.schemaVersion,
    hash: asset.hash,
    size: asset.size,
    currentVersion: asset.currentVersion,
    isBinary: asset.isBinary,
    createdAt: asset.createdAt,
    rev: asset.rev + 1,
    updatedAt: now,
    latestApprovalId: undefined,
  };
}

/* ------------------------------------------------------------------ */
/* 并发闸门                                                            */
/* ------------------------------------------------------------------ */

export function assertExpectedRev(asset: Asset, expectedRev?: number): void {
  if (expectedRev === undefined) return;
  if (asset.rev !== expectedRev) {
    throw new CoreError(
      "E_CONFLICT",
      `资产已被修改（当前 rev=${asset.rev}，你持有 rev=${expectedRev}）。` +
        `请重新读取后再提交。`,
      { assetId: asset.id, currentRev: asset.rev, expectedRev }
    );
  }
}

export function assertDuplicatePath(assets: Asset[], logicalPath: string, exceptId?: string): void {
  const hit = assets.find((a) => a.path === logicalPath && a.id !== exceptId);
  if (hit) {
    throw new CoreError("E_PATH_DUPLICATE", `路径已被占用：${logicalPath}`, {
      logicalPath,
      assetId: hit.id,
    });
  }
}

export function assertAssetEditable(asset: Asset): void {
  if (asset.status === "released") {
    throw new CoreError(
      "E_ASSET_LOCKED",
      `资产「${asset.path}」已发布，不能直接编辑。请先创建新版本（revise）。`,
      { assetId: asset.id, status: asset.status }
    );
  }
  if (asset.status === "deprecated") {
    throw new CoreError("E_ASSET_LOCKED", `资产「${asset.path}」已废弃，不能编辑。`, {
      assetId: asset.id,
    });
  }
}

/* ------------------------------------------------------------------ */
/* 删除                                                                */
/* ------------------------------------------------------------------ */

/** 物理删除资产：活跃文件、快照目录、索引条目都由调用方负责 */
export function removeAssetFiles(wsRoot: string, projectId: string, asset: Asset): void {
  const p = projectPaths(wsRoot, projectId);
  try {
    const f = assetFilePath(wsRoot, projectId, asset.path);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch {
    /* 文件可能已不存在 */
  }
  const snapshots = path.join(p.versionsDir, asset.id);
  if (fs.existsSync(snapshots)) fs.rmSync(snapshots, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* 辅助                                                                */
/* ------------------------------------------------------------------ */

export function toBuffer(content: string | Buffer): Buffer {
  return typeof content === "string" ? Buffer.from(content, "utf8") : content;
}

export function decodeContent(
  content: string,
  encoding: "utf-8" | "base64",
  logicalPath: string
): string | Buffer {
  if (encoding === "base64") {
    if (isTextPath(logicalPath)) {
      throw invalid(`文本资产不接受 base64 编码，请用 utf-8：${logicalPath}`);
    }
    return Buffer.from(content, "base64");
  }
  if (!isTextPath(logicalPath)) {
    throw invalid(
      `二进制资产不接受 utf-8 编码，请用 base64：${logicalPath}`
    );
  }
  return content;
}

export function contentAsText(asset: Asset, buf: Buffer | null): string | null {
  if (!buf) return null;
  if (asset.isBinary) return null;
  return buf.toString("utf8");
}
