/**
 * Ditto 实施平台 - 交付包导出
 *
 * 只导出已经 released 的资产 —— 这是「审批放行才有交付物」的物理体现。
 * 同时产出一份清单，把规则结论与审批记录一并固化，作为交付证据。
 */

import fs from "node:fs";
import path from "node:path";
import type { Asset, Project } from "../types";
import { KIND_LABELS, STATUS_LABELS } from "../types";
import { invalid } from "../errors";
import { readProject } from "../store/projects";
import { assetFilePath, readAssets } from "../store/assets";
import { listApprovals } from "../store/approvals";
import { listRuns } from "../store/runs";
import { appendAudit } from "../store/audit";
import { ensureDir, workspacePaths } from "../store/paths";
import { writeJsonAtomic } from "../store/fsjson";
import type { OpContext } from "./context";

export interface ExportOptions {
  projectId: string;
  /** 只导出 released；设为 false 则导出全部资产（用于中期评审打包） */
  releasedOnly?: boolean;
  /** 附带版本历史快照 */
  includeVersions?: boolean;
}

export interface ExportManifestEntry {
  path: string;
  name: string;
  kind: string;
  format: string;
  status: string;
  version: number;
  rev: number;
  hash: string;
  size: number;
  exportedAt: string;
}

export interface ExportResult {
  dir: string;
  fileCount: number;
  skipped: Array<{ path: string; reason: string }>;
  manifestPath: string;
  manifest: {
    project: { id: string; name: string; code: string; customer: string; status: string };
    exportedAt: string;
    exportedBy: string;
    fileCount: number;
    entries: ExportManifestEntry[];
    approvals: Array<{
      id: string;
      assetId?: string;
      decision: string;
      actor: string;
      reason?: string;
      overrides: number;
      createdAt: string;
    }>;
    ruleRuns: Array<{
      id: string;
      scope: string;
      counts: { error: number; warn: number; info: number };
      finishedAt: string;
    }>;
    /** 明确的边界声明，随交付物一起交给客户 */
    disclaimer: string;
  };
}

function timestamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`
  );
}

export function exportProject(ctx: OpContext, options: ExportOptions): ExportResult {
  const project = readProject(ctx.root, options.projectId);
  const releasedOnly = options.releasedOnly !== false;

  const all = readAssets(ctx.root, options.projectId);
  const selected = releasedOnly ? all.filter((a) => a.status === "released") : all;

  if (selected.length === 0) {
    throw invalid(
      releasedOnly
        ? `项目「${project.name}」还没有已发布的资产，无可导出内容。` +
            `请先完成审批并发布（ditto_approval_decide → ditto_asset_release）。`
        : `项目「${project.name}」没有任何资产。`
    );
  }

  const exportedAt = (ctx.now ?? (() => new Date()))();
  const dir = path.join(
    workspacePaths(ctx.root).exportsDir,
    `${project.id}-${timestamp(exportedAt)}`
  );
  ensureDir(dir);

  const entries: ExportManifestEntry[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  for (const asset of selected) {
    const src = assetFilePath(ctx.root, options.projectId, asset.path);
    if (!fs.existsSync(src)) {
      skipped.push({ path: asset.path, reason: "磁盘上的资产文件不存在" });
      continue;
    }

    const dest = path.join(dir, "assets", asset.path);
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);

    if (options.includeVersions) {
      copyVersions(ctx, options.projectId, asset, dir);
    }

    entries.push({
      path: asset.path,
      name: asset.name,
      kind: KIND_LABELS[asset.kind] ?? asset.kind,
      format: asset.format,
      status: STATUS_LABELS[asset.status] ?? asset.status,
      version: asset.currentVersion,
      rev: asset.rev,
      hash: asset.hash,
      size: asset.size,
      exportedAt: exportedAt.toISOString(),
    });
  }

  const approvals = listApprovals(ctx.root, options.projectId).map((a) => ({
    id: a.id,
    assetId: a.assetId,
    decision: a.decision,
    actor: a.actor.name,
    reason: a.reason,
    overrides: a.overrides.length,
    createdAt: a.createdAt,
  }));

  const ruleRuns = listRuns(ctx.root, options.projectId)
    .slice(0, 50)
    .map((r) => ({
      id: r.id,
      scope: r.scope,
      counts: r.counts,
      finishedAt: r.finishedAt,
    }));

  const manifest = {
    project: {
      id: project.id,
      name: project.name,
      code: project.code,
      customer: project.customer,
      status: project.status,
    },
    exportedAt: exportedAt.toISOString(),
    exportedBy: `${ctx.actor.name}（${ctx.actor.type}·${ctx.actor.via}）`,
    fileCount: entries.length,
    entries,
    approvals,
    ruleRuns,
    disclaimer:
      "本清单由 ditto 实施平台自动生成。审批操作者身份来自客户端自报，" +
      "未经密码学认证，仅用于流程留痕，不构成法律意义上的签章。",
  };

  const manifestPath = path.join(dir, "交付清单.json");
  writeJsonAtomic(manifestPath, manifest);

  appendAudit(workspacePaths(ctx.root).auditDir, {
    actor: ctx.actor,
    action: "project.export",
    projectId: options.projectId,
    summary: `导出交付包：${entries.length} 个文件 → ${path.relative(ctx.root, dir)}`,
    details: { fileCount: entries.length, skipped: skipped.length, releasedOnly },
  });

  return { dir, fileCount: entries.length, skipped, manifestPath, manifest };
}

function copyVersions(ctx: OpContext, projectId: string, asset: Asset, dir: string): void {
  const versionsRoot = path.join(ctx.root, "projects", projectId, "versions", asset.id);
  if (!fs.existsSync(versionsRoot)) return;

  const dest = path.join(dir, "versions", asset.id);
  ensureDir(dest);

  for (const file of fs.readdirSync(versionsRoot)) {
    if (file === "index.json") continue;
    const src = path.join(versionsRoot, file);
    if (!fs.statSync(src).isFile()) continue;
    fs.copyFileSync(src, path.join(dest, file));
  }
}

/* ------------------------------------------------------------------ */
/* 版本差异（供 ditto_asset_diff）                                      */
/* ------------------------------------------------------------------ */

export interface DiffLine {
  type: "add" | "del" | "same";
  text: string;
  fromLine?: number;
  toLine?: number;
}

/**
 * 手写 LCS 行级差异，零依赖。
 * 大文件走快速路径：超过 2000 行时退化为"整体替换"的摘要，
 * 避免 O(n²) 的 DP 表把内存吃光。
 */
export function diffLines(from: string, to: string): DiffLine[] {
  const a = from.split("\n");
  const b = to.split("\n");

  if (a.length > 2000 || b.length > 2000) {
    return [
      ...a.map((text, i) => ({ type: "del" as const, text, fromLine: i + 1 })),
      ...b.map((text, i) => ({ type: "add" as const, text, toLine: i + 1 })),
    ];
  }

  // LCS 动态规划
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i], fromLine: i + 1, toLine: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: a[i], fromLine: i + 1 });
      i++;
    } else {
      out.push({ type: "add", text: b[j], toLine: j + 1 });
      j++;
    }
  }

  while (i < n) out.push({ type: "del", text: a[i], fromLine: ++i });
  while (j < m) out.push({ type: "add", text: b[j], toLine: ++j });

  return out;
}

export interface DiffSummary {
  added: number;
  removed: number;
  unchanged: number;
  lines: DiffLine[];
}

export function summarizeDiff(from: string, to: string, contextLines = 3): DiffSummary {
  const all = diffLines(from, to);

  // 只保留有变化的区域 ± context
  const keep = new Set<number>();
  all.forEach((line, idx) => {
    if (line.type === "same") return;
    for (let k = Math.max(0, idx - contextLines); k <= Math.min(all.length - 1, idx + contextLines); k++) {
      keep.add(k);
    }
  });

  const lines = all.filter((_, idx) => keep.has(idx));

  return {
    added: all.filter((l) => l.type === "add").length,
    removed: all.filter((l) => l.type === "del").length,
    unchanged: all.filter((l) => l.type === "same").length,
    lines,
  };
}

export type { Project };
