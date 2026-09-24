/**
 * Ditto 实施平台 - 规则引擎
 *
 * 设计上的承重属性是**纯度**：
 *   - 不直接摸 node:fs（读内容通过注入的 readContent）
 *   - findings 排序确定、不含时间戳
 *   - inputHash 记录（规则包 + 资产 rev/hash）
 *
 * 这样不同 AI 客户端跑的 run 是**可证明一致**的。
 * 一旦两者能漂移，闸门就失去了权威 —— 存量 run 只是证据，不是权威。
 */

import {
  countFindings,
  SEVERITY_ORDER,
  type Actor,
  type Asset,
  type CapabilityPackage,
  type Finding,
  type Project,
  type Rule,
  type RulePack,
  type RuleRun,
  type Severity,
  type VarSpec,
} from "../core/types";
import { sha256Hex, canonicalJson } from "../core/store/fsjson";
import { effectiveVars } from "../core/identity";
import { CHECKERS, PROJECT_SCOPED, truncateEvidence, type CheckContext, type LoadedCapabilityInfo } from "./checkers";
import { matchAnyGlob } from "./glob";

export interface ResolvedRule extends Rule {
  packId: string;
  /** 该规则所属规则包声明的阻断级别 */
  blockingSeverities: Severity[];
}

export interface RunInput {
  project: Project;
  assets: Asset[];
  capabilities: Array<{ manifest: CapabilityPackage; vars: VarSpec[] }>;
  rulePacks: RulePack[];
  actor: Actor;
  /** 读取资产文本内容；二进制返回 null */
  readContent: (asset: Asset) => string | null;
  /** 只对单个资产执行（资产级 run）；不传则做项目级全量 */
  assetId?: string;
  now?: () => Date;
  newId: () => string;
}

/**
 * 默认阻断 error + warn。
 *
 * warn 默认阻断是刻意的：否则豁免（waiver）机制就没有存在意义 ——
 * 「警告不拦路、豁免只留给错误」等于把评审意见降级成装饰。
 * 更宽松的规则包可以把 blockingSeverities 设成 ["error"]，
 * 更严格的可以设成 ["error","warn","info"]，都是**数据**，零代码改动。
 */
const DEFAULT_BLOCKING: Severity[] = ["error", "warn"];

/* ------------------------------------------------------------------ */
/* 规则合并                                                            */
/* ------------------------------------------------------------------ */

/**
 * 按 id 合并规则包：后者覆盖前者。
 * 调用方负责传对顺序 —— 内置 → 能力包 → 工作区。
 */
export function mergeRulePacks(packs: RulePack[]): ResolvedRule[] {
  const byId = new Map<string, ResolvedRule>();

  for (const pack of packs) {
    const blocking = pack.blockingSeverities?.length
      ? pack.blockingSeverities
      : DEFAULT_BLOCKING;

    for (const rule of pack.rules) {
      byId.set(rule.id, { ...rule, packId: pack.id, blockingSeverities: blocking });
    }
  }

  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

/* ------------------------------------------------------------------ */
/* 适用性                                                              */
/* ------------------------------------------------------------------ */

export function ruleAppliesToAsset(rule: Rule, asset: Asset): boolean {
  const { kinds, formats, paths } = rule.appliesTo;

  if (kinds && kinds.length > 0 && !kinds.includes(asset.kind)) return false;
  if (formats && formats.length > 0 && !formats.includes(asset.format)) return false;
  if (paths && paths.length > 0 && !matchAnyGlob(asset.path, paths)) return false;

  return true;
}

/* ------------------------------------------------------------------ */
/* 执行                                                                */
/* ------------------------------------------------------------------ */

export function runRules(input: RunInput): RuleRun {
  const now = input.now ?? (() => new Date());
  const startedAt = now().toISOString();

  const resolved = mergeRulePacks(input.rulePacks).filter((r) => r.enabled);

  const capabilities: LoadedCapabilityInfo[] = input.capabilities.map((c) => ({
    manifest: c.manifest,
    vars: c.vars,
  }));

  // ★ 规则与模板必须看到同一份变量。
  //   规则若只看原始 project.vars，派生变量（如 customer.name）就会被判缺失，
  //   而文档明明渲染得好好的 —— 这种不一致会让闸门失去可信度。
  const vars = effectiveVars(
    input.project,
    input.capabilities.flatMap((c) => c.vars)
  );

  // 预读检查单内容：检查器不自己读盘。
  //
  // 目标是**由规则声明**出来的，不能靠 kind 或文件名猜 —— 验收报告
  // (kind=acceptance) 同样会被 checklist-complete 规则指向。
  const checklistPaths = new Set<string>();
  for (const rule of resolved) {
    if (rule.checker.type === "checklist-complete") {
      checklistPaths.add(rule.checker.path);
    }
  }

  const checklists: Record<string, string> = {};
  for (const asset of input.assets) {
    if (!checklistPaths.has(asset.path)) continue;
    const text = input.readContent(asset);
    if (text !== null) checklists[asset.id] = text;
  }

  const targetAsset = input.assetId
    ? input.assets.find((a) => a.id === input.assetId)
    : undefined;

  const scopedAssets = targetAsset ? [targetAsset] : input.assets;

  const findings: Finding[] = [];
  let seq = 0;
  const nextFindingId = () => `f_${String(++seq).padStart(4, "0")}`;

  // 1) 项目级检查器：整项目只跑一次
  for (const rule of resolved) {
    if (!PROJECT_SCOPED.has(rule.checker.type)) continue;
    // 资产级 run 时跳过项目级规则，避免把全项目的问题算到单个资产头上
    if (input.assetId) continue;

    const ctx: CheckContext = {
      project: input.project,
      allAssets: input.assets,
      capabilities,
      vars,
      checklists,
    };

    emit(rule, CHECKERS[rule.checker.type](rule.checker, ctx), undefined, findings, nextFindingId);
  }

  // 2) 资产级检查器：逐个适用资产跑
  for (const asset of scopedAssets) {
    const content = input.readContent(asset);

    for (const rule of resolved) {
      if (PROJECT_SCOPED.has(rule.checker.type)) continue;
      if (!ruleAppliesToAsset(rule, asset)) continue;

      const ctx: CheckContext = {
        project: input.project,
        allAssets: input.assets,
        capabilities,
        vars,
        checklists,
        asset,
        content,
      };

      emit(rule, CHECKERS[rule.checker.type](rule.checker, ctx), asset, findings, nextFindingId);
    }
  }

  const sorted = sortFindings(findings);
  const finishedAt = now().toISOString();

  return {
    schemaVersion: 1,
    id: input.newId(),
    projectId: input.project.id,
    assetId: targetAsset?.id,
    scope: targetAsset ? "asset" : "project",
    rulePackIds: Array.from(new Set(input.rulePacks.map((p) => p.id))).sort(),
    startedAt,
    finishedAt,
    inputHash: computeInputHash(input.rulePacks, scopedAssets),
    targetRev: targetAsset?.rev,
    targetHash: targetAsset?.hash,
    counts: countFindings(sorted),
    findings: sorted,
    actor: input.actor,
  };
}

function emit(
  rule: ResolvedRule,
  hits: ReturnType<typeof CHECKERS[keyof typeof CHECKERS]>,
  asset: Asset | undefined,
  out: Finding[],
  nextId: () => string
): void {
  for (const hit of hits) {
    out.push({
      id: nextId(),
      ruleId: rule.id,
      ruleName: rule.name,
      severity: rule.severity,
      message: hit.message,
      assetId: asset?.id,
      assetPath: asset?.path,
      field: hit.field,
      location: hit.location,
      evidence: hit.evidence ? truncateEvidence(hit.evidence) : undefined,
      remediation: rule.remediation,
    });
  }
}

/**
 * 排序必须确定：(severity, ruleId, assetPath, line)。
 * 不含时间戳 —— 同一输入必然产出同一输出。
 */
export function sortFindings(findings: Finding[]): Finding[] {
  return findings.slice().sort((a, b) => {
    const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (s !== 0) return s;
    const r = a.ruleId.localeCompare(b.ruleId);
    if (r !== 0) return r;
    const p = (a.assetPath ?? "").localeCompare(b.assetPath ?? "");
    if (p !== 0) return p;
    return (a.location?.line ?? 0) - (b.location?.line ?? 0);
  });
}

/**
 * run 的输入指纹：规则包内容 + 被检查资产的 rev/hash。
 * 内容相同则指纹相同 —— 这是不同客户端跑出同一结果的可验证依据。
 */
export function computeInputHash(packs: RulePack[], assets: Asset[]): string {
  const payload = {
    packs: packs
      .map((p) => ({ id: p.id, version: p.version, rules: p.rules }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    assets: assets
      .map((a) => ({ id: a.id, rev: a.rev, hash: a.hash }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  return sha256Hex(canonicalJson(payload));
}

/* ------------------------------------------------------------------ */
/* 闸门判定                                                            */
/* ------------------------------------------------------------------ */

/**
 * 判断一个 finding 是否阻断。
 *
 * error  → 无条件阻断
 * warn   → 仅当规则包把 warn 列为阻断级别时（严格客户规则包可据此提升）
 * info   → 从不阻断
 */
export function isBlocking(finding: Finding, rule: { blockingSeverities: Severity[] } | undefined): boolean {
  const levels = rule?.blockingSeverities ?? DEFAULT_BLOCKING;
  return levels.includes(finding.severity);
}

export function blockingFindings(run: RuleRun, rules: ResolvedRule[]): Finding[] {
  const byId = new Map(rules.map((r) => [r.id, r]));
  return run.findings.filter((f) => isBlocking(f, byId.get(f.ruleId)));
}

export { canonicalJson };
