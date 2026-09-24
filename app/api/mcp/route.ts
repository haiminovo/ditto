/**
 * Ditto 实施平台 - HTTP Streamable MCP 入口
 *
 * 这是 Web 对外暴露的 MCP 传输。Web 聊天内部则通过 InMemoryTransport
 * 复用同一套工具定义（lib/mcp/server.ts），所以行为不可能漂移。
 *
 * 关于**无状态模式**：
 * 每个请求新建 McpServer + transport，用完即弃（sessionIdGenerator: undefined）。
 * 这与常见的"模块级 Map<sessionId, transport>"写法相比是刻意的取舍：
 *   + 无服务器实例回收时不会静默丢失会话
 *   + 没有跨请求内存增长
 *   - 代价是没有跨请求会话状态与进度通知
 * 本平台的工具集是无状态的（每次调用都从磁盘读当前状态），所以这个代价为零。
 */

import type { NextRequest } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "@/lib/mcp/server";
import { mcpActor } from "@/lib/core/actors";
import {
  resolveActiveWorkspaceRoot,
  resolveWorkspaceRootById,
} from "@/lib/core/store/workspace-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_HEADERS = [
  "Content-Type",
  "Authorization",
  "mcp-session-id",
  "mcp-protocol-version",
  "Last-Event-ID",
  "x-ditto-workspace",
].join(", ");

const EXPOSED_HEADERS = "mcp-session-id, mcp-protocol-version";

/**
 * 从请求头推导操作者身份。
 *
 * ⚠️ 这不是鉴权：token 只用于在审计里记名。真正的鉴权（OAuth / SSO）
 *    属于反向代理或 MCP 授权层，不在本平台范围内。
 *    配置 DITTO_MCP_TOKENS="tokenA:张三,tokenB:李四" 可让审计区分到人。
 */
function actorFromRequest(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";

  let tokenActorId: string | undefined;
  if (bearer) {
    const table = process.env.DITTO_MCP_TOKENS ?? "";
    for (const pair of table.split(",")) {
      const [token, name] = pair.split(":");
      if (token?.trim() && token.trim() === bearer) {
        tokenActorId = (name ?? token).trim();
        break;
      }
    }
  }

  return mcpActor(
    {
      name: req.headers.get("x-ditto-client") ?? "http-client",
      version: req.headers.get("x-ditto-client-version") ?? "unknown",
    },
    "mcp-http",
    tokenActorId
  );
}

/**
 * 让响应体流完之后再清理服务端实例。
 *
 * 不能直接 `await server.close()` —— 返回的可能是仍在推送的 SSE 流，
 * 提前关闭会把流截断。这里把它包一层，等流真正结束（或客户端断开）再收尾。
 */
function withCleanup(response: Response, cleanup: () => Promise<void>): Response {
  if (!response.body) {
    void cleanup();
    return response;
  }

  const original = response.body;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let cleaned = false;
  const cleanupOnce = () => {
    if (cleaned) return;
    cleaned = true;
    void cleanup();
  };

  const wrapped = new ReadableStream<Uint8Array>({
    async start(controller) {
      const currentReader = original.getReader();
      reader = currentReader;
      try {
        for (;;) {
          const { done, value } = await currentReader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      } finally {
        cleanupOnce();
      }
    },
    async cancel(reason) {
      try {
        if (reader) await reader.cancel(reason);
        else await original.cancel(reason);
      } catch {
        // The reader may already have completed or the stream may be closing.
      } finally {
        cleanupOnce();
      }
    },
  });

  return new Response(wrapped, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function handle(req: NextRequest): Promise<Response> {
  const requestedWorkspace = req.headers.get("x-ditto-workspace")?.trim();
  let root: string;
  try {
    root = requestedWorkspace
      ? resolveWorkspaceRootById(requestedWorkspace)
      : resolveActiveWorkspaceRoot();
  } catch (error) {
    return Response.json(
      {
        jsonrpc: "2.0",
        error: {
          code: -32602,
          message: error instanceof Error ? error.message : String(error),
        },
        id: null,
      },
      { status: 400 }
    );
  }

  const { server } = createMcpServer({
    root,
    actor: actorFromRequest(req),
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    // undefined ⇒ 无状态模式，见文件头说明
    sessionIdGenerator: undefined,
    enableJsonResponse: false,
  });

  try {
    await server.connect(transport);
    const response = await transport.handleRequest(req);

    response.headers.set("Access-Control-Allow-Origin", "*");
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", ALLOWED_HEADERS);
    response.headers.set("Access-Control-Expose-Headers", EXPOSED_HEADERS);

    return withCleanup(response, async () => {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    });
  } catch (error) {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);

    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      {
        jsonrpc: "2.0",
        error: { code: -32603, message: `MCP 服务端内部错误：${message}` },
        id: null,
      },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function GET(req: NextRequest): Promise<Response> {
  // 无状态模式下没有可恢复的会话，GET 主要用于 SSE 流
  return handle(req);
}

export async function DELETE(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": ALLOWED_HEADERS,
      "Access-Control-Expose-Headers": EXPOSED_HEADERS,
      "Access-Control-Max-Age": "86400",
    },
  });
}
