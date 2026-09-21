/**
 * Ditto 实施平台 - 规则包校验
 *
 * 规则是**数据**，来自工作区 JSON 文件 —— 也就是 AI 客户端和用户都能写的输入。
 * 因此这里必须回答一个问题：什么样的规则数据是安全的？
 *
 *   1. 硬禁可执行键（code / script / fn / source / eval / body ...）
 *      —— 引擎里没有 eval / new Function，也绝不允许规则数据诱导出来。
 *   2. 限制体积与正则长度。
 *   3. 正则复杂度守卫：拒绝嵌套量词这类容易造成 ReDoS 的写法。
 *      —— 声明式不等于安全：正则本身就是一台可被引爆的状态机。
 *
 * 手写类型守卫，不引 zod（zod 只用在 MCP 工具入参边界）。
 */

import { CoreError, invalid } from "../core/errors";
import {
  ASSET_FORMATS,
  ASSET_KINDS,
  SEVERITIES,
  type Checker,
  type Rule,
  type RulePack,
  type Severity,
} from "../core/types";

/** 一旦出现这些键，规则包被拒绝加载 */
export const FORBIDDEN_RULE_KEYS = [
  "code",
  "script",
  "fn",
  "func",
  "source",
  "eval",
  "body",
  "exec",
  "require",
  "import",
  "lambda",
] as const;

export const LIMITS = {
  maxRulePackBytes: 512 * 1024,
  maxRulesPerPack: 500,
  maxPatternLength: 500,
  maxPatternsPerRule: 100,
  maxGlobsPerRule: 200,
} as const;

/* ------------------------------------------------------------------ */
/* 深层禁用键扫描                                                      */
/* ------------------------------------------------------------------ */

/**
 * 不扫描的子树：`checker.schema` 是交给 ajv 的 JSON Schema 载荷。
 *
 * 它是**纯数据**，不是规则结构 —— 里面的 `properties.code` / `properties.source`
 * 是业务字段名，不是代码字段。把结构守卫套到载荷上会造出莫名其妙的误报，
 * 而误报会让人干脆把守卫关掉，那才是真正的损失。
 *
 * 扫描的是规则结构：`checker.type`、`checker.pattern` 这些将来可能被
 * 某个新检查器解释成行为的字段。
 */
const OPAQUE_SUBTREES = [".checker.schema"];

/**
 * 递归扫描任意 JSON 值，发现禁用键即抛错。
 * 不只查顶层 —— 藏在 checker 里的 `{"fn": "..."}` 同样要拦。
 */
export function assertNoExecutableKeys(value: unknown, pathLabel = "规则包"): void {
  const walk = (node: unknown, trail: string) => {
    if (node === null || typeof node !== "object") return;

    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${trail}[${i}]`));
      return;
    }

    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const nextTrail = `${trail}.${key}`;

      if (OPAQUE_SUBTREES.some((suffix) => nextTrail.endsWith(suffix))) continue;

      if ((FORBIDDEN_RULE_KEYS as readonly string[]).includes(key.toLowerCase())) {
        throw new CoreError(
          "E_RULE_FORBIDDEN_KEY",
          `${pathLabel}在 ${nextTrail} 处包含可执行键「${key}」。` +
            `规则必须是纯声明式数据，不接受任何代码字段。`,
          { key, path: nextTrail }
        );
      }
      walk(child, nextTrail);
    }
  };

  walk(value, "root");
}

/* ------------------------------------------------------------------ */
/* 正则复杂度守卫                                                      */
/* ------------------------------------------------------------------ */

/**
 * 拒绝嵌套量词：形如 (a+)+ / (a*)* / (.*)* —— 经典的指数级回溯。
 *
 * 诚实标注局限：这是启发式，不是完备的 ReDoS 检测器。
 * 真正的兜底是 maxPatternLength 与规则包的审查流程。
 */
export function assertSafePattern(pattern: string, label: string): void {
  if (pattern.length > LIMITS.maxPatternLength) {
    throw new CoreError(
      "E_RULE_INVALID",
      `${label} 的正则过长（${pattern.length} > ${LIMITS.maxPatternLength}）`
    );
  }

  // 组内含量词，且该组本身又被量词修饰
  const nestedQuantifier = /\([^)]*[*+][^)]*\)\s*[*+{]/;
  if (nestedQuantifier.test(pattern)) {
    throw new CoreError(
      "E_RULE_INVALID",
      `${label} 的正则含嵌套量词，可能造成指数级回溯（ReDoS）：${pattern}`,
      { pattern }
    );
  }

  // 顶层也拒绝 `(a|aa)+` 这类高危交替叠加量词
  const alternationQuantified = /\([^)]*\|[^)]*\)\s*[+*]/;
  if (alternationQuantified.test(pattern) && /[+*]\s*\)/.test(pattern)) {
    throw new CoreError(
      "E_RULE_INVALID",
      `${label} 的正则含「交替 + 量词」嵌套，可能造成灾难性回溯：${pattern}`,
      { pattern }
    );
  }

  try {
    new RegExp(pattern);
  } catch (e) {
    throw invalid(`${label} 的正则无法编译：${(e as Error).message}`, { pattern });
  }
}

/* ------------------------------------------------------------------ */
/* 类型守卫                                                            */
/* ------------------------------------------------------------------ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireString(v: unknown, label: string): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw invalid(`${label} 必须是非空字符串`);
  }
  return v;
}

function requireStringArray(v: unknown, label: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw invalid(`${label} 必须是字符串数组`);
  }
  return v as string[];
}

function requireSeverity(v: unknown, label: string): Severity {
  if (typeof v !== "string" || !(SEVERITIES as readonly string[]).includes(v)) {
    throw invalid(`${label} 必须是 error / warn / info 之一，收到：${String(v)}`);
  }
  return v as Severity;
}

/* ------------------------------------------------------------------ */
/* checker 校验                                                        */
/* ------------------------------------------------------------------ */

const CHECKER_TYPES = [
  "required-fields",
  "field-pattern",
  "field-enum",
  "forbidden-content",
  "file-exists",
  "checklist-complete",
  "reference-integrity",
  "json-schema",
  "size-limit",
  "capability-compat",
  "unique-path",
  "format-valid",
  "heading-structure",
  "project-metadata",
] as const;

function parseChecker(raw: unknown, ruleId: string): Checker {
  if (!isRecord(raw)) throw invalid(`规则 ${ruleId} 的 checker 必须是对象`);
  const type = requireString(raw.type, `规则 ${ruleId} 的 checker.type`);

  if (!(CHECKER_TYPES as readonly string[]).includes(type)) {
    throw invalid(
      `规则 ${ruleId} 使用了未知的检查器「${type}」。可用：${CHECKER_TYPES.join(", ")}`
    );
  }

  const label = `规则 ${ruleId}`;

  switch (type) {
    case "required-fields": {
      const fields = requireStringArray(raw.fields, `${label} 的 fields`);
      const scope = raw.scope === "vars" ? "vars" : "meta";
      return { type, fields, scope };
    }
    case "field-pattern": {
      const pattern = requireString(raw.pattern, `${label} 的 pattern`);
      assertSafePattern(pattern, label);
      const field = requireString(raw.field, `${label} 的 field`);
      const flags = typeof raw.flags === "string" ? raw.flags : undefined;
      const scope = raw.scope === "vars" ? "vars" : "meta";
      return { type, field, pattern, flags, scope };
    }
    case "field-enum": {
      const field = requireString(raw.field, `${label} 的 field`);
      const allowed = requireStringArray(raw.allowed, `${label} 的 allowed`);
      const scope = raw.scope === "vars" ? "vars" : "meta";
      return { type, field, allowed, scope };
    }
    case "forbidden-content": {
      const patterns = requireStringArray(raw.patterns, `${label} 的 patterns`);
      if (patterns.length > LIMITS.maxPatternsPerRule) {
        throw invalid(`${label} 的 patterns 超过 ${LIMITS.maxPatternsPerRule} 条`);
      }
      patterns.forEach((p, i) => assertSafePattern(p, `${label} patterns[${i}]`));
      const flags = typeof raw.flags === "string" ? raw.flags : undefined;
      const scan = raw.scan === "meta" ? "meta" : "content";
      return { type, patterns, flags, scan };
    }
    case "file-exists": {
      const globs = requireStringArray(raw.globs, `${label} 的 globs`);
      if (globs.length > LIMITS.maxGlobsPerRule) {
        throw invalid(`${label} 的 globs 超过 ${LIMITS.maxGlobsPerRule} 条`);
      }
      const atLeast =
        typeof raw.atLeast === "number" && raw.atLeast > 0 ? raw.atLeast : undefined;
      return { type, globs, atLeast };
    }
    case "checklist-complete": {
      const path = requireString(raw.path, `${label} 的 path`);
      const requireEvidence = raw.requireEvidence === true ? true : undefined;
      return { type, path, requireEvidence };
    }
    case "reference-integrity":
      return { type, allowExternal: raw.allowExternal === true };
    case "json-schema": {
      if (!isRecord(raw.schema)) throw invalid(`${label} 的 schema 必须是对象`);
      return { type, schema: raw.schema };
    }
    case "size-limit": {
      const num = (k: string) => (typeof raw[k] === "number" ? (raw[k] as number) : undefined);
      const out: Checker = {
        type,
        minBytes: num("minBytes"),
        maxBytes: num("maxBytes"),
        maxLines: num("maxLines"),
      };
      if (!out.minBytes && !out.maxBytes && !out.maxLines) {
        throw invalid(`${label} 的 size-limit 至少要给出 minBytes / maxBytes / maxLines 之一`);
      }
      return out;
    }
    case "capability-compat": {
      const packageId = typeof raw.packageId === "string" ? raw.packageId : undefined;
      return { type, packageId };
    }
    case "unique-path":
      return { type };
    case "format-valid": {
      const format = raw.format === "json" ? "json" : "markdown";
      return { type, format };
    }
    case "heading-structure": {
      const requiredHeadings = requireStringArray(
        raw.requiredHeadings,
        `${label} 的 requiredHeadings`
      );
      return { type, requiredHeadings, ordered: raw.ordered === true };
    }
    case "project-metadata": {
      const fields = requireStringArray(raw.fields, `${label} 的 fields`);
      return { type, fields };
    }
    default:
      throw invalid(`未实现的检查器：${type}`);
  }
}

/* ------------------------------------------------------------------ */
/* Rule / RulePack 校验                                                */
/* ------------------------------------------------------------------ */

function parseRule(raw: unknown, index: number, packId: string): Rule {
  if (!isRecord(raw)) throw invalid(`规则包 ${packId} 的第 ${index} 条规则不是对象`);

  const id = requireString(raw.id, `规则包 ${packId} 第 ${index} 条规则的 id`);
  const name = requireString(raw.name, `规则 ${id} 的 name`);
  const severity = requireSeverity(raw.severity, `规则 ${id} 的 severity`);

  const appliesRaw = isRecord(raw.appliesTo) ? raw.appliesTo : {};
  const appliesTo: Rule["appliesTo"] = {};

  if (appliesRaw.kinds !== undefined) {
    const kinds = requireStringArray(appliesRaw.kinds, `规则 ${id} 的 appliesTo.kinds`);
    for (const k of kinds) {
      if (!(ASSET_KINDS as readonly string[]).includes(k)) {
        throw invalid(`规则 ${id} 的 appliesTo.kinds 含未知类型：${k}`);
      }
    }
    appliesTo.kinds = kinds as Rule["appliesTo"]["kinds"];
  }
  if (appliesRaw.formats !== undefined) {
    const formats = requireStringArray(appliesRaw.formats, `规则 ${id} 的 appliesTo.formats`);
    for (const f of formats) {
      if (!(ASSET_FORMATS as readonly string[]).includes(f)) {
        throw invalid(`规则 ${id} 的 appliesTo.formats 含未知格式：${f}`);
      }
    }
    appliesTo.formats = formats as Rule["appliesTo"]["formats"];
  }
  if (appliesRaw.paths !== undefined) {
    appliesTo.paths = requireStringArray(appliesRaw.paths, `规则 ${id} 的 appliesTo.paths`);
  }

  return {
    id,
    name,
    description: typeof raw.description === "string" ? raw.description : undefined,
    severity,
    enabled: raw.enabled !== false,
    appliesTo,
    checker: parseChecker(raw.checker, id),
    remediation: typeof raw.remediation === "string" ? raw.remediation : undefined,
  };
}

export function parseRulePack(raw: unknown, sourceLabel = "规则包"): RulePack {
  if (!isRecord(raw)) throw invalid(`${sourceLabel} 不是对象`);

  // 先拦可执行键，再谈结构
  assertNoExecutableKeys(raw, sourceLabel);

  const id = requireString(raw.id, `${sourceLabel} 的 id`);
  const name = requireString(raw.name, `${sourceLabel} 的 name`);
  const version = typeof raw.version === "string" ? raw.version : "1.0.0";

  if (!Array.isArray(raw.rules)) {
    throw invalid(`规则包 ${id} 的 rules 必须是数组`);
  }
  if (raw.rules.length > LIMITS.maxRulesPerPack) {
    throw invalid(`规则包 ${id} 的规则数超过上限 ${LIMITS.maxRulesPerPack}`);
  }

  let blockingSeverities: Severity[] | undefined;
  if (raw.blockingSeverities !== undefined) {
    blockingSeverities = requireStringArray(
      raw.blockingSeverities,
      `规则包 ${id} 的 blockingSeverities`
    ).map((s, i) => requireSeverity(s, `规则包 ${id} 的 blockingSeverities[${i}]`));
  }

  const seen = new Set<string>();
  const rules = raw.rules.map((r, i) => {
    const rule = parseRule(r, i, id);
    if (seen.has(rule.id)) {
      throw invalid(`规则包 ${id} 中存在重复的规则 id：${rule.id}`);
    }
    seen.add(rule.id);
    return rule;
  });

  return {
    schemaVersion: 1,
    id,
    name,
    version,
    description: typeof raw.description === "string" ? raw.description : undefined,
    blockingSeverities,
    rules,
  };
}

/** 校验规则包文本，同时施加体积上限 */
export function parseRulePackJson(text: string, sourceLabel: string): RulePack {
  if (text.length > LIMITS.maxRulePackBytes) {
    throw invalid(
      `${sourceLabel} 超过体积上限（${text.length} > ${LIMITS.maxRulePackBytes} 字节）`
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw invalid(`${sourceLabel} 不是合法 JSON：${(e as Error).message}`);
  }
  return parseRulePack(raw, sourceLabel);
}
