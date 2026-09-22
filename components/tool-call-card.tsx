"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/components/ui/button";
import { Loader2, ChevronRight, Wrench } from "lucide-react";

/**
 * 界面上的一次工具调用。
 *
 * 类型定义在**这里**而不是 chat.tsx：卡片是消费方，形状由它定，
 * 这样依赖方向只有 chat.tsx → 本文件一条，不会转成循环 import。
 */
export interface UiToolCall {
  id: string;
  name: string;
  argsJson: string;
  /** undefined 表示还没回来 —— 卡片据此显示「执行中」 */
  result?: string;
  isError?: boolean;
}

/**
 * 工具名 → 给人看的说法。
 *
 * 这里**不是**白名单（白名单在 lib/sdk/tools.ts，服务端强制），
 * 纯粹是显示层：`ditto_rule_run` 对用的人是「跑一遍规则检查」。
 * 查不到的名字原样显示 —— 显示层不该因为漏了一条映射就把调用藏起来。
 */
const TOOL_LABELS: Record<string, string> = {
  ditto_workspace_info: "查看工作区",
  ditto_handoff: "取全局状态",
  ditto_project_list: "列出项目",
  ditto_project_get: "查看项目",
  ditto_asset_list: "列出资产",
  ditto_asset_get: "读取资产",
  ditto_asset_history: "查看资产版本",
  ditto_asset_diff: "对比资产版本",
  ditto_capability_list: "列出能力包",
  ditto_capability_get: "查看能力包",
  ditto_template_list: "列出模板",
  ditto_template_render: "预览模板渲染",
  ditto_rule_list: "查看生效规则",
  ditto_rule_run: "跑一遍规则检查",
  ditto_rule_run_get: "查看规则结果",
  ditto_gate_check: "闸门预检",
  ditto_approval_list: "查看审批",
  ditto_asset_approval_status: "查看资产审批状态",
  ditto_audit_list: "查审计流水",
  ditto_audit_verify: "校验审计链",
};

/** 结果可能很长（handoff 动辄上万字符），折叠时只给个概览 */
const RESULT_PREVIEW_CHARS = 1600;

function prettyJson(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "（无参数）";
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    // 参数不是合法 JSON —— 如实显示原文。这正是服务端会回 E_TOOL_ARGS 的情况，
    // 在这里「美化」成空对象只会把问题藏掉。
    return raw;
  }
}

export function ToolCallCard({ call }: { call: UiToolCall }) {
  const [open, setOpen] = useState(false);

  const running = call.result === undefined;
  const errored = call.isError === true;
  const label = TOOL_LABELS[call.name] ?? call.name;

  return (
    <div
      className={cn(
        "my-1.5 rounded-md border text-xs overflow-hidden",
        errored
          ? "border-red-200 dark:border-red-900 bg-red-50/50 dark:bg-red-950/20"
          : "border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50"
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-gray-100/70 dark:hover:bg-gray-800/50 transition-colors"
      >
        <ChevronRight
          className={cn(
            "w-3.5 h-3.5 shrink-0 text-gray-400 transition-transform",
            open && "rotate-90"
          )}
        />
        <Wrench className="w-3.5 h-3.5 shrink-0 text-gray-400" />
        <span className="font-medium text-gray-700 dark:text-gray-300">{label}</span>
        <span className="font-mono text-[11px] text-gray-400 truncate">{call.name}</span>

        <span className="ml-auto shrink-0">
          {running ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-500" />
          ) : errored ? (
            <Badge tone="red">失败</Badge>
          ) : (
            <Badge tone="green">完成</Badge>
          )}
        </span>
      </button>

      {open && (
        <div className="border-t border-gray-200 dark:border-gray-800 px-2.5 py-2 space-y-2">
          <div>
            <div className="text-[11px] text-gray-500 dark:text-gray-400 mb-1">参数</div>
            <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-950 rounded p-2 max-h-48 overflow-y-auto">
              {prettyJson(call.argsJson)}
            </pre>
          </div>

          {call.result !== undefined && (
            <div>
              <div className="text-[11px] text-gray-500 dark:text-gray-400 mb-1">
                结果{call.result.length > RESULT_PREVIEW_CHARS && "（已截断显示）"}
              </div>
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-950 rounded p-2 max-h-72 overflow-y-auto">
                {call.result.length > RESULT_PREVIEW_CHARS
                  ? `${call.result.slice(0, RESULT_PREVIEW_CHARS)}\n\n…（共 ${call.result.length} 字符）`
                  : call.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
