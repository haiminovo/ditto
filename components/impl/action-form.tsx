"use client";

import * as React from "react";
import { useFormState, useFormStatus } from "react-dom";
import { cn } from "@/components/ui/button";

export interface ActionState {
  ok: boolean;
  message: string;
}

/**
 * 提交按钮：自动反映所在表单的提交中状态。
 * 拆成独立组件是因为 useFormStatus 只在 <form> 的子组件里有效。
 */
export function SubmitButton({
  children,
  variant = "primary",
  size = "sm",
  confirm,
}: {
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "destructive";
  size?: "sm" | "md";
  /** 需要二次确认的操作（发布、物理删除等） */
  confirm?: string;
}) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
      className={cn(
        "inline-flex items-center justify-center rounded-md font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2",
        "disabled:opacity-50 disabled:pointer-events-none",
        {
          "bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600":
            variant === "primary",
          "bg-gray-100 text-gray-900 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700":
            variant === "secondary",
          "hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300":
            variant === "ghost",
          "bg-red-600 text-white hover:bg-red-700 dark:bg-red-500 dark:hover:bg-red-600":
            variant === "destructive",
        },
        { "h-8 px-3 text-sm": size === "sm", "h-10 px-4 py-2": size === "md" }
      )}
    >
      {pending ? "处理中…" : children}
    </button>
  );
}

/**
 * 把表单的提交结果渲染出来。
 *
 * 用的是 react-dom 的 useFormState，**不是** React 的 useActionState ——
 * 后者是 React 19 才有的 API，本项目锁在 React 18.3，用它会直接运行时崩溃
 * （TS 类型因为 @types/react 的关系未必报错，属于容易被漏掉的一类错误）。
 */
export function ActionForm({
  action,
  children,
  className,
  hiddenFields,
}: {
  action: (fd: FormData) => Promise<ActionState>;
  children: React.ReactNode;
  className?: string;
  hiddenFields?: Record<string, string>;
}) {
  const [state, formAction] = useFormState(
    async (_prev: ActionState | null, fd: FormData) => action(fd),
    null as ActionState | null
  );

  return (
    <form action={formAction} className={className}>
      {hiddenFields &&
        Object.entries(hiddenFields).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
      {children}
      {state && (
        <div
          role="status"
          className={cn(
            "mt-2 rounded-md px-3 py-2 text-sm",
            state.ok
              ? "bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-300"
              : "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-300"
          )}
        >
          {state.ok ? "✓ " : "✗ "}
          {state.message}
        </div>
      )}
    </form>
  );
}
