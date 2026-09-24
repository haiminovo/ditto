"use client";

import { useCallback, useEffect, useState } from "react";
import type { WorkspaceState } from "@/lib/workspace/types";

export interface WorkspaceController extends WorkspaceState {
  loading: boolean;
  mutating: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  add: (path: string, name?: string) => Promise<void>;
  select: (id: string) => Promise<void>;
  initialize: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  clearError: () => void;
}

export function useWorkspaces(): WorkspaceController {
  const [state, setState] = useState<WorkspaceState>({
    active: null,
    workspaces: [],
  });
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/workspaces", { cache: "no-store" });
      const body = (await response.json()) as WorkspaceState & { error?: string };
      if (!response.ok) throw new Error(body.error || "读取工作区失败");
      setState({ active: body.active, workspaces: body.workspaces });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = useCallback(
    async (payload: Record<string, unknown>) => {
      setMutating(true);
      setError(null);
      try {
        const response = await fetch("/api/workspaces", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body = (await response.json()) as WorkspaceState & { error?: string };
        if (!response.ok) throw new Error(body.error || "工作区操作失败");
        setState({ active: body.active, workspaces: body.workspaces });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        throw cause;
      } finally {
        setMutating(false);
      }
    },
    []
  );

  return {
    ...state,
    loading,
    mutating,
    error,
    refresh: load,
    add: (path, name) => mutate({ action: "add", path, name }),
    select: (id) => mutate({ action: "select", id }),
    initialize: (id) => mutate({ action: "init", id }),
    remove: (id) => mutate({ action: "remove", id }),
    clearError: () => setError(null),
  };
}
