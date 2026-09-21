/**
 * Ditto 实施平台 - 错误分类
 *
 * 领域层只抛 CoreError。MCP 适配层把它翻译成工具错误，
 * 控制台适配层把它翻译成表单提示 —— 两边共用同一套 code。
 */

export type CoreErrorCode =
  // 通用
  | "E_NOT_FOUND"
  | "E_INVALID"
  | "E_CONFLICT"
  | "E_IO"
  // 资产与项目
  | "E_ASSET_LOCKED"
  | "E_PATH_ESCAPE"
  | "E_PATH_DUPLICATE"
  | "E_STATUS_TRANSITION"
  // 规则与闸门
  | "E_RULE_FORBIDDEN_KEY"
  | "E_RULE_INVALID"
  | "E_RUN_STALE"
  | "E_WAIVER_REQUIRED"
  | "E_GATE_BLOCKED"
  | "E_APPROVAL_FORBIDDEN"
  // 能力包与模板
  | "E_CAPABILITY_NOT_FOUND"
  | "E_CAPABILITY_INVALID"
  | "E_TEMPLATE_NOT_FOUND"
  | "E_RENDER_MISSING_VARS"
  | "E_RENDER_SYNTAX";

export class CoreError extends Error {
  readonly code: CoreErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: CoreErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "CoreError";
    this.code = code;
    this.details = details;
  }

  /** 面向 AI 客户端与控制台的中文单行描述 */
  toDisplay(): string {
    return `[${this.code}] ${this.message}`;
  }
}

export function isCoreError(e: unknown): e is CoreError {
  return e instanceof CoreError;
}

/** 把任意抛出物转成 CoreError，保留原始信息 */
export function asCoreError(e: unknown, fallbackCode: CoreErrorCode = "E_IO"): CoreError {
  if (isCoreError(e)) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new CoreError(fallbackCode, message);
}

export function notFound(what: string, id: string): CoreError {
  return new CoreError("E_NOT_FOUND", `未找到${what}：${id}`, { what, id });
}

export function invalid(message: string, details?: Record<string, unknown>): CoreError {
  return new CoreError("E_INVALID", message, details);
}

export function conflict(message: string, details?: Record<string, unknown>): CoreError {
  return new CoreError("E_CONFLICT", message, details);
}
