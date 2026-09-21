/**
 * Ditto 实施平台 - 项目与资产类 MCP 工具
 *
 * 全部只是 lib/core/ops 的薄壳：zod 进 → 文本出。
 * 任何业务逻辑都不许写在这一层（否则控制台与 MCP 的审计会分叉）。
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ASSET_FORMATS, ASSET_KINDS } from "../../core/types";
import type { OpContext } from "../../core/ops/context";
import {
  createProject,
  getProject,
  installBuiltinCapability,
  listProjects,
  projectOverview,
  transitionProject,
  updateProject,
} from "../../core/ops/project-ops";
import {
  createAsset,
  deleteAsset,
  listAssets,
  listVersions,
  readAssetContent,
  reviseAsset,
  updateAsset,
} from "../../core/ops/asset-ops";
import { projectReleaseBlockers, releaseAsset } from "../../core/ops/approval-ops";
import { diffLines, exportProject } from "../../core/ops/delivery-ops";
import { buildHandoff } from "../../core/ops/handoff";
import { workspaceInfo } from "../../core/store/workspace";
import { handle, ok, field, heading, list, truncate } from "../result";

const kindEnum = z.enum(ASSET_KINDS as unknown as [string, ...string[]]);
const formatEnum = z.enum(ASSET_FORMATS as unknown as [string, ...string[]]);

/* ------------------------------------------------------------------ */

export function registerOrientationTools(server: McpServer, ctx: OpContext): void {
  server.registerTool(
    "ditto_workspace_info",
    {
      title: "工作区概览",
      description: "查看当前工作区路径、Schema 版本与各项统计。首次接入时用它确认工作区位置是否正确。",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    handle(() => {
      const info = workspaceInfo(ctx.root);
      return ok(
        [
          "工作区信息",
          field("根目录", info.root),
          field("已初始化", info.initialized ? "是" : "否（请调用 ditto_workspace_init）"),
          field("Schema 版本", info.schemaVersion),
          heading("统计"),
          field("项目数", info.counts.projects),
          field("能力包", info.counts.capabilities),
          field("工作区规则包", info.counts.rulepacks),
        ].join("\n")
      );
    })
  );

  server.registerTool(
    "ditto_workspace_init",
    {
      title: "初始化工作区",
      description:
        "创建工作区目录并安装内置能力包。幂等：重复调用不会覆盖你已修改过的能力包文件。",
      inputSchema: {},
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    handle(() => {
      const r = installBuiltinCapability(ctx, "general");
      const info = workspaceInfo(ctx.root);
      return ok(
        [
          r.installed ? "✓ 已安装内置能力包「通用底座」" : "· 内置能力包已存在，未覆盖",
          field("工作区", info.root),
          field("能力包总数", info.counts.capabilities),
        ].join("\n")
      );
    })
  );

  server.registerTool(
    "ditto_handoff",
    {
      title: "上下文交接（推荐首先调用）",
      description:
        "一次调用拿全当前状态：工作区、能力包与所需变量、项目与资产清单、每个资产的规则结论与审批状态，以及由状态机算出的「下一步该做什么」。接入后建议第一个调用它，避免多轮探索把上下文读歪。",
      inputSchema: {
        projectId: z.string().optional().describe("项目 id；不传则返回项目列表"),
        includeAssetContent: z.boolean().optional().describe("是否内联资产正文（注意上下文体积）"),
        maxBytesPerAsset: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    handle((args) => {
      const handoff = buildHandoff(ctx, {
        projectId: args.projectId,
        includeAssetContent: args.includeAssetContent,
        maxBytesPerAsset: args.maxBytesPerAsset,
      });
      return ok(renderHandoff(handoff));
    })
  );
}

function renderHandoff(h: ReturnType<typeof buildHandoff>): string {
  const lines: string[] = [];

  lines.push("工作区", field("根目录", h.workspace.root), field("已初始化", h.workspace.initialized));
  lines.push("", "当前操作者", field("身份", `${h.actor.name}（${h.actor.type} · ${h.actor.via}）`));

  if (h.capabilities.length > 0) {
    lines.push("", "已安装能力包");
    for (const c of h.capabilities) {
      lines.push(`  · ${c.name}（${c.id} v${c.version}）平台：${c.platforms.join("/")}`);
      for (const v of c.vars) {
        lines.push(`      - ${v.key}（${v.label}）${v.required ? "必填" : "可选"}${v.default !== undefined ? `，默认 ${v.default}` : ""}`);
      }
    }
  }

  if (h.projects) {
    lines.push("", `项目列表（${h.projects.length}）`);
    lines.push(
      list(
        h.projects.map(
          (p) => `${p.id}｜${p.name}｜${p.customer}｜${p.status}｜${p.assetCount} 个资产`
        ),
        "还没有任何项目。用 ditto_project_create 创建第一个。"
      )
    );
  }

  if (h.project) {
    const p = h.project;
    lines.push("", `项目：${p.name}（${p.id}）`);
    lines.push(
      field("编号", p.code),
      field("客户", p.customer),
      field("状态", p.status),
      field("责任人", p.owner),
      field("平台", p.platforms.join("/")),
      field("已挂载能力包", p.capabilityPackageIds.join("、")),
      field("允许 AI 审批", p.settings.allowAiApproval ? "是" : "否"),
      field("要求审批人不同于提交人", p.settings.requireDistinctApprover ? "是" : "否")
    );

    const vars = Object.entries(p.vars);
    lines.push("", "项目变量");
    lines.push(list(vars.map(([k, v]) => `${k} = ${v}`), "（尚未设置任何变量）"));

    if (h.assets) {
      lines.push("", `资产（${h.assets.length}）`);
      if (h.assets.length === 0) {
        lines.push("  （还没有资产，可用 ditto_template_apply 从能力包生成）");
      }
      for (const a of h.assets) {
        const run = a.lastRun
          ? `｜上次规则 ${a.lastRun.stale ? "（已过期）" : ""}阻断${a.lastRun.counts.error}/警告${a.lastRun.counts.warn}`
          : "｜未执行规则";
        lines.push(`  · ${a.path}｜${a.kind}/${a.format}｜${a.status}｜v${a.version} rev${a.rev}${run}`);
      }
    }

    if (h.counts) {
      lines.push("", "状态统计");
      lines.push(list(Object.entries(h.counts.byStatus).map(([k, v]) => `${k}: ${v}`)));
      lines.push(
        `  当前有效的规则结论：阻断 ${h.counts.bySeverity.error} / 警告 ${h.counts.bySeverity.warn} / 提示 ${h.counts.bySeverity.info}`
      );
    }

    if (h.rulePacks) {
      lines.push("", "生效的规则包");
      lines.push(list(h.rulePacks.map((r) => `${r.name}（${r.id}）${r.ruleCount} 条规则`)));
    }

    if (h.nextActions && h.nextActions.length > 0) {
      lines.push("", "建议的下一步");
      for (const a of h.nextActions) {
        lines.push(`  · [${a.tool}] ${a.action}`);
        lines.push(`      ${a.reason}`);
        if (a.assetPath) lines.push(`      资产：${a.assetPath}`);
      }
    } else {
      lines.push("", "建议的下一步", "  （没有待处理事项）");
    }

    if (h.truncation) lines.push("", `⚠️ ${h.truncation}`);
  }

  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* 项目                                                                */
/* ------------------------------------------------------------------ */

export function registerProjectTools(server: McpServer, ctx: OpContext): void {
  server.registerTool(
    "ditto_project_list",
    {
      title: "项目列表",
      description: "列出工作区内的实施项目，可按状态或关键字过滤。",
      inputSchema: {
        status: z.string().optional().describe("按状态过滤：draft/in_review/approved/released"),
        q: z.string().optional().describe("按名称、编号或客户名模糊匹配"),
      },
      annotations: { readOnlyHint: true },
    },
    handle((args) => {
      const projects = listProjects(ctx, { status: args.status, q: args.q });
      if (projects.length === 0) return ok("没有匹配的项目。");
      return ok(
        `共 ${projects.length} 个项目\n` +
          list(
            projects.map(
              (p) =>
                `${p.id}｜${p.name}｜客户 ${p.customer}｜${p.status}｜更新于 ${p.updatedAt.slice(0, 19)}`
            )
          )
      );
    })
  );

  server.registerTool(
    "ditto_project_create",
    {
      title: "创建实施项目",
      description:
        "新建一个实施项目。创建后即可用 ditto_template_apply 从已挂载的能力包生成交付物骨架。",
      inputSchema: {
        name: z.string().min(1).describe("项目名称，将用于生成项目 id"),
        customer: z.string().min(1).describe("客户名称"),
        code: z.string().optional().describe("项目编号，不传则按 id 生成"),
        description: z.string().optional(),
        owner: z.string().optional().describe("项目责任人"),
        platforms: z.array(z.string()).optional().describe('目标平台，默认 ["generic"]'),
        capabilityPackageIds: z
          .array(z.string())
          .optional()
          .describe("要挂载的能力包 id。不传则自动挂载平台匹配的全部已安装能力包"),
        vars: z.record(z.string(), z.string()).optional().describe("项目变量，如 domain"),
        allowAiApproval: z.boolean().optional().describe("是否允许 AI 客户端审批放行，默认 true"),
      },
      annotations: { readOnlyHint: false },
    },
    handle(async (args) => {
      // 不指定能力包时，自动挂载平台匹配的 —— 否则新项目没有任何规则约束
      let capIds = args.capabilityPackageIds;
      if (!capIds) {
        const { loadCapabilities } = await import("../../capabilities/loader");
        const platforms = args.platforms ?? ["generic"];
        capIds = loadCapabilities(ctx.root)
          .filter((c) => {
            const cp = c.manifest.platforms;
            return cp.length === 0 || cp.some((p) => platforms.includes(p) || p === "generic");
          })
          .map((c) => c.manifest.id);
      }

      const { project, mountedCapabilities } = await createProject(ctx, {
        name: args.name,
        customer: args.customer,
        code: args.code,
        description: args.description,
        owner: args.owner,
        platforms: args.platforms,
        capabilityPackageIds: capIds,
        vars: args.vars,
        settings:
          args.allowAiApproval === undefined ? undefined : { allowAiApproval: args.allowAiApproval },
      });

      return ok(
        [
          `✓ 已创建项目「${project.name}」`,
          field("项目 id", project.id),
          field("编号", project.code),
          field("客户", project.customer),
          field("状态", project.status),
          field("已挂载能力包", mountedCapabilities.join("、") || "（无）"),
          "",
          "下一步：用 ditto_template_apply 生成交付物骨架，或 ditto_handoff 查看建议动作。",
        ].join("\n")
      );
    })
  );

  server.registerTool(
    "ditto_project_get",
    {
      title: "查看项目",
      description: "查看项目详情与资产清单。需要完整上下文（含规则结论与下一步）时请用 ditto_handoff。",
      inputSchema: { projectId: z.string().describe("项目 id") },
      annotations: { readOnlyHint: true },
    },
    handle((args) => {
      const { project, assets } = projectOverview(ctx, args.projectId);
      const lines = [
        `项目：${project.name}（${project.id}）`,
        field("编号", project.code),
        field("客户", project.customer),
        field("状态", project.status),
        field("责任人", project.owner),
        field("描述", project.description),
        heading("变量"),
        list(
          Object.entries(project.vars).map(([k, v]) => `${k} = ${v}`),
          "（尚未设置）"
        ),
        heading(`资产（${assets.length}）`),
        list(
          assets.map((a) => `${a.id}｜${a.path}｜${a.status}｜v${a.currentVersion}`),
          "（无）"
        ),
      ];
      return ok(lines.join("\n"));
    })
  );

  server.registerTool(
    "ditto_project_update",
    {
      title: "更新项目",
      description:
        "更新项目元数据、变量或能力包挂载。变量传空字符串表示删除该变量。改客户名请用 patch.customer，不要另设 customer.name 变量。",
      inputSchema: {
        projectId: z.string(),
        name: z.string().optional(),
        code: z.string().optional(),
        customer: z.string().optional(),
        description: z.string().optional(),
        owner: z.string().optional(),
        tags: z.array(z.string()).optional(),
        vars: z.record(z.string(), z.string()).optional(),
        mountCapabilities: z.array(z.string()).optional().describe("增量挂载能力包"),
        unmountCapabilities: z.array(z.string()).optional(),
        allowAiApproval: z.boolean().optional(),
        requireDistinctApprover: z.boolean().optional(),
        message: z.string().optional().describe("审计说明"),
      },
      annotations: { readOnlyHint: false },
    },
    handle(async (args) => {
      const project = await updateProject(ctx, args.projectId, {
        patch: {
          name: args.name,
          code: args.code,
          customer: args.customer,
          description: args.description,
          owner: args.owner,
          tags: args.tags,
        },
        vars: args.vars,
        mountCapabilities: args.mountCapabilities,
        unmountCapabilities: args.unmountCapabilities,
        settings:
          args.allowAiApproval === undefined && args.requireDistinctApprover === undefined
            ? undefined
            : {
                allowAiApproval: args.allowAiApproval,
                requireDistinctApprover: args.requireDistinctApprover,
              },
        message: args.message,
      });

      return ok(
        [
          `✓ 已更新项目「${project.name}」`,
          field("客户", project.customer),
          field("已挂载能力包", project.capabilityPackageIds.join("、") || "（无）"),
          heading("当前变量"),
          list(Object.entries(project.vars).map(([k, v]) => `${k} = ${v}`), "（无）"),
        ].join("\n")
      );
    })
  );

  server.registerTool(
    "ditto_project_submit",
    {
      title: "提交项目评审",
      description: "把项目从 draft/rejected 置为 in_review，并返回当前闸门状态。",
      inputSchema: { projectId: z.string() },
      annotations: { readOnlyHint: false },
    },
    handle(async (args) => {
      const project = await transitionProject(ctx, args.projectId, "in_review", "提交项目评审");
      const blockers = projectReleaseBlockersFor(ctx, args.projectId);
      return ok(
        [
          `✓ 项目「${project.name}」已提交评审`,
          field("状态", project.status),
          heading("发布前仍需处理"),
          list(blockers, "（无阻塞项，可以调用 ditto_project_release 走放行）"),
        ].join("\n")
      );
    })
  );

  server.registerTool(
    "ditto_project_release",
    {
      title: "项目放行 / 驳回",
      description:
        "对项目级发布做审批决策。放行前会重新计算全部规则（不信任存量结论），并要求所有资产均已批准或发布。",
      inputSchema: {
        projectId: z.string(),
        decision: z.enum(["approved", "rejected"]),
        reason: z.string().optional(),
        overrides: z
          .array(z.object({ ruleId: z.string(), reason: z.string() }))
          .optional()
          .describe("逐条豁免（需理由）。先调 ditto_gate_check 拿到需要豁免的规则 id"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    handle(async (args) => {
      const { decideApproval } = await import("../../core/ops/approval-ops");
      const r = await decideApproval(ctx, {
        projectId: args.projectId,
        decision: args.decision,
        reason: args.reason,
        overrides: args.overrides,
      });
      return ok(
        [
          `✓ 项目「${r.project.name}」${args.decision === "approved" ? "已放行" : "已驳回"}`,
          field("状态", r.project.status),
          field("审批单", r.approval.id),
          field("豁免条数", r.approval.overrides.length),
        ].join("\n")
      );
    })
  );

  server.registerTool(
    "ditto_project_export",
    {
      title: "导出交付包",
      description:
        "把已发布的资产导出为交付目录，并生成固化了规则结论与审批记录的交付清单。只有已发布的资产会进包。",
      inputSchema: {
        projectId: z.string(),
        releasedOnly: z.boolean().optional().describe("默认 true；设为 false 可导出全部资产用于中期评审"),
        includeVersions: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false },
    },
    handle((args) => {
      const r = exportProject(ctx, {
        projectId: args.projectId,
        releasedOnly: args.releasedOnly,
        includeVersions: args.includeVersions,
      });
      return ok(
        [
          `✓ 已导出 ${r.fileCount} 个文件`,
          field("目录", r.dir),
          field("交付清单", r.manifestPath),
          field("客户", r.manifest.project.customer),
          heading("包含的资产"),
          list(r.manifest.entries.map((e) => `${e.path}｜${e.status}｜v${e.version}`)),
          r.skipped.length > 0
            ? `${heading("跳过")}\n${list(r.skipped.map((s) => `${s.path}：${s.reason}`))}`
            : "",
        ]
          .filter(Boolean)
          .join("\n")
      );
    })
  );
}

function projectReleaseBlockersFor(ctx: OpContext, projectId: string): string[] {
  return projectReleaseBlockers(ctx, getProject(ctx, projectId));
}

/* ------------------------------------------------------------------ */
/* 资产                                                                */
/* ------------------------------------------------------------------ */

export function registerAssetTools(server: McpServer, ctx: OpContext): void {
  server.registerTool(
    "ditto_asset_list",
    {
      title: "资产清单",
      description: "列出项目下的实施资产，可按类型、状态、格式或路径前缀过滤。",
      inputSchema: {
        projectId: z.string(),
        kind: kindEnum.optional(),
        status: z.string().optional(),
        format: formatEnum.optional(),
        pathPrefix: z.string().optional().describe('路径前缀，如 "docs"'),
      },
      annotations: { readOnlyHint: true },
    },
    handle((args) => {
      const assets = listAssets(ctx, args.projectId, {
        kind: args.kind as never,
        status: args.status,
        format: args.format as never,
        pathPrefix: args.pathPrefix,
      });
      if (assets.length === 0) return ok("没有匹配的资产。");
      return ok(
        `共 ${assets.length} 个资产\n` +
          list(
            assets.map(
              (a) => `${a.id}｜${a.path}｜${a.kind}/${a.format}｜${a.status}｜v${a.currentVersion} rev${a.rev}`
            )
          )
      );
    })
  );

  server.registerTool(
    "ditto_asset_get",
    {
      title: "读取资产",
      description:
        "按 id 或逻辑路径读取资产正文本。默认不内联内容（返回元数据），需要正文请把 includeContent 设为 true。",
      inputSchema: {
        projectId: z.string(),
        assetId: z.string().optional(),
        path: z.string().optional().describe("逻辑路径，与 assetId 二选一"),
        version: z.number().int().positive().optional().describe("读取历史版本，默认当前版本"),
        includeContent: z.boolean().optional().describe("是否返回正文，默认 false"),
      },
      annotations: { readOnlyHint: true },
    },
    handle((args) => {
      const c = readAssetContent(ctx, args.projectId, { assetId: args.assetId, path: args.path }, args.version);
      const a = c.asset;

      const lines = [
        `资产：${a.path}`,
        field("id", a.id),
        field("名称", a.name),
        field("类型", `${a.kind} / ${a.format}`),
        field("状态", a.status),
        field("版本", `v${a.currentVersion}（rev ${a.rev}）`),
        field("大小", `${a.size} 字节`),
        field("哈希", a.hash),
        field("责任人", a.owner),
        field("来源模板", a.templateId),
        field("依赖", a.dependsOn.join("、")),
      ];

      if (args.includeContent) {
        if (a.isBinary) {
          lines.push(heading("正文"), "  （二进制资产，不内联返回）");
        } else {
          lines.push(heading(`正文（v${c.version}）`), truncate(c.text ?? "", 20000));
        }
      } else {
        lines.push("", `（未内联正文；需要时把 includeContent 设为 true，或用资源 ditto://asset/${a.id} 读取）`);
      }

      return ok(lines.join("\n"));
    })
  );

  server.registerTool(
    "ditto_asset_create",
    {
      title: "新建资产",
      description: "在项目中新建一个实施资产。路径为项目内相对路径，如 docs/01-方案.md。",
      inputSchema: {
        projectId: z.string(),
        path: z.string().describe("项目内相对路径"),
        content: z.string().describe("正文；二进制资产用 base64"),
        encoding: z.enum(["utf-8", "base64"]).optional(),
        name: z.string().optional(),
        kind: kindEnum.optional(),
        format: formatEnum.optional(),
        owner: z.string().optional(),
        tags: z.array(z.string()).optional(),
        message: z.string().optional().describe("审计说明"),
      },
      annotations: { readOnlyHint: false },
    },
    handle(async (args) => {
      const r = await createAsset(ctx, args.projectId, {
        path: args.path,
        content: args.content,
        encoding: args.encoding,
        name: args.name,
        kind: args.kind as never,
        format: args.format as never,
        owner: args.owner,
        tags: args.tags,
        message: args.message,
      });
      return ok(
        [
          `✓ 已创建资产「${r.asset.path}」`,
          field("id", r.asset.id),
          field("状态", r.asset.status),
          field("版本", `v${r.asset.currentVersion} rev${r.asset.rev}`),
          field("哈希", r.asset.hash),
          "",
          "下一步：用 ditto_rule_run 做规则自检。",
        ].join("\n")
      );
    })
  );

  server.registerTool(
    "ditto_asset_update",
    {
      title: "更新资产",
      description:
        "更新资产正文或元数据。内容变化会产生新版本并回到 draft。传入 expectedRev 可避免覆盖别人的修改。已发布的资产不能直接编辑，需先 ditto_asset_revise。",
      inputSchema: {
        projectId: z.string(),
        assetId: z.string().optional(),
        path: z.string().optional(),
        content: z.string().optional(),
        encoding: z.enum(["utf-8", "base64"]).optional(),
        name: z.string().optional(),
        owner: z.string().optional(),
        tags: z.array(z.string()).optional(),
        dependsOn: z.array(z.string()).optional(),
        message: z.string().optional(),
        expectedRev: z.number().int().optional().describe("乐观并发：不匹配则拒绝"),
      },
      annotations: { readOnlyHint: false },
    },
    handle(async (args) => {
      const r = await updateAsset(ctx, args.projectId, {
        assetId: args.assetId,
        path: args.path,
        content: args.content,
        encoding: args.encoding,
        message: args.message,
        expectedRev: args.expectedRev,
        patch:
          args.name === undefined &&
          args.owner === undefined &&
          args.tags === undefined &&
          args.dependsOn === undefined
            ? undefined
            : {
                name: args.name,
                owner: args.owner,
                tags: args.tags,
                dependsOn: args.dependsOn,
              },
      });
      return ok(
        [
          `✓ 已更新「${r.asset.path}」`,
          field("内容是否变化", r.contentChanged ? "是" : "否（内容与现状一致）"),
          field("版本", `v${r.asset.currentVersion} rev${r.asset.rev}`),
          field("状态", r.asset.status),
        ].join("\n")
      );
    })
  );

  server.registerTool(
    "ditto_asset_revise",
    {
      title: "改版已发布资产",
      description:
        "把已发布/已废弃的资产重新打开为 draft 以便继续编辑。已发布内容不会丢失，仍归档在版本历史中。",
      inputSchema: {
        projectId: z.string(),
        assetId: z.string(),
        reason: z.string().optional(),
      },
      annotations: { readOnlyHint: false },
    },
    handle(async (args) => {
      const a = await reviseAsset(ctx, args.projectId, args.assetId, args.reason);
      return ok(
        [
          `✓ 资产「${a.path}」已改版`,
          field("状态", a.status),
          field("当前版本", `v${a.currentVersion} rev${a.rev}`),
          "（原已发布版本仍保留在版本历史中）",
        ].join("\n")
      );
    })
  );

  server.registerTool(
    "ditto_asset_release",
    {
      title: "发布资产",
      description: "把已批准的资产置为已发布。只有已发布的资产会进入交付包。",
      inputSchema: { projectId: z.string(), assetId: z.string() },
      annotations: { readOnlyHint: false },
    },
    handle(async (args) => {
      const a = await releaseAsset(ctx, args.projectId, args.assetId);
      return ok(
        [`✓ 已发布「${a.path}」`, field("状态", a.status), field("版本", `v${a.currentVersion}`)].join(
          "\n"
        )
      );
    })
  );

  server.registerTool(
    "ditto_asset_delete",
    {
      title: "删除资产",
      description: "默认软删除（标记为已废弃）；hard=true 会物理删除文件与全部版本历史，不可恢复。",
      inputSchema: {
        projectId: z.string(),
        assetId: z.string().optional(),
        path: z.string().optional(),
        hard: z.boolean().optional().describe("默认 false"),
        reason: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    handle(async (args) => {
      const r = await deleteAsset(ctx, args.projectId, {
        assetId: args.assetId,
        path: args.path,
        hard: args.hard,
        reason: args.reason,
      });
      return ok(
        [
          r.hard ? `✓ 已物理删除「${r.asset.path}」` : `✓ 已废弃「${r.asset.path}」`,
          r.hard ? "（文件与版本历史均已删除，不可恢复）" : "（可随时通过改版恢复编辑）",
        ].join("\n")
      );
    })
  );

  server.registerTool(
    "ditto_asset_history",
    {
      title: "资产版本历史",
      description: "列出资产的全部版本快照。",
      inputSchema: {
        projectId: z.string(),
        assetId: z.string().optional(),
        path: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    handle((args) => {
      const versions = listVersions(ctx, args.projectId, {
        assetId: args.assetId,
        path: args.path,
      });
      if (versions.length === 0) return ok("该资产还没有版本记录。");
      return ok(
        `共 ${versions.length} 个版本\n` +
          list(
            versions.map(
              (v) =>
                `v${v.version}（rev${v.rev}）｜${v.createdAt.slice(0, 19)}｜${v.author.name}｜${v.message}` +
                (v.approvalId ? `｜审批 ${v.approvalId}` : "")
            )
          )
      );
    })
  );

  server.registerTool(
    "ditto_asset_diff",
    {
      title: "版本差异",
      description: "比较资产两个版本的正文差异。",
      inputSchema: {
        projectId: z.string(),
        assetId: z.string().optional(),
        path: z.string().optional(),
        fromVersion: z.number().int().positive(),
        toVersion: z.number().int().positive().optional().describe("默认当前版本"),
      },
      annotations: { readOnlyHint: true },
    },
    handle((args) => {
      const ref = { assetId: args.assetId, path: args.path };
      const from = readAssetContent(ctx, args.projectId, ref, args.fromVersion);
      const to = args.toVersion
        ? readAssetContent(ctx, args.projectId, ref, args.toVersion)
        : readAssetContent(ctx, args.projectId, ref);

      if (from.text === null || to.text === null) {
        return ok("二进制资产不支持文本差异比较。");
      }

      const lines = diffLines(from.text, to.text);
      const changed = lines.filter((l) => l.type !== "same");
      const body = lines
        .filter((l) => l.type !== "same")
        .slice(0, 100)
        .map((l) => `${l.type === "add" ? "+" : "-"} ${l.text}`)
        .join("\n");

      return ok(
        [
          `资产「${from.asset.path}」v${from.version} → v${to.version}`,
          field("新增行", lines.filter((l) => l.type === "add").length),
          field("删除行", lines.filter((l) => l.type === "del").length),
          heading("差异"),
          body || "  （无差异）",
          changed.length > 100 ? `\n…（仅显示前 100 行，共 ${changed.length} 行变化）` : "",
        ].join("\n")
      );
    })
  );
}
