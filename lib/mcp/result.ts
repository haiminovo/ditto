/**
 * Ditto 实施平台 - MCP 工具返回值
 *
 * 两条约定：
 *
 * 1. **业务错误返回 isError，不抛异常。**
 *    抛出去会变成 JSON-RPC 协议错误，客户端往往只看到一句笼统的失败；
 *    返回 isError 则能把 E_GATE_BLOCKED 的规则清单、缺哪些变量这些
 *    可操作信息原样带给 AI，它才知道下一步该改什么。
 *
 * 2. **返回中文文本，不返回裸 JSON。**
 *    工具结果会直接进模型上下文，结构化文本比转义后的 JSON 更好读、
 *    更省 token，也更容易让模型抓到重点。
 */

import { isCoreError, asCoreError } from "../core/errors";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

export function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function okJson(text: string, structured: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: structured,
  };
}

/**
 * 把 CoreError 翻译成可操作的错误结果。
 * code 与 details 都带上 —— 调用方（AI 或人）需要它们来定位问题。
 */
export function fail(error: unknown): ToolResult {
  const e = isCoreError(error) ? error : asCoreError(error, "E_INVALID");

  const lines = [`【${e.code}】${e.message}`];

  if (e.details && Object.keys(e.details).length > 0) {
    lines.push("", "详情：");
    lines.push(formatDetails(e.details));
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    isError: true,
  };
}

function formatDetails(details: Record<string, unknown>): string {
  return Object.entries(details)
    .map(([k, v]) => {
      if (Array.isArray(v)) {
        if (v.length === 0) return `  ${k}: （无）`;
        return `  ${k}:\n${v.map((item) => `    · ${renderItem(item)}`).join("\n")}`;
      }
      return `  ${k}: ${renderItem(v)}`;
    })
    .join("\n");
}

function renderItem(v: unknown): string {
  if (v === null || v === undefined) return "（空）";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 0);
  } catch {
    return String(v);
  }
}

/**
 * 包装工具处理函数：统一错误处理。
 * 所有工具的 handler 都用这个包一层，避免每处都写 try/catch。
 */
export function handle<A>(
  fn: (args: A) => ToolResult | Promise<ToolResult>
): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(e);
    }
  };
}

/* ------------------------------------------------------------------ */
/* 文本渲染辅助                                                        */
/* ------------------------------------------------------------------ */

/** 渲染一个「键: 值」表格 */
export function field(label: string, value: unknown): string {
  return `  ${label}：${value === undefined || value === null || value === "" ? "（无）" : value}`;
}

export function bullet(text: string): string {
  return `  · ${text}`;
}

export function heading(text: string): string {
  return `\n${text}`;
}

/** 把列表渲染成「- 项」形式，空列表给出明确说明 */
export function list(items: string[], emptyText = "（无）"): string {
  if (items.length === 0) return `  ${emptyText}`;
  return items.map((i) => `  · ${i}`).join("\n");
}

export function truncate(text: string, max = 400): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n…（已截断，共 ${text.length} 字符）`;
}
