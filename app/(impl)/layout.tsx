import Link from "next/link";
import { ConsoleNav } from "@/components/impl/nav";
import { resolveWorkspaceRoot } from "@/lib/core/store/paths";

/**
 * 实施平台控制台的壳。
 *
 * 位于路由组 (impl) 内，不影响 URL —— 页面路径仍是 /impl/*。
 * 顶层的 app/layout.tsx 不需要任何改动：Providers 已经包住全部路由，
 * 而聊天页在 `/`，与控制台互不干扰。
 */
export default function ImplLayout({ children }: { children: React.ReactNode }) {
  // 服务端组件，可以直读工作区路径用于页脚展示
  let workspaceRoot = "";
  try {
    workspaceRoot = resolveWorkspaceRoot();
  } catch {
    workspaceRoot = "（未配置）";
  }

  return (
    <div className="flex h-screen">
      <aside className="w-56 shrink-0 border-r border-gray-200 dark:border-gray-800 flex flex-col">
        <div className="px-4 py-5">
          <Link href="/impl" className="block">
            <div className="text-base font-semibold">Ditto 实施平台</div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              以项目为中心的交付
            </div>
          </Link>
        </div>

        <div className="px-3 flex-1 overflow-y-auto">
          <ConsoleNav />
        </div>

        <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-800">
          <div className="text-[11px] text-gray-400 dark:text-gray-500 leading-tight">
            <div className="truncate" title={workspaceRoot}>
              工作区：{workspaceRoot}
            </div>
            <div className="mt-1">
              操作者身份为自报，仅供留痕，不构成安全边界
            </div>
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto bg-gray-50 dark:bg-gray-950">
        <div className="mx-auto max-w-5xl px-6 py-8">{children}</div>
      </main>
    </div>
  );
}
