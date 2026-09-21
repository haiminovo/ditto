import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge, SeverityBadge, StatusBadge } from "@/components/ui/badge";
import { ActionForm, SubmitButton } from "@/components/impl/action-form";
import {
  actionDecideApproval,
  actionDeleteAsset,
  actionReleaseAsset,
  actionReviseAsset,
  actionRunRules,
  actionSaveAsset,
  actionSubmitForApproval,
} from "../../actions";
import { consoleActor } from "@/lib/core/actors";
import { createContext } from "@/lib/core/ops/context";
import { resolveWorkspaceRoot } from "@/lib/core/store/paths";
import { KIND_LABELS } from "@/lib/core/types";
import { listProjects } from "@/lib/core/ops/project-ops";
import {
  listAssets,
  listVersions,
  readAssetContent,
} from "@/lib/core/ops/asset-ops";
import { gateCheck } from "@/lib/core/ops/rule-ops";
import { effectiveApprovalFor } from "@/lib/core/ops/approval-ops";
import { listRuns } from "@/lib/core/store/runs";

export const dynamic = "force-dynamic";

export default async function AssetPage({
  params,
}: {
  params: { assetId: string };
}) {
  const root = resolveWorkspaceRoot();
  const ctx = createContext(root, consoleActor("控制台用户"));
  const assetId = decodeURIComponent(params.assetId);

  // 资产 id 不含项目信息，需要遍历定位
  let projectId = "";
  for (const p of listProjects(ctx)) {
    if (listAssets(ctx, p.id).some((a) => a.id === assetId)) {
      projectId = p.id;
      break;
    }
  }
  if (!projectId) notFound();

  const asset = listAssets(ctx, projectId).find((a) => a.id === assetId);
  if (!asset) notFound();

  const content = readAssetContent(ctx, projectId, { assetId });
  const versions = listVersions(ctx, projectId, { assetId });
  const gate = gateCheck(ctx, { projectId, assetId });
  const approval = effectiveApprovalFor(ctx, projectId, asset);
  const runs = listRuns(root, projectId).filter((r) => r.assetId === assetId);

  const latestRun = asset.latestRunId
    ? runs.find((r) => r.id === asset.latestRunId) ?? null
    : runs[0] ?? null;
  const runStale =
    latestRun !== null &&
    (latestRun.targetRev !== asset.rev || latestRun.targetHash !== asset.hash);

  const canEdit = asset.status !== "released" && asset.status !== "deprecated";

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Link
            href={`/impl/projects/${projectId}`}
            className="text-xs text-gray-500 hover:underline"
          >
            ← 返回项目
          </Link>
          <h1 className="text-xl font-semibold mt-1 font-mono break-all">
            {asset.path}
          </h1>
          <p className="text-xs text-gray-500 mt-1">
            {KIND_LABELS[asset.kind]} · {asset.format} · v{asset.currentVersion} （rev{" "}
            {asset.rev}） · {asset.size} 字节 · {asset.hash.slice(0, 12)}
          </p>
        </div>
        <StatusBadge status={asset.status} />
      </header>

      {/* ---------------- 闸门与审批 ---------------- */}
      <Card
        className={
          gate.blocked ? "border-red-300 dark:border-red-900" : "border-green-300 dark:border-green-900"
        }
      >
        <CardHeader>
          <CardTitle className="text-base">
            {gate.blocked ? "闸门：当前无法放行" : "闸门：已放行"}
          </CardTitle>
          <CardDescription>
            放行时会重新计算规则（不信任上次结论）
            {runStale && " · 上次规则执行晚于当前版本，结论已过期"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-4 text-sm">
            <span>
              阻断 <strong className="text-red-600">{gate.errors.length}</strong>
            </span>
            <span>
              待豁免{" "}
              <strong className="text-amber-600">{gate.warnings.length}</strong>
            </span>
            <span className="text-gray-500">已豁免 {gate.waived.length}</span>
          </div>

          {gate.errors.length > 0 && (
            <div className="space-y-2">
              {gate.errors.map((f, i) => (
                <div
                  key={i}
                  className="rounded-md bg-red-50 dark:bg-red-950/40 px-3 py-2 text-xs"
                >
                  <div className="flex items-center gap-2">
                    <SeverityBadge severity={f.severity} />
                    <span className="font-mono">{f.ruleId}</span>
                  </div>
                  <div className="mt-1">{f.message}</div>
                  {f.evidence && (
                    <div className="mt-1 text-gray-500 font-mono break-all">
                      证据：{f.evidence}
                    </div>
                  )}
                  {f.remediation && (
                    <div className="mt-1 text-gray-600 dark:text-gray-400">
                      修复：{f.remediation}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {gate.warnings.length > 0 && (
            <div className="space-y-2">
              {gate.warnings.map((f, i) => (
                <div
                  key={i}
                  className="rounded-md bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs"
                >
                  <div className="flex items-center gap-2">
                    <SeverityBadge severity={f.severity} />
                    <span className="font-mono">{f.ruleId}</span>
                  </div>
                  <div className="mt-1">{f.message}</div>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <ActionForm action={actionRunRules} hiddenFields={{ projectId, assetId }}>
              <SubmitButton variant="secondary">执行规则自检</SubmitButton>
            </ActionForm>

            {(asset.status === "draft" || asset.status === "rejected") && (
              <ActionForm
                action={actionSubmitForApproval}
                hiddenFields={{ projectId, assetId }}
              >
                <SubmitButton variant="secondary">提交评审</SubmitButton>
              </ActionForm>
            )}

            {asset.status === "approved" && (
              <ActionForm action={actionReleaseAsset} hiddenFields={{ projectId, assetId }}>
                <SubmitButton>发布</SubmitButton>
              </ActionForm>
            )}

            {!canEdit && (
              <ActionForm action={actionReviseAsset} hiddenFields={{ projectId, assetId }}>
                <SubmitButton variant="secondary">改版以继续编辑</SubmitButton>
              </ActionForm>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ---------------- 审批 ---------------- */}
      {asset.status === "in_review" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">审批决策</CardTitle>
            <CardDescription>
              放行需要通过闸门。仍有警告时，必须逐条填写豁免理由 ——
              理由会写进审计流水与最终交付清单。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={actionDecideApproval} className="space-y-4">
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="assetId" value={assetId} />

              {gate.blocked && (
                <div className="space-y-2">
                  <div className="text-sm font-medium">
                    需要豁免的规则（留空表示不放行）
                  </div>
                  {[...gate.errors, ...gate.warnings]
                    .filter(
                      (f, i, arr) => arr.findIndex((x) => x.ruleId === f.ruleId) === i
                    )
                    .map((f) => (
                      <div key={f.ruleId} className="rounded-md border border-gray-200 dark:border-gray-800 p-2.5">
                        <div className="flex items-center gap-2 text-xs">
                          <SeverityBadge severity={f.severity} />
                          <span className="font-mono">{f.ruleId}</span>
                          <span className="text-gray-500">{f.message}</span>
                        </div>
                        <Input
                          name={`override.${f.ruleId}`}
                          placeholder="填写豁免理由（必填，会永久留痕）"
                          className="mt-2 h-9"
                        />
                      </div>
                    ))}
                </div>
              )}

              <label className="block">
                <span className="block text-sm font-medium mb-1.5">决策说明</span>
                <Input name="reason" placeholder="选填，但建议写清依据" />
              </label>

              <label className="block">
                <span className="block text-sm font-medium mb-1.5">
                  操作者署名（仅留痕，非身份认证）
                </span>
                <Input name="actor" placeholder="你的名字" />
              </label>

              <div className="flex gap-2">
                <button
                  type="submit"
                  name="decision"
                  value="approved"
                  className="inline-flex h-10 items-center justify-center rounded-md bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700"
                >
                  放行
                </button>
                <button
                  type="submit"
                  name="decision"
                  value="rejected"
                  className="inline-flex h-10 items-center justify-center rounded-md bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700"
                >
                  驳回
                </button>
              </div>
            </ActionForm>
          </CardContent>
        </Card>
      )}

      {approval && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">当前有效的审批</CardTitle>
            <CardDescription>
              与资产当前版本匹配（rev {approval.targetRev}）
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm space-y-1">
            <div>
              <Badge tone="green">{approval.decision}</Badge>{" "}
              {approval.actor.name}（{approval.actor.type} · {approval.actor.via}）
            </div>
            {approval.reason && <div className="text-gray-500">{approval.reason}</div>}
            {approval.overrides.length > 0 && (
              <div className="text-xs text-amber-700 dark:text-amber-400 space-y-0.5">
                {approval.overrides.map((o) => (
                  <div key={o.ruleId}>
                    豁免 <span className="font-mono">{o.ruleId}</span>：{o.reason}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ---------------- 正文编辑 ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">正文</CardTitle>
          <CardDescription>
            {canEdit
              ? "保存会产生新版本并把状态回到草稿。"
              : "已发布/已废弃的资产不能直接编辑，请先改版。"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {asset.isBinary ? (
            <p className="text-sm text-gray-500">
              二进制资产（{asset.size} 字节）不支持在控制台编辑。
            </p>
          ) : (
            <ActionForm action={actionSaveAsset} className="space-y-3">
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="assetId" value={assetId} />
              <Textarea
                name="content"
                defaultValue={content.text ?? ""}
                rows={22}
                disabled={!canEdit}
                className="font-mono text-xs leading-relaxed"
              />
              <div className="flex items-center gap-3">
                <SubmitButton size="md">保存正文</SubmitButton>
                <Input name="message" placeholder="本次修改说明（会写入版本历史）" className="h-9 max-w-md" />
              </div>
            </ActionForm>
          )}
        </CardContent>
      </Card>

      {/* ---------------- 版本历史 ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">版本历史（{versions.length}）</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {versions
            .slice()
            .reverse()
            .map((v) => (
              <div key={v.version} className="flex items-start gap-3 text-xs">
                <span className="font-mono w-10 shrink-0">v{v.version}</span>
                <span className="text-gray-400 w-36 shrink-0">
                  {v.createdAt.slice(0, 19).replace("T", " ")}
                </span>
                <span className="text-gray-500 w-24 shrink-0">{v.author.name}</span>
                <span className="min-w-0">
                  {v.message}
                  {v.approvalId && (
                    <span className="text-gray-400"> · 审批 {v.approvalId}</span>
                  )}
                </span>
              </div>
            ))}
        </CardContent>
      </Card>

      {/* ---------------- 规则执行记录 ---------------- */}
      {runs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">规则执行记录（{runs.length}）</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            {runs.slice(0, 8).map((r) => (
              <div key={r.id} className="flex items-center gap-3">
                <span className="text-gray-400 w-36 shrink-0">
                  {r.finishedAt.slice(0, 19).replace("T", " ")}
                </span>
                <span className="font-mono text-gray-500">{r.id}</span>
                <span>
                  阻断 {r.counts.error} / 警告 {r.counts.warn} / 提示 {r.counts.info}
                </span>
                {r.actor.via !== "console" && (
                  <Badge tone="blue">{r.actor.via}</Badge>
                )}
                {r.targetRev !== asset.rev && <Badge tone="gray">已过期</Badge>}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* ---------------- 危险操作 ---------------- */}
      <Card className="border-red-200 dark:border-red-950">
        <CardHeader>
          <CardTitle className="text-base">危险操作</CardTitle>
        </CardHeader>
        <CardContent className="flex gap-2">
          <ActionForm action={actionDeleteAsset} hiddenFields={{ projectId, assetId }}>
            <SubmitButton
              variant="secondary"
              confirm={`将【废弃】资产 ${asset.path}（可改版恢复）。确认？`}
            >
              废弃
            </SubmitButton>
          </ActionForm>
          <ActionForm
            action={actionDeleteAsset}
            hiddenFields={{ projectId, assetId, hard: "1" }}
          >
            <SubmitButton
              variant="destructive"
              confirm={`将【物理删除】资产 ${asset.path} 及其全部版本历史，不可恢复！确认？`}
            >
              物理删除
            </SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>
    </div>
  );
}
