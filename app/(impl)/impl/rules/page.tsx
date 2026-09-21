import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge, SeverityBadge } from "@/components/ui/badge";
import { consoleActor } from "@/lib/core/actors";
import { createContext } from "@/lib/core/ops/context";
import { resolveWorkspaceRoot } from "@/lib/core/store/paths";
import { SEVERITY_LABELS } from "@/lib/core/types";
import { listProjects } from "@/lib/core/ops/project-ops";
import { loadRulePacksForProject } from "@/lib/core/ops/rule-ops";
import { listRuns } from "@/lib/core/store/runs";

export const dynamic = "force-dynamic";

export default async function RulesPage() {
  const root = resolveWorkspaceRoot();
  const ctx = createContext(root, consoleActor("控制台用户"));
  const projects = listProjects(ctx);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">规则</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          规则是**声明式数据**，不是代码。引擎内没有 eval，也拒绝嵌套量词正则。
        </p>
      </header>

      <Card className="border-blue-200 dark:border-blue-900">
        <CardHeader>
          <CardTitle className="text-base">严重级别与阻断</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-gray-600 dark:text-gray-400 space-y-2">
          <div className="flex items-center gap-2">
            <SeverityBadge severity="error" />
            <span>无条件阻断，必须整改或显式豁免</span>
          </div>
          <div className="flex items-center gap-2">
            <SeverityBadge severity="warn" />
            <span>
              同样阻断，需逐条给出豁免理由才能放行 —— 否则评审意见会退化成装饰
            </span>
          </div>
          <div className="flex items-center gap-2">
            <SeverityBadge severity="info" />
            <span>仅提示，从不阻断</span>
          </div>
          <p className="text-xs pt-1">
            规则包可用 <code className="font-mono">blockingSeverities</code>{" "}
            调整自己的阻断级别：客户可以不改代码就收紧或放宽某套规则。
          </p>
        </CardContent>
      </Card>

      {projects.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-gray-500">
            还没有项目。规则挂在项目上，先
            <Link href="/impl/projects" className="text-blue-600 hover:underline mx-1">
              创建一个项目
            </Link>
            。
          </CardContent>
        </Card>
      ) : (
        projects.map((p) => {
          const { packs, rules } = loadRulePacksForProject(ctx, p);
          const runs = listRuns(root, p.id);

          return (
            <Card key={p.id}>
              <CardHeader>
                <CardTitle className="text-base">
                  <Link href={`/impl/projects/${p.id}`} className="hover:underline">
                    {p.name}
                  </Link>
                </CardTitle>
                <CardDescription>
                  {rules.length} 条规则，来自 {packs.length} 个规则包 ·{" "}
                  {runs.length} 次执行记录
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  {packs.map((pack) => (
                    <Badge key={pack.id} tone="gray">
                      {pack.name}（{pack.rules.length}）
                    </Badge>
                  ))}
                  {packs.length === 0 && (
                    <span className="text-sm text-amber-600">
                      未挂载任何规则包 —— 没有质量约束的项目不允许发布
                    </span>
                  )}
                </div>

                <div className="space-y-2">
                  {rules.map((r) => (
                    <div
                      key={r.id}
                      className="rounded-md border border-gray-200 dark:border-gray-800 px-3 py-2"
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <SeverityBadge severity={r.severity} />
                        <span className="text-sm font-medium">{r.name}</span>
                        <span className="text-[11px] font-mono text-gray-400">
                          {r.id}
                        </span>
                        {!r.enabled && <Badge tone="gray">已停用</Badge>}
                      </div>
                      {r.description && (
                        <div className="text-xs text-gray-500 mt-1">
                          {r.description}
                        </div>
                      )}
                      <div className="text-[11px] text-gray-400 mt-1 font-mono">
                        检查器：{r.checker.type}
                      </div>
                      {r.remediation && (
                        <div className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                          修复：{r.remediation}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {runs.length > 0 && (
                  <div>
                    <div className="text-sm font-medium mb-2">最近执行</div>
                    <div className="space-y-1 text-xs">
                      {runs.slice(0, 5).map((run) => (
                        <div key={run.id} className="flex items-center gap-3">
                          <span className="text-gray-400 w-36 shrink-0">
                            {run.finishedAt.slice(0, 19).replace("T", " ")}
                          </span>
                          <Badge tone="gray">
                            {run.scope === "asset" ? "单资产" : "项目级"}
                          </Badge>
                          <span>
                            阻断 <strong className="text-red-600">{run.counts.error}</strong>{" "}
                            / 警告{" "}
                            <strong className="text-amber-600">{run.counts.warn}</strong>{" "}
                            / 提示 {run.counts.info}
                          </span>
                          <span className="text-gray-400">{run.actor.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })
      )}

      <p className="text-xs text-gray-500">
        当前支持的状态与严重级取值见 MCP 资源{" "}
        <code className="font-mono">ditto://statuses</code>。
      </p>
    </div>
  );
}
