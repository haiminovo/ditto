"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  FolderKanban,
  Package,
  ListChecks,
  ShieldCheck,
  History,
  MessageSquare,
} from "lucide-react";
import { cn } from "@/components/ui/button";

const ITEMS = [
  { href: "/impl", label: "工作台", icon: LayoutDashboard, exact: true },
  { href: "/impl/projects", label: "项目", icon: FolderKanban },
  { href: "/impl/capabilities", label: "能力包", icon: Package },
  { href: "/impl/rules", label: "规则", icon: ListChecks },
  { href: "/impl/approvals", label: "审批", icon: ShieldCheck },
  { href: "/impl/audit", label: "审计", icon: History },
];

export function ConsoleNav() {
  const pathname = usePathname() ?? "";

  return (
    <nav className="flex flex-col gap-1">
      {ITEMS.map((item) => {
        const active = item.exact
          ? pathname === item.href
          : pathname === item.href || pathname.startsWith(`${item.href}/`);
        const Icon = item.icon;

        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
              active
                ? "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300 font-medium"
                : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {item.label}
          </Link>
        );
      })}

      <div className="my-2 border-t border-gray-200 dark:border-gray-800" />

      <Link
        href="/"
        className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
      >
        <MessageSquare className="h-4 w-4 shrink-0" />
        返回对话
      </Link>
    </nav>
  );
}
