/**
 * Ditto 实施平台 - 能力包 / 模板 / 规则类 MCP 工具
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { KIND_LABELS, SEVERITY_LABELS } from "../../core/types";
import type { OpContext } from "../../core/ops/context";
import {
  applyTemplate,
  capabilitiesOfProject,
  getCapability,
  listCapabilities,
  listTemplates,
  previewTemplate,
} from "../../core/ops/template-ops";
import { installBuiltinCapability } from "../../core/ops/project-ops";
import {
  getRun,
  loadRulePacksForProject,
  runProjectRules,
  waiveFinding,
} from "../../core/ops/rule-ops";
import { readProject } from "../../core/store/projects";
import { handle, ok, field, heading, list, truncate } from "../result";

export function registerCapabilityTools(server: McpServer, ctx: OpContext): void {
  server.registerTool(
    "ditto_capability_list",
    {
      title: "能力包列表",
      description:
        "列出工作区中已安装的能力包。能力包决定项目能用哪些模板、受哪些规则约束，以及适配哪个平台。",
      inputSchema: {
        platform: z.string().optional().describe("按目标平台过滤"),
        projectId: z.string().optional().describe("只看某个项目已挂载的能力包"),
      },
      annotations: { readOnlyHint: true },
    },
    handle((args) => {
      let caps = args.projectId
        ? capabilitiesOfProject(ctx, args.projectId)
        : listCapabilities(ctx);

      if (args.platform) {
        caps = caps.filter((c) => c.platforms.includes(args.platform!));
      }

      if (caps.length === 0) {
        return ok("没有匹配的能力包。可用 ditto_workspace_init 安装内置能力包。");
      }

      return ok(
        `共 ${caps.length} 个能力包\n` +
          caps
            .map(
              (c) =>
                `  · ${c.name}（${c.id} v${c.version}）\n` +
                `      平台：${c.platforms.join("/")}　模板 ${c.templateCount} 个　规则包 ${c.rulePackIds.length} 个\n` +
                `      ${c.description}`
            )
            .join("\n")
      );
    })
  );

  server.registerTool(
    "ditto_capability_get",
    {
      title: "能力包详情",
      description: "查看能力包的模板清单、所需变量与配套规则包。",
      inputSchema: { capabilityId: z.string() },
      annotations: { readOnlyHint: true },
    },
    handle((args) => {
      const c = getCapability(ctx, args.capabilityId);

      const lines = [
        `${c.name}（${c.id} v${c.version}）`,
        field("平台", c.platforms.join("/")),
        field("说明", c.description),
        heading(`所需变量（${c.vars.length}）`),
        list(
          c.vars.map(
            (v) =>
              `${v.key}（${v.label}）${v.type}${v.required ? " 必填" : ""}` +
              (v.default !== undefined ? ` 默认=${v.default}` : "") +
              (v.allowed ? ` 取值=${v.allowed.join("/")}` : "") +
              (v.description ? `\n        ${v.description}` : "")
          ),
          "（无）"
        ),
        heading(`模板（${c.templates.length}）`),
        list(
          c.templates.map(
            (t) => `${t.id}｜${t.name}｜${KIND_LABELS[t.kind]}｜→ ${t.targetPath}`
          ),
          "（无）"
        ),
        heading(`规则包（${c.rulePackIds.length}）`),
        list(c.rulePackIds),
      ];
      return ok(lines.join("\n"));
    })
  );

  server.registerTool(
    "ditto_capability_install",
    {
      title: "安装能力包",
      description: "安装随平台内置的能力包到工作区。已存在的不会覆盖。",
      inputSchema: {
        capabilityId: z.string().describe('内置能力包 id，目前为 "general"'),
        projectId: z.string().optional().describe("顺带挂载到该项目"),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    handle(async (args) => {
      const r = installBuiltinCapability(ctx, args.capabilityId);

      let mountNote = "";
      if (args.projectId && r.installed) {
        const { updateProject } = await import("../../core/ops/project-ops");
        await updateProject(ctx, args.projectId, {
          mountCapabilities: [args.capabilityId],
          message: `安装并挂载能力包 ${args.capabilityId}`,
        });
        mountNote = `\n✓ 已挂载到项目 ${args.projectId}`;
      }

      return ok(
        (r.installed ? `✓ 已安装能力包「${r.id}」` : `· 能力包「${r.id}」已存在，未覆盖`) + mountNote
      );
    })
  );

  server.registerTool(
    "ditto_template_list",
    {
      title: "模板清单",
      description: "列出能力包提供的交付物模板。",
      inputSchema: { capabilityId: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    handle((args) => {
      const templates = listTemplates(ctx, args.capabilityId);
      if (templates.length === 0) return ok("没有匹配的模板。");
      return ok(
        `共 ${templates.length} 个模板\n` +
          list(
            templates.map(
              (t) =>
                `${t.id}｜${t.name}｜${KIND_LABELS[t.kind]}｜→ ${t.targetPath}　[${t.capabilityPackageId}]`
            )
          )
      );
    })
  );

  server.registerTool(
    "ditto_template_render",
    {
      title: "预览模板渲染结果",
      description:
        "只渲染不落盘，用于确认变量是否齐备、内容是否符合预期。缺变量会一并列出。落盘请用 ditto_template_apply。",
      inputSchema: {
        templateId: z.string(),
        projectId: z.string().optional(),
        capabilityId: z.string().optional(),
        vars: z.record(z.string(), z.string()).optional().describe("临时覆盖项目变量"),
        includeContent: z.boolean().optional().describe("是否返回渲染后的正文，默认 true"),
      },
      annotations: { readOnlyHint: true },
    },
    handle((args) => {
      const p = previewTemplate(ctx, {
        templateId: args.templateId,
        packageId: args.capabilityId,
        projectId: args.projectId,
        vars: args.vars,
      });

      const lines = [
        `模板：${p.name}（${p.templateId}）`,
        field("目标路径", p.path),
        field("类型", `${KIND_LABELS[p.kind]} / ${p.format}`),
        field("能力包", p.capabilityPackageId),
        field("目标路径是否已存在资产", p.existingAssetId ? `是（${p.existingAssetId}）` : "否"),
      ];

      if (p.missingRequired.length > 0) {
        lines.push(
          heading("⚠️ 必填变量缺失（无法落盘）"),
          list(p.missingRequired.map((k) => `${k} —— 用 ditto_project_update 的 vars 补齐`))
        );
      }
      if (p.missingKeys.length > 0) {
        lines.push(
          heading("⚠️ 模板引用了但作用域里没有的变量"),
          list(p.missingKeys)
        );
      }
      if (p.missingRequired.length === 0 && p.missingKeys.length === 0) {
        lines.push("", "✓ 变量齐备，可以直接 ditto_template_apply 落盘");
      }

      if (args.includeContent !== false) {
        lines.push(heading("渲染结果"), truncate(p.content, 8000));
      }

      return ok(lines.join("\n"));
    })
  );

  server.registerTool(
    "ditto_template_apply",
    {
      title: "生成资产（落盘）",
      description:
        "按能力包模板渲染并落盘为资产。变量缺失会明确报错而不会生成半成品。目标路径已存在时需显式 overwrite=true。",
      inputSchema: {
        projectId: z.string(),
        templateId: z.string(),
        capabilityId: z.string().optional(),
        vars: z.record(z.string(), z.string()).optional(),
        overwrite: z.boolean().optional().describe("目标路径已存在时是否按模板重新生成"),
      },
      annotations: { readOnlyHint: false },
    },
    handle(async (args) => {
      const r = await applyTemplate(ctx, {
        projectId: args.projectId,
        templateId: args.templateId,
        packageId: args.capabilityId,
        vars: args.vars,
        overwrite: args.overwrite,
      });

      return ok(
        [
          `${r.created ? "✓ 已生成" : "✓ 已重新生成"}资产「${r.asset.path}」`,
          field("id", r.asset.id),
          field("类型", `${KIND_LABELS[r.asset.kind]} / ${r.asset.format}`),
          field("状态", r.asset.status),
          field("版本", `v${r.asset.currentVersion} rev${r.asset.rev}`),
          "",
          "提示：模板生成的是骨架，通常仍含待填内容，需执行规则自检后逐项补齐。",
        ].join("\n")
      );
    })
  );
}

/* ------------------------------------------------------------------ */

export function registerRuleTools(server: McpServer, ctx: OpContext): void {
  server.registerTool(
    "ditto_rule_list",
    {
      title: "规则清单",
      description: "列出某项目当前生效的全部规则，含检查器类型与修复建议。",
      inputSchema: {
        projectId: z.string(),
        severity: z.enum(["error", "warn", "info"]).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    handle((args) => {
      const project = readProject(ctx.root, args.projectId);
      const { packs, rules } = loadRulePacksForProject(ctx, project);

      const filtered = args.severity
        ? rules.filter((r) => r.severity === args.severity)
        : rules;

      const lines = [
        `项目「${project.name}」生效规则 ${filtered.length} 条（来自 ${packs.length} 个规则包）`,
        heading("规则包"),
        list(packs.map((p) => `${p.name}（${p.id} v${p.version}）${p.rules.length} 条`)),
        heading("规则"),
      ];

      for (const r of filtered) {
        lines.push(
          `  · [${SEVERITY_LABELS[r.severity]}] ${r.id}｜${r.name}` +
            (r.enabled ? "" : "（已停用）")
        );
        if (r.description) lines.push(`      ${r.description}`);
        lines.push(`      检查器：${r.checker.type}`);
        if (r.remediation) lines.push(`      修复：${r.remediation}`);
      }

      return ok(lines.join("\n"));
    })
  );

  server.registerTool(
    "ditto_rule_run",
    {
      title: "执行规则自检",
      description:
        "对项目或单个资产执行规则，返回逐条命中项并落盘本次执行记录。这是整改循环的起点：跑一次 → 按结论改 → 再跑一次。",
      inputSchema: {
        projectId: z.string(),
        assetId: z.string().optional().describe("只检查单个资产；不传则做项目级全量检查"),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    handle((args) => {
      const run = runProjectRules(ctx, { projectId: args.projectId, assetId: args.assetId });

      const lines = [
        `规则执行 ${run.id}（${run.scope === "asset" ? "单资产" : "项目级"}）`,
        field("阻断", run.counts.error),
        field("警告", run.counts.warn),
        field("提示", run.counts.info),
      ];

      if (run.findings.length === 0) {
        lines.push("", "✓ 全部通过");
        return ok(lines.join("\n"));
      }

      const byRule = new Map<string, typeof run.findings>();
      for (const f of run.findings) {
        const list = byRule.get(f.ruleId) ?? [];
        list.push(f);
        byRule.set(f.ruleId, list);
      }

      lines.push(heading("命中明细"));
      for (const [ruleId, findings] of byRule) {
        const head = findings[0];
        lines.push(`  [${SEVERITY_LABELS[head.severity]}] ${ruleId}｜${head.ruleName}（${findings.length} 处）`);
        for (const f of findings.slice(0, 5)) {
          lines.push(`      · ${f.assetPath ?? "（项目级）"}${f.location?.line ? `:${f.location.line}` : ""} — ${f.message}`);
          if (f.evidence) lines.push(`        证据：${f.evidence}`);
        }
        if (findings.length > 5) lines.push(`      …另有 ${findings.length - 5} 处`);
        if (head.remediation) lines.push(`      修复建议：${head.remediation}`);
      }

      lines.push(
        "",
        `下一步：整改后重新执行 ditto_rule_run。若确认某项可接受，用 ditto_rule_waive 逐条豁免（必须给出理由）。`
      );

      return ok(lines.join("\n"));
    })
  );

  server.registerTool(
    "ditto_rule_run_get",
    {
      title: "查看规则执行记录",
      description: "按 id 读取一次历史规则执行的完整结论。",
      inputSchema: { projectId: z.string(), runId: z.string() },
      annotations: { readOnlyHint: true },
    },
    handle((args) => {
      const run = getRun(ctx, args.projectId, args.runId);
      return ok(
        [
          `规则执行 ${run.id}`,
          field("范围", run.scope === "asset" ? "单资产" : "项目级"),
          field("执行者", `${run.actor.name}（${run.actor.via}）`),
          field("开始", run.startedAt),
          field("结束", run.finishedAt),
          field("输入指纹", run.inputHash),
          field("结论", `阻断 ${run.counts.error} / 警告 ${run.counts.warn} / 提示 ${run.counts.info}`),
          heading(`命中项（${run.findings.length}）`),
          list(
            run.findings.map(
              (f) =>
                `[${SEVERITY_LABELS[f.severity]}] ${f.ruleId}｜${f.assetPath ?? "项目级"}｜${f.message}` +
                (f.waived ? `（已豁免：${f.waived.reason}）` : "")
            ),
            "（无）"
          ),
        ].join("\n")
      );
    })
  );

  server.registerTool(
    "ditto_rule_waive",
    {
      title: "豁免规则命中项",
      description:
        "对某次规则执行中的某条规则给出显式豁免。豁免必须给出理由并永久留痕，不会自动发生。",
      inputSchema: {
        projectId: z.string(),
        runId: z.string(),
        ruleId: z.string(),
        reason: z.string().min(2).describe("豁免理由，会写入审计与审批记录"),
        assetId: z.string().optional().describe("只豁免该资产上的命中项"),
      },
      annotations: { readOnlyHint: false },
    },
    handle((args) => {
      const run = waiveFinding(ctx, args.projectId, args.runId, args.ruleId, args.reason, args.assetId);
      const waived = run.findings.filter((f) => f.ruleId === args.ruleId && f.waived);
      return ok(
        [
          `✓ 已豁免规则「${args.ruleId}」的 ${waived.length} 处命中`,
          field("理由", args.reason),
          field("豁免人", `${ctx.actor.name}（${ctx.actor.via}）`),
          "（豁免已写入审计流水，也会出现在交付清单中）",
        ].join("\n")
      );
    })
  );
}
