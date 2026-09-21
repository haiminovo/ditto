/**
 * Ditto 实施平台 - 能力包加载与模板渲染
 *
 * 数据驱动的关键在这里：只认 capability.json 的结构，不认具体是
 * general / k8s / linux / cloud-*。往 workspace/capabilities/ 里丢一个新目录
 * 即可生效，零代码改动。
 */

import path from "node:path";
import type {
  AssetFormat,
  AssetKind,
  CapabilityPackage,
  TemplateSpec,
  VarSpec,
} from "../core/types";
import { ASSET_FORMATS, ASSET_KINDS } from "../core/types";
import {
  capabilityDirFor,
  readCapabilityManifest,
  readCapabilityTemplates,
  scanCapabilityDirs,
} from "../core/store/capabilities";
import { readTextOrNull } from "../core/store/fsjson";
import { CoreError, invalid } from "../core/errors";
import { render, renderSafe } from "./render";
import { effectiveVars } from "../core/identity";
import type { ProjectIdentity } from "../core/identity";
import { BUILTIN_SEEDS } from "./builtin/general";

/* ------------------------------------------------------------------ */
/* manifest 校验                                                       */
/* ------------------------------------------------------------------ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, label: string): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw new CoreError("E_CAPABILITY_INVALID", `${label} 必须是非空字符串`);
  }
  return v;
}

function strArray(v: unknown, label: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new CoreError("E_CAPABILITY_INVALID", `${label} 必须是字符串数组`);
  }
  return v as string[];
}

function parseVarSpec(raw: unknown, label: string): VarSpec {
  if (!isRecord(raw)) throw invalid(`${label} 不是对象`);
  const key = str(raw.key, `${label}.key`);
  const type = (raw.type ?? "string") as VarSpec["type"];
  if (!["string", "enum", "number", "boolean"].includes(type)) {
    throw invalid(`${label}.type 非法：${String(raw.type)}`);
  }
  const allowed = raw.allowed === undefined ? undefined : strArray(raw.allowed, `${label}.allowed`);
  if (type === "enum" && (!allowed || allowed.length === 0)) {
    throw invalid(`${label} 是 enum 类型但未给出 allowed 取值`);
  }
  return {
    key,
    label: typeof raw.label === "string" ? raw.label : key,
    type,
    required: raw.required === true,
    default: typeof raw.default === "string" ? raw.default : undefined,
    allowed,
    description: typeof raw.description === "string" ? raw.description : undefined,
  };
}

function parseTemplateSpec(raw: unknown, label: string): TemplateSpec {
  if (!isRecord(raw)) throw invalid(`${label} 不是对象`);
  const kind = str(raw.kind ?? "other", `${label}.kind`) as AssetKind;
  if (!(ASSET_KINDS as readonly string[]).includes(kind)) {
    throw invalid(`${label}.kind 非法：${kind}`);
  }
  const format = str(raw.format ?? "text", `${label}.format`) as AssetFormat;
  if (!(ASSET_FORMATS as readonly string[]).includes(format)) {
    throw invalid(`${label}.format 非法：${format}`);
  }
  return {
    id: str(raw.id, `${label}.id`),
    name: typeof raw.name === "string" ? raw.name : str(raw.id, `${label}.id`),
    kind,
    format,
    targetPath: str(raw.targetPath, `${label}.targetPath`),
    contentFile: str(raw.contentFile, `${label}.contentFile`),
    checklist: Array.isArray(raw.checklist)
      ? (raw.checklist as TemplateSpec["checklist"])
      : undefined,
  };
}

export function parseManifest(raw: unknown, label = "能力包 manifest"): CapabilityPackage {
  if (!isRecord(raw)) throw invalid(`${label} 不是对象`);

  const templatesRaw = raw.templates;
  if (!Array.isArray(templatesRaw)) throw invalid(`${label}.templates 必须是数组`);

  const templates = templatesRaw.map((t, i) => parseTemplateSpec(t, `${label}.templates[${i}]`));

  const seen = new Set<string>();
  for (const t of templates) {
    if (seen.has(t.id)) throw invalid(`${label} 存在重复的模板 id：${t.id}`);
    seen.add(t.id);
  }

  const targets = new Set<string>();
  for (const t of templates) {
    if (targets.has(t.targetPath)) {
      throw invalid(`${label} 存在重复的目标路径：${t.targetPath}`);
    }
    targets.add(t.targetPath);
  }

  const varsRaw = raw.vars;
  const vars = Array.isArray(varsRaw)
    ? varsRaw.map((v, i) => parseVarSpec(v, `${label}.vars[${i}]`))
    : [];

  return {
    schemaVersion: 1,
    id: str(raw.id, `${label}.id`),
    name: str(raw.name, `${label}.name`),
    version: typeof raw.version === "string" ? raw.version : "1.0.0",
    description: typeof raw.description === "string" ? raw.description : "",
    author: typeof raw.author === "string" ? raw.author : undefined,
    platforms: strArray(raw.platforms, `${label}.platforms`),
    requires: strArray(raw.requires, `${label}.requires`),
    vars,
    rulePacks: strArray(raw.rulePacks, `${label}.rulePacks`),
    templates,
  };
}

/* ------------------------------------------------------------------ */
/* 加载                                                                */
/* ------------------------------------------------------------------ */

export interface LoadedCapability {
  manifest: CapabilityPackage;
  dir: string;
  /** 模板文件名 → 内容 */
  templates: Record<string, string>;
}

/** 扫描并加载工作区里的全部能力包 */
export function loadCapabilities(wsRoot: string): LoadedCapability[] {
  const out: LoadedCapability[] = [];

  for (const { dirName, dir } of scanCapabilityDirs(wsRoot)) {
    const raw = readCapabilityManifest(dir);
    if (!raw) continue;

    let manifest: CapabilityPackage;
    try {
      manifest = parseManifest(raw, `能力包 ${dirName}`);
    } catch (e) {
      // 坏的能力包不该拖垮整个平台，跳过并保留其它包可用
      process.stderr.write(
        `[ditto] 跳过错的能力包 ${dirName}：${(e as Error).message}\n`
      );
      continue;
    }

    out.push({
      manifest,
      dir,
      templates: readCapabilityTemplates(dir),
    });
  }

  return out;
}

export function findCapability(
  capabilities: LoadedCapability[],
  id: string
): LoadedCapability | null {
  return capabilities.find((c) => c.manifest.id === id) ?? null;
}

export function requireCapability(
  capabilities: LoadedCapability[],
  id: string
): LoadedCapability {
  const hit = findCapability(capabilities, id);
  if (!hit) {
    throw new CoreError(
      "E_CAPABILITY_NOT_FOUND",
      `未安装能力包「${id}」。可用能力包：${
        capabilities.map((c) => c.manifest.id).join(", ") || "（无）"
      }`,
      { capabilityId: id }
    );
  }
  return hit;
}

export function findTemplate(
  cap: LoadedCapability,
  templateId: string
): TemplateSpec | null {
  return cap.manifest.templates.find((t) => t.id === templateId) ?? null;
}

/** 在所有能力包里找模板（用于 ditto_template_* 不指定包时的查找） */
export function findTemplateAnywhere(
  capabilities: LoadedCapability[],
  templateId: string,
  packageId?: string
): { cap: LoadedCapability; template: TemplateSpec } | null {
  const pool = packageId ? capabilities.filter((c) => c.manifest.id === packageId) : capabilities;
  for (const cap of pool) {
    const t = findTemplate(cap, templateId);
    if (t) return { cap, template: t };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 渲染作用域                                                          */
/* ------------------------------------------------------------------ */

export type { ProjectIdentity };
export { identityToVars } from "../core/identity";

/**
 * 变量合并顺序（越靠后优先级越高）：
 *   项目固有属性 → 能力包默认值 → 项目变量 → 调用方覆盖
 *
 * 基础部分直接复用 `effectiveVars` —— 规则引擎算的也是它。
 * 两边各写一份合并逻辑是这个平台最容易犯、也最致命的错误：
 * 渲染通过的文档被规则判成缺变量，闸门的可信度就没了。
 */
export function buildScope(
  manifest: CapabilityPackage,
  projectVars: Record<string, string>,
  overrides: Record<string, string> = {},
  identity?: ProjectIdentity
): Record<string, string> {
  const scope = effectiveVars(
    {
      id: identity?.id ?? "",
      name: identity?.name ?? "",
      code: identity?.code ?? "",
      customer: identity?.customer ?? "",
      vars: projectVars,
    },
    manifest.vars
  );

  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined && v !== null) scope[k] = String(v);
  }

  return scope;
}

/** 校验作用域是否满足 manifest 的 required 变量 */
export function checkRequiredVars(
  manifest: CapabilityPackage,
  scope: Record<string, string>
): string[] {
  const missing: string[] = [];
  for (const spec of manifest.vars) {
    if (!spec.required) continue;
    const value = scope[spec.key];
    if (value === undefined || value.trim() === "") missing.push(spec.key);
  }
  return missing;
}

/* ------------------------------------------------------------------ */
/* 渲染模板                                                            */
/* ------------------------------------------------------------------ */

export interface RenderTemplateInput {
  cap: LoadedCapability;
  template: TemplateSpec;
  scope: Record<string, string>;
  now?: Date;
}

export interface RenderedTemplate {
  templateId: string;
  name: string;
  path: string;
  content: string;
  kind: AssetKind;
  format: AssetFormat;
  capabilityPackageId: string;
  missingKeys: string[];
}

/** 读取模板文件内容（能力包目录下的 templates/） */
export function readTemplateSource(cap: LoadedCapability, template: TemplateSpec): string {
  const direct = cap.templates[template.contentFile];
  if (direct !== undefined) return direct;

  const onDisk = readTextOrNull(path.join(cap.dir, "templates", template.contentFile));
  if (onDisk !== null) return onDisk;

  throw new CoreError(
    "E_TEMPLATE_NOT_FOUND",
    `能力包「${cap.manifest.id}」缺少模板文件 templates/${template.contentFile}`,
    { capabilityId: cap.manifest.id, contentFile: template.contentFile }
  );
}

/**
 * 渲染一个模板：路径与内容都走同一套变量。
 *
 * 路径渲染先于内容 —— 路径里的变量缺失就没法确定落点，必须立刻报错。
 */
export function renderTemplate(input: RenderTemplateInput): RenderedTemplate {
  const { cap, template, scope, now } = input;

  const label = `${cap.manifest.name} / ${template.name}`;
  const source = readTemplateSource(cap, template);

  const targetPath = render({
    template: template.targetPath,
    format: "text",
    vars: scope,
    now,
    label: `${label} 的目标路径`,
  });

  const result = renderSafe({
    template: source,
    format: template.format,
    vars: scope,
    now,
    label,
  });

  return {
    templateId: template.id,
    name: template.name,
    path: targetPath,
    content: result.content,
    kind: template.kind,
    format: template.format,
    capabilityPackageId: cap.manifest.id,
    missingKeys: result.missingKeys,
  };
}

/** 把默认的内置能力包写到指定目录（供 capability_install 使用） */
export function builtinSeeds() {
  return BUILTIN_SEEDS;
}
