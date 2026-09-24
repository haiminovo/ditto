/**
 * Ditto 实施平台 - 操作者构造
 *
 * ⚠️ 诚实边界：actor 全部是**自报**的，这不是身份认证，不构成安全边界。
 *    它的作用是留痕与流程约束。真正的鉴权（MCP OAuth / 反向代理 SSO）
 *    不在本期范围。
 *
 * 本文件不碰 fs，纯计算。
 */

import type { Actor, ActorType, ActorVia } from "./types";

export const SYSTEM_ACTOR: Actor = {
  type: "system",
  id: "system:core",
  name: "系统",
  via: "cli",
};

export const LOCAL_ACTOR: Actor = {
  type: "human",
  id: "local:user",
  name: "本地用户",
  via: "cli",
};

/** 本地操作者：允许脚本覆盖展示名 */
export function localActor(name?: string): Actor {
  const trimmed = name?.trim();
  return trimmed ? { ...LOCAL_ACTOR, name: trimmed } : LOCAL_ACTOR;
}

/**
 * MCP 操作者：由 initialize 的 clientInfo 推导。
 * via 区分 stdio / http / chat，便于审计里看出是哪个通道来的。
 *
 * `via: "chat"` 是本平台自己那个对话界面 —— 它也是一个 AI 客户端，
 * 只是跑在同进程里而不是通过 stdio/HTTP 连进来。
 */
export function mcpActor(
  clientInfo: { name?: string; version?: string } | undefined,
  via: "mcp-stdio" | "mcp-http" | "chat",
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

/**
 * 通道与身份类型的中文标签。
 *
 * 用 Record 而不是嵌套三元：两侧都是闭合联合，少写一个取值
 * 编译器就会在这里报错，而不是悄悄落进最后的 else。
 * 导出是给 UI 用的 —— 审计表格要按列拆分渲染，用不了 describeActor
 * 那个整串，但同样不该把 "mcp-stdio" / "chat" 这种内部取值直接摆给用户看。
 */
export const VIA_LABELS: Record<ActorVia, string> = {
  "mcp-stdio": "MCP stdio",
  "mcp-http": "MCP HTTP",
  chat: "对话",
  cli: "命令行",
};

export const ACTOR_TYPE_LABELS: Record<ActorType, string> = {
  human: "人",
  ai: "AI",
  system: "系统",
};

export function describeActor(actor: Actor): string {
  return `${actor.name}（${ACTOR_TYPE_LABELS[actor.type]}·${VIA_LABELS[actor.via]}）`;
}
