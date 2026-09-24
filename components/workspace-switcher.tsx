"use client";

import { useState } from "react";
import {
  Check,
  ChevronDown,
  FolderOpen,
  Loader2,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { Button, cn } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { WorkspaceController } from "@/components/use-workspaces";

export function WorkspaceSwitcher({ controller }: { controller: WorkspaceController }) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");

  const active = controller.active;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-left transition-colors",
          "hover:border-gray-300 hover:bg-gray-50",
          "dark:border-gray-800 dark:bg-gray-900 dark:hover:border-gray-700 dark:hover:bg-gray-800"
        )}
      >
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-300">
            {controller.loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FolderOpen className="h-4 w-4" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[11px] text-gray-500 dark:text-gray-400">
              当前工作区
            </span>
            <span className="block truncate text-sm font-medium">
              {active?.name || "选择工作区"}
            </span>
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" />
        </div>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <Card className="max-h-[80vh] w-full max-w-xl">
            <CardHeader className="flex flex-row items-start justify-between gap-4 pb-3">
              <div>
                <CardTitle>工作区</CardTitle>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  选择 AI 工具可以访问的本机目录
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label="关闭"
                onClick={() => setOpen(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </CardHeader>

            <CardContent className="max-h-[calc(80vh-96px)] space-y-5 overflow-y-auto pt-2">
              {controller.error && (
                <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                  {controller.error}
                </div>
              )}

              <div className="space-y-2">
                {controller.workspaces.map((workspace) => {
                  const selected = workspace.id === controller.active?.id;
                  return (
                    <div
                      key={workspace.id}
                      className={cn(
                        "flex items-center gap-3 rounded-lg border px-3 py-3",
                        selected
                          ? "border-blue-300 bg-blue-50/60 dark:border-blue-800 dark:bg-blue-950/30"
                          : "border-gray-200 dark:border-gray-800"
                      )}
                    >
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onClick={() => {
                          if (!selected) {
                            void controller.select(workspace.id).catch(() => undefined);
                          }
                        }}
                      >
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">
                            {workspace.name}
                          </span>
                          <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                            {workspace.kind === "default" ? "默认" : "自选"}
                          </span>
                          {!workspace.initialized && (
                            <span className="shrink-0 text-[10px] text-amber-600 dark:text-amber-400">
                              未初始化
                            </span>
                          )}
                        </div>
                        <div className="mt-1 truncate text-xs text-gray-500 dark:text-gray-400">
                          {workspace.path}
                        </div>
                      </button>

                      {!workspace.initialized && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={controller.mutating}
                          onClick={() => {
                            void controller.initialize(workspace.id).catch(() => undefined);
                          }}
                        >
                          初始化
                        </Button>
                      )}

                      {selected ? (
                        <Check className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
                      ) : null}

                      {workspace.kind === "external" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`移除 ${workspace.name}`}
                          disabled={controller.mutating}
                          onClick={() => {
                            void controller.remove(workspace.id).catch(() => undefined);
                          }}
                        >
                          <Trash2 className="h-4 w-4 text-gray-400 hover:text-red-500" />
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="border-t border-gray-200 pt-5 dark:border-gray-800">
                <div className="mb-3">
                  <h3 className="text-sm font-medium">添加本机目录</h3>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    目录不存在时会创建并初始化。移除工作区不会删除磁盘文件。
                  </p>
                </div>
                <div className="space-y-3">
                  <Input
                    value={path}
                    onChange={(event) => setPath(event.target.value)}
                    placeholder="/Users/you/Documents/ditto-workspace"
                    aria-label="工作区路径"
                  />
                  <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="显示名称（可选）"
                    aria-label="工作区名称"
                  />
                  <Button
                    className="w-full"
                    disabled={!path.trim() || controller.mutating}
                    onClick={async () => {
                      try {
                        await controller.add(path.trim(), name.trim() || undefined);
                        setPath("");
                        setName("");
                        setOpen(false);
                      } catch {
                        // 错误由 controller 展示
                      }
                    }}
                  >
                    {controller.mutating ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Plus className="mr-2 h-4 w-4" />
                    )}
                    添加并使用
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
