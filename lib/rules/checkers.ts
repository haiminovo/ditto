/**
 * Ditto 实施平台 - 内置检查器
 *
 * 每个检查器是一个**纯函数**：输入声明式的 Checker 参数 + 上下文，
 * 输出若干条命中描述。这里没有 eval、没有 new Function、不碰 node:fs
 * （需要读文件的地方都通过注入的上下文拿）。
 *
 * 返回多条结果是刻意的：一条 forbidden-content 规则可能命中三种模式，
 * 应该报三条 finding 而不是一条。
 */

import Ajv from "ajv";
import type {
  Asset,
  CapabilityPackage,
  Checker,
  CheckerType,
  Project,
  VarSpec,
} from "../core/types";
import { matchGlob, matchAnyGlob } from "./glob";

/* ------------------------------------------------------------------ */
/* 上下文                                                              */
/* ------------------------------------------------------------------ */

export interface CheckContext {
  project: Project;
  /** 项目内全部资产（含被检查的那个） */
  allAssets: Asset[];
  /** 项目已挂载的能力包 */
  capabilities: LoadedCapabilityInfo[];
  /** 当前被检查的资产；项目级检查时为 undefined */
  asset?: Asset;
  /** 当前资产的内容；二进制资产为 null */
  content?: string | null;
  /** 项目变量（project.vars） */
  vars: Record<string, string>;
  /** 检查单资产 id → 文本内容。由引擎预读注入，检查器不自己读盘。 */
  checklists?: Record<string, string>;
}

export interface LoadedCapabilityInfo {
  manifest: CapabilityPackage;
  vars: VarSpec[];
}

export interface CheckHit {
  message: string;
  field?: string;
  location?: { line?: number; char?: number };
  /** 命中片段，已在引擎侧截断 */
  evidence?: string;
}

export type CheckerFn = (checker: Checker, ctx: CheckContext) => CheckHit[];

/** 需要项目级执行（而不是逐资产执行）的检查器 */
export const PROJECT_SCOPED: ReadonlySet<CheckerType> = new Set<CheckerType>([
  "file-exists",
  "unique-path",
  "project-metadata",
  "capability-compat",
  "checklist-complete",
]);

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

const EVIDENCE_MAX = 200;

export function truncateEvidence(s: string): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > EVIDENCE_MAX ? oneLine.slice(0, EVIDENCE_MAX) + "…" : oneLine;
}

/** 在文本中定位所有匹配，返回行号与片段 */
function locate(content: string, re: RegExp, limit = 5): Array<{
  line: number;
  char: number;
  excerpt: string;
}> {
  const out: Array<{ line: number; char: number; excerpt: string }> = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const line = lines[i];
    // 每条正则都带 g 标志，逐行重置 lastIndex
    const local = new RegExp(re.source, re.flags);
    let m: RegExpExecArray | null;
    while ((m = local.exec(line)) !== null) {
      out.push({ line: i + 1, char: m.index + 1, excerpt: line.slice(0, 200) });
      if (m.index === local.lastIndex) local.lastIndex += 1; // 防空匹配死循环
      if (out.length >= limit) break;
    }
  }

  // 多行模式失败时退化为整体搜索
  if (out.length === 0 && re.multiline) {
    const m = content.match(re);
    if (m) out.push({ line: 1, char: 1, excerpt: m[0].slice(0, 200) });
  }

  return out;
}

function buildRegExp(pattern: string, flags = ""): RegExp {
  const f = flags.includes("g") ? flags : flags + "g";
  return new RegExp(pattern, f);
}

function metaValue(asset: Asset, field: string): unknown {
  return (asset as unknown as Record<string, unknown>)[field];
}

function varsValue(ctx: CheckContext, field: string): unknown {
  return ctx.vars[field];
}

/** 解析 Markdown 复选框：`- [x] 文本` */
export interface ChecklistEntry {
  checked: boolean;
  text: string;
  requiresEvidence: boolean;
}

export function parseChecklist(content: string): ChecklistEntry[] {
  const out: ChecklistEntry[] = [];
  const re = /^\s*[-*]\s*\[([ xX])\]\s*(.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const text = m[2];
    out.push({
      checked: m[1].toLowerCase() === "x",
      text,
      // 约定：以「（需证据）」或 "(evidence)" 结尾的条目要求附证据
      requiresEvidence: /[（(]\s*需证据\s*[)）]|[（(]evidence[)）]/i.test(text),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 元数据类检查器                                                      */
/* ------------------------------------------------------------------ */

const checkRequiredFields: CheckerFn = (checker, ctx) => {
  if (checker.type !== "required-fields") return [];
  const hits: CheckHit[] = [];

  for (const field of checker.fields) {
    const value =
      checker.scope === "vars" ? varsValue(ctx, field) : ctx.asset ? metaValue(ctx.asset, field) : undefined;

    const missing =
      value === undefined ||
      value === null ||
      (typeof value === "string" && value.trim() === "") ||
      (Array.isArray(value) && value.length === 0);

    if (missing) {
      hits.push({
        message: `必填项缺失：${field}`,
        field,
      });
    }
  }
  return hits;
};

const checkFieldPattern: CheckerFn = (checker, ctx) => {
  if (checker.type !== "field-pattern") return [];

  const value =
    checker.scope === "vars" ? varsValue(ctx, checker.field) : ctx.asset ? metaValue(ctx.asset, checker.field) : undefined;

  if (value === undefined || value === null || value === "") return [];

  const text = String(value);
  const re = new RegExp(checker.pattern, checker.flags ?? "");
  if (re.test(text)) return [];

  return [
    {
      message: `字段 ${checker.field} 的值「${truncateEvidence(text)}」不符合格式要求`,
      field: checker.field,
      evidence: truncateEvidence(text),
    },
  ];
};

const checkFieldEnum: CheckerFn = (checker, ctx) => {
  if (checker.type !== "field-enum") return [];

  const value =
    checker.scope === "vars" ? varsValue(ctx, checker.field) : ctx.asset ? metaValue(ctx.asset, checker.field) : undefined;

  if (value === undefined || value === null || value === "") return [];

  const text = String(value);
  if (checker.allowed.includes(text)) return [];

  return [
    {
      message: `字段 ${checker.field} 的值「${text}」不在允许范围内：${checker.allowed.join(" / ")}`,
      field: checker.field,
      evidence: text,
    },
  ];
};

const checkProjectMetadata: CheckerFn = (checker, ctx) => {
  if (checker.type !== "project-metadata") return [];
  const hits: CheckHit[] = [];

  for (const field of checker.fields) {
    const value = (ctx.project as unknown as Record<string, unknown>)[field];
    const missing =
      value === undefined ||
      value === null ||
      (typeof value === "string" && value.trim() === "") ||
      (Array.isArray(value) && value.length === 0);

    if (missing) hits.push({ message: `项目必填项缺失：${field}`, field });
  }
  return hits;
};

/* ------------------------------------------------------------------ */
/* 内容类检查器                                                        */
/* ------------------------------------------------------------------ */

const checkForbiddenContent: CheckerFn = (checker, ctx) => {
  if (checker.type !== "forbidden-content") return [];

  let haystack: string;
  if (checker.scan === "meta") {
    if (!ctx.asset) return [];
    haystack = JSON.stringify({
      name: ctx.asset.name,
      path: ctx.asset.path,
      owner: ctx.asset.owner,
      tags: ctx.asset.tags,
    });
  } else {
    if (ctx.content === null || ctx.content === undefined) return [];
    haystack = ctx.content;
  }

  const hits: CheckHit[] = [];
  for (const pattern of checker.patterns) {
    const re = buildRegExp(pattern, checker.flags ?? "");
    const found = locate(haystack, re);
    for (const f of found) {
      hits.push({
        message: `命中禁止内容：/${pattern}/`,
        location: { line: f.line, char: f.char },
        evidence: truncateEvidence(f.excerpt),
      });
    }
  }
  return hits;
};

const checkFormatValid: CheckerFn = (checker, ctx) => {
  if (checker.type !== "format-valid") return [];
  if (ctx.content === null || ctx.content === undefined) return [];

  if (checker.format === "json") {
    try {
      JSON.parse(ctx.content);
      return [];
    } catch (e) {
      return [{ message: `JSON 语法不合法：${(e as Error).message}` }];
    }
  }

  // markdown：要求至少一个一级或二级标题，否则视为结构缺失
  if (!/^\s*#{1,2}\s+\S/m.test(ctx.content)) {
    return [{ message: "Markdown 文档缺少标题（未找到 # 或 ## 开头的行）" }];
  }
  return [];
};

const checkHeadingStructure: CheckerFn = (checker, ctx) => {
  if (checker.type !== "heading-structure") return [];
  if (ctx.content === null || ctx.content === undefined) return [];

  const headings = Array.from(ctx.content.matchAll(/^\s*(#{1,6})\s+(.+?)\s*$/gm)).map((m) => ({
    level: m[1].length,
    text: m[2].trim(),
  }));

  const hits: CheckHit[] = [];

  if (checker.ordered) {
    let cursor = 0;
    for (const required of checker.requiredHeadings) {
      const idx = headings.findIndex((h, i) => i >= cursor && h.text.includes(required));
      if (idx === -1) {
        hits.push({ message: `缺少必需的章节（或顺序不符）：${required}` });
      } else {
        cursor = idx + 1;
      }
    }
  } else {
    for (const required of checker.requiredHeadings) {
      if (!headings.some((h) => h.text.includes(required))) {
        hits.push({ message: `缺少必需的章节：${required}` });
      }
    }
  }

  return hits;
};

const checkSizeLimit: CheckerFn = (checker, ctx) => {
  if (checker.type !== "size-limit") return [];
  if (!ctx.asset) return [];

  const hits: CheckHit[] = [];
  const size = ctx.asset.size;

  if (checker.minBytes !== undefined && size < checker.minBytes) {
    hits.push({
      message: `文件过小：${size} 字节，低于下限 ${checker.minBytes} 字节`,
      evidence: `size=${size}`,
    });
  }
  if (checker.maxBytes !== undefined && size > checker.maxBytes) {
    hits.push({
      message: `文件过大：${size} 字节，超过上限 ${checker.maxBytes} 字节`,
      evidence: `size=${size}`,
    });
  }
  if (checker.maxLines !== undefined && ctx.content) {
    const lines = ctx.content.split("\n").length;
    if (lines > checker.maxLines) {
      hits.push({
        message: `行数过多：${lines} 行，超过上限 ${checker.maxLines} 行`,
        evidence: `lines=${lines}`,
      });
    }
  }
  return hits;
};

const ajv = new Ajv({ allErrors: true, strict: false });

const checkJsonSchema: CheckerFn = (checker, ctx) => {
  if (checker.type !== "json-schema") return [];
  if (ctx.content === null || ctx.content === undefined) {
    return [{ message: "资产无文本内容，无法做 JSON Schema 校验" }];
  }

  let data: unknown;
  try {
    data = JSON.parse(ctx.content);
  } catch (e) {
    return [{ message: `JSON 语法不合法，无法校验：${(e as Error).message}` }];
  }

  let validate;
  try {
    validate = ajv.compile(checker.schema);
  } catch (e) {
    return [{ message: `规则中的 JSON Schema 本身不合法：${(e as Error).message}` }];
  }

  if (validate(data)) return [];

  return (validate.errors ?? []).slice(0, 20).map((err) => ({
    message: `Schema 校验失败：${err.instancePath || "/"} ${err.message ?? ""}`.trim(),
    field: err.instancePath || undefined,
    evidence: truncateEvidence(JSON.stringify(err.params ?? {})),
  }));
};

/* ------------------------------------------------------------------ */
/* 跨资产 / 项目级检查器                                               */
/* ------------------------------------------------------------------ */

const checkUniquePath: CheckerFn = (_checker, ctx) => {
  const seen = new Map<string, string[]>();
  for (const a of ctx.allAssets) {
    const list = seen.get(a.path) ?? [];
    list.push(a.id);
    seen.set(a.path, list);
  }

  const hits: CheckHit[] = [];
  for (const [path, ids] of seen) {
    if (ids.length > 1) {
      hits.push({
        message: `路径重复：${path} 被 ${ids.length} 个资产占用`,
        field: path,
        evidence: ids.join(", "),
      });
    }
  }
  return hits;
};

const checkFileExists: CheckerFn = (checker, ctx) => {
  if (checker.type !== "file-exists") return [];

  const paths = ctx.allAssets.map((a) => a.path);
  const hits: CheckHit[] = [];

  // 每个 glob 都必须至少命中一个 —— 这是"齐套性"的本意：列出来的都要有
  for (const glob of checker.globs) {
    const matches = paths.filter((p) => matchGlob(p, glob));
    if (matches.length === 0) {
      hits.push({
        message: `缺少必需的交付物：${glob}`,
        field: glob,
      });
    }
  }

  // atLeast 约束的是**所有 glob 合计**的命中总数，不是单个 glob
  if (checker.atLeast !== undefined) {
    const total = new Set(
      paths.filter((p) => checker.globs.some((g) => matchGlob(p, g)))
    ).size;
    if (total < checker.atLeast) {
      hits.push({
        message:
          `交付物不齐：共匹配到 ${total} 个，要求至少 ${checker.atLeast} 个` +
          `（涉及：${checker.globs.join("、")}）`,
        evidence: `total=${total}`,
      });
    }
  }

  return hits;
};

const checkCapabilityCompat: CheckerFn = (checker, ctx) => {
  if (checker.type !== "capability-compat") return [];

  const targets = checker.packageId
    ? ctx.capabilities.filter((c) => c.manifest.id === checker.packageId)
    : ctx.capabilities;

  const hits: CheckHit[] = [];

  for (const cap of targets) {
    for (const spec of cap.vars) {
      if (!spec.required) continue;
      const value = ctx.vars[spec.key] ?? spec.default;
      if (value === undefined || value === null || String(value).trim() === "") {
        hits.push({
          message: `能力包「${cap.manifest.name}」要求变量 ${spec.key}（${spec.label}）必须有值`,
          field: spec.key,
        });
        continue;
      }
      if (spec.type === "enum" && spec.allowed && !spec.allowed.includes(String(value))) {
        hits.push({
          message: `变量 ${spec.key} 的值「${value}」不在允许范围内：${spec.allowed.join(" / ")}`,
          field: spec.key,
          evidence: String(value),
        });
      }
    }
  }
  return hits;
};

const checkChecklistComplete: CheckerFn = (checker, ctx) => {
  if (checker.type !== "checklist-complete") return [];

  const target = ctx.allAssets.find((a) => a.path === checker.path);
  if (!target) {
    return [{ message: `检查单资产不存在：${checker.path}` }];
  }

  // 内容由引擎注入到 ctx.checklists，避免检查器直接读文件
  const content = ctx.checklists?.[target.id];
  if (content === undefined) {
    return [{ message: `无法读取检查单内容：${checker.path}` }];
  }

  const entries = parseChecklist(content);
  if (entries.length === 0) {
    return [{ message: `检查单 ${checker.path} 中没有任何「- [ ]」条目` }];
  }

  const hits: CheckHit[] = [];
  const unchecked = entries.filter((e) => !e.checked);
  if (unchecked.length > 0) {
    hits.push({
      message: `检查单 ${checker.path} 有 ${unchecked.length}/${entries.length} 项未勾选`,
      field: checker.path,
      evidence: truncateEvidence(unchecked.map((e) => e.text).join("；")),
    });
  }

  if (checker.requireEvidence) {
    const noEvidence = entries.filter((e) => e.requiresEvidence && !e.checked);
    for (const e of noEvidence) {
      hits.push({
        message: `检查单条目要求证据但未勾选：${e.text}`,
        field: checker.path,
        evidence: truncateEvidence(e.text),
      });
    }
  }

  return hits;
};

/** 资产正文里引用的其他资产：`[[asset:路径]]` */
const REFERENCE_RE = /\[\[asset:([^\]\s]+)\]\]/g;

export function extractReferences(content: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(REFERENCE_RE.source, "g");
  while ((m = re.exec(content)) !== null) out.push(m[1]);
  return out;
}

const checkReferenceIntegrity: CheckerFn = (checker, ctx) => {
  if (checker.type !== "reference-integrity") return [];
  if (ctx.content === null || ctx.content === undefined) return [];

  const refs = extractReferences(ctx.content);
  if (refs.length === 0) return [];

  const byPath = new Map(ctx.allAssets.map((a) => [a.path, a]));
  const byId = new Map(ctx.allAssets.map((a) => [a.id, a]));

  const hits: CheckHit[] = [];
  for (const ref of refs) {
    const isExternal = /^https?:\/\//i.test(ref);
    if (isExternal) {
      if (!checker.allowExternal) {
        hits.push({
          message: `不接受外部引用：${ref}`,
          evidence: truncateEvidence(ref),
        });
      }
      continue;
    }
    if (!byPath.has(ref) && !byId.has(ref)) {
      hits.push({
        message: `引用的资产不存在：${ref}`,
        field: ref,
        evidence: truncateEvidence(ref),
      });
    }
  }
  return hits;
};

/* ------------------------------------------------------------------ */
/* 注册表                                                              */
/* ------------------------------------------------------------------ */

export const CHECKERS: Record<CheckerType, CheckerFn> = {
  "required-fields": checkRequiredFields,
  "field-pattern": checkFieldPattern,
  "field-enum": checkFieldEnum,
  "forbidden-content": checkForbiddenContent,
  "file-exists": checkFileExists,
  "checklist-complete": checkChecklistComplete,
  "reference-integrity": checkReferenceIntegrity,
  "json-schema": checkJsonSchema,
  "size-limit": checkSizeLimit,
  "capability-compat": checkCapabilityCompat,
  "unique-path": checkUniquePath,
  "format-valid": checkFormatValid,
  "heading-structure": checkHeadingStructure,
  "project-metadata": checkProjectMetadata,
};

