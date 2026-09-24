/**
 * Ditto MCP ToolSource：聊天 ↔ 实施平台进程内桥接
 *
 * 通用 harness 只认识 HarnessToolSource；这个适配器把它连到同一套 lib/mcp
 * 服务端（createMcpServer），所以 Web 聊天与 HTTP MCP 的工具行为、审计发射一致。
 *
 * ⚠️ 本文件是**服务端专用**：它 import 了 lib/mcp/server.ts，而后者经
 *    lib/core/store/paths 依赖 node:fs。所以它**绝不能**出现在
 *    lib/sdk/index.ts 的 barrel 里 —— 那个 barrel 被 components/chat.tsx
 *    导入，一旦漏进去客户端打包就会挂。lib/sdk/server.ts 同样是这么处理的。
 *
 * 为什么走进程内 InMemoryTransport 而不是 HTTP 打自己的 /api/mcp：
 *   1. 少一跳网络，少一次序列化往返；
 *   2. 不必在服务端进程里再建一个 HTTP 客户端去连自己；
 *   3. createMcpServer 明确不做 I/O、构造很便宜（见 lib/mcp/server.ts:33-39），
 *      按请求建一套是它的预期用法。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Actor } from "../core/types";
import { createMcpServer } from "../mcp/server";
import { resolveWorkspaceRoot } from "../core/store/paths";
import type {
  HarnessToolContext,
  HarnessToolDefinition,
  HarnessToolResult,
  HarnessToolSource,
} from "../harness/types";

/**
 * 对话界面**被允许**调用的工具。
 *
 * 这份清单是**显式**的，不从 `readOnlyHint` 注解推导 —— 给对话新增一个工具
 * 应当是深思熟虑的动作，而不是上游给某个工具加个注解就自动获得权限。
 *
 * 范围：19 个纯查询工具 + ditto_rule_run。
 *   ditto_rule_run 标注了 readOnlyHint: false，但那只是因为它会落一份 run
 *   记录；它不修改任何资产。它是「自检拿整改建议」的核心，必须在内。
 *
 * ★ 不在这里的工具，对话**拿不到**：所有写操作（asset_create / update /
 *   delete / revise）、提交审批、放行、导出，以及 ditto_rule_waive 豁免。
 *   让 AI 直接放行会让「放行时刻重新计算规则」这条闸门变成摆设。
 */
export const CHAT_TOOL_ALLOWLIST: readonly string[] = [
  // 总览
  "ditto_workspace_info",
  "ditto_handoff",
  // 项目
  "ditto_project_list",
  "ditto_project_get",
  // 资产
  "ditto_asset_list",
  "ditto_asset_get",
  "ditto_asset_history",
  "ditto_asset_diff",
  // 能力包与模板
  "ditto_capability_list",
  "ditto_capability_get",
  "ditto_template_list",
  "ditto_template_render",
  // 规则
  "ditto_rule_list",
  "ditto_rule_run",
  "ditto_rule_run_get",
  "ditto_gate_check",
  // 审批（只读）
  "ditto_approval_list",
  "ditto_asset_approval_status",
  // 审计
  "ditto_audit_list",
  "ditto_audit_verify",
];

/** 归一化后的工具定义，交给各 provider 转成自己的格式 */
export type ProviderTool = HarnessToolDefinition;
export type ToolCallOutcome = HarnessToolResult;

/** Ditto MCP 工具源；同时实现通用 harness 的 ToolSource 契约。 */
export interface ToolBridge extends HarnessToolSource {
  id: "ditto-mcp";
  close(): Promise<void>;
}

/**
 * 剥掉 provider 不认的 JSON Schema 键。
 *
 * MCP 的 inputSchema 由 zod-to-json-schema 生成，可能带上 `$schema`。
 * Anthropic 对未知的 JSON Schema 关键字是严格的，会因为一个 `$schema`
 * 直接 400 —— 而那个 400 会伪装成「模型调用工具失败」，最难查的那种。
 */
function sanitizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _drop, ...rest } = schema;
  if (!rest.type) rest.type = "object";
  // 无参数工具在 MCP 那边登记成 inputSchema: {}，补上 properties 免得
  // 某些网关因为缺 properties 报 schema 不合法
  if (!rest.properties) rest.properties = {};
  return rest;
}

function isAllowed(name: string): boolean {
  return CHAT_TOOL_ALLOWLIST.includes(name);
}

/**
 * 建一个连到实施平台的进程内 MCP 客户端。
 *
 * 用完必须 `close()`，否则每轮对话都会漏一个 McpServer + 两条 transport。
 *
 * `root` 不传就按 DITTO_WORKSPACE → 祖先标记 → cwd/workspace 解析；
 * 冒烟脚本靠它指到临时工作区。
 */
export async function createToolBridge(
  actor: Actor,
  options: { root?: string } = {}
): Promise<ToolBridge> {
  const { server } = createMcpServer({
    root: options.root ?? resolveWorkspaceRoot(),
    actor,
  });

  // 顺序要紧：先 connect 服务端，再 connect 客户端。
  // InMemoryTransport 在 peer 挂上 onmessage 之前会把消息排进 _messageQueue
  // （inMemory.js:40-47），反过来接会有一小段窗口丢消息。
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "ditto-chat", version: "0.1.0" });
  await client.connect(clientTransport);

  return {
    id: "ditto-mcp" as const,

    async listTools(signal?: AbortSignal): Promise<ProviderTool[]> {
      signal?.throwIfAborted();
      const { tools } = await client.listTools();
      signal?.throwIfAborted();

      return tools
        .filter((t) => isAllowed(t.name))
        .map((t) => ({
          name: t.name,
          description: t.description ?? "",
          inputSchema: sanitizeSchema(t.inputSchema as Record<string, unknown>),
          annotations: t.annotations as Record<string, unknown> | undefined,
        }));
    },

    async callTool(
      name: string,
      args: Record<string, unknown>,
      context?: HarnessToolContext
    ): Promise<ToolCallOutcome> {
      context?.signal?.throwIfAborted();
      // 纵深防御：模型只会看到白名单内的工具，但参数是模型给的，
      // 不能假设它只会点名见过的工具
      if (!isAllowed(name)) {
        return {
          text: `【E_TOOL_NOT_ALLOWED】工具 ${name} 不在对话界面可用的范围内。写操作与审批请通过 MCP 客户端执行。`,
          isError: true,
        };
      }

      const res = (await client.callTool({ name, arguments: args })) as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      context?.signal?.throwIfAborted();

      // lib/mcp/result.ts 的约定：业务错误以 isError 返回，不抛异常
      // （抛出去会变成 JSON-RPC 协议错误，把 E_GATE_BLOCKED 这类可操作
      //  的载荷藏起来）。这里如实透传。
      const text = (res.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");

      return { text, isError: res.isError === true };
    },

    async close(): Promise<void> {
      // transport 已经断开时 close 会抛，而这里没有补救动作 —— 吞掉
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}
