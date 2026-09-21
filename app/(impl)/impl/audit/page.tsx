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
import { resolveWorkspaceRoot, workspacePaths } from "@/lib/core/store/paths";
import { queryAudit, verifyAudit } from "@/lib/core/store/audit";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const root = resolveWorkspaceRoot();
  const auditDir = workspacePaths(root).auditDir;

  const entries = queryAudit(auditDir, { limit: 200 });
  const chain = verifyAudit(auditDir);

  const byAction = new Map<string, number>();
  for (const e of entries) {
    byAction.set(e.action, (byAction.get(e.action) ?? 0) + 1);
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">审计</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          按月分片追加写，条目带哈希链：hash = sha256(prevHash + 规范化条目)
        </p>
      </header>

      <Card
        className={
          chain.ok
            ? "border-green-200 dark:border-green-900"
            : "border-red-300 dark:border-red-900"
        }
      >
        <CardHeader>
          <CardTitle className="text-base">
            {chain.ok ? "哈希链完好" : "哈希链已断裂"}
          </CardTitle>
          <CardDescription>
            任何条目被篡改、或在中间被删除，都会在断链处报出
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex gap-4">
            <span>
              记录数 <strong className="tabular-nums">{chain.total}</strong>
            </span>
            {!chain.ok && (
              <>
                <span className="text-red-600">
                  首个断点 #{chain.brokenAtSeq}
                </span>
                <span className="text-red-600">{chain.reason}</span>
              </>
            )}
          </div>
          <div className="text-xs text-gray-500 font-mono break-all">
            {auditDir}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">动作分布</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {Array.from(byAction.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([action, count]) => (
              <Badge key={action} tone="gray">
                <span className="font-mono">{action}</span>
                <span className="ml-1.5 tabular-nums">{count}</span>
              </Badge>
            ))}
          {byAction.size === 0 && (
            <span className="text-sm text-gray-500">还没有操作记录。</span>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            流水（最近 {entries.length} 条）
          </CardTitle>
          <CardDescription>
            审批人身份为客户端自报，仅供留痕
          </CardDescription>
        </CardHeader>
        <CardContent>
          {entries.length === 0 ? (
            <p className="text-sm text-gray-500">还没有任何操作。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-14">#</TableHead>
                  <TableHead className="w-36">时间</TableHead>
                  <TableHead className="w-36">动作</TableHead>
                  <TableHead className="w-40">操作者</TableHead>
                  <TableHead>摘要</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((e) => (
                  <TableRow key={e.seq}>
                    <TableCell className="text-xs text-gray-400 tabular-nums">
                      {e.seq}
                    </TableCell>
                    <TableCell className="text-xs text-gray-500 tabular-nums whitespace-nowrap">
                      {e.at.slice(0, 19).replace("T", " ")}
                    </TableCell>
                    <TableCell className="text-xs font-mono">{e.action}</TableCell>
                    <TableCell className="text-xs">
                      {e.actor.name}
                      <span className="text-gray-400">
                        （{e.actor.type} · {e.actor.via}）
                      </span>
                    </TableCell>
                    <TableCell className="text-xs">
                      {e.summary}
                      {e.details && (
                        <details className="mt-0.5">
                          <summary className="cursor-pointer text-gray-400 text-[11px]">
                            详情
                          </summary>
                          <pre className="mt-1 text-[11px] text-gray-500 whitespace-pre-wrap break-all">
                            {JSON.stringify(e.details, null, 2)}
                          </pre>
                        </details>
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
