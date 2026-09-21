import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { consoleActor } from "@/lib/core/actors";
import { createContext } from "@/lib/core/ops/context";
import { resolveWorkspaceRoot } from "@/lib/core/store/paths";
import { listProjects } from "@/lib/core/ops/project-ops";
import { pendingApprovals } from "@/lib/core/ops/approval-ops";
import { listApprovals } from "@/lib/core/store/approvals";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const root = resolveWorkspaceRoot();
  const ctx = createContext(root, consoleActor("控制台用户"));
  const projects = listProjects(ctx);

  const pending = projects.flatMap((p) =>
    pendingApprovals(ctx, p.id).map((x) => ({ project: p, ...x }))
  );

  const history = projects
    .flatMap((p) =>
      listApprovals(root, p.id).map((a) => ({ project: p, approval: a }))
    )
    .sort((a, b) => b.approval.createdAt.localeCompare(a.approval.createdAt));

  const totalOverrides = history.reduce(
    (sum, h) => sum + h.approval.overrides.length,
    0
  );

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">审批</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          闸门在放行时刻重新计算规则。存量结论只是证据，不是权威。
        </p>
      </header>

      <Card className="border-amber-200 dark:border-amber-900">
        <CardHeader>
          <CardTitle className="text-base">关于豁免与身份</CardTitle>
          <CardDescription>两件需要说清楚的事</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-gray-600 dark:text-gray-400 space-y-2">
          <p>
            <strong>豁免</strong>：error 与 warn 默认都阻断。要放行就必须逐条给出豁免理由，
            理由会写入审计流水并固化进交付清单 ——
            豁免是留给「确认可接受」的，不是留给「懒得处理」的。
          </p>
          <p>
            <strong>身份</strong>：审批人署名来自客户端自报，
            <strong>不构成安全边界</strong>，仅用于流程留痕。
            真正的鉴权（OAuth / 反向代理 SSO）不在本平台范围内。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">待办（{pending.length}）</CardTitle>
          <CardDescription>处于评审中的资产</CardDescription>
        </CardHeader>
        <CardContent>
          {pending.length === 0 ? (
            <p className="text-sm text-gray-500">当前没有待办。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>资产</TableHead>
                  <TableHead>项目</TableHead>
                  <TableHead className="w-32">闸门</TableHead>
                  <TableHead>需豁免规则</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pending.map((p) => (
                  <TableRow key={p.asset.id}>
                    <TableCell>
                      <Link
                        href={`/impl/assets/${p.asset.id}`}
                        className="font-mono text-xs hover:underline"
                      >
                        {p.asset.path}
                      </Link>
                    </TableCell>
                    <TableCell className="text-xs">{p.project.name}</TableCell>
                    <TableCell>
                      {p.gate.blocked ? (
                        <Badge tone="red">被拦</Badge>
                      ) : (
                        <Badge tone="green">可放行</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs font-mono text-gray-500">
                      {p.gate.missingWaiverRuleIds.join("、") || "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">历史审批（{history.length}）</CardTitle>
          <CardDescription>
            全部豁免合计 {totalOverrides} 条 —— 这个数字在交付清单里也会出现
          </CardDescription>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-sm text-gray-500">还没有审批记录。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-40">时间</TableHead>
                  <TableHead className="w-20">结论</TableHead>
                  <TableHead className="w-28">对象</TableHead>
                  <TableHead>审批人</TableHead>
                  <TableHead>说明 / 豁免</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.slice(0, 50).map((h) => (
                  <TableRow key={h.approval.id}>
                    <TableCell className="text-xs text-gray-400">
                      {h.approval.createdAt.slice(0, 19).replace("T", " ")}
                    </TableCell>
                    <TableCell>
                      <Badge
                        tone={h.approval.decision === "approved" ? "green" : "red"}
                      >
                        {h.approval.decision === "approved" ? "放行" : "驳回"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">
                      {h.approval.assetId ? "资产" : "项目"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {h.approval.actor.name}
                      <span className="text-gray-400">
                        （{h.approval.actor.via}）
                      </span>
                    </TableCell>
                    <TableCell className="text-xs">
                      {h.approval.reason && (
                        <div className="text-gray-600 dark:text-gray-400">
                          {h.approval.reason}
                        </div>
                      )}
                      {h.approval.overrides.length > 0 && (
                        <div className="mt-0.5 text-amber-700 dark:text-amber-400">
                          豁免 {h.approval.overrides.length} 条：
                          {h.approval.overrides.map((o) => o.ruleId).join("、")}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
