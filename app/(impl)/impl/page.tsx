import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { SubmitButton, ActionForm } from "@/components/impl/action-form";
import { actionWorkspaceInit } from "./actions";
import { consoleActor } from "@/lib/core/actors";
import { createContext } from "@/lib/core/ops/context";
import { resolveWorkspaceRoot } from "@/lib/core/store/paths";
import { listProjects } from "@/lib/core/ops/project-ops";
import { listAssets } from "@/lib/core/ops/asset-ops";
import { listCapabilities } from "@/lib/core/ops/template-ops";
import { pendingApprovals } from "@/lib/core/ops/approval-ops";
import { queryAudit, verifyAudit } from "@/lib/core/store/audit";
import { workspacePaths } from "@/lib/core/store/paths";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const root = resolveWorkspaceRoot();
  const ctx = createContext(root, consoleActor("控制台用户"));

  const projects = listProjects(ctx);
  const capabilities = listCapabilities(ctx);
  const auditDir = workspacePaths(root).auditDir;
  const recent = queryAudit(auditDir, { limit: 12 });
  const chain = verifyAudit(auditDir);

  const assetTotal = projects.reduce(
    (sum, p) => sum + listAssets(ctx, p.id).length,
    0
  );

  const pending = projects.flatMap((p) =>
    pendingApprovals(ctx, p.id).map((x) => ({ project: p, ...x }))
  );

  const needsInit = capabilities.length === 0;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">工作台</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          以项目为中心，以实施资产为对象，以能力包适配平台，以规则与审批保证交付质量
        </p>
      </header>

      {needsInit && (
        <Card className="border-amber-300 dark:border-amber-800">
          <CardHeader>
            <CardTitle className="text-base">工作区尚未初始化</CardTitle>
            <CardDescription>
              安装内置能力包「通用底座」后即可创建项目。能力包提供交付物模板与配套的质量规则。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={actionWorkspaceInit}>
              <SubmitButton>安装通用底座</SubmitButton>
            </ActionForm>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat label="项目" value={projects.length} href="/impl/projects" />
        <Stat label="资产" value={assetTotal} />
        <Stat label="待审批" value={pending.length} href="/impl/approvals" />
        <Stat label="能力包" value={capabilities.length} href="/impl/capabilities" />
      </div>

      {pending.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">待办审批</CardTitle>
            <CardDescription>
              闸门会在放行时刻重新计算规则。被拦下的需要整改或给出豁免理由。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {pending.slice(0, 6).map((p) => (
              <div
                key={p.asset.id}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <div className="min-w-0">
                  <Link
                    href={`/impl/assets/${p.asset.id}`}
                    className="font-medium hover:underline truncate block"
                  >
                    {p.asset.path}
                  </Link>
                  <span className="text-xs text-gray-500">
                    {p.project.name}
                  </span>
                </div>
                {p.gate.blocked ? (
                  <Badge tone="red">
                    需豁免 {p.gate.missingWaiverRuleIds.length} 条
                  </Badge>
                ) : (
                  <Badge tone="green">可放行</Badge>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">最近活动</CardTitle>
          <CardDescription>
            审计流水带哈希链
            {chain.ok ? (
              <Badge tone="green" className="ml-2">
                链完好（{chain.total} 条）
              </Badge>
            ) : (
              <Badge tone="red" className="ml-2">
                链已断裂 @#{chain.brokenAtSeq}
              </Badge>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="text-sm text-gray-500">还没有任何操作记录。</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {recent.map((e) => (
                <li key={`${e.seq}`} className="flex gap-3">
                  <span className="text-xs text-gray-400 w-32 shrink-0 tabular-nums">
                    {e.at.slice(5, 19).replace("T", " ")}
                  </span>
                  <span className="min-w-0">
                    <span className="font-mono text-xs text-gray-500">
                      {e.action}
                    </span>{" "}
                    {e.summary}
                    <span className="text-xs text-gray-400">
                      {" "}
                      — {e.actor.name}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Link
            href="/impl/audit"
            className="mt-3 inline-block text-sm text-blue-600 dark:text-blue-400 hover:underline"
          >
            查看完整审计 →
          </Link>
        </CardContent>
      </Card>

      {projects.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">项目</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {projects.slice(0, 6).map((p) => {
              const assets = listAssets(ctx, p.id);
              const released = assets.filter((a) => a.status === "released").length;
              return (
                <div key={p.id} className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/impl/projects/${p.id}`}
                      className="font-medium hover:underline"
                    >
                      {p.name}
                    </Link>
                    <div className="text-xs text-gray-500">
                      客户 {p.customer} · {released}/{assets.length} 已发布
                    </div>
                  </div>
                  <StatusBadge status={p.status} />
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  href,
}: {
  label: string;
  value: number;
  href?: string;
}) {
  const body = (
    <Card>
      <CardContent className="p-4">
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        <div className="text-xs text-gray-500 mt-0.5">{label}</div>
      </CardContent>
    </Card>
  );
  return href ? (
    <Link href={href} className="block hover:opacity-80 transition-opacity">
      {body}
    </Link>
  ) : (
    body
  );
}
