/**
 * Ditto Models API Route
 *
 * 向 provider 拉取模型列表。与 /api/chat 同理，必须走服务端代理：
 * api.openai.com 与 api.deepseek.com 都不返回宽松的 CORS 头，浏览器直连必失败；
 * 而逐 provider 处理 CORS 分叉比一个代理差得多。key 走请求体不走 query（query 会进日志）。
 */

import { NextRequest } from "next/server";
import { handleModelsRequest, type ModelsRequest } from "@/lib/sdk/server";

// Anthropic SDK 需要 Node 运行时
export const runtime = "nodejs";
// 结果不进 Data Cache：否则「我在 provider 加了模型，列表却没变」
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as ModelsRequest;
    return await handleModelsRequest(body);
  } catch (error) {
    console.error("Models API error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message, models: [], warnings: [] }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
