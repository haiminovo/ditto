/**
 * Ditto 实施平台 - 操作层出口
 *
 * ★ 所有 MCP 工具都必须只调用这里，不许各写一份逻辑。
 *   两边各写一份的后果很具体：审计流水分叉，闸门在不同入口给出不同结论。
 *
 * ⚠️ 依赖 node:fs，只能在服务端 import。
 */

export * from "./context";
export * from "./project-ops";
export * from "./asset-ops";
export * from "./rule-ops";
export * from "./template-ops";
export * from "./approval-ops";
export * from "./delivery-ops";
export * from "./handoff";
