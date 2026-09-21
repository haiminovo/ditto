/**
 * Ditto 实施平台 - 审批与审计类 MCP 工具
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { STATUS_LABELS } from "../../core/types";
import type { OpContext } from "../../core/ops/context";
import {
  approvalHistory,
  decideApproval,
  effectiveApprovalFor,
  pendingApprovals,
  submitForApproval,
} from "../../core/ops/approval-ops";
import { gateCheck } from "../../core/ops/rule-ops";
import { listAssets } from "../../core/ops/asset-ops";
import { queryAudit, verifyAudit } from "../../core/store/audit";
import { workspacePaths } from "../../core/store/paths";
import { handle, ok, field, heading, list } from "../result";

export function registerApprovalTools(server: McpServer, ctx: OpContext): void {
  server.registerTool(
    "ditto_gate_check",
    {
      title: "闸门预检（dry-run）",
      description:
        "在不改变任何状态的前提下，重新计算规则并给出放行结论：会被哪些问题拦下、还需要豁免哪些规则。整改循环里应当反复调用它，直到 blocked 为 false。",
      inputSchema: {
        projectId: z.string(),
        assetId: z.string().optional().describe("只预检单个资产；不传则预检项目级发布"),
        overrides: z
          .array(z.object({ ruleId: z.string(), reason: z.string() }))
          .optional()
          .describe("模拟这批豁免生效后的结论"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    handle((args) => {
      const gate = gateCheck(ctx, {
        projectId: args.projectId,
        assetId: args.assetId,
        overrides: args.overrides,
      });

      const lines = [
        gate.blocked ? "⛔ 当前无法放行" : "✓ 闸门已放行",
        field("阻断项", gate.errors.length),
        field("待豁免警告", gate.warnings.length),
        field("已豁免", gate.waived.length),
      ];

      if (gate.reasons.length > 0) {
        lines.push(heading("原因"), list(gate.reasons));
      }

      if (gate.errors.length > 0) {
        lines.push(heading("必须先整改的阻断项"));
        for (const f of gate.errors.slice(0, 15)) {
          lines.push(`  · ${f.ruleId}｜${f.assetPath ?? "项目级"}｜${f.message}`);
          if (f.evidence) lines.push(`      证据：${f.evidence}`);
          if (f.remediation) lines.push(`      修复：${f.remediation}`);
        }
        if (gate.errors.length > 15) lines.push(`  …另有 ${gate.errors.length - 15} 项`);
      }

      if (gate.missingWaiverRuleIds.length > 0) {
        lines.push(
          heading("需要显式豁免的规则"),
          list(gate.missingWaiverRuleIds.map((id) => `${id} —— 给出理由后作为 overrides 传入`)),
          "",
          "放行调用示例：ditto_approval_decide 时传入 overrides: [{ruleId, reason}]"
        );
      }

      return ok(lines.join("\n"));
    })
  );

  server.registerTool(
    "ditto_approval_submit",
    {
      title: "提交评审",
      description:
        "把资产（或整个项目）置为评审中，并返回当前闸门状态与还需要豁免哪些规则。",
      inputSchema: {
        projectId: z.string(),
        assetId: z.string().optional().describe("不传则提交项目级评审"),
      },
      annotations: { readOnlyHint: false },
    },
    handle(async (args) => {
      const r = await submitForApproval(ctx, args.projectId, args.assetId);

      const lines = [
        r.asset
          ? `✓ 资产「${r.asset.path}」已提交评审`
          : `✓ 项目「${r.project.name}」已提交评审`,
        field("状态", STATUS_LABELS[r.asset?.status ?? r.project.status]),
        field("规则执行", r.runId),
        heading("闸门现状"),
        field("能否直接放行", r.gate.blocked ? "否" : "是"),
      ];

      if (r.gate.blocked) {
        lines.push(
          field("阻断项", r.gate.errors.length),
          field("待豁免", r.gate.warnings.length),
          heading("需要豁免的规则"),
          list(r.gate.missingWaiverRuleIds.map((id) => `${id}`), "（无）"),
          "",
          "下一步：整改后用 ditto_gate_check 复查；确认可接受的用 ditto_approval_decide 带 overrides 放行。"
        );
      } else {
        lines.push("", "下一步：调用 ditto_approval_decide 放行。");
      }

      return ok(lines.join("\n"));
    })
  );

  server.registerTool(
    "ditto_approval_decide",
    {
      title: "审批决策",
      description:
        "对资产或项目做出放行/驳回决策。放行会**重新计算**全部规则（不信任存量结论）；仍有阻断或未豁免警告时会被拒绝。",
      inputSchema: {
        projectId: z.string(),
        assetId: z.string().optional(),
        decision: z.enum(["approved", "rejected"]),
        reason: z.string().optional(),
        overrides: z
          .array(z.object({ ruleId: z.string(), reason: z.string() }))
          .optional()
          .describe("逐条豁免，必须给出理由"),
        expectedRev: z
          .number()
          .int()
          .optional()
          .describe("你审的是哪一版。资产在评审期间被改过时会拒绝，避免放行的不是你看到的那一版"),
      },
      annotations: { readOnlyHint: false },
    },
    handle(async (args) => {
      const r = await decideApproval(ctx, {
        projectId: args.projectId,
        assetId: args.assetId,
        decision: args.decision,
        reason: args.reason,
        overrides: args.overrides,
        expectedRev: args.expectedRev,
      });

      const lines = [
        `✓ ${args.decision === "approved" ? "已放行" : "已驳回"}${
          r.asset ? `资产「${r.asset.path}」` : `项目「${r.project.name}」`
        }`,
        field("状态", STATUS_LABELS[r.asset?.status ?? r.project.status]),
        field("审批单", r.approval.id),
        field("审批人", `${r.approval.actor.name}（${r.approval.actor.type} · ${r.approval.actor.via}）`),
      ];

      if (r.approval.overrides.length > 0) {
        lines.push(heading(`本次豁免（${r.approval.overrides.length} 条，已留痕）`));
        lines.push(list(r.approval.overrides.map((o) => `${o.ruleId}：${o.reason}`)));
      }

      if (args.decision === "approved" && r.asset) {
        lines.push("", "下一步：ditto_asset_release 发布，之后该资产才会进入交付包。");
      }

      return ok(lines.join("\n"));
    })
  );

  server.registerTool(
    "ditto_approval_list",
    {
      title: "审批情况",
      description: "查看待办（处于评审中的资产及其闸门状态）与历史审批记录。",
      inputSchema: {
        projectId: z.string(),
        pendingOnly: z.boolean().optional().describe("只看待办"),
      },
      annotations: { readOnlyHint: true },
    },
    handle((args) => {
      const pending = pendingApprovals(ctx, args.projectId);
      const history = args.pendingOnly ? [] : approvalHistory(ctx, args.projectId);

      const lines: string[] = [];

      lines.push(`待办 ${pending.length} 项`);
      for (const p of pending) {
        lines.push(
          `  · ${p.asset.path}（rev ${p.asset.rev}）` +
            (p.gate.blocked
              ? `｜仍被拦：需豁免 ${p.gate.missingWaiverRuleIds.join(", ") || "（无）"}`
              : "｜闸门已放行，可直接决策")
        );
      }
      if (pending.length === 0) lines.push("  （无待办）");

      if (!args.pendingOnly) {
        lines.push(heading(`历史审批（${history.length}）`));
        lines.push(
          list(
            history.slice(0, 30).map(
              (a) =>
                `${a.createdAt.slice(0, 19)}｜${a.assetId ? "资产" : "项目"}｜${a.decision}｜` +
                `${a.actor.name}｜豁免 ${a.overrides.length} 条` +
                (a.reason ? `｜${a.reason}` : "")
            ),
            "（无记录）"
          )
        );
      }

      return ok(lines.join("\n"));
    })
  );

  server.registerTool(
    "ditto_asset_approval_status",
    {
      title: "资产审批状态",
      description: "查看某个资产当前有效的审批结论（会校验资产是否在审批后被改过）。",
      inputSchema: {
        projectId: z.string(),
        assetId: z.string().optional(),
        path: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    handle((args) => {
      const assets = listAssets(ctx, args.projectId);
      const asset = args.assetId
        ? assets.find((a) => a.id === args.assetId)
        : assets.find((a) => a.path === args.path);

      if (!asset) return ok("未找到该资产。");

      const approval = effectiveApprovalFor(ctx, args.projectId, asset);

      return ok(
        [
          `资产「${asset.path}」`,
          field("当前状态", STATUS_LABELS[asset.status]),
          field("当前版本", `v${asset.currentVersion}（rev ${asset.rev}）`),
          heading("有效审批"),
          approval
            ? [
                field("审批单", approval.id),
                field("决策", approval.decision),
                field("审批人", `${approval.actor.name}（${approval.actor.type} · ${approval.actor.via}）`),
                field("时间", approval.createdAt),
                field("豁免", approval.overrides.map((o) => o.ruleId).join("、") || "（无）"),
              ].join("\n")
            : "  （没有对当前版本有效的审批 —— 资产自上次审批后可能已变更）",
        ].join("\n")
      );
    })
  );
}

/* ------------------------------------------------------------------ */

export function registerAuditTools(server: McpServer, ctx: OpContext): void {
  server.registerTool(
    "ditto_audit_list",
    {
      title: "审计流水",
      description: "查询操作审计记录，支持按项目、资产、动作与时间过滤。",
      inputSchema: {
        projectId: z.string().optional(),
        assetId: z.string().optional(),
        action: z.string().optional().describe("如 asset.approve / rule.waive"),
        since: z.string().optional().describe("ISO 时间，只返回此后的记录"),
        limit: z.number().int().positive().max(500).optional().describe("默认 50"),
      },
      annotations: { readOnlyHint: true },
    },
    handle((args) => {
      const entries = queryAudit(workspacePaths(ctx.root).auditDir, {
        projectId: args.projectId,
        assetId: args.assetId,
        action: args.action as never,
        since: args.since,
        limit: args.limit ?? 50,
      });

      if (entries.length === 0) return ok("没有匹配的审计记录。");

      return ok(
        `共 ${entries.length} 条（最新在前）\n` +
          list(
            entries.map(
              (e) =>
                `#${e.seq}｜${e.at.slice(0, 19)}｜${e.action}｜${e.actor.name}（${e.actor.via}）` +
                `｜${e.summary}` +
                (e.details ? `\n      ${JSON.stringify(e.details)}` : "")
            )
          )
      );
    })
  );

  server.registerTool(
    "ditto_audit_verify",
    {
      title: "校验审计链",
      description:
        "校验审计流水的哈希链是否完整。任何条目被篡改或在中间被删除都会在断链处报出。",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    handle(() => {
      const r = verifyAudit(workspacePaths(ctx.root).auditDir);
      if (r.ok) {
        return ok(`✓ 审计链完好，共 ${r.total} 条记录。`);
      }
      return ok(
        [
          "⛔ 审计链已断裂",
          field("总条数", r.total),
          field("首个断点", `#${r.brokenAtSeq}`),
          field("原因", r.reason),
        ].join("\n")
      );
    })
  );
}
