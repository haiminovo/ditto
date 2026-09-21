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
import { ActionForm, SubmitButton } from "@/components/impl/action-form";
import { actionWorkspaceInit } from "../actions";
import { consoleActor } from "@/lib/core/actors";
import { createContext } from "@/lib/core/ops/context";
import { resolveWorkspaceRoot } from "@/lib/core/store/paths";
import { listCapabilities, listTemplates } from "@/lib/core/ops/template-ops";
import { KIND_LABELS } from "@/lib/core/types";

export const dynamic = "force-dynamic";

export default async function CapabilitiesPage() {
  const root = resolveWorkspaceRoot();
  const ctx = createContext(root, consoleActor("控制台用户"));

  const capabilities = listCapabilities(ctx);
  const templates = listTemplates(ctx);

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">能力包</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            能力包是平台适配的载体：决定项目能用哪些模板、受哪些规则约束
          </p>
        </div>
        <ActionForm action={actionWorkspaceInit}>
          <SubmitButton variant="secondary">安装内置能力包</SubmitButton>
        </ActionForm>
      </header>

      <Card className="border-blue-200 dark:border-blue-900">
        <CardHeader>
          <CardTitle className="text-base">如何新增一个平台能力包</CardTitle>
          <CardDescription>
            能力包是**数据**，不是代码 —— 加一个 K8s / Linux / 云厂商包不需要改任何代码。
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-gray-600 dark:text-gray-400 space-y-2">
          <p>
            在 <code className="font-mono text-xs">workspace/capabilities/</code>{" "}
            下新建一个目录，放入：
          </p>
          <ul className="list-disc list-inside space-y-1 text-xs font-mono">
            <li>capability.json —— 清单：模板列表、所需变量、规则包引用</li>
            <li>templates/ —— 模板文件，用 {"{{变量}}"} 占位</li>
            <li>rules/ —— 该平台自带的规则包（纯 JSON）</li>
          </ul>
          <p className="text-xs">
            刷新本页即会出现在列表中，无需重启，也无需改一行 TypeScript。
          </p>
        </CardContent>
      </Card>

      {capabilities.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-gray-500">
            尚未安装任何能力包。点击右上角「安装内置能力包」开始。
          </CardContent>
        </Card>
      ) : (
        capabilities.map((c) => {
          const own = templates.filter((t) => t.capabilityPackageId === c.id);
          return (
            <Card key={c.id}>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  {c.name}
                  <span className="text-xs font-mono text-gray-400">{c.id}</span>
                  <Badge tone="blue">v{c.version}</Badge>
                </CardTitle>
                <CardDescription>{c.description}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="text-gray-500">适配平台：</span>
                  {c.platforms.map((p) => (
                    <Badge key={p} tone="gray">
                      {p}
                    </Badge>
                  ))}
                </div>

                <div>
                  <div className="text-sm font-medium mb-2">
                    模板（{own.length}）
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>模板</TableHead>
                        <TableHead>类型</TableHead>
                        <TableHead>目标路径</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {own.map((t) => (
                        <TableRow key={t.id}>
                          <TableCell>
                            <div className="font-medium text-xs">{t.name}</div>
                            <div className="text-[11px] font-mono text-gray-400">
                              {t.id}
                            </div>
                          </TableCell>
                          <TableCell className="text-xs">
                            {KIND_LABELS[t.kind]}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {t.targetPath}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                <div className="text-xs text-gray-500">
                  规则包：{c.rulePackIds.join("、") || "（无）"}
                </div>
              </CardContent>
            </Card>
          );
        })
      )}
    </div>
  );
}
