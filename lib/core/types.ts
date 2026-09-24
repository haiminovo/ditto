/**
 * Ditto 实施平台 - 核心领域类型
 *
 * 本文件是**纯类型与常量**，零 import：不引用 fs / React / Next / MCP。
 * MCP 服务端、脚本与聊天客户端共用同一套定义。
 */

export const SCHEMA_VERSION = 1 as const;

/* ------------------------------------------------------------------ */
/* 枚举                                                                */
/* ------------------------------------------------------------------ */

/** 资产与项目共用的生命周期状态 */
export type AssetStatus =
  | "draft"
  | "in_review"
  | "approved"
  | "rejected"
  | "released"
  | "deprecated";

export type Severity = "error" | "warn" | "info";

export type AssetKind =
  | "doc"
  | "design"
  | "topology"
  | "config"
  | "script"
  | "sql"
  | "checklist"
  | "report"
  | "acceptance"
  | "other";

export type AssetFormat =
  | "markdown"
  | "json"
  | "yaml"
  | "text"
  | "shell"
  | "sql"
  | "binary";

export const ASSET_STATUSES: readonly AssetStatus[] = [
  "draft",
  "in_review",
  "approved",
  "rejected",
  "released",
  "deprecated",
];

export const SEVERITIES: readonly Severity[] = ["error", "warn", "info"];

export const ASSET_KINDS: readonly AssetKind[] = [
  "doc",
  "design",
  "topology",
  "config",
  "script",
  "sql",
  "checklist",
  "report",
  "acceptance",
  "other",
];

export const ASSET_FORMATS: readonly AssetFormat[] = [
  "markdown",
  "json",
  "yaml",
  "text",
  "shell",
  "sql",
  "binary",
];

/**
 * 状态机（项目与资产共用）
 *
 *   draft ─submit→ in_review ─approve→ approved ─release→ released ─deprecate→ deprecated
 *     ↑              │                                        │
 *     │              └reject→ rejected ─revise→ draft          └revise→ draft
 *     └─── 内容变更自动回 draft 并清除 latestApprovalId ───┘
 */
export const STATUS_TRANSITIONS: Record<AssetStatus, readonly AssetStatus[]> = {
  draft: ["in_review", "deprecated"],
  in_review: ["approved", "rejected", "draft"],
  approved: ["released", "draft", "deprecated"],
  rejected: ["draft", "deprecated"],
  released: ["deprecated", "draft"], // draft 仅经 revise 生效
  deprecated: [],
};

export function canTransition(from: AssetStatus, to: AssetStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

/** 已发布资产禁止直接编辑，必须先 revise 出新版本 */
export function isEditable(status: AssetStatus): boolean {
  return status !== "released" && status !== "deprecated";
}

/* ------------------------------------------------------------------ */
/* 操作者                                                              */
/* ------------------------------------------------------------------ */

export type ActorType = "human" | "ai" | "system";

export type ActorVia = "mcp-http" | "chat" | "cli";

export interface Actor {
  type: ActorType;
  /** 稳定标识，例如 "local:user" / "mcp:claude-code" / "system:seed" */
  id: string;
  /** 展示名 */
  name: string;
  via: ActorVia;
  clientInfo?: { name: string; version: string };
}

/* ------------------------------------------------------------------ */
/* 项目                                                                */
/* ------------------------------------------------------------------ */

export interface ProjectSettings {
  /** 是否允许 AI（MCP 客户端）直接审批放行 */
  allowAiApproval: boolean;
  /**
   * 是否要求审批人与提交人不同。
   * 默认 false —— 打开它，纯 MCP 工作流会死锁（没有人工审批者）。
   */
  requireDistinctApprover: boolean;
  /** 覆盖规则包的阻断级别，默认 ["error"] */
  blockingSeverities?: Severity[];
}

export interface Project {
  schemaVersion: number;
  id: string;
  name: string;
  /** 项目编号 */
  code: string;
  customer: string;
  description?: string;
  /** 目标平台标识，例如 ["generic"]、["k8s"] */
  platforms: string[];
  capabilityPackageIds: string[];
  status: AssetStatus;
  owner?: string;
  tags: string[];
  /** 模板渲染变量，键形如 "customer.name" */
  vars: Record<string, string>;
  settings: ProjectSettings;
  latestApprovalId?: string;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* 资产                                                                */
/* ------------------------------------------------------------------ */

export interface AssetVersion {
  assetId: string;
  version: number;
  rev: number;
  hash: string;
  size: number;
  mimeType: string;
  createdAt: string;
  author: Actor;
  message: string;
  runId?: string;
  approvalId?: string;
  /** 归档文件相对路径 */
  snapshot: string;
}

export interface Asset {
  schemaVersion: number;
  /** ULID，跨版本不变，是 ditto:// URI 的身份 */
  id: string;
  projectId: string;
  /**
   * 逻辑路径，正斜杠分隔。创建后不可变（当前版本没有实现改名）——
   * 这也是 URI 同时以 id 为准的原因：路径虽然稳定，但不是为变更设计的。
   */
  path: string;
  name: string;
  kind: AssetKind;
  format: AssetFormat;
  mimeType: string;
  capabilityPackageId?: string;
  templateId?: string;
  /** 渲染时使用的变量，用于原地重渲染 */
  vars?: Record<string, string>;
  status: AssetStatus;
  owner?: string;
  tags: string[];
  /** 依赖的资产 id */
  dependsOn: string[];
  /** 仅内容变化时 +1 */
  currentVersion: number;
  /** 任何变更（含只改 owner）都 +1；闸门判定过期用这个 */
  rev: number;
  hash: string;
  size: number;
  isBinary: boolean;
  latestRunId?: string;
  latestApprovalId?: string;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* 能力包                                                              */
/* ------------------------------------------------------------------ */

export type VarType = "string" | "enum" | "number" | "boolean";

export interface VarSpec {
  key: string;
  label: string;
  type: VarType;
  required?: boolean;
  default?: string;
  /** type === "enum" 时必填 */
  allowed?: string[];
  description?: string;
}

export interface ChecklistItemSpec {
  id: string;
  text: string;
  requiresEvidence?: boolean;
}

export interface TemplateSpec {
  id: string;
  name: string;
  kind: AssetKind;
  format: AssetFormat;
  /** 目标逻辑路径，支持 {{var}} */
  targetPath: string;
  /** 模板文件相对能力包目录的路径 */
  contentFile: string;
  /** 渲染完成后自动生成的检查单条目 */
  checklist?: ChecklistItemSpec[];
}

export interface CapabilityPackage {
  schemaVersion: number;
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  platforms: string[];
  /** 依赖的其他能力包 id */
  requires: string[];
  vars: VarSpec[];
  rulePacks: string[];
  templates: TemplateSpec[];
}

/* ------------------------------------------------------------------ */
/* 规则                                                                */
/* ------------------------------------------------------------------ */

/** 检查器的判别联合。全部是**声明式数据**，引擎内没有 eval / new Function。 */
export type Checker =
  | { type: "required-fields"; fields: string[]; scope: "meta" | "vars" }
  | { type: "field-pattern"; field: string; pattern: string; flags?: string; scope: "meta" | "vars" }
  | { type: "field-enum"; field: string; allowed: string[]; scope: "meta" | "vars" }
  | { type: "forbidden-content"; patterns: string[]; flags?: string; scan?: "content" | "meta" }
  | { type: "file-exists"; globs: string[]; atLeast?: number }
  | { type: "checklist-complete"; path: string; requireEvidence?: boolean }
  | { type: "reference-integrity"; allowExternal?: boolean }
  | { type: "json-schema"; schema: Record<string, unknown> }
  | { type: "size-limit"; minBytes?: number; maxBytes?: number; maxLines?: number }
  | { type: "capability-compat"; packageId?: string }
  | { type: "unique-path" }
  | { type: "format-valid"; format: "json" | "markdown" }
  | { type: "heading-structure"; requiredHeadings: string[]; ordered?: boolean }
  | { type: "project-metadata"; fields: string[] };

export type CheckerType = Checker["type"];

export interface RuleAppliesTo {
  kinds?: AssetKind[];
  formats?: AssetFormat[];
  paths?: string[];
  stages?: string[];
}

export interface Rule {
  id: string;
  name: string;
  description?: string;
  severity: Severity;
  enabled: boolean;
  appliesTo: RuleAppliesTo;
  checker: Checker;
  /** 中文修复建议 */
  remediation?: string;
}

export interface RulePack {
  schemaVersion: number;
  id: string;
  name: string;
  version: string;
  description?: string;
  /** 覆盖默认阻断级别（默认 ["error"]） */
  blockingSeverities?: Severity[];
  rules: Rule[];
}

export interface Finding {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: Severity;
  /** 中文说明 */
  message: string;
  assetId?: string;
  assetPath?: string;
  field?: string;
  location?: { line?: number; char?: number };
  /** 命中片段，截断到 200 字符 */
  evidence?: string;
  remediation?: string;
  waived?: { by: Actor; reason: string; at: string };
}

export interface RuleRun {
  schemaVersion: number;
  id: string;
  projectId: string;
  assetId?: string;
  scope: "asset" | "project";
  rulePackIds: string[];
  startedAt: string;
  finishedAt: string;
  /** 规则包 + 资产 rev 的哈希，用于判定 run 是否过期 */
  inputHash: string;
  targetRev?: number;
  targetHash?: string;
  counts: { error: number; warn: number; info: number };
  findings: Finding[];
  actor: Actor;
}

/* ------------------------------------------------------------------ */
/* 审批                                                                */
/* ------------------------------------------------------------------ */

export type ApprovalDecision = "approved" | "rejected";

export interface RuleOverride {
  ruleId: string;
  reason: string;
}

export interface Approval {
  schemaVersion: number;
  id: string;
  projectId: string;
  /** 缺省表示项目级审批 */
  assetId?: string;
  targetRev: number;
  targetHash: string;
  fromStatus: AssetStatus;
  toStatus: AssetStatus;
  decision: ApprovalDecision;
  actor: Actor;
  reason?: string;
  overrides: RuleOverride[];
  runId?: string;
  createdAt: string;
}

/** 审批提交前的闸门判定结果（dry-run，不改任何状态） */
export interface GateResult {
  blocked: boolean;
  /** 未豁免的 error 级 findings */
  errors: Finding[];
  /** 未被 overrides 覆盖的 warn 级 findings */
  warnings: Finding[];
  /** 已经显式豁免的 findings */
  waived: Finding[];
  /** 需要调用方补齐豁免的规则 id */
  missingWaiverRuleIds: string[];
  /** 阻塞原因的中文说明 */
  reasons: string[];
}

/* ------------------------------------------------------------------ */
/* 审计                                                                */
/* ------------------------------------------------------------------ */

export type AuditAction =
  | "workspace.init"
  | "project.create"
  | "project.update"
  | "project.submit"
  | "project.release"
  | "project.export"
  | "asset.create"
  | "asset.update"
  | "asset.delete"
  | "asset.revise"
  | "asset.submit"
  | "asset.approve"
  | "asset.reject"
  | "asset.release"
  | "asset.deprecate"
  | "rule.run"
  | "rule.waive"
  | "capability.install"
  | "template.render"
  | "template.apply";

export interface AuditEntry {
  seq: number;
  at: string;
  actor: Actor;
  action: AuditAction;
  projectId?: string;
  assetId?: string;
  targetRev?: number;
  summary: string;
  details?: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

/* ------------------------------------------------------------------ */
/* 文件名与路径约定                                                    */
/* ------------------------------------------------------------------ */

export const WORKSPACE_MARKER = "ditto.workspace.json";
export const PROJECT_FILE = "project.json";
export const ASSETS_INDEX_FILE = "assets.json";
export const CAPABILITY_MANIFEST_FILE = "capability.json";

/** 视为文本的扩展名白名单，其余按二进制处理 */
export const TEXT_EXTENSIONS = [
  "md",
  "markdown",
  "txt",
  "json",
  "yaml",
  "yml",
  "xml",
  "conf",
  "cfg",
  "ini",
  "properties",
  "sh",
  "bash",
  "sql",
  "tf",
  "csv",
  "tsv",
  "env",
  "log",
  "tpl",
] as const;

const EXT_TO_FORMAT: Record<string, AssetFormat> = {
  md: "markdown",
  markdown: "markdown",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  sh: "shell",
  bash: "shell",
  sql: "sql",
};

const EXT_TO_MIME: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  sh: "text/x-shellscript",
  bash: "text/x-shellscript",
  sql: "application/sql",
  csv: "text/csv",
  txt: "text/plain",
};

export function extOf(path: string): string {
  const base = path.split("/").pop() ?? "";
  const i = base.lastIndexOf(".");
  return i === -1 ? "" : base.slice(i + 1).toLowerCase();
}

/** 无扩展名但明确是文本的文件名 */
const TEXT_BASENAMES = [
  "dockerfile",
  "makefile",
  "license",
  "readme",
  "changelog",
  "procfile",
  ".gitignore",
  ".dockerignore",
  ".env",
];

export function isTextPath(path: string): boolean {
  const base = (path.split("/").pop() ?? "").toLowerCase();
  if (TEXT_BASENAMES.includes(base)) return true;
  if (base.startsWith(".env")) return true;

  const ext = extOf(path);
  if (!ext) return false;
  return (TEXT_EXTENSIONS as readonly string[]).includes(ext);
}

export function formatForPath(path: string): AssetFormat {
  const ext = extOf(path);
  return EXT_TO_FORMAT[ext] ?? (isTextPath(path) ? "text" : "binary");
}

export function mimeForPath(path: string): string {
  const ext = extOf(path);
  return EXT_TO_MIME[ext] ?? (isTextPath(path) ? "text/plain" : "application/octet-stream");
}

/* ------------------------------------------------------------------ */
/* 辅助                                                                */
/* ------------------------------------------------------------------ */

export function emptyCounts(): { error: number; warn: number; info: number } {
  return { error: 0, warn: 0, info: 0 };
}

export function countFindings(findings: Finding[]): {
  error: number;
  warn: number;
  info: number;
} {
  const c = emptyCounts();
  for (const f of findings) c[f.severity] += 1;
  return c;
}

export const SEVERITY_ORDER: Record<Severity, number> = {
  error: 0,
  warn: 1,
  info: 2,
};

export const STATUS_LABELS: Record<AssetStatus, string> = {
  draft: "草稿",
  in_review: "评审中",
  approved: "已批准",
  rejected: "已驳回",
  released: "已发布",
  deprecated: "已废弃",
};

export const SEVERITY_LABELS: Record<Severity, string> = {
  error: "阻断",
  warn: "警告",
  info: "提示",
};

export const KIND_LABELS: Record<AssetKind, string> = {
  doc: "文档",
  design: "设计",
  topology: "拓扑",
  config: "配置",
  script: "脚本",
  sql: "SQL",
  checklist: "检查单",
  report: "报告",
  acceptance: "验收",
  other: "其他",
};
