import * as React from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * 配色沿用 button.tsx 已建立的调色板，不再引入新色。
 * 语义映射见 lib/core/types.ts 的 STATUS_LABELS / SEVERITY_LABELS。
 */
export type BadgeTone = "gray" | "blue" | "green" | "amber" | "red";

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

const TONE_CLASSES: Record<BadgeTone, string> = {
  gray: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  blue: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  green: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  red: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
};

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, tone = "gray", ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        TONE_CLASSES[tone],
        className
      )}
      {...props}
    />
  )
);
Badge.displayName = "Badge";

/* ------------------------------------------------------------------ */
/* 语义映射                                                            */
/* ------------------------------------------------------------------ */

import type { AssetStatus, Severity } from "@/lib/core/types";

const STATUS_TONE: Record<AssetStatus, BadgeTone> = {
  draft: "gray",
  in_review: "blue",
  approved: "green",
  rejected: "red",
  released: "green",
  deprecated: "gray",
};

export function StatusBadge({ status }: { status: AssetStatus }) {
  return <Badge tone={STATUS_TONE[status] ?? "gray"}>{STATUS_TEXT[status] ?? status}</Badge>;
}

const STATUS_TEXT: Record<AssetStatus, string> = {
  draft: "草稿",
  in_review: "评审中",
  approved: "已批准",
  rejected: "已驳回",
  released: "已发布",
  deprecated: "已废弃",
};

const SEVERITY_TONE: Record<Severity, BadgeTone> = {
  error: "red",
  warn: "amber",
  info: "blue",
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <Badge tone={SEVERITY_TONE[severity] ?? "gray"}>
      {SEVERITY_TEXT[severity] ?? severity}
    </Badge>
  );
}

const SEVERITY_TEXT: Record<Severity, string> = {
  error: "阻断",
  warn: "警告",
  info: "提示",
};

export { cn };
