/**
 * Ditto 实施平台 - 审批状态机与闸门执行
 *
 * 状态机（资产与项目共用）：
 *
 *   draft ─submit→ in_review ─approve→ approved ─release→ released
 *     ↑              │
 *     │              └reject→ rejected ─→ draft
 *     └─── 内容变更自动回 draft，并清除 latestApprovalId ───
 *
 * 关于「run 过期」：本模块在**放行时刻重新计算规则**，而不是去校验一份
 * 存量 run 是否新鲜。这比 E_RUN_STALE 更强 —— 存量 run 根本不被信任，
 * 它只是证据。想确认"审的就是我看到的那版"，用 decide 的 expectedRev，
 * 不匹配会得到 E_CONFLICT。
 */

import type {
  Actor,
  Approval,
  Asset,
  GateResult,
  Project,
  RuleOverride,
} from "../types";
import { CoreError, conflict, invalid, notFound } from "../errors";
import { readAssets, writeAssets, findAssetById } from "../store/assets";
import { readProject, writeProject } from "../store/projects";
import { listApprovals, writeApproval } from "../store/approvals";
import { appendAudit } from "../store/audit";
import { projectPaths, workspacePaths } from "../store/paths";
import { withProjectWriteLock } from "../store/lock";
import { gateCheck, runProjectRules, loadRulePacksForProject } from "./rule-ops";
import type { OpContext } from "./context";

/* ------------------------------------------------------------------ */
/* 权限判定                                                            */
/* ------------------------------------------------------------------ */

export interface ApprovalPolicyInput {
  actor: Actor;
  project: Project;
  /** 提交人（用于「审批人须不同于提交人」判定） */
  submittedBy?: string;
}

/**
 * 统一的放行权限判定。
 *
 * ⚠️ 这里的 actor 是**自报**的，不是身份认证。它约束的是流程，
 *    不是安全边界。真正的鉴权（OAuth / SSO）不在本期范围。
 */
export function assertCanApprove(input: ApprovalPolicyInput): void {
  const { actor, project, submittedBy } = input;

  if (actor.type === "ai" && !project.settings.allowAiApproval) {
    throw new CoreError(
      "E_APPROVAL_FORBIDDEN",
      `项目「${project.name}」已关闭 AI 审批。请由具备权限的人工操作者通过 MCP 客户端放行，` +
        `或用 ditto_project_update 把 settings.allowAiApproval 置为 true。`,
      { projectId: project.id, actor: actor.id }
    );
  }

  if (project.settings.requireDistinctApprover && submittedBy && submittedBy === actor.name) {
    throw new CoreError(
      "E_APPROVAL_FORBIDDEN",
      `项目「${project.name}」要求审批人与提交人不同，但当前操作者「${actor.name}」` +
        `就是提交人。请换一位审批人。`,
      { projectId: project.id, actor: actor.id, submittedBy }
    );
  }
}

/* ------------------------------------------------------------------ */
/* 提交                                                                */
/* ------------------------------------------------------------------ */

export interface SubmitResult {
  project: Project;
  asset?: Asset;
  runId: string;
  gate: GateResult;
}

/**
 * 提交审批：先跑一次规则，把资产置为 in_review，并回传闸门现状。
 *
 * 回传 gate 是刻意的 —— AI 客户端一次调用就拿到「还差什么」，
 * 不用再单独问一遍。
 */
export async function submitForApproval(
  ctx: OpContext,
  projectId: string,
  assetId?: string
): Promise<SubmitResult> {
  const paths = projectPaths(ctx.root, projectId);

  return withProjectWriteLock(paths.lockDir, projectId, () => {
    const project = readProject(ctx.root, projectId);

    if (assetId) {
      const assets = readAssets(ctx.root, projectId);
      const asset = findAssetById(assets, assetId);
      if (!asset) throw notFound("资产", assetId);

      if (asset.status !== "draft" && asset.status !== "rejected") {
        throw new CoreError(
          "E_STATUS_TRANSITION",
          `资产「${asset.path}」当前状态为「${asset.status}」，只有 draft / rejected 可以提交评审。`,
          { assetId, status: asset.status }
        );
      }

      const run = runProjectRules(ctx, { projectId, assetId });

      const next: Asset = { ...asset, status: "in_review", latestRunId: run.id, rev: asset.rev + 1 };
      writeAssets(
        ctx.root,
        projectId,
        assets.map((a) => (a.id === asset.id ? next : a))
      );

      appendAudit(workspacePaths(ctx.root).auditDir, {
        actor: ctx.actor,
        action: "asset.submit",
        projectId,
        assetId,
        targetRev: next.rev,
        summary: `提交评审：${asset.path}`,
        details: { runId: run.id, counts: run.counts },
      });

      return {
        project,
        asset: next,
        runId: run.id,
        gate: gateCheck(ctx, { projectId, assetId }),
      };
    }

    // 项目级提交
    if (project.status !== "draft" && project.status !== "rejected") {
      throw new CoreError(
        "E_STATUS_TRANSITION",
        `项目「${project.name}」当前状态为「${project.status}」，只有 draft / rejected 可以提交评审。`,
        { projectId, status: project.status }
      );
    }

    const run = runProjectRules(ctx, { projectId });
    return {
      project,
      runId: run.id,
      gate: gateCheck(ctx, { projectId }),
    };
  });
}

/* ------------------------------------------------------------------ */
/* 决策                                                                */
/* ------------------------------------------------------------------ */

export interface DecideInput {
  projectId: string;
  /** 资产级审批；不传则为项目级 */
  assetId?: string;
  decision: "approved" | "rejected";
  reason?: string;
  overrides?: RuleOverride[];
  /** 调用方看到的 rev；不匹配则拒绝，避免"审的和放的不是同一版" */
  expectedRev?: number;
}

export interface DecideResult {
  project: Project;
  asset?: Asset;
  approval: Approval;
  gate: GateResult;
}

export async function decideApproval(
  ctx: OpContext,
  input: DecideInput
): Promise<DecideResult> {
  const paths = projectPaths(ctx.root, input.projectId);

  return withProjectWriteLock(paths.lockDir, input.projectId, () => {
    const project = readProject(ctx.root, input.projectId);

    if (input.assetId) {
      const assets = readAssets(ctx.root, input.projectId);
      const asset = findAssetById(assets, input.assetId);
      if (!asset) throw notFound("资产", input.assetId);

      if (asset.status !== "in_review") {
        throw new CoreError(
          "E_STATUS_TRANSITION",
          `资产「${asset.path}」当前状态为「${asset.status}」，不在评审中，无法决策。`,
          { assetId: asset.id, status: asset.status }
        );
      }

      if (input.expectedRev !== undefined && asset.rev !== input.expectedRev) {
        throw conflict(
          `资产在评审期间被修改（当前 rev=${asset.rev}，你审的是 rev=${input.expectedRev}）。` +
            `请重新读取并重新发起评审。`,
          { assetId: asset.id, currentRev: asset.rev, expectedRev: input.expectedRev }
        );
      }

      const previous = listApprovals(ctx.root, input.projectId).find(
        (a) => a.assetId === asset.id && a.fromStatus === "in_review"
      );
      assertCanApprove({
        actor: ctx.actor,
        project,
        submittedBy: previous?.actor.name,
      });

      // ★ 重新计算，不信任任何存量 run
      const gate = gateCheck(ctx, {
        projectId: input.projectId,
        assetId: asset.id,
        overrides: input.overrides,
      });

      if (input.decision === "approved" && gate.blocked) {
        throw new CoreError(
          "E_GATE_BLOCKED",
          gate.reasons.join("；") +
            `。需要豁免的规则：${gate.missingWaiverRuleIds.join(", ") || "（无）"}`,
          {
            errors: gate.errors.map((f) => ({
              ruleId: f.ruleId,
              message: f.message,
              assetPath: f.assetPath,
            })),
            warnings: gate.warnings.map((f) => ({ ruleId: f.ruleId, message: f.message })),
            missingWaiverRuleIds: gate.missingWaiverRuleIds,
          }
        );
      }

      const run = runProjectRules(ctx, { projectId: input.projectId, assetId: asset.id });
      const toStatus = input.decision === "approved" ? "approved" : "rejected";

      const approval: Approval = {
        schemaVersion: 1,
        id: ctx.newId("apr"),
        projectId: input.projectId,
        assetId: asset.id,
        targetRev: asset.rev,
        targetHash: asset.hash,
        fromStatus: "in_review",
        toStatus,
        decision: input.decision,
        actor: ctx.actor,
        reason: input.reason,
        overrides: input.overrides ?? [],
        runId: run.id,
        createdAt: (ctx.now ?? (() => new Date()))().toISOString(),
      };

      writeApproval(ctx.root, approval);

      const next: Asset = {
        ...asset,
        status: toStatus,
        latestApprovalId: input.decision === "approved" ? approval.id : undefined,
        latestRunId: run.id,
        rev: asset.rev + 1,
      };
      writeAssets(
        ctx.root,
        input.projectId,
        assets.map((a) => (a.id === asset.id ? next : a))
      );

      appendAudit(workspacePaths(ctx.root).auditDir, {
        actor: ctx.actor,
        action: input.decision === "approved" ? "asset.approve" : "asset.reject",
        projectId: input.projectId,
        assetId: asset.id,
        targetRev: next.rev,
        summary:
          `${input.decision === "approved" ? "批准" : "驳回"}资产「${asset.path}」` +
          (input.reason ? `：${input.reason}` : ""),
        details: {
          approvalId: approval.id,
          overrides: approval.overrides,
          gateCounts: { error: gate.errors.length, warn: gate.warnings.length },
        },
      });

      return { project, asset: next, approval, gate };
    }

    // 项目级决策
    if (project.status !== "in_review") {
      throw new CoreError(
        "E_STATUS_TRANSITION",
        `项目「${project.name}」当前状态为「${project.status}」，不在评审中。`,
        { projectId: project.id, status: project.status }
      );
    }

    assertCanApprove({ actor: ctx.actor, project });

    const gate = gateCheck(ctx, { projectId: input.projectId, overrides: input.overrides });

    if (input.decision === "approved") {
      const assetGate = projectReleaseBlockers(ctx, project);
      if (assetGate.length > 0) {
        throw new CoreError(
          "E_GATE_BLOCKED",
          `项目尚不满足发布条件：\n${assetGate.map((s) => `  · ${s}`).join("\n")}`,
          { blockers: assetGate }
        );
      }
      if (gate.blocked) {
        throw new CoreError(
          "E_GATE_BLOCKED",
          gate.reasons.join("；") +
            `。需要豁免的规则：${gate.missingWaiverRuleIds.join(", ") || "（无）"}`,
          { missingWaiverRuleIds: gate.missingWaiverRuleIds }
        );
      }
    }

    const toStatus = input.decision === "approved" ? "approved" : "rejected";
    const approval: Approval = {
      schemaVersion: 1,
      id: ctx.newId("apr"),
      projectId: project.id,
      targetRev: 0,
      targetHash: "",
      fromStatus: "in_review",
      toStatus,
      decision: input.decision,
      actor: ctx.actor,
      reason: input.reason,
      overrides: input.overrides ?? [],
      createdAt: (ctx.now ?? (() => new Date()))().toISOString(),
    };
    writeApproval(ctx.root, approval);

    const nextProject: Project = {
      ...project,
      status: toStatus,
      latestApprovalId: input.decision === "approved" ? approval.id : undefined,
    };
    writeProject(ctx.root, nextProject);

    appendAudit(workspacePaths(ctx.root).auditDir, {
      actor: ctx.actor,
      action: "project.release",
      projectId: project.id,
      summary: `${input.decision === "approved" ? "批准" : "驳回"}项目发布` +
        (input.reason ? `：${input.reason}` : ""),
      details: { approvalId: approval.id },
    });

    return { project: nextProject, approval, gate };
  });
}

/* ------------------------------------------------------------------ */
/* 项目发布前置条件                                                     */
/* ------------------------------------------------------------------ */

/** 项目可以发布前，各资产必须达到的状态 */
export function projectReleaseBlockers(ctx: OpContext, project: Project): string[] {
  const assets = readAssets(ctx.root, project.id);
  const blockers: string[] = [];

  if (assets.length === 0) {
    blockers.push("项目下没有任何资产");
    return blockers;
  }

  for (const a of assets) {
    if (a.status === "in_review") blockers.push(`资产「${a.path}」仍在评审中`);
    else if (a.status === "rejected") blockers.push(`资产「${a.path}」已被驳回`);
    else if (a.status === "draft") blockers.push(`资产「${a.path}」尚未提交评审`);
  }

  // 发布前必须有一条对项目级规则的有效执行
  const { rules } = loadRulePacksForProject(ctx, project);
  const projectRules = rules.filter((r) => r.enabled);
  if (projectRules.length === 0) {
    blockers.push("项目未挂载任何规则包 —— 没有任何质量约束的项目不允许发布");
  }

  return blockers;
}

/* ------------------------------------------------------------------ */
/* 发布                                                                */
/* ------------------------------------------------------------------ */

export async function releaseAsset(
  ctx: OpContext,
  projectId: string,
  assetId: string
): Promise<Asset> {
  const paths = projectPaths(ctx.root, projectId);

  return withProjectWriteLock(paths.lockDir, projectId, () => {
    const assets = readAssets(ctx.root, projectId);
    const asset = findAssetById(assets, assetId);
    if (!asset) throw notFound("资产", assetId);

    if (asset.status !== "approved") {
      throw new CoreError(
        "E_STATUS_TRANSITION",
        `资产「${asset.path}」当前状态为「${asset.status}」，只有 approved 可以发布。`,
        { assetId, status: asset.status }
      );
    }

    const next: Asset = { ...asset, status: "released", rev: asset.rev + 1 };
    writeAssets(
      ctx.root,
      projectId,
      assets.map((a) => (a.id === asset.id ? next : a))
    );

    appendAudit(workspacePaths(ctx.root).auditDir, {
      actor: ctx.actor,
      action: "asset.release",
      projectId,
      assetId,
      targetRev: next.rev,
      summary: `发布资产「${asset.path}」`,
      details: { version: asset.currentVersion, hash: asset.hash },
    });

    return next;
  });
}

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

export interface PendingApproval {
  asset: Asset;
  gate: GateResult;
}

/** 待办：所有处于 in_review 的资产，附带当前闸门状态 */
export function pendingApprovals(ctx: OpContext, projectId: string): PendingApproval[] {
  const assets = readAssets(ctx.root, projectId).filter((a) => a.status === "in_review");
  return assets.map((asset) => ({
    asset,
    gate: gateCheck(ctx, { projectId, assetId: asset.id }),
  }));
}

export function approvalHistory(ctx: OpContext, projectId: string): Approval[] {
  return listApprovals(ctx.root, projectId);
}

/** 取业务上"仍然有效"的审批：结论为 approved 且 rev/hash 与资产当前值一致 */
export function effectiveApprovalFor(
  ctx: OpContext,
  projectId: string,
  asset: Asset
): Approval | null {
  const approvals = listApprovals(ctx.root, projectId);
  return (
    approvals.find(
      (a) =>
        a.assetId === asset.id &&
        a.decision === "approved" &&
        a.targetRev === asset.rev &&
        a.targetHash === asset.hash
    ) ?? null
  );
}
