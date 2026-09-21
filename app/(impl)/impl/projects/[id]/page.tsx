import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { ActionForm, SubmitButton } from "@/components/impl/action-form";
import {
  actionApplyTemplate,
  actionDeleteAsset,
  actionExportProject,
  actionReleaseAsset,
  actionReviseAsset,
  actionRunRules,
  actionSaveAsset,
  actionSubmitForApproval,
  actionTransitionProject,
  actionUpdateProjectVars,
} from "../../actions";
import { consoleActor } from "@/lib/core/actors";
import { createContext } from "@/lib/core/ops/context";
import { resolveWorkspaceRoot } from "@/lib/core/store/paths";
import { KIND_LABELS, type Asset } from "@/lib/core/types";
import { getProject } from "@/lib/core/ops/project-ops";
import { listAssets } from "@/lib/core/ops/asset-ops";
import { gateCheck, loadRulePacksForProject } from "@/lib/core/ops/rule-ops";
import { pendingApprovals } from "@/lib/core/ops/approval-ops";
import { capabilitiesForProject } from "@/lib/core/ops/rule-ops";
import { listTemplates } from "@/lib/core/ops/template-ops";

export const dynamic = "force-dynamic";

export default async function ProjectDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const root = resolveWorkspaceRoot();
  const ctx = createContext(root, consoleActor("控制台用户"));

  let project;
  try {
    project = getProject(ctx, decodeURIComponent(params.id));
  } catch {
    notFound();
  }

  const assets = listAssets(ctx, project.id);
  const gate = gateCheck(ctx, { projectId: project.id });
  const pending = pendingApprovals(ctx, project.id);
  const caps = capabilitiesForProject(ctx, project);
  const { packs } = loadRulePacksForProject(ctx, project);

  const templates = listTemplates(ctx);
  const existingPaths = new Set(assets.map((a) => a.path));
  const releasedCount = assets.filter((a) => a.status === "released").length;

  // 变量清单：能力包声明的 + 项目已有的
  const varKeys = new Map<string, { label: string; required: boolean; hint?: string }>();
  for (const cap of caps) {
    for (const v of cap.manifest.vars) {
      varKeys.set(v.key, {
        label: v.label,
        required: v.required === true,
        hint: v.description,
      });
    }
  }
  for (const k of Object.keys(project.vars)) {
    if (!varKeys.has(k)) varKeys.set(k, { label: k, required: false });
  }

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <Link
            href="/impl/projects"
            className="text-xs text-gray-500 hover:underline"
          >
            ← 项目列表
          </Link>
          <h1 className="text-2xl font-semibold mt-1">{project.name}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            编号 {project.code} · 客户 {project.customer} ·{" "}
            {releasedCount}/{assets.length} 已发布
          </p>
        </div>
        <StatusBadge status={project.status} />
      </header>

      {/* ---------------- 闸门状态 ---------------- */}
      <Card
        className={
          gate.blocked
            ? "border-red-300 dark:border-red-900"
            : "border-green-300 dark:border-green-900"
        }
      >
        <CardHeader>
          <CardTitle className="text-base">
            {gate.blocked ? "闸门：当前无法放行" : "闸门：已放行"}
          </CardTitle>
          <CardDescription>
            项目级规则结论（实时重算，不信任历史记录）
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-4 text-sm">
            <span>
              阻断 <strong className="text-red-600">{gate.errors.length}</strong>
            </span>
            <span>
              待豁免警告{" "}
              <strong className="text-amber-600">{gate.warnings.length}</strong>
            </span>
            <span className="text-gray-500">已豁免 {gate.waived.length}</span>
          </div>

          {gate.errors.length > 0 && (
            <div className="space-y-1">
              {gate.errors.slice(0, 5).map((f, i) => (
                <div key={i} className="text-xs">
                  <Badge tone="red">{f.ruleId}</Badge>{" "}
                  <span className="text-gray-600 dark:text-gray-400">
                    {f.assetPath ?? "项目级"} — {f.message}
                  </span>
                </div>
              ))}
              {gate.errors.length > 5 && (
                <div className="text-xs text-gray-500">
                  …另有 {gate.errors.length - 5} 项
                </div>
              )}
            </div>
          )}

          {gate.missingWaiverRuleIds.length > 0 && (
            <div className="text-xs text-gray-500">
              需显式豁免的规则：{gate.missingWaiverRuleIds.join("、")}
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <ActionForm action={actionRunRules} hiddenFields={{ projectId: project.id }}>
              <SubmitButton variant="secondary">执行规则自检</SubmitButton>
            </ActionForm>

            <ActionForm
              action={actionTransitionProject}
              hiddenFields={{ projectId: project.id, to: "in_review" }}
            >
              <SubmitButton variant="secondary">提交项目评审</SubmitButton>
            </ActionForm>

            <ActionForm
              action={actionExportProject}
              hiddenFields={{ projectId: project.id }}
            >
              <SubmitButton variant="secondary">导出交付包</SubmitButton>
            </ActionForm>
          </div>
        </CardContent>
      </Card>

      {/* ---------------- 项目变量 ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">项目变量</CardTitle>
          <CardDescription>
            渲染模板与规则校验共用这一份变量。客户名请改项目的「客户」字段，
            不要另设 customer.name —— 二者是同一样东西。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={actionUpdateProjectVars} className="space-y-4">
            <input type="hidden" name="projectId" value={project.id} />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {Array.from(varKeys.entries()).map(([key, meta]) => (
                <label key={key} className="block">
                  <span className="block text-sm font-medium mb-1.5">
                    {meta.label}
                    <span className="text-xs text-gray-400 ml-1.5 font-normal">
                      {key}
                    </span>
                    {meta.required && <span className="text-red-500 ml-1">*</span>}
                  </span>
                  <Input
                    name={`var.${key}`}
                    defaultValue={project.vars[key] ?? ""}
                    placeholder={meta.hint ?? ""}
                  />
                </label>
              ))}
            </div>
            <div className="text-xs text-gray-500">
              留空表示删除该变量。域名为占位值时会被规则拦下。
            </div>
            <SubmitButton>保存变量</SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>

      {/* ---------------- 从模板生成 ---------------- */}
      {templates.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">从能力包生成资产</CardTitle>
            <CardDescription>
              模板给的是骨架，里面的待填内容需要按项目实情补齐 ——
              刚生成时过不了规则是正常的。已存在的路径需勾选覆盖。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>模板</TableHead>
                  <TableHead>目标路径</TableHead>
                  <TableHead className="w-40">状态</TableHead>
                  <TableHead className="w-32" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {templates.map((t) => {
                  const exists = existingPaths.has(t.targetPath);
                  return (
                    <TableRow key={`${t.capabilityPackageId}:${t.id}`}>
                      <TableCell>
                        <div className="font-medium">{t.name}</div>
                        <div className="text-xs text-gray-500">
                          {KIND_LABELS[t.kind]} · {t.capabilityPackageId}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {t.targetPath}
                      </TableCell>
                      <TableCell>
                        {exists ? (
                          <Badge tone="gray">已存在</Badge>
                        ) : (
                          <Badge tone="blue">未生成</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <ActionForm
                          action={actionApplyTemplate}
                          hiddenFields={{
                            projectId: project.id,
                            templateId: t.id,
                            overwrite: exists ? "1" : "0",
                          }}
                        >
                          <SubmitButton
                            variant="secondary"
                            confirm={exists ? `将按模板覆盖 ${t.targetPath}，未保存的手工修改会丢失。确认？` : undefined}
                          >
                            {exists ? "覆盖生成" : "生成"}
                          </SubmitButton>
                        </ActionForm>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* ---------------- 资产 ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">实施资产（{assets.length}）</CardTitle>
          <CardDescription>
            资产是工作区磁盘上的真实文件。已发布的不能直接编辑，需先改版。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {assets.length === 0 ? (
            <p className="text-sm text-gray-500">还没有资产。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>路径</TableHead>
                  <TableHead className="w-24">类型</TableHead>
                  <TableHead className="w-24">状态</TableHead>
                  <TableHead className="w-20">版本</TableHead>
                  <TableHead className="w-64">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {assets.map((a) => (
                  <AssetRow key={a.id} projectId={project.id} asset={a} />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ---------------- 规则包 ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">生效规则包</CardTitle>
          <CardDescription>
            规则包随能力包挂载；工作区 rulepacks/ 下可放同 id 的包来覆盖
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {packs.map((p) => (
            <div key={p.id} className="flex items-center justify-between">
              <span>
                {p.name}{" "}
                <span className="text-xs text-gray-500 font-mono">{p.id}</span>
              </span>
              <span className="text-xs text-gray-500">{p.rules.length} 条规则</span>
            </div>
          ))}
          {packs.length === 0 && (
            <p className="text-gray-500">
              项目未挂载任何规则包 —— 没有质量约束的项目不允许发布。
            </p>
          )}
        </CardContent>
      </Card>

      {pending.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">待办审批（{pending.length}）</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {pending.map((p) => (
              <Link
                key={p.asset.id}
                href={`/impl/assets/${p.asset.id}`}
                className="flex items-center justify-between hover:underline"
              >
                <span className="font-mono text-xs">{p.asset.path}</span>
                {p.gate.blocked ? (
                  <Badge tone="red">
                    需豁免 {p.gate.missingWaiverRuleIds.length} 条
                  </Badge>
                ) : (
                  <Badge tone="green">可放行</Badge>
                )}
              </Link>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function AssetRow({ projectId, asset }: { projectId: string; asset: Asset }) {
  const canEdit = asset.status !== "released" && asset.status !== "deprecated";

  return (
    <TableRow>
      <TableCell>
        <Link
          href={`/impl/assets/${asset.id}`}
          className="font-mono text-xs hover:underline"
        >
          {asset.path}
        </Link>
        {asset.templateId && (
          <div className="text-[11px] text-gray-400">
            来自模板 {asset.templateId}
          </div>
        )}
      </TableCell>
      <TableCell className="text-xs">{KIND_LABELS[asset.kind]}</TableCell>
      <TableCell>
        <StatusBadge status={asset.status} />
      </TableCell>
      <TableCell className="text-xs tabular-nums">
        v{asset.currentVersion}
        <span className="text-gray-400"> / r{asset.rev}</span>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1.5">
          <ActionForm
            action={actionRunRules}
            hiddenFields={{ projectId, assetId: asset.id }}
          >
            <SubmitButton variant="ghost">跑规则</SubmitButton>
          </ActionForm>

          {(asset.status === "draft" || asset.status === "rejected") && (
            <ActionForm
              action={actionSubmitForApproval}
              hiddenFields={{ projectId, assetId: asset.id }}
            >
              <SubmitButton variant="ghost">提交评审</SubmitButton>
            </ActionForm>
          )}

          {asset.status === "approved" && (
            <ActionForm
              action={actionReleaseAsset}
              hiddenFields={{ projectId, assetId: asset.id }}
            >
              <SubmitButton variant="ghost">发布</SubmitButton>
            </ActionForm>
          )}

          {!canEdit && (
            <ActionForm
              action={actionReviseAsset}
              hiddenFields={{ projectId, assetId: asset.id }}
            >
              <SubmitButton variant="ghost">改版</SubmitButton>
            </ActionForm>
          )}

          <ActionForm
            action={actionDeleteAsset}
            hiddenFields={{ projectId, assetId: asset.id }}
          >
            <SubmitButton
              variant="ghost"
              confirm={`将【废弃】资产 ${asset.path}（可改版恢复）。确认？`}
            >
              废弃
            </SubmitButton>
          </ActionForm>
        </div>
      </TableCell>
    </TableRow>
  );
}
