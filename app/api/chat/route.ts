/**
 * Ditto Chat API Route
 * 作为代理，避免 CORS 问题
 */

import { NextRequest } from "next/server";
import { handleChatRequest, ChatRequest } from "@/lib/sdk/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as ChatRequest;
    return await handleChatRequest(body, { signal: request.signal });
  } catch (error) {
    console.error("Chat API error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
