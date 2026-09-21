/**
 * Ditto 实施平台 - 规则执行与闸门
 *
 * 规则包来源与优先级（后者覆盖前者，按规则 id 合并）：
 *   项目已挂载能力包自带的规则  →  工作区 rulepacks/ 下的补充与覆盖
 *
 * 工作区级的覆盖能力是刻意留的：客户可以不改任何代码，只在
 * workspace/rulepacks/ 里丢一个同 id 的规则包，就把某条规则的严重级别
 * 或适用范围改掉。
 */

import type { Finding, Project, RulePack, RuleRun, Severity } from "../types";
import { countFindings } from "../types";
import { CoreError, invalid, notFound } from "../errors";
import {
  loadCapabilities,
  findCapability,
  type LoadedCapability,
} from "../../capabilities/loader";
import {
  readCapabilityRulePacks,
  readWorkspaceRulePacks,
} from "../store/capabilities";
import { readTextOrNull } from "../store/fsjson";
import { readAssets, assetFilePath } from "../store/assets";
import { readProject } from "../store/projects";
import { readRun } from "../store/runs";
import { writeRun } from "../store/runs";
import { appendAudit } from "../store/audit";
import { workspacePaths } from "../store/paths";
import { parseRulePack } from "../../rules/schema";
import { blockingFindings, mergeRulePacks, runRules, type ResolvedRule } from "../../rules/engine";
import type { OpContext } from "./context";
import type { GateResult } from "../types";

/* ------------------------------------------------------------------ */
/* 能力包解析                                                          */
/* ------------------------------------------------------------------ */

/** 项目实际已挂载、且磁盘上存在的能力包 */
export function capabilitiesForProject(
  ctx: OpContext,
  project: Project
): LoadedCapability[] {
  const installed = loadCapabilities(ctx.root);
  return project.capabilityPackageIds
    .map((id) => findCapability(installed, id))
    .filter((c): c is LoadedCapability => c !== null);
}

/** 项目创建时默认挂载的能力包：平台标识与项目匹配的那些 */
export function defaultCapabilitiesFor(project: Project, installed: LoadedCapability[]): string[] {
  return installed
    .filter((c) => {
      const platforms = c.manifest.platforms;
      if (platforms.length === 0) return true;
      return platforms.some((p) => project.platforms.includes(p) || p === "generic");
    })
    .map((c) => c.manifest.id);
}

/* ------------------------------------------------------------------ */
/* 规则包加载                                                          */
/* ------------------------------------------------------------------ */

export interface RulePackLoad {
  packs: RulePack[];
  rules: ResolvedRule[];
}

export function loadRulePacksForProject(ctx: OpContext, project: Project): RulePackLoad {
  const packs: RulePack[] = [];
  const errors: string[] = [];

  // 1) 已挂载能力包自带的规则
  for (const cap of capabilitiesForProject(ctx, project)) {
    for (const raw of readCapabilityRulePacks(cap.dir)) {
      try {
        packs.push(parseRulePack(raw, `能力包 ${cap.manifest.id} 的规则包`));
      } catch (e) {
        errors.push(`${cap.manifest.id}: ${(e as Error).message}`);
      }
    }
  }

  // 2) 工作区级规则包（可覆盖上面）
  for (const raw of readWorkspaceRulePacks(ctx.root)) {
    try {
      packs.push(parseRulePack(raw, "工作区规则包"));
    } catch (e) {
      errors.push(`workspace/rulepacks: ${(e as Error).message}`);
    }
  }

  if (errors.length > 0) {
    // 坏规则包不静默吞掉 —— 否则用户会以为规则生效了
    throw new CoreError(
      "E_RULE_INVALID",
      `以下规则包加载失败：\n${errors.map((e) => `  · ${e}`).join("\n")}`,
      { errors }
    );
  }

  return { packs, rules: mergeRulePacks(packs) };
}

/* ------------------------------------------------------------------ */
/* 执行                                                                */
/* ------------------------------------------------------------------ */

export interface RunRulesOptions {
  projectId: string;
  /** 只跑单个资产（资产级 run）；不传则做项目级全量 */
  assetId?: string;
  /** 持久化本次 run（默认 true） */
  persist?: boolean;
}

export function runProjectRules(ctx: OpContext, options: RunRulesOptions): RuleRun {
  const project = readProject(ctx.root, options.projectId);
  const assets = readAssets(ctx.root, options.projectId);
  const { packs } = loadRulePacksForProject(ctx, project);
  const capabilities = capabilitiesForProject(ctx, project);

  const run = runRules({
    project,
    assets,
    capabilities: capabilities.map((c) => ({ manifest: c.manifest, vars: c.manifest.vars })),
    rulePacks: packs,
    actor: ctx.actor,
    assetId: options.assetId,
    readContent: (asset) => readTextOrNull(assetFilePath(ctx.root, options.projectId, asset.path)),
    now: ctx.now,
    newId: () => ctx.newId("run"),
  });

  if (options.persist !== false) {
    writeRun(ctx.root, run);

    appendAudit(workspacePaths(ctx.root).auditDir, {
      actor: ctx.actor,
      action: "rule.run",
      projectId: options.projectId,
      assetId: options.assetId,
      targetRev: run.targetRev,
      summary: `执行规则（${run.scope === "asset" ? "单资产" : "项目级"}）：` +
        `${run.counts.error} 阻断 / ${run.counts.warn} 警告 / ${run.counts.info} 提示`,
      details: { runId: run.id, counts: run.counts, inputHash: run.inputHash },
    });
  }

  return run;
}

export function getRun(ctx: OpContext, projectId: string, runId: string): RuleRun {
  return readRun(ctx.root, projectId, runId);
}

/* ------------------------------------------------------------------ */
/* 豁免                                                                */
/* ------------------------------------------------------------------ */

/**
 * 给某条 finding 打上显式豁免。
 *
 * 豁免**永远不自动、不推断** —— 必须由调用方给出理由并留痕。
 * 这正是它值得被信任的原因。
 */
export function waiveFinding(
  ctx: OpContext,
  projectId: string,
  runId: string,
  ruleId: string,
  reason: string,
  assetId?: string
): RuleRun {
  if (!reason || reason.trim().length < 2) {
    throw invalid("豁免必须给出理由（至少 2 个字符）");
  }

  const run = readRun(ctx.root, projectId, runId);

  let hit = 0;
  const findings: Finding[] = run.findings.map((f) => {
    if (f.ruleId !== ruleId) return f;
    if (assetId && f.assetId !== assetId) return f;
    hit += 1;
    return {
      ...f,
      waived: { by: ctx.actor, reason: reason.trim(), at: (ctx.now ?? (() => new Date()))().toISOString() },
    };
  });

  if (hit === 0) {
    throw notFound(`规则「${ruleId}」在本次执行中的命中项`, runId);
  }

  const next: RuleRun = { ...run, findings };
  writeRun(ctx.root, next);

  appendAudit(workspacePaths(ctx.root).auditDir, {
    actor: ctx.actor,
    action: "rule.waive",
    projectId,
    assetId,
    summary: `豁免规则「${ruleId}」：${reason.trim()}`,
    details: { runId, ruleId, affected: hit },
  });

  return next;
}

/* ------------------------------------------------------------------ */
/* 闸门                                                                */
/* ------------------------------------------------------------------ */

export interface GateCheckOptions {
  projectId: string;
  assetId?: string;
  /** 调用方给出的豁免列表（仅对本次判定生效，不落盘） */
  overrides?: Array<{ ruleId: string; reason: string }>;
}

/**
 * 闸门判定 —— **重新计算，绝不信任存量 run**。
 *
 * 存量 run 是证据，不是权威：规则包或资产可能在 run 之后变过。
 * 这里重跑一遍才能保证放行结论建立在当前真实状态上。
 */
export function gateCheck(ctx: OpContext, options: GateCheckOptions): GateResult {
  const project = readProject(ctx.root, options.projectId);
  const { packs, rules } = loadRulePacksForProject(ctx, project);

  // dry-run：不落盘
  const run = runProjectRules(ctx, {
    projectId: options.projectId,
    assetId: options.assetId,
    persist: false,
  });

  const overrideIds = new Set((options.overrides ?? []).map((o) => o.ruleId));

  const waived: Finding[] = [];
  const errors: Finding[] = [];
  const warnings: Finding[] = [];
  const missingWaiverRuleIds = new Set<string>();

  const ruleById = new Map(rules.map((r) => [r.id, r]));

  for (const f of run.findings) {
    if (f.waived) {
      waived.push(f);
      continue;
    }

    const rule = ruleById.get(f.ruleId);
    const blocking = (rule?.blockingSeverities ?? ["error", "warn"]).includes(f.severity);
    if (!blocking) continue;

    if (overrideIds.has(f.ruleId)) {
      waived.push(f);
      continue;
    }

    if (f.severity === "error") {
      errors.push(f);
      missingWaiverRuleIds.add(f.ruleId);
    } else {
      warnings.push(f);
      missingWaiverRuleIds.add(f.ruleId);
    }
  }

  const reasons: string[] = [];
  if (errors.length > 0) {
    reasons.push(`存在 ${errors.length} 项阻断级问题，必须整改后重新执行规则`);
  }
  if (warnings.length > 0) {
    reasons.push(
      `存在 ${warnings.length} 项警告，需要逐条给出豁免理由才能放行`
    );
  }

  return {
    blocked: errors.length > 0 || warnings.length > 0,
    errors,
    warnings,
    waived,
    missingWaiverRuleIds: Array.from(missingWaiverRuleIds).sort(),
    reasons,
  };
}

/* ------------------------------------------------------------------ */
/* 辅助                                                                */
/* ------------------------------------------------------------------ */

export function ruleCatalog(ctx: OpContext, projectId: string): ResolvedRule[] {
  const project = readProject(ctx.root, projectId);
  return loadRulePacksForProject(ctx, project).rules;
}

export function severityCounts(findings: Finding[]): { error: number; warn: number; info: number } {
  return countFindings(findings);
}

/** 判断某个 run 是否仍然对资产当前状态有效 */
export function isRunCurrent(run: RuleRun, assetRev: number, assetHash: string): boolean {
  return run.targetRev === assetRev && run.targetHash === assetHash;
}

export function blockingOf(run: RuleRun, rules: ResolvedRule[]): Finding[] {
  return blockingFindings(run, rules);
}

export { runRules };
export type { ResolvedRule, Severity };
