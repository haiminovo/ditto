/**
 * Ditto 实施平台 - 上下文交接
 *
 * ditto_handoff 是整个平台对 AI 客户端最重要的一个工具：**一次调用拿全状态**，
 * 并且带上由状态机算出的「下一步该做什么」。
 *
 * 设计意图：让 AI 客户端不必先做一轮探索性调用才知道自己在哪。
 * 探索轮次越多，越容易在途中把上下文读歪。
 */

import { SCHEMA_VERSION, type Asset, type Project, type Severity } from "../types";
import { listProjects, projectOverview } from "./project-ops";
import { getCapability, listCapabilities } from "./template-ops";
import { capabilitiesForProject, gateCheck, loadRulePacksForProject } from "./rule-ops";
import { listApprovals } from "../store/approvals";
import { listRuns } from "../store/runs";
import { workspaceInfo } from "../store/workspace";
import { workspacePaths } from "../store/paths";
import { readTextOrNull } from "../store/fsjson";
import { assetFilePath } from "../store/assets";
import type { OpContext } from "./context";

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export interface AssetHandoffEntry {
  id: string;
  path: string;
  name: string;
  kind: string;
  format: string;
  status: string;
  version: number;
  rev: number;
  hash: string;
  size: number;
  owner?: string;
  dependsOn: string[];
  fromTemplate?: string;
  /** 最近一次规则执行的结论 */
  lastRun?: {
    id: string;
    counts: { error: number; warn: number; info: number };
    finishedAt: string;
    /** 该 run 之后资产是否又被改过 */
    stale: boolean;
  };
  /** 最近一次审批结论 */
  lastApproval?: { id: string; decision: string; actor: string; at: string };
}

export interface NextAction {
  /** 面向项目还是某个资产 */
  target: "project" | "asset";
  assetId?: string;
  assetPath?: string;
  action: string;
  /** 建议调用的工具名 */
  tool: string;
  reason: string;
  severity?: Severity;
}

export interface Handoff {
  workspace: {
    root: string;
    schemaVersion: number;
    initialized: boolean;
    counts: { projects: number; capabilities: number; rulepacks: number };
  };
  actor: { id: string; name: string; type: string; via: string };
  capabilities: Array<{
    id: string;
    name: string;
    version: string;
    platforms: string[];
    vars: Array<{ key: string; label: string; required: boolean; default?: string }>;
  }>;
  projects?: Array<{
    id: string;
    name: string;
    code: string;
    customer: string;
    status: string;
    assetCount: number;
    updatedAt: string;
  }>;
  project?: {
    id: string;
    name: string;
    code: string;
    customer: string;
    description?: string;
    status: string;
    owner?: string;
    platforms: string[];
    capabilityPackageIds: string[];
    vars: Record<string, string>;
    settings: Project["settings"];
    createdAt: string;
    updatedAt: string;
  };
  assets?: AssetHandoffEntry[];
  counts?: {
    byStatus: Record<string, number>;
    bySeverity: { error: number; warn: number; info: number };
  };
  pendingApprovals?: Array<{
    assetId: string;
    assetPath: string;
    rev: number;
    blocked: boolean;
    missingWaiverRuleIds: string[];
  }>;
  rulePacks?: Array<{ id: string; name: string; version: string; ruleCount: number }>;
  nextActions?: NextAction[];
  /** 被截断的字段会在这里说明，不让调用方误以为拿到的是全部 */
  truncation?: string;
}

export interface HandoffOptions {
  projectId?: string;
  /** 附带每个资产的正文（注意体积） */
  includeAssetContent?: boolean;
  maxBytesPerAsset?: number;
}

const DEFAULT_MAX_ASSET_BYTES = 32 * 1024;

/* ------------------------------------------------------------------ */
/* 构建                                                                */
/* ------------------------------------------------------------------ */

export function buildHandoff(ctx: OpContext, options: HandoffOptions = {}): Handoff {
  const info = workspaceInfo(ctx.root);
  const installedCaps = loadCapabilitiesForHandoff(ctx);

  const base: Handoff = {
    workspace: {
      root: info.root,
      schemaVersion: SCHEMA_VERSION,
      initialized: info.initialized,
      counts: info.counts,
    },
    actor: {
      id: ctx.actor.id,
      name: ctx.actor.name,
      type: ctx.actor.type,
      via: ctx.actor.via,
    },
    capabilities: installedCaps,
  };

  if (!options.projectId) {
    base.projects = listProjects(ctx).map((p) => ({
      id: p.id,
      name: p.name,
      code: p.code,
      customer: p.customer,
      status: p.status,
      assetCount: projectOverview(ctx, p.id).assetCount,
      updatedAt: p.updatedAt,
    }));

    if (base.projects.length === 0) {
      base.nextActions = [
        {
          target: "project",
          action: "创建工作区第一个项目",
          tool: "ditto_project_create",
          reason: "工作区还没有任何项目",
        },
      ];
    }
    return base;
  }

  const { project, assets } = projectOverview(ctx, options.projectId);

  base.project = {
    id: project.id,
    name: project.name,
    code: project.code,
    customer: project.customer,
    description: project.description,
    status: project.status,
    owner: project.owner,
    platforms: project.platforms,
    capabilityPackageIds: project.capabilityPackageIds,
    vars: project.vars,
    settings: project.settings,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };

  const runs = listRuns(ctx.root, project.id);
  const approvals = listApprovals(ctx.root, project.id);

  let truncatedCount = 0;

  base.assets = assets.map<AssetHandoffEntry>((a) => {
    const lastRun = runs.find((r) => r.assetId === a.id);
    const lastApproval = approvals.find((x) => x.assetId === a.id);

    return {
      id: a.id,
      path: a.path,
      name: a.name,
      kind: a.kind,
      format: a.format,
      status: a.status,
      version: a.currentVersion,
      rev: a.rev,
      hash: a.hash,
      size: a.size,
      owner: a.owner,
      dependsOn: a.dependsOn,
      fromTemplate: a.templateId,
      lastRun: lastRun
        ? {
            id: lastRun.id,
            counts: lastRun.counts,
            finishedAt: lastRun.finishedAt,
            stale: lastRun.targetRev !== a.rev || lastRun.targetHash !== a.hash,
          }
        : undefined,
      lastApproval: lastApproval
        ? {
            id: lastApproval.id,
            decision: lastApproval.decision,
            actor: lastApproval.actor.name,
            at: lastApproval.createdAt,
          }
        : undefined,
    };
  });

  if (options.includeAssetContent) {
    const limit = options.maxBytesPerAsset ?? DEFAULT_MAX_ASSET_BYTES;
    const withContent: Array<AssetHandoffEntry & { content?: string }> = [];

    for (const entry of base.assets) {
      const asset = assets.find((a) => a.id === entry.id);
      /* istanbul ignore next */
      if (!asset) continue;

      if (asset.isBinary) {
        truncatedCount += 1;
        withContent.push(entry);
        continue;
      }

      const text = readTextOrNull(assetFilePath(ctx.root, project.id, asset.path));
      if (text === null) {
        withContent.push(entry);
        continue;
      }

      if (text.length > limit) {
        truncatedCount += 1;
        withContent.push({
          ...entry,
          content: text.slice(0, limit) + `\n…（已截断，完整内容请用 ditto_asset_get 读取，共 ${text.length} 字符）`,
        });
      } else {
        withContent.push({ ...entry, content: text });
      }
    }

    base.assets = withContent;
  }

  base.counts = {
    byStatus: countBy(assets, (a) => a.status),
    bySeverity: sumSeverity(base.assets),
  };

  base.pendingApprovals = assets
    .filter((a) => a.status === "in_review")
    .map((a) => {
      const gate = gateCheck(ctx, { projectId: project.id, assetId: a.id });
      return {
        assetId: a.id,
        assetPath: a.path,
        rev: a.rev,
        blocked: gate.blocked,
        missingWaiverRuleIds: gate.missingWaiverRuleIds,
      };
    });

  const { packs } = loadRulePacksForProject(ctx, project);
  base.rulePacks = packs.map((p) => ({
    id: p.id,
    name: p.name,
    version: p.version,
    ruleCount: p.rules.length,
  }));

  base.nextActions = deriveNextActions(ctx, project, assets, base);

  if (truncatedCount > 0) {
    base.truncation = `有 ${truncatedCount} 个资产的正文被截断或未内联（二进制或超过体积上限），` +
      `请用 ditto_asset_get 单独读取。`;
  }

  return base;
}

function loadCapabilitiesForHandoff(ctx: OpContext): Handoff["capabilities"] {
  return listCapabilities(ctx).map((c) => {
    const detail = getCapability(ctx, c.id);
    return {
      id: c.id,
      name: c.name,
      version: c.version,
      platforms: c.platforms,
      vars: detail.vars.map((v) => ({
        key: v.key,
        label: v.label,
        required: v.required === true,
        default: v.default,
      })),
    };
  });
}

/* ------------------------------------------------------------------ */
/* 下一步动作推导                                                       */
/* ------------------------------------------------------------------ */

export function deriveNextActions(
  ctx: OpContext,
  project: Project,
  assets: Asset[],
  handoff: Handoff
): NextAction[] {
  const actions: NextAction[] = [];

  if (assets.length === 0) {
    const mounted = capabilitiesForProject(ctx, project);
    actions.push({
      target: "project",
      action: "从能力包生成基础交付物",
      tool: "ditto_template_apply",
      reason:
        mounted.length > 0
          ? `项目还没有资产。已挂载能力包「${mounted.map((c) => c.manifest.name).join("、")}」可一键生成。`
          : "项目还没有资产，且未挂载任何能力包。",
    });
    return actions;
  }

  const pendingIds = new Set((handoff.pendingApprovals ?? []).map((p) => p.assetId));

  for (const entry of handoff.assets ?? []) {
    const asset = assets.find((a) => a.id === entry.id);

    if (entry.status === "draft" || entry.status === "rejected") {
      if (!entry.lastRun || entry.lastRun.stale) {
        actions.push({
          target: "asset",
          assetId: entry.id,
          assetPath: entry.path,
          action: "执行规则自检",
          tool: "ditto_rule_run",
          reason: entry.lastRun
            ? "资产在上次规则执行之后被修改过，需要重跑"
            : "资产尚未执行过规则",
        });
        continue;
      }

      if (entry.lastRun.counts.error > 0 || entry.lastRun.counts.warn > 0) {
        actions.push({
          target: "asset",
          assetId: entry.id,
          assetPath: entry.path,
          action: "按规则结论整改",
          tool: "ditto_rule_run",
          reason: `存在 ${entry.lastRun.counts.error} 项阻断、${entry.lastRun.counts.warn} 项警告，整改后需重跑规则`,
          severity: entry.lastRun.counts.error > 0 ? "error" : "warn",
        });
        continue;
      }

      actions.push({
        target: "asset",
        assetId: entry.id,
        assetPath: entry.path,
        action: "提交评审",
        tool: "ditto_approval_submit",
        reason: "规则已全部通过，可以提交评审",
      });
      continue;
    }

    if (entry.status === "in_review") {
      const pending = (handoff.pendingApprovals ?? []).find((p) => p.assetId === entry.id);
      if (pending?.blocked) {
        actions.push({
          target: "asset",
          assetId: entry.id,
          assetPath: entry.path,
          action: "整改或显式豁免后放行",
          tool: "ditto_gate_check",
          reason:
            `闸门仍拦着，需要豁免的规则：${pending.missingWaiverRuleIds.join(", ") || "（无）"}。` +
            `豁免必须给出理由。`,
          severity: "error",
        });
      } else {
        actions.push({
          target: "asset",
          assetId: entry.id,
          assetPath: entry.path,
          action: "审批放行",
          tool: "ditto_approval_decide",
          reason: "闸门已放行，等待审批决策",
        });
      }
      continue;
    }

    if (entry.status === "approved") {
      actions.push({
        target: "asset",
        assetId: entry.id,
        assetPath: entry.path,
        action: "发布资产",
        tool: "ditto_asset_release",
        reason: "已批准，尚未发布；只有已发布的资产会进入交付包",
      });
    }
  }

  if (pendingIds.size === 0 && assets.every((a) => a.status === "released")) {
    if (project.status !== "released") {
      actions.push({
        target: "project",
        action: "提交并发布项目",
        tool: "ditto_project_release",
        reason: "全部资产均已发布，可以走项目级发布",
      });
    }
  }

  return actions;
}

/* ------------------------------------------------------------------ */
/* 辅助                                                                */
/* ------------------------------------------------------------------ */

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function sumSeverity(entries: AssetHandoffEntry[]): {
  error: number;
  warn: number;
  info: number;
} {
  const out = { error: 0, warn: 0, info: 0 };
  for (const e of entries) {
    if (!e.lastRun) continue;
    // 过期的 run 不计入，避免用陈旧结论误导调用方
    if (e.lastRun.stale) continue;
    out.error += e.lastRun.counts.error;
    out.warn += e.lastRun.counts.warn;
    out.info += e.lastRun.counts.info;
  }
  return out;
}
