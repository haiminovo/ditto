/**
 * Ditto 实施平台 - 资产操作
 *
 * 所有写操作在项目写锁内执行；`rev` 乐观并发作为第二层防线。
 * 审计在每次写后发射。
 */

import fs from "node:fs";
import path from "node:path";
import type {
  Asset,
  AssetKind,
  AssetFormat,
  AssetVersion,
} from "../types";
import { isTextPath } from "../types";
import { CoreError, conflict, invalid, notFound } from "../errors";
import { ulid } from "../ids";
import {
  applyContentUpdate,
  applyMetaUpdate,
  assertAssetEditable,
  assertDuplicatePath,
  assertExpectedRev,
  buildAsset,
  contentAsText,
  decodeContent,
  findAssetById,
  findAssetByPath,
  nextSnapshotRelPath,
  persistAssetContent,
  readAssetBuffer,
  readAssets,
  readVersions,
  removeAssetFiles,
  requireAssetById,
  writeAssets,
} from "../store/assets";
import { readProject } from "../store/projects";
import { appendAudit } from "../store/audit";
import { normalizeLogicalPath, projectPaths, workspacePaths } from "../store/paths";
import { withProjectWriteLock } from "../store/lock";
import type { OpContext } from "./context";

/* ------------------------------------------------------------------ */
/* 读                                                                  */
/* ------------------------------------------------------------------ */

export interface ListAssetsFilter {
  kind?: AssetKind;
  status?: string;
  format?: AssetFormat;
  pathPrefix?: string;
}

export function listAssets(
  ctx: OpContext,
  projectId: string,
  filter: ListAssetsFilter = {}
): Asset[] {
  let assets = readAssets(ctx.root, projectId);

  if (filter.kind) assets = assets.filter((a) => a.kind === filter.kind);
  if (filter.status) assets = assets.filter((a) => a.status === filter.status);
  if (filter.format) assets = assets.filter((a) => a.format === filter.format);
  if (filter.pathPrefix) {
    const prefix = normalizeLogicalPath(filter.pathPrefix, "路径前缀");
    assets = assets.filter((a) => a.path.startsWith(prefix));
  }

  return assets.sort((a, b) => a.path.localeCompare(b.path));
}

export interface AssetRef {
  assetId?: string;
  path?: string;
}

/** 按 id 或逻辑路径定位资产 —— AI 客户端两种写法都应该能用 */
export function resolveAsset(ctx: OpContext, projectId: string, ref: AssetRef): Asset {
  const assets = readAssets(ctx.root, projectId);

  if (ref.assetId) {
    const asset = findAssetById(assets, ref.assetId);
    if (!asset) throw notFound("资产", ref.assetId);
    return asset;
  }

  if (ref.path) {
    const normalized = normalizeLogicalPath(ref.path, "资产路径");
    const asset = findAssetByPath(assets, normalized);
    if (!asset) throw notFound("资产（按路径）", normalized);
    return asset;
  }

  throw invalid("必须提供 assetId 或 path 之一");
}

export interface AssetContent {
  asset: Asset;
  /** 文本内容；二进制资产为 null */
  text: string | null;
  /** 原始字节 */
  buffer: Buffer | null;
  version: number;
}

export function readAssetContent(
  ctx: OpContext,
  projectId: string,
  ref: AssetRef,
  version?: number
): AssetContent {
  const asset = resolveAsset(ctx, projectId, ref);

  if (version !== undefined && version !== asset.currentVersion) {
    const versions = readVersions(ctx.root, projectId, asset.id);
    const snap = versions.find((v) => v.version === version);
    if (!snap) {
      throw notFound(
        `资产「${asset.path}」的版本 v${version}`,
        `（现有版本：${versions.map((v) => v.version).join(", ") || "无"}）`
      );
    }
    const buf = readVersionContentBuffer(ctx, projectId, asset, snap);
    return { asset, text: contentAsText(asset, buf), buffer: buf, version };
  }

  const buffer = readAssetBuffer(ctx.root, projectId, asset);
  return { asset, text: contentAsText(asset, buffer), buffer, version: asset.currentVersion };
}

function readVersionContentBuffer(
  ctx: OpContext,
  projectId: string,
  asset: Asset,
  snap: AssetVersion
): Buffer | null {
  const abs = path.join(projectPaths(ctx.root, projectId).root, snap.snapshot);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs);
}

export function listVersions(ctx: OpContext, projectId: string, ref: AssetRef): AssetVersion[] {
  const asset = resolveAsset(ctx, projectId, ref);
  return readVersions(ctx.root, projectId, asset.id);
}

/* ------------------------------------------------------------------ */
/* 创建                                                                */
/* ------------------------------------------------------------------ */

export interface CreateAssetInput {
  path: string;
  content: string;
  encoding?: "utf-8" | "base64";
  name?: string;
  kind?: AssetKind;
  format?: AssetFormat;
  owner?: string;
  tags?: string[];
  dependsOn?: string[];
  message?: string;
  capabilityPackageId?: string;
  templateId?: string;
  vars?: Record<string, string>;
}

export interface WriteAssetResult {
  asset: Asset;
  created: boolean;
  contentChanged: boolean;
}

export async function createAsset(
  ctx: OpContext,
  projectId: string,
  input: CreateAssetInput
): Promise<WriteAssetResult> {
  const paths = projectPaths(ctx.root, projectId);
  const logicalPath = normalizeLogicalPath(input.path, "资产路径");

  return withProjectWriteLock(paths.lockDir, projectId, () => {
    readProject(ctx.root, projectId); // 项目不存在则抛 notFound
    const assets = readAssets(ctx.root, projectId);
    assertDuplicatePath(assets, logicalPath);

    const content = decodeContent(input.content, input.encoding ?? "utf-8", logicalPath);

    const { asset, version } = buildAsset({
      projectId,
      id: ulid(),
      path: logicalPath,
      name: input.name,
      kind: input.kind,
      format: input.format,
      content,
      author: ctx.actor,
      message: input.message ?? "创建资产",
      capabilityPackageId: input.capabilityPackageId,
      templateId: input.templateId,
      vars: input.vars,
      owner: input.owner ?? ctx.actor.name,
      tags: input.tags,
      dependsOn: input.dependsOn,
    });

    persistAssetContent(ctx.root, projectId, asset, content, version);
    writeAssets(ctx.root, projectId, [...assets, asset]);

    appendAudit(workspacePaths(ctx.root).auditDir, {
      actor: ctx.actor,
      action: "asset.create",
      projectId,
      assetId: asset.id,
      targetRev: asset.rev,
      summary: `创建资产「${logicalPath}」`,
      details: {
        kind: asset.kind,
        format: asset.format,
        hash: asset.hash,
        fromTemplate: input.templateId,
      },
    });

    return { asset, created: true, contentChanged: true };
  });
}

/* ------------------------------------------------------------------ */
/* 更新                                                                */
/* ------------------------------------------------------------------ */

export interface UpdateAssetInput extends AssetRef {
  content?: string;
  encoding?: "utf-8" | "base64";
  message?: string;
  expectedRev?: number;
  patch?: Partial<Pick<Asset, "name" | "owner" | "tags" | "dependsOn" | "kind">>;
}

export async function updateAsset(
  ctx: OpContext,
  projectId: string,
  input: UpdateAssetInput
): Promise<WriteAssetResult> {
  const paths = projectPaths(ctx.root, projectId);

  return withProjectWriteLock(paths.lockDir, projectId, () => {
    const assets = readAssets(ctx.root, projectId);
    const asset = resolveAssetIn(assets, input);

    assertExpectedRev(asset, input.expectedRev);
    assertAssetEditable(asset);

    if (input.content === undefined && !input.patch) {
      throw invalid("updateAsset 需要 content 或 patch 至少之一");
    }

    let next: Asset;
    let contentChanged = false;

    if (input.content !== undefined) {
      const text = decodeContent(input.content, input.encoding ?? "utf-8", asset.path);
      const result = applyContentUpdate(asset, text, ctx.actor, input.message ?? "更新内容");
      contentChanged = result.contentChanged;

      if (contentChanged) {
        persistAssetContent(ctx.root, projectId, asset, text, result.version);
        next = result.asset;
        // 内容变了就回到 draft，之前的审批随之作废
        if (asset.status !== "draft") next.status = "draft";
      } else {
        // 内容与现状一致：不产生新版本，只当作一次元数据触碰
        next = applyMetaUpdate(asset, {});
      }
    } else {
      next = applyMetaUpdate(asset, {});
    }

    if (input.patch) {
      Object.assign(next, {
        name: input.patch.name ?? next.name,
        owner: input.patch.owner ?? next.owner,
        tags: input.patch.tags ?? next.tags,
        dependsOn: input.patch.dependsOn ?? next.dependsOn,
        kind: input.patch.kind ?? next.kind,
      });
    }

    const updated = assets.map((a) => (a.id === next.id ? next : a));
    writeAssets(ctx.root, projectId, updated);

    appendAudit(workspacePaths(ctx.root).auditDir, {
      actor: ctx.actor,
      action: "asset.update",
      projectId,
      assetId: next.id,
      targetRev: next.rev,
      summary: input.message ?? `更新资产「${next.path}」`,
      details: {
        contentChanged,
        version: next.currentVersion,
        rev: next.rev,
      },
    });

    return { asset: next, created: false, contentChanged };
  });
}

function resolveAssetIn(assets: Asset[], ref: AssetRef): Asset {
  if (ref.assetId) return requireAssetById(assets, ref.assetId);
  if (ref.path) {
    const normalized = normalizeLogicalPath(ref.path, "资产路径");
    const hit = findAssetByPath(assets, normalized);
    if (!hit) throw notFound("资产（按路径）", normalized);
    return hit;
  }
  throw invalid("必须提供 assetId 或 path 之一");
}

/* ------------------------------------------------------------------ */
/* 改版                                                                */
/* ------------------------------------------------------------------ */

/**
 * 把已发布/已废弃的资产重新打开为 draft，以便继续编辑。
 *
 * 已发布的内容**不会丢** —— 它作为编号版本留在 versions/<assetId>/ 里。
 * 这正是"已发布资产禁止直接编辑"能成立的前提：不可变性有归档兜底，
 * 而不是靠拒绝一切修改。
 */
export async function reviseAsset(
  ctx: OpContext,
  projectId: string,
  assetId: string,
  reason?: string
): Promise<Asset> {
  const paths = projectPaths(ctx.root, projectId);

  return withProjectWriteLock(paths.lockDir, projectId, () => {
    const assets = readAssets(ctx.root, projectId);
    const asset = findAssetById(assets, assetId);
    if (!asset) throw notFound("资产", assetId);

    if (asset.status !== "released" && asset.status !== "deprecated") {
      throw new CoreError(
        "E_STATUS_TRANSITION",
        `资产「${asset.path}」当前状态为「${asset.status}」，只有已发布/已废弃的资产需要改版。`,
        { assetId, status: asset.status }
      );
    }

    const from = asset.status;
    const next: Asset = {
      ...asset,
      status: "draft",
      rev: asset.rev + 1,
      latestApprovalId: undefined,
    };

    writeAssets(
      ctx.root,
      projectId,
      assets.map((a) => (a.id === next.id ? next : a))
    );

    appendAudit(workspacePaths(ctx.root).auditDir, {
      actor: ctx.actor,
      action: "asset.revise",
      projectId,
      assetId,
      targetRev: next.rev,
      summary: `改版资产「${asset.path}」：${from} → draft${reason ? `（${reason}）` : ""}`,
      details: { from, preservedVersion: asset.currentVersion, hash: asset.hash },
    });

    return next;
  });
}

/* ------------------------------------------------------------------ */
/* 删除                                                                */
/* ------------------------------------------------------------------ */

export interface DeleteAssetInput extends AssetRef {
  /** true 为物理删除；默认软删除（标记 deprecated） */
  hard?: boolean;
  reason?: string;
}

export async function deleteAsset(
  ctx: OpContext,
  projectId: string,
  input: DeleteAssetInput
): Promise<{ asset: Asset; hard: boolean }> {
  const paths = projectPaths(ctx.root, projectId);

  return withProjectWriteLock(paths.lockDir, projectId, () => {
    const assets = readAssets(ctx.root, projectId);
    const asset = resolveAssetIn(assets, input);

    if (input.hard) {
      removeAssetFiles(ctx.root, projectId, asset);
      writeAssets(
        ctx.root,
        projectId,
        assets.filter((a) => a.id !== asset.id)
      );

      appendAudit(workspacePaths(ctx.root).auditDir, {
        actor: ctx.actor,
        action: "asset.delete",
        projectId,
        assetId: asset.id,
        summary: `物理删除资产「${asset.path}」`,
        details: { reason: input.reason },
      });

      return { asset, hard: true };
    }

    const next: Asset = { ...asset, status: "deprecated", rev: asset.rev + 1 };
    writeAssets(
      ctx.root,
      projectId,
      assets.map((a) => (a.id === next.id ? next : a))
    );

    appendAudit(workspacePaths(ctx.root).auditDir, {
      actor: ctx.actor,
      action: "asset.deprecate",
      projectId,
      assetId: asset.id,
      targetRev: next.rev,
      summary: `废弃资产「${asset.path}」`,
      details: { reason: input.reason },
    });

    return { asset: next, hard: false };
  });
}

/* ------------------------------------------------------------------ */
/* 并发写验证（供 race-test 使用）                                      */
/* ------------------------------------------------------------------ */

/**
 * 无锁并发写入的落点：所有写操作都串行化在这里。
 * race-test 会并发调用 createAsset 验证最终状态一致。
 */
export async function bulkCreate(
  ctx: OpContext,
  projectId: string,
  items: CreateAssetInput[]
): Promise<WriteAssetResult[]> {
  return Promise.all(items.map((item) => createAsset(ctx, projectId, item)));
}

export { isTextPath, conflict, nextSnapshotRelPath };
