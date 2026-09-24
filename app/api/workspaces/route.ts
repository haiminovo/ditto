import type { NextRequest } from "next/server";
import { CoreError } from "@/lib/core/errors";
import {
  addWorkspace,
  initializeWorkspace,
  listWorkspaceState,
  removeWorkspace,
  selectWorkspace,
} from "@/lib/core/store/workspace-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error: unknown): Response {
  const status =
    error instanceof CoreError && error.code === "E_NOT_FOUND" ? 404 : 400;
  return Response.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status }
  );
}

export async function GET(): Promise<Response> {
  try {
    return Response.json(await listWorkspaceState());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const body = (await request.json()) as {
      action?: "add" | "select" | "init" | "remove";
      id?: string;
      path?: string;
      name?: string;
    };

    switch (body.action) {
      case "add":
        if (!body.path?.trim()) return Response.json({ error: "工作区路径不能为空" }, { status: 400 });
        return Response.json(await addWorkspace({ path: body.path, name: body.name }));
      case "select":
        if (!body.id) return Response.json({ error: "缺少工作区 id" }, { status: 400 });
        return Response.json(await selectWorkspace(body.id));
      case "init":
        if (!body.id) return Response.json({ error: "缺少工作区 id" }, { status: 400 });
        return Response.json(await initializeWorkspace(body.id));
      case "remove":
        if (!body.id) return Response.json({ error: "缺少工作区 id" }, { status: 400 });
        return Response.json(await removeWorkspace(body.id));
      default:
        return Response.json({ error: "不支持的工作区操作" }, { status: 400 });
    }
  } catch (error) {
    return errorResponse(error);
  }
}
