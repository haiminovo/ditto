/**
 * Ditto 实施平台 - 操作上下文
 *
 * ★ 这是整个平台最重要的结构约定：
 *
 *   lib/core/ops/*.ts          ← 唯一实现（业务逻辑 + 审计发射）
 *     ├─ app/(impl)/impl/actions.ts   ← Server Action 适配器（FormData 进）
 *     └─ lib/mcp/tools/*.ts           ← MCP 适配器（zod 进）
 *
 * 控制台与 MCP 必须都只是薄壳。不这样做的后果很具体：两边各写一份逻辑，
 * 审计流水就会分叉，闸门在不同入口给出不同结论，质量保证随之失效。
 */

import { SYSTEM_ACTOR } from "../actors";
import { ulid } from "../ids";
import type { Actor } from "../types";

export interface OpContext {
  /** 工作区根目录 */
  root: string;
  /** 操作者（自报，非鉴权凭据） */
  actor: Actor;
  /** 注入时钟，便于测试确定化 */
  now?: () => Date;
  /** 注入 id 生成器 */
  newId: (prefix?: string) => string;
}

export function createContext(
  root: string,
  actor: Actor = SYSTEM_ACTOR,
  overrides: Partial<OpContext> = {}
): OpContext {
  const base: OpContext = {
    root,
    actor,
    now: () => new Date(),
    newId: (prefix?: string) => (prefix ? `${prefix}_${ulid()}` : ulid()),
  };

  // 只接受**有值**的覆盖：直接展开会让 `{newId: undefined}` 把默认实现顶掉，
  // 而调用方传 undefined 的本意是"用默认值"。
  return {
    root: overrides.root ?? base.root,
    actor: overrides.actor ?? base.actor,
    now: overrides.now ?? base.now,
    newId: overrides.newId ?? base.newId,
  };
}

export function nowIso(ctx: OpContext): string {
  return (ctx.now ?? (() => new Date()))().toISOString();
}

export function today(ctx: OpContext): Date {
  return (ctx.now ?? (() => new Date()))();
}
