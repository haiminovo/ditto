/**
 * Ditto 实施平台 - 审批记录
 *
 * JSONL 审计是日志，这里的 JSON 是审批单据本身。
 *
 * ⚠️ 使用 node:fs，只能在服务端使用。
 */

import fs from "node:fs";
import path from "node:path";
import type { Approval } from "../types";
import { readJsonOrNull, writeJsonAtomic } from "./fsjson";
import { ensureDir, projectPaths } from "./paths";
import { notFound } from "../errors";

export function writeApproval(wsRoot: string, approval: Approval): void {
  const p = projectPaths(wsRoot, approval.projectId);
  ensureDir(p.approvalsDir);
  writeJsonAtomic(path.join(p.approvalsDir, `${approval.id}.json`), approval);
}

export function readApproval(wsRoot: string, projectId: string, approvalId: string): Approval {
  const approval = readJsonOrNull<Approval>(
    path.join(projectPaths(wsRoot, projectId).approvalsDir, `${approvalId}.json`)
  );
  if (!approval) throw notFound("审批单", approvalId);
  return approval;
}

export function readApprovalOrNull(
  wsRoot: string,
  projectId: string,
  approvalId: string
): Approval | null {
  return readJsonOrNull<Approval>(
    path.join(projectPaths(wsRoot, projectId).approvalsDir, `${approvalId}.json`)
  );
}

export function listApprovals(wsRoot: string, projectId: string): Approval[] {
  const dir = projectPaths(wsRoot, projectId).approvalsDir;
  if (!fs.existsSync(dir)) return [];

  const out: Approval[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const a = readJsonOrNull<Approval>(path.join(dir, file));
    if (a) out.push(a);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 某资产当前有效的审批单（最近一条） */
export function latestApprovalForAsset(
  wsRoot: string,
  projectId: string,
  assetId: string
): Approval | null {
  return listApprovals(wsRoot, projectId).find((a) => a.assetId === assetId) ?? null;
}

/**
 * 取对当前 rev 仍然有效的审批：审批单记录的 targetRev/targetHash
 * 必须与资产当前值一致，否则视为失效（资产在审批后被改过）。
 */
export function effectiveApproval(
  wsRoot: string,
  projectId: string,
  assetId: string,
  currentRev: number,
  currentHash: string
): Approval | null {
  const approvals = listApprovals(wsRoot, projectId);
  const hit = approvals.find(
    (a) =>
      a.assetId === assetId &&
      a.decision === "approved" &&
      a.targetRev === currentRev &&
      a.targetHash === currentHash
  );
  return hit ?? null;
}
