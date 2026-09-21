import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/badge";
import { ActionForm, SubmitButton } from "@/components/impl/action-form";
import { actionCreateProject } from "../actions";
import { consoleActor } from "@/lib/core/actors";
import { createContext } from "@/lib/core/ops/context";
import { resolveWorkspaceRoot } from "@/lib/core/store/paths";
import { listProjects } from "@/lib/core/ops/project-ops";
import { listAssets } from "@/lib/core/ops/asset-ops";
import { listCapabilities } from "@/lib/core/ops/template-ops";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const root = resolveWorkspaceRoot();
  const ctx = createContext(root, consoleActor("控制台用户"));

  const projects = listProjects(ctx);
  const capabilities = listCapabilities(ctx);
  const hasGeneral = capabilities.some((c) => c.id === "general");

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">项目</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          项目是平台的中心：资产属于项目，规则挂载在项目上，审批发生在项目内
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">新建项目</CardTitle>
          <CardDescription>
            建项目时请一次把变量补齐 —— 少填一步就会生成出一批带占位符的资产，之后要逐个返工。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={actionCreateProject} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="项目名称" required>
                <Input name="name" placeholder="例如：某某银行 CRM 实施" required />
              </Field>
              <Field label="客户名称" required>
                <Input name="customer" placeholder="例如：某某银行" required />
              </Field>
              <Field label="项目编号">
                <Input name="code" placeholder="留空则自动生成" />
              </Field>
              <Field label="责任人">
                <Input name="owner" placeholder="例如：张三" />
              </Field>
              <Field label="访问域名" hint="占位域名会被规则拦下">
                <Input name="var.domain" placeholder="crm.example-bank.cn" />
              </Field>
              <Field label="目标环境">
                <Input name="var.env.name" placeholder="prod / staging / test / dev" />
              </Field>
              <Field label="应用版本">
                <Input name="var.app.version" placeholder="1.0.0" />
              </Field>
              <Field label="运维联系人">
                <Input name="var.ops.contact" placeholder="例如：李四" />
              </Field>
            </div>

            <Field label="项目描述">
              <Input name="description" placeholder="选填" />
            </Field>

            <div className="space-y-1">
              <Field label="操作者署名" hint="仅用于审计留痕，不是身份认证">
                <Input name="actor" placeholder="你的名字" />
              </Field>
            </div>

            <SubmitButton size="md">
              {hasGeneral ? "创建项目（自动挂载通用底座）" : "创建项目"}
            </SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">全部项目（{projects.length}）</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {projects.length === 0 ? (
            <p className="text-sm text-gray-500">
              还没有项目。用上面的表单创建第一个。
            </p>
          ) : (
            projects.map((p) => {
              const assets = listAssets(ctx, p.id);
              const released = assets.filter((a) => a.status === "released").length;
              return (
                <Link
                  key={p.id}
                  href={`/impl/projects/${p.id}`}
                  className="block rounded-md border border-gray-200 dark:border-gray-800 p-3 hover:border-blue-400 dark:hover:border-blue-600 transition-colors"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{p.name}</div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        编号 {p.code} · 客户 {p.customer} · {released}/{assets.length} 已发布
                        {p.capabilityPackageIds.length > 0 &&
                          ` · 能力包 ${p.capabilityPackageIds.join("、")}`}
                      </div>
                    </div>
                    <StatusBadge status={p.status} />
                  </div>
                </Link>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Field({
  label,
  children,
  required,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  required?: boolean;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium mb-1.5">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </span>
      {children}
      {hint && <span className="block text-xs text-gray-500 mt-1">{hint}</span>}
    </label>
  );
}
