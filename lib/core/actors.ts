/**
 * Ditto 实施平台 - 操作者构造
 *
 * ⚠️ 诚实边界：actor 全部是**自报**的，这不是身份认证，不构成安全边界。
 *    它的作用是留痕与流程约束。真正的鉴权（MCP OAuth / 反向代理 SSO）
 *    不在本期范围。
 *
 * 本文件不碰 fs，纯计算。
 */

import type { Actor } from "./types";

export const SYSTEM_ACTOR: Actor = {
  type: "system",
  id: "system:core",
  name: "系统",
  via: "cli",
};

export const CONSOLE_ACTOR: Actor = {
  type: "human",
  id: "console:local",
  name: "本地用户",
  via: "console",
};

/** 控制台操作者：允许表单覆盖展示名 */
export function consoleActor(name?: string): Actor {
  const trimmed = name?.trim();
  return trimmed ? { ...CONSOLE_ACTOR, name: trimmed } : CONSOLE_ACTOR;
}

/**
 * MCP 操作者：由 initialize 的 clientInfo 推导。
 * via 区分 stdio / http，便于审计里看出是哪个通道来的。
 */
export function mcpActor(
  clientInfo: { name?: string; version?: string } | undefined,
  via: "mcp-stdio" | "mcp-http",
  tokenActorId?: string
): Actor {
  const clientName = clientInfo?.name?.trim() || "unknown-client";
  const version = clientInfo?.version?.trim() || "0";

  // 带 token 的 HTTP 请求按 token 对应的身份记名
  if (tokenActorId) {
    return {
      type: "human",
      id: `token:${tokenActorId}`,
      name: tokenActorId,
      via,
      clientInfo: { name: clientName, version },
    };
  }

  return {
    type: "ai",
    id: `mcp:${clientName}`,
    name: clientName,
    via,
    clientInfo: { name: clientName, version },
  };
}

/** 审计里展示用的一行描述 */
export function describeActor(actor: Actor): string {
  const via =
    actor.via === "console"
      ? "控制台"
      : actor.via === "mcp-stdio"
        ? "MCP stdio"
        : actor.via === "mcp-http"
          ? "MCP HTTP"
          : "命令行";
  const kind = actor.type === "human" ? "人" : actor.type === "ai" ? "AI" : "系统";
  return `${actor.name}（${kind}·${via}）`;
}
