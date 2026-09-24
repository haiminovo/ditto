/**
 * Ditto 实施平台 - 能力包与模板操作
 *
 * 这是「以能力包适配不同平台」的落点：能力包是数据，模板是数据，
 * 渲染是纯函数。加一个新平台只需要往 workspace/capabilities/ 丢一个目录。
 */

import type { Asset, CapabilityPackage, TemplateSpec, VarSpec } from "../types";
import { CoreError, invalid, notFound } from "../errors";
import {
  buildScope,
  checkRequiredVars,
  findTemplateAnywhere,
  loadCapabilities,
  renderTemplate,
  type LoadedCapability,
} from "../../capabilities/loader";
import { readProject } from "../store/projects";
import { readTextOrNull } from "../store/fsjson";
import { appendAudit } from "../store/audit";
import { assetFilePath, findAssetByPath, readAssets } from "../store/assets";
import { workspacePaths } from "../store/paths";
import { createAsset, updateAsset } from "./asset-ops";
import { capabilitiesForProject } from "./rule-ops";
import type { OpContext } from "./context";

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

export interface CapabilitySummary {
  id: string;
  name: string;
  version: string;
  description: string;
  platforms: string[];
  templateCount: number;
  rulePackIds: string[];
  installed: true;
}

export function listCapabilities(ctx: OpContext): CapabilitySummary[] {
  return loadCapabilities(ctx.root).map((c) => summarize(c));
}

function summarize(cap: LoadedCapability): CapabilitySummary {
  return {
    id: cap.manifest.id,
    name: cap.manifest.name,
    version: cap.manifest.version,
    description: cap.manifest.description,
    platforms: cap.manifest.platforms,
    templateCount: cap.manifest.templates.length,
    rulePackIds: cap.manifest.rulePacks,
    installed: true,
  };
}

export interface CapabilityDetail extends CapabilitySummary {
  manifest: CapabilityPackage;
  vars: VarSpec[];
  templates: TemplateSpec[];
  /** 该能力包占用的模板 id 列表，便于冲突排查 */
  templateIds: string[];
}

export function getCapability(ctx: OpContext, capabilityId: string): CapabilityDetail {
  const cap = loadCapabilities(ctx.root).find((c) => c.manifest.id === capabilityId);
  if (!cap) {
    throw new CoreError("E_CAPABILITY_NOT_FOUND", `未安装能力包「${capabilityId}」`, {
      capabilityId,
    });
  }
  return {
    ...summarize(cap),
    manifest: cap.manifest,
    vars: cap.manifest.vars,
    templates: cap.manifest.templates,
    templateIds: cap.manifest.templates.map((t) => t.id),
  };
}

/** 项目视角下的能力包（只列已挂载的） */
export function capabilitiesOfProject(ctx: OpContext, projectId: string): CapabilitySummary[] {
  const project = readProject(ctx.root, projectId);
  return capabilitiesForProject(ctx, project).map(summarize);
}

export interface TemplateSummary extends Omit<TemplateSpec, "contentFile"> {
  capabilityPackageId: string;
  capabilityName: string;
}

export function listTemplates(ctx: OpContext, packageId?: string): TemplateSummary[] {
  const caps = loadCapabilities(ctx.root).filter(
    (c) => !packageId || c.manifest.id === packageId
  );

  const out: TemplateSummary[] = [];
  for (const cap of caps) {
    for (const t of cap.manifest.templates) {
      const { contentFile: _omit, ...rest } = t;
      out.push({
        ...rest,
        capabilityPackageId: cap.manifest.id,
        capabilityName: cap.manifest.name,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

export interface RenderTemplateOptions {
  projectId?: string;
  templateId: string;
  packageId?: string;
  /** 覆盖项目变量 */
  vars?: Record<string, string>;
}

export interface RenderedPreview {
  templateId: string;
  name: string;
  path: string;
  content: string;
  kind: TemplateSpec["kind"];
  format: TemplateSpec["format"];
  capabilityPackageId: string;
  /** 模板用到但作用域里没有的变量 —— 空数组才说明能直接落盘 */
  missingKeys: string[];
  /** 能力包声明为必填、但当前作用域没值的变量 */
  missingRequired: string[];
  /** 目标路径上是否已存在资产 */
  existingAssetId?: string;
}

/**
 * 只渲染不落盘 —— 给 AI 客户端做预览用。
 *
 * 即使缺变量也不抛错，而是把缺失项列出来，让调用方一次看清还差什么。
 */
export function previewTemplate(
  ctx: OpContext,
  options: RenderTemplateOptions
): RenderedPreview {
  const found = resolveTemplate(ctx, options.templateId, options.packageId);
  if (!found) {
    throw notFound("模板", options.templateId);
  }
  const { cap, template } = found;

  const project = options.projectId ? readProject(ctx.root, options.projectId) : null;

  const scope = buildScope(
    cap.manifest,
    project?.vars ?? {},
    options.vars ?? {},
    project ?? undefined
  );
  const rendered = renderTemplate({ cap, template, scope, now: ctx.now?.() });

  const existing = options.projectId
    ? findAssetByPath(readAssets(ctx.root, options.projectId), rendered.path)
    : null;

  return {
    templateId: rendered.templateId,
    name: rendered.name,
    path: rendered.path,
    content: rendered.content,
    kind: rendered.kind,
    format: rendered.format,
    capabilityPackageId: rendered.capabilityPackageId,
    missingKeys: rendered.missingKeys,
    missingRequired: checkRequiredVars(cap.manifest, scope),
    existingAssetId: existing?.id,
  };
}

export interface ApplyTemplateOptions extends RenderTemplateOptions {
  projectId: string;
  /** 目标路径已存在时是否覆盖 */
  overwrite?: boolean;
}

export interface ApplyTemplateResult {
  asset: Asset;
  created: boolean;
  preview: RenderedPreview;
}

/**
 * 渲染并落盘。
 *
 * 缺变量时**明确报错**，不静默生成半成品 —— 一份缺了客户名的验收报告
 * 流到交付现场，比当场报错危险得多。
 */
export async function applyTemplate(
  ctx: OpContext,
  options: ApplyTemplateOptions
): Promise<ApplyTemplateResult> {
  const preview = previewTemplate(ctx, options);

  if (preview.missingKeys.length > 0 || preview.missingRequired.length > 0) {
    const parts: string[] = [];
    if (preview.missingRequired.length > 0) {
      parts.push(`必填变量缺失：${preview.missingRequired.join(", ")}`);
    }
    if (preview.missingKeys.length > 0) {
      parts.push(`模板引用的变量缺失：${preview.missingKeys.join(", ")}`);
    }
    throw new CoreError(
      "E_RENDER_MISSING_VARS",
      `无法生成「${preview.name}」：${parts.join("；")}。` +
        `请用 ditto_project_update 补齐项目变量，或在 vars 参数中直接提供。`,
      {
        templateId: options.templateId,
        missingKeys: preview.missingKeys,
        missingRequired: preview.missingRequired,
      }
    );
  }

  const found = resolveTemplate(ctx, options.templateId, options.packageId);
  if (!found) throw notFound("模板", options.templateId);

  const scope = buildScope(
    found.cap.manifest,
    readProject(ctx.root, options.projectId).vars,
    options.vars ?? {},
    readProject(ctx.root, options.projectId)
  );

  const varsUsed: Record<string, string> = {};
  for (const spec of found.cap.manifest.vars) {
    const v = scope[spec.key];
    if (v !== undefined) varsUsed[spec.key] = v;
  }

  if (preview.existingAssetId) {
    if (!options.overwrite) {
      throw new CoreError(
        "E_PATH_DUPLICATE",
        `目标路径已存在资产：${preview.path}。` +
          `如需按模板重新生成，请显式传入 overwrite=true。`,
        { path: preview.path, assetId: preview.existingAssetId }
      );
    }

    const result = await updateAsset(ctx, options.projectId, {
      assetId: preview.existingAssetId,
      content: preview.content,
      message: `按能力包模板「${preview.name}」重新生成`,
      patch: { kind: preview.kind },
    });

    appendAudit(workspacePaths(ctx.root).auditDir, {
      actor: ctx.actor,
      action: "template.apply",
      projectId: options.projectId,
      assetId: result.asset.id,
      targetRev: result.asset.rev,
      summary: `重新生成资产「${preview.path}」（模板 ${preview.templateId}）`,
      details: { capabilityPackageId: preview.capabilityPackageId, vars: varsUsed },
    });

    return { asset: result.asset, created: false, preview };
  }

  const result = await createAsset(ctx, options.projectId, {
    path: preview.path,
    content: preview.content,
    kind: preview.kind,
    format: preview.format,
    name: preview.name,
    message: `由能力包模板「${preview.name}」生成`,
    capabilityPackageId: preview.capabilityPackageId,
    templateId: preview.templateId,
    vars: varsUsed,
  });

  appendAudit(workspacePaths(ctx.root).auditDir, {
    actor: ctx.actor,
    action: "template.apply",
    projectId: options.projectId,
    assetId: result.asset.id,
    targetRev: result.asset.rev,
    summary: `生成资产「${preview.path}」（模板 ${preview.templateId}）`,
    details: { capabilityPackageId: preview.capabilityPackageId, vars: varsUsed },
  });

  return { asset: result.asset, created: true, preview };
}

/* ------------------------------------------------------------------ */
/* 辅助                                                                */
/* ------------------------------------------------------------------ */

function resolveTemplate(
  ctx: OpContext,
  templateId: string,
  packageId?: string
): { cap: LoadedCapability; template: TemplateSpec } | null {
  if (packageId) {
    const cap = loadCapabilities(ctx.root).find((c) => c.manifest.id === packageId);
    if (!cap) {
      throw new CoreError("E_CAPABILITY_NOT_FOUND", `未安装能力包「${packageId}」`, { packageId });
    }
    const template = cap.manifest.templates.find((t) => t.id === templateId);
    return template ? { cap, template } : null;
  }
  return findTemplateAnywhere(loadCapabilities(ctx.root), templateId);
}

/** 读取渲染后的资产正文（供 diff / 审计对比使用） */
export function readRenderedAsset(ctx: OpContext, projectId: string, asset: Asset): string | null {
  return readTextOrNull(assetFilePath(ctx.root, projectId, asset.path));
}
