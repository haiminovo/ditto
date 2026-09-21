/**
 * Ditto 实施平台 - 模板渲染
 *
 * 手写，零依赖。支持：
 *   {{key}}                        变量替换
 *   {{#if key}}…{{else}}…{{/if}}
 *   {{#unless key}}…{{/unless}}
 *   {{#each key}}…{{this}}…{{@index}}…{{/each}}
 *   {{date}} / {{date:YYYY-MM-DD}} 内置日期
 *
 * 两条不可让步的性质：
 *
 * 1. **未知变量绝不静默留空** —— 一次性收集全部缺失键并抛错。
 *    静默留空会让「客户名称」变成空白永远流到交付物里，比报错危险得多。
 *
 * 2. **按目标格式转义** —— 这是本模块的安全要点。
 *    markdown/text 原样；json 做 JSON 字符串转义；shell 做 POSIX 单引号转义。
 *    没有这层，客户名填 `; rm -rf /` 就会原样落进 deploy.sh 并被执行。
 *
 *    关于 shell 的取舍：我们**总是**把值转义成一个单引号包裹的独立词。
 *    这意味着模板里应把占位符当作独立 token 使用（`NAME={{x}}`），
 *    若写成 `"{{x}}"` 会得到 `"'值'"` —— 多一层引号（观感瑕疵，但安全）。
 *    反过来（只转义双引号内的元字符）会让 `NAME={{x}}` 这种裸 token 位置
 *    仍然可被 `;` `|` 注入，那是真正的漏洞。观感瑕疵换注入免疫，这个交换值。
 */

import { CoreError, invalid } from "../core/errors";
import type { AssetFormat } from "../core/types";

/* ------------------------------------------------------------------ */
/* 语法树                                                              */
/* ------------------------------------------------------------------ */

type Node =
  | { type: "text"; value: string }
  | { type: "var"; key: string; dateFormat?: string }
  | { type: "if"; key: string; then: Node[]; otherwise: Node[] }
  | { type: "unless"; key: string; body: Node[] }
  | { type: "each"; key: string; body: Node[] };

const TAG_RE = /\{\{([\s\S]*?)\}\}/g;

class Parser {
  private pos = 0;
  private readonly tokens: Array<{ kind: "text" | "tag"; value: string }>;

  constructor(template: string) {
    this.tokens = tokenize(template);
  }

  parseBlock(stopTags: string[]): Node[] {
    const nodes: Node[] = [];

    while (this.pos < this.tokens.length) {
      const token = this.tokens[this.pos];

      if (token.kind === "text") {
        nodes.push({ type: "text", value: token.value });
        this.pos += 1;
        continue;
      }

      const tag = token.value.trim();

      if (stopTags.includes(tag)) return nodes;

      if (tag.startsWith("#if ")) {
        this.pos += 1;
        const then = this.parseBlock(["else", "/if"]);
        let otherwise: Node[] = [];
        if (this.tokens[this.pos]?.value.trim() === "else") {
          this.pos += 1;
          otherwise = this.parseBlock(["/if"]);
        }
        this.expect("/if");
        nodes.push({ type: "if", key: tag.slice(4).trim(), then, otherwise });
        continue;
      }

      if (tag.startsWith("#unless ")) {
        this.pos += 1;
        const body = this.parseBlock(["/unless"]);
        this.expect("/unless");
        nodes.push({ type: "unless", key: tag.slice(8).trim(), body });
        continue;
      }

      if (tag.startsWith("#each ")) {
        this.pos += 1;
        const body = this.parseBlock(["/each"]);
        this.expect("/each");
        nodes.push({ type: "each", key: tag.slice(6).trim(), body });
        continue;
      }

      if (tag.startsWith("#") || tag.startsWith("/")) {
        throw new CoreError("E_RENDER_SYNTAX", `模板标签无法识别：{{${tag}}}`);
      }

      // 普通变量
      this.pos += 1;
      const [key, dateFormat] = splitKey(tag);
      nodes.push({ type: "var", key, dateFormat });
    }

    return nodes;
  }

  private expect(tag: string): void {
    const token = this.tokens[this.pos];
    if (!token || token.value.trim() !== tag) {
      throw new CoreError(
        "E_RENDER_SYNTAX",
        `模板标签未闭合：期望 {{${tag}}}，实际到末尾或遇到 {{${token?.value ?? ""}}}`
      );
    }
    this.pos += 1;
  }
}

function tokenize(template: string): Array<{ kind: "text" | "tag"; value: string }> {
  const tokens: Array<{ kind: "text" | "tag"; value: string }> = [];
  let last = 0;
  const re = new RegExp(TAG_RE.source, "g");
  let m: RegExpExecArray | null;

  while ((m = re.exec(template)) !== null) {
    if (m.index > last) {
      tokens.push({ kind: "text", value: template.slice(last, m.index) });
    }
    tokens.push({ kind: "tag", value: m[1] });
    last = m.index + m[0].length;
  }

  if (last < template.length) {
    tokens.push({ kind: "text", value: template.slice(last) });
  }

  return tokens;
}

function splitKey(tag: string): [string, string | undefined] {
  const idx = tag.indexOf(":");
  if (idx === -1) return [tag, undefined];
  return [tag.slice(0, idx).trim(), tag.slice(idx + 1).trim()];
}

/* ------------------------------------------------------------------ */
/* 求值                                                                */
/* ------------------------------------------------------------------ */

export interface RenderScope {
  vars: Record<string, string>;
  /** 内置日期，注入以便测试确定化 */
  now?: Date;
}

const MISSING = Symbol("missing");

function resolve(scope: RenderScope, key: string): string | typeof MISSING {
  if (key === "date" || key.startsWith("date:")) {
    return formatDate(scope.now ?? new Date(), key);
  }
  const value = scope.vars[key];
  if (value === undefined || value === null) return MISSING;
  return String(value);
}

function formatDate(date: Date, key: string): string {
  const idx = key.indexOf(":");
  if (idx === -1) return date.toISOString().slice(0, 10);

  const pattern = key.slice(idx + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = date.getUTCFullYear();
  const mo = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const h = pad(date.getUTCHours());
  const mi = pad(date.getUTCMinutes());
  const s = pad(date.getUTCSeconds());

  return pattern
    .replace(/YYYY/g, String(y))
    .replace(/MM/g, mo)
    .replace(/DD/g, d)
    .replace(/HH/g, h)
    .replace(/mm/g, mi)
    .replace(/SS/g, s);
}

interface EvalState {
  missing: Set<string>;
  /** each 循环内的局部变量 */
  locals: Record<string, string>;
}

function valueOf(scope: RenderScope, state: EvalState, key: string): string | typeof MISSING {
  if (key === "this") return state.locals["this"] ?? MISSING;
  if (key === "@index") return state.locals["@index"] ?? MISSING;
  if (state.locals[key] !== undefined) return state.locals[key];
  return resolve(scope, key);
}

function evalNodes(nodes: Node[], scope: RenderScope, state: EvalState, format: AssetFormat): string {
  let out = "";

  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out += node.value;
        break;

      case "var": {
        const value = valueOf(scope, state, node.key);
        if (value === MISSING) {
          state.missing.add(node.key);
          break;
        }
        out += escapeFor(format, value);
        break;
      }

      case "if": {
        const value = valueOf(scope, state, node.key);
        const truthy = value !== MISSING && value !== "" && value !== "false" && value !== "0";
        out += truthy
          ? evalNodes(node.then, scope, state, format)
          : evalNodes(node.otherwise, scope, state, format);
        break;
      }

      case "unless": {
        const value = valueOf(scope, state, node.key);
        const truthy = value !== MISSING && value !== "" && value !== "false" && value !== "0";
        if (!truthy) out += evalNodes(node.body, scope, state, format);
        break;
      }

      case "each": {
        const raw = valueOf(scope, state, node.key);
        if (raw === MISSING) {
          state.missing.add(node.key);
          break;
        }
        const items = String(raw)
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "");

        items.forEach((item, index) => {
          const saved = { ...state.locals };
          state.locals["this"] = item;
          state.locals["@index"] = String(index);
          out += evalNodes(node.body, scope, state, format);
          state.locals = saved;
        });
        break;
      }
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* 按格式转义                                                          */
/* ------------------------------------------------------------------ */

export function escapeFor(format: AssetFormat, value: string): string {
  switch (format) {
    case "json":
      // JSON.stringify 的引号内内容，正好可以直接嵌进模板的字符串里
      return JSON.stringify(value).slice(1, -1);

    case "shell":
      return shellQuote(value);

    case "sql":
      return value.replace(/'/g, "''");

    case "markdown":
    case "yaml":
    case "text":
    case "binary":
    default:
      return value;
  }
}

/** POSIX 单引号转义：把值变成恰好一个 shell 词 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

export interface RenderInput {
  template: string;
  format: AssetFormat;
  vars: Record<string, string>;
  now?: Date;
  /** 出错时用于定位的模板名 */
  label?: string;
}

export interface RenderResult {
  content: string;
  /** 模板里出现过、但作用域里没有的键 */
  missingKeys: string[];
}

/**
 * 渲染。缺失变量时抛 E_RENDER_MISSING_VARS 并在 details 里列出全部缺失键
 * —— 一次报全，不要让调用方改一个报一个。
 */
export function render(input: RenderInput): string {
  const result = renderSafe(input);
  if (result.missingKeys.length > 0) {
    const where = input.label ? `模板「${input.label}」` : "模板";
    throw new CoreError(
      "E_RENDER_MISSING_VARS",
      `${where}缺少变量：${result.missingKeys.join(", ")}。` +
        `请在项目变量或渲染参数中补齐后重试。`,
      { missingKeys: result.missingKeys, label: input.label }
    );
  }
  return result.content;
}

/** 不抛错的版本，返回缺失键供调用方自己决定 */
export function renderSafe(input: RenderInput): RenderResult {
  let ast: Node[];
  try {
    const parser = new Parser(input.template);
    ast = parser.parseBlock([]);
  } catch (e) {
    if (e instanceof CoreError) throw e;
    throw invalid(`模板解析失败：${(e as Error).message}`);
  }

  const state: EvalState = { missing: new Set(), locals: {} };
  const content = evalNodes(ast, { vars: input.vars, now: input.now }, state, input.format);

  return { content, missingKeys: Array.from(state.missing).sort() };
}

/** 从模板中提取全部占位符键名（用于能力包校验与表单预填） */
export function extractPlaceholders(template: string): string[] {
  const keys = new Set<string>();
  const re = new RegExp(TAG_RE.source, "g");
  let m: RegExpExecArray | null;

  while ((m = re.exec(template)) !== null) {
    const tag = m[1].trim();
    if (tag.startsWith("/") || tag === "else") continue;

    let key = tag;
    if (tag.startsWith("#if ")) key = tag.slice(4).trim();
    else if (tag.startsWith("#unless ")) key = tag.slice(8).trim();
    else if (tag.startsWith("#each ")) key = tag.slice(6).trim();
    else if (tag.startsWith("#")) continue;

    const [name] = splitKey(key);
    if (name && name !== "this" && name !== "@index" && !name.startsWith("date")) {
      keys.add(name);
    }
  }

  return Array.from(keys).sort();
}

/** 判断模板是否引用了某个键 */
export function templateUsesKey(template: string, key: string): boolean {
  return extractPlaceholders(template).includes(key);
}

/** 渲染 targetPath（只允许路径安全的变量） */
export function renderPath(
  targetPath: string,
  vars: Record<string, string>,
  label: string
): string {
  const rendered = renderSafe({ template: targetPath, format: "text", vars, label });
  if (rendered.missingKeys.length > 0) {
    throw new CoreError(
      "E_RENDER_MISSING_VARS",
      `模板路径「${targetPath}」缺少变量：${rendered.missingKeys.join(", ")}`,
      { missingKeys: rendered.missingKeys }
    );
  }
  return rendered.content;
}
