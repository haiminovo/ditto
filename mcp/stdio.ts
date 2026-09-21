#!/usr/bin/env node
/**
 * Ditto 实施平台 - stdio MCP 入口
 *
 *   npm run mcp
 *   DITTO_WORKSPACE=/path/to/ws npx tsx mcp/stdio.ts
 *
 * 接入 Claude Code：
 *   claude mcp add ditto --scope user \
 *     -e DITTO_WORKSPACE=/绝对路径/workspace \
 *     -- /绝对路径/node_modules/.bin/tsx /绝对路径/mcp/stdio.ts
 *
 * ⚠️ 两条硬约束：
 *
 * 1. **stdout 是 JSON-RPC 通道**。任何调试输出必须走 stderr，
 *    往 stdout 写一个字符就会破坏协议。本文件不用 console.log。
 *
 * 2. 项目 package.json 没有 "type": "module"，本文件按 CJS 运行，
 *    所以**不能用顶层 await**，也不能用 import.meta.url。
 *    这不是缺陷：为了它加 "type": "module" 会连带打断
 *    next.config.js / postcss.config.js / tailwind.config.ts。
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "../lib/mcp/server";
import { resolveWorkspaceRoot } from "../lib/core/store/paths";
import { mcpActor } from "../lib/core/actors";

async function main(): Promise<void> {
  const root = resolveWorkspaceRoot();

  const actor = mcpActor(
    {
      name: process.env.DITTO_CLIENT_NAME ?? "claude-code",
      version: process.env.DITTO_CLIENT_VERSION ?? "unknown",
    },
    "mcp-stdio"
  );

  const { server } = createMcpServer({ root, actor });
  const transport = new StdioServerTransport();

  await server.connect(transport);

  // 只写 stderr：stdout 是 JSON-RPC 通道
  process.stderr.write(`[ditto] MCP 服务端已就绪（stdio）\n`);
  process.stderr.write(`[ditto] 工作区：${root}\n`);
  process.stderr.write(`[ditto] 操作者：${actor.name}\n`);

  const shutdown = async (signal: string) => {
    process.stderr.write(`[ditto] 收到 ${signal}，正在关闭…\n`);
    try {
      await server.close();
    } catch {
      /* 关闭失败也要退出，否则进程会挂住 */
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[ditto] 启动失败：${message}\n`);
  process.exit(1);
});
