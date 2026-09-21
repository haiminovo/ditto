/**
 * Ditto 实施平台 - MCP 资源
 *
 * 资源与工具的分工：
 *   - 工具：AI 主动执行动作（写、跑规则、审批）
 *   - 资源：AI 把平台状态**挂载进上下文**，不需要先想好调哪个工具
 *
 * 资产的 URI 以 **asset id** 为准：逻辑路径会改名，id 不会。
 * 同时保留按路径寻址的模板，因为人（和 AI）更常记得路径。
 */

import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ASSET_STATUSES, KIND_LABELS } from "../core/types";
import type { OpContext } from "../core/ops/context";
import { listProjects, projectOverview } from "../core/ops/project-ops";
import { listAssets, listVersions, readAssetContent } from "../core/ops/asset-ops";
import { getCapability, listCapabilities, listTemplates } from "../core/ops/template-ops";
import { loadRulePacksForProject } from "../core/ops/rule-ops";
import { listApprovals } from "../core/store/approvals";
import { readProject } from "../core/store/projects";
import { assetFilePath } from "../core/store/assets";
import { workspaceInfo } from "../core/store/workspace";
import { CoreError } from "../core/errors";
import { buildHandoff } from "../core/ops/handoff";

const MIME_MARKDOWN = "text/markdown";
const MIME_JSON = "application/json";

/** 单个内联返回的二进制上限：再大就会冲垮客户端上下文 */
const MAX_INLINE_BINARY = 1024 * 1024;

function text(uri: string, body: string, mimeType = MIME_MARKDOWN) {
  return { contents: [{ uri, mimeType, text: body }] };
}

/**
 * 解码资源模板取回的变量。
 *
 * RFC 6570 的两种展开都**不做百分号解码**：
 *   - 简单展开 `{projectId}` 会编码保留字符，但值本身仍是编码后的字符串
 *   - 保留展开 `{+path}` 保住斜杠不被编码，同样不解码
 *
 * 客户端把 URI 送进来时，中文会被编码成 %E9%A1%B9…，服务端拿到的就是这一串。
 * 不解这一步，所有中文项目 id 与中文资产路径都读不到 ——
 * 而中文命名恰恰是这个平台上的常态。
 *
 * 逐段解码而非整体解码：万一某段里真的有 %2F，整体解码会凭空多出一个路径分隔符。
 */
function decodeVariable(raw: string): string {
  return raw
    .split("/")
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join("/");
}

export function registerResources(server: McpServer, ctx: OpContext): void {
  /* ---------------- 静态资源 ---------------- */

  server.registerResource(
    "workspace",
    "ditto://workspace",
    {
      title: "工作区概览",
      description: "工作区路径、Schema 版本与统计",
      mimeType: MIME_MARKDOWN,
    },
    (uri) => {
      const info = workspaceInfo(ctx.root);
      return text(
        uri.href,
        [
          `# 工作区`,
          ``,
          `- 根目录：${info.root}`,
          `- 已初始化：${info.initialized ? "是" : "否"}`,
          `- Schema 版本：${info.schemaVersion ?? "—"}`,
          `- 项目：${info.counts.projects}`,
          `- 能力包：${info.counts.capabilities}`,
          `- 工作区规则包：${info.counts.rulepacks}`,
        ].join("\n")
      );
    }
  );

  server.registerResource(
    "projects",
    "ditto://projects",
    { title: "项目列表", description: "工作区内全部实施项目", mimeType: MIME_MARKDOWN },
    (uri) => {
      const projects = listProjects(ctx);
      if (projects.length === 0) return text(uri.href, "# 项目\n\n（还没有项目）");
      return text(
        uri.href,
        [
          "# 项目列表",
          "",
          ...projects.map(
            (p) =>
              `- **${p.name}**（\`${p.id}\`）— 客户 ${p.customer}｜${p.status}｜平台 ${p.platforms.join("/")}`
          ),
        ].join("\n")
      );
    }
  );

  server.registerResource(
    "capabilities",
    "ditto://capabilities",
    { title: "能力包目录", description: "已安装的能力包及其平台与模板数", mimeType: MIME_MARKDOWN },
    (uri) => {
      const caps = listCapabilities(ctx);
      if (caps.length === 0) return text(uri.href, "# 能力包\n\n（尚未安装，可调用 ditto_workspace_init）");
      return text(
        uri.href,
        [
          "# 能力包",
          "",
          ...caps.map(
            (c) =>
              `- **${c.name}**（\`${c.id}\` v${c.version}）平台 ${c.platforms.join("/")}｜模板 ${c.templateCount} 个｜规则包 ${c.rulePackIds.length} 个\n  ${c.description}`
          ),
        ].join("\n")
      );
    }
  );

  server.registerResource(
    "templates",
    "ditto://templates",
    { title: "模板目录", description: "全部能力包提供的交付物模板", mimeType: MIME_MARKDOWN },
    (uri) => {
      const templates = listTemplates(ctx);
      return text(
        uri.href,
        [
          "# 模板",
          "",
          ...templates.map(
            (t) => `- \`${t.id}\`｜${t.name}｜${KIND_LABELS[t.kind]}｜→ \`${t.targetPath}\`　[${t.capabilityPackageId}]`
          ),
        ].join("\n")
      );
    }
  );

  /* ---------------- 项目级模板 ---------------- */

  server.registerResource(
    "project",
    new ResourceTemplate("ditto://project/{projectId}", {
      list: async () => ({
        resources: listProjects(ctx).map((p) => ({
          uri: `ditto://project/${p.id}`,
          name: p.name,
          title: `${p.name}（${p.id}）`,
          mimeType: MIME_MARKDOWN,
        })),
      }),
    }),
    { title: "项目详情", description: "项目元数据、变量与资产清单", mimeType: MIME_MARKDOWN },
    (uri, variables) => {
      const projectId = decodeVariable(String(variables.projectId));
      const { project, assets } = projectOverview(ctx, projectId);

      return text(
        uri.href,
        [
          `# ${project.name}`,
          "",
          `- 项目 id：\`${project.id}\``,
          `- 编号：${project.code}`,
          `- 客户：${project.customer}`,
          `- 状态：${project.status}`,
          `- 责任人：${project.owner ?? "—"}`,
          `- 平台：${project.platforms.join("/")}`,
          `- 已挂载能力包：${project.capabilityPackageIds.join("、") || "—"}`,
          "",
          "## 项目变量",
          "",
          ...Object.entries(project.vars).map(([k, v]) => `- \`${k}\` = ${v}`),
          ...(Object.keys(project.vars).length === 0 ? ["（尚未设置）"] : []),
          "",
          `## 资产（${assets.length}）`,
          "",
          ...assets.map(
            (a) =>
              `- \`${a.path}\`｜${KIND_LABELS[a.kind]}｜${a.status}｜v${a.currentVersion}（rev ${a.rev}）｜[打开](ditto://asset/${a.id})`
          ),
          ...(assets.length === 0 ? ["（还没有资产）"] : []),
        ].join("\n")
      );
    }
  );

  server.registerResource(
    "project-assets",
    new ResourceTemplate("ditto://project/{projectId}/assets", {
      list: undefined,
    }),
    { title: "项目资产清单", description: "项目下全部资产", mimeType: MIME_MARKDOWN },
    (uri, variables) => {
      const projectId = decodeVariable(String(variables.projectId));
      const assets = listAssets(ctx, projectId);
      return text(
        uri.href,
        [
          `# 资产清单（${assets.length}）`,
          "",
          ...assets.map(
            (a) => `- \`${a.path}\`｜${KIND_LABELS[a.kind]}｜${a.status}｜v${a.currentVersion}`
          ),
        ].join("\n")
      );
    }
  );

  server.registerResource(
    "project-context",
    new ResourceTemplate("ditto://context/{projectId}", { list: undefined }),
    {
      title: "项目完整上下文",
      description:
        "等价于 ditto_handoff 的只读快照：状态、规则结论、审批情况与建议的下一步动作",
      mimeType: MIME_MARKDOWN,
    },
    (uri, variables) => {
      const projectId = decodeVariable(String(variables.projectId));
      const h = buildHandoff(ctx, { projectId });

      const lines: string[] = [
        `# 项目上下文：${h.project?.name ?? projectId}`,
        "",
        `## 状态`,
        `- 项目状态：${h.project?.status}`,
        `- 客户：${h.project?.customer}`,
        `- 平台：${h.project?.platforms.join("/")}`,
      ];

      if (h.counts) {
        lines.push(
          "",
          "## 规则结论",
          `- 阻断 ${h.counts.bySeverity.error} / 警告 ${h.counts.bySeverity.warn} / 提示 ${h.counts.bySeverity.info}`
        );
      }

      if (h.assets) {
        lines.push("", `## 资产（${h.assets.length}）`);
        for (const a of h.assets) {
          const run = a.lastRun
            ? `规则 阻断${a.lastRun.counts.error}/警告${a.lastRun.counts.warn}${a.lastRun.stale ? "（已过期）" : ""}`
            : "未执行规则";
          lines.push(`- \`${a.path}\`｜${a.status}｜rev ${a.rev}｜${run}`);
        }
      }

      if (h.nextActions && h.nextActions.length > 0) {
        lines.push("", "## 建议的下一步");
        for (const a of h.nextActions) {
          lines.push(`- **${a.action}**（\`${a.tool}\`）`);
          lines.push(`  - ${a.reason}`);
          if (a.assetPath) lines.push(`  - 资产：\`${a.assetPath}\``);
        }
      }

      return text(uri.href, lines.join("\n"));
    }
  );

  server.registerResource(
    "project-approvals",
    new ResourceTemplate("ditto://approvals/{projectId}", { list: undefined }),
    { title: "项目审批记录", description: "审批历史与豁免留痕", mimeType: MIME_MARKDOWN },
    (uri, variables) => {
      const projectId = decodeVariable(String(variables.projectId));
      const approvals = listApprovals(ctx.root, projectId);
      return text(
        uri.href,
        [
          `# 审批记录（${approvals.length}）`,
          "",
          ...approvals.map(
            (a) =>
              `- ${a.createdAt}｜${a.assetId ? "资产" : "项目"}｜**${a.decision}**｜${a.actor.name}（${a.actor.via}）` +
              (a.reason ? `｜${a.reason}` : "") +
              (a.overrides.length > 0
                ? `\n  - 豁免 ${a.overrides.length} 条：${a.overrides.map((o) => o.ruleId).join("、")}`
                : "")
          ),
          ...(approvals.length === 0 ? ["（暂无记录）"] : []),
        ].join("\n")
      );
    }
  );

  /* ---------------- 资产 ---------------- */

  server.registerResource(
    "asset",
    new ResourceTemplate("ditto://asset/{assetId}", {
      list: async () => {
        // 列出全部项目的资产作为可发现资源
        const out: Array<{ uri: string; name: string; mimeType: string }> = [];
        for (const p of listProjects(ctx)) {
          for (const a of listAssets(ctx, p.id)) {
            out.push({
              uri: `ditto://asset/${a.id}`,
              name: a.path,
              mimeType: a.isBinary ? "application/octet-stream" : MIME_MARKDOWN,
            });
          }
        }
        return { resources: out.slice(0, 200) };
      },
    }),
    { title: "资产正文", description: "按资产 id 读取当前版本正文", mimeType: MIME_MARKDOWN },
    (uri, variables) => {
      const assetId = decodeVariable(String(variables.assetId));
      const found = locateAsset(ctx, assetId);

      if (found.kind === "binary") {
        if (found.buffer && found.buffer.byteLength <= MAX_INLINE_BINARY) {
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: found.asset.mimeType,
                blob: found.buffer.toString("base64"),
              },
            ],
          };
        }
        return text(
          uri.href,
          `二进制资产 \`${found.asset.path}\`（${found.asset.size} 字节）超过内联上限 ${MAX_INLINE_BINARY} 字节，` +
            `未内联返回。磁盘位置：\`${found.diskPath}\``
        );
      }

      return text(uri.href, found.text ?? "（内容为空）", found.asset.mimeType);
    }
  );

  server.registerResource(
    "asset-meta",
    new ResourceTemplate("ditto://asset/{assetId}/meta", { list: undefined }),
    { title: "资产元数据", description: "资产的完整元数据（JSON）", mimeType: MIME_JSON },
    (uri, variables) => {
      const assetId = decodeVariable(String(variables.assetId));
      const found = locateAsset(ctx, assetId);
      return text(uri.href, JSON.stringify(found.asset, null, 2), MIME_JSON);
    }
  );

  server.registerResource(
    "asset-history",
    new ResourceTemplate("ditto://asset/{assetId}/history", { list: undefined }),
    { title: "资产版本历史", description: "资产的版本快照列表", mimeType: MIME_MARKDOWN },
    (uri, variables) => {
      const assetId = decodeVariable(String(variables.assetId));
      const found = locateAsset(ctx, assetId);
      const versions = listVersions(ctx, found.projectId, { assetId });

      return text(
        uri.href,
        [
          `# ${found.asset.path} 的版本历史`,
          "",
          ...versions.map(
            (v) =>
              `- v${v.version}（rev ${v.rev}）｜${v.createdAt}｜${v.author.name}｜${v.message}` +
              (v.approvalId ? `｜审批 ${v.approvalId}` : "")
          ),
          ...(versions.length === 0 ? ["（无版本记录）"] : []),
        ].join("\n")
      );
    }
  );

  server.registerResource(
    "asset-version",
    new ResourceTemplate("ditto://asset/{assetId}/v/{version}", { list: undefined }),
    { title: "资产历史版本正文", description: "读取资产的指定历史版本", mimeType: MIME_MARKDOWN },
    (uri, variables) => {
      const assetId = decodeVariable(String(variables.assetId));
      const version = Number.parseInt(decodeVariable(String(variables.version)), 10);
      if (!Number.isFinite(version)) {
        throw new CoreError("E_INVALID", `版本号不合法：${decodeVariable(String(variables.version))}`);
      }
      const found = locateAsset(ctx, assetId);
      const c = readAssetContent(ctx, found.projectId, { assetId }, version);
      return text(uri.href, c.text ?? "（该版本无文本内容）", c.asset.mimeType);
    }
  );

  /* 按逻辑路径寻址 —— 注意 {+path} 的加号不能省：
     RFC 6570 的简单展开 {path} 会把斜杠百分号编码，路径永远匹配不上 */
  server.registerResource(
    "asset-by-path",
    new ResourceTemplate("ditto://project/{projectId}/asset-by-path/{+path}", { list: undefined }),
    {
      title: "按路径读取资产",
      description: "按逻辑路径读取资产正文，如 ditto://project/demo/asset-by-path/docs/01-方案.md",
      mimeType: MIME_MARKDOWN,
    },
    (uri, variables) => {
      const projectId = decodeVariable(String(variables.projectId));
      const logicalPath = decodeVariable(decodeVariable(String(variables.path)));
      const c = readAssetContent(ctx, projectId, { path: logicalPath });
      if (c.asset.isBinary) {
        return text(uri.href, `二进制资产，请用 ditto://asset/${c.asset.id} 读取。`);
      }
      return text(uri.href, c.text ?? "（内容为空）", c.asset.mimeType);
    }
  );

  /* ---------------- 能力包与规则 ---------------- */

  server.registerResource(
    "capability",
    new ResourceTemplate("ditto://capability/{capabilityId}", {
      list: async () => ({
        resources: listCapabilities(ctx).map((c) => ({
          uri: `ditto://capability/${c.id}`,
          name: c.name,
          title: `${c.name}（${c.id}）`,
          mimeType: MIME_MARKDOWN,
        })),
      }),
    }),
    { title: "能力包详情", description: "能力包的模板、变量与规则包", mimeType: MIME_MARKDOWN },
    (uri, variables) => {
      const id = decodeVariable(String(variables.capabilityId));
      const c = getCapability(ctx, id);

      return text(
        uri.href,
        [
          `# ${c.name}（\`${c.id}\` v${c.version}）`,
          "",
          c.description,
          "",
          `- 平台：${c.platforms.join("/")}`,
          `- 依赖：${c.manifest.requires.join("、") || "无"}`,
          "",
          "## 所需变量",
          "",
          ...c.vars.map(
            (v) =>
              `- \`${v.key}\`（${v.label}）${v.type}${v.required ? " **必填**" : ""}` +
              (v.default !== undefined ? `，默认 \`${v.default}\`` : "") +
              (v.allowed ? `，取值 ${v.allowed.join("/")}` : "")
          ),
          ...(c.vars.length === 0 ? ["（无）"] : []),
          "",
          "## 模板",
          "",
          ...c.templates.map(
            (t) => `- \`${t.id}\`｜${t.name}｜${KIND_LABELS[t.kind]}｜→ \`${t.targetPath}\``
          ),
          "",
          "## 规则包",
          "",
          ...c.rulePackIds.map((r) => `- \`${r}\``),
        ].join("\n")
      );
    }
  );

  server.registerResource(
    "rules",
    new ResourceTemplate("ditto://rules/{projectId}", { list: undefined }),
    {
      title: "项目生效规则",
      description: "该项目当前生效的全部规则（含严重级别与修复建议）",
      mimeType: MIME_MARKDOWN,
    },
    (uri, variables) => {
      const projectId = decodeVariable(String(variables.projectId));
      const project = readProject(ctx.root, projectId);
      const { packs, rules } = loadRulePacksForProject(ctx, project);

      return text(
        uri.href,
        [
          `# ${project.name} 生效规则（${rules.length} 条）`,
          "",
          `来自 ${packs.length} 个规则包：${packs.map((p) => p.id).join("、")}`,
          "",
          ...rules.map(
            (r) =>
              `## [${r.severity}] ${r.name}\n\n- 规则 id：\`${r.id}\`\n- 检查器：\`${r.checker.type}\`\n` +
              (r.description ? `- ${r.description}\n` : "") +
              (r.remediation ? `- 修复建议：${r.remediation}\n` : "")
          ),
        ].join("\n")
      );
    }
  );

  server.registerResource(
    "statuses",
    "ditto://statuses",
    {
      title: "状态与严重级取值",
      description: "资产状态机与规则严重级的合法取值，供构造调用参数时参考",
      mimeType: MIME_MARKDOWN,
    },
    (uri) =>
      text(
        uri.href,
        [
          "# 取值参考",
          "",
          "## 资产 / 项目状态",
          "",
          ...ASSET_STATUSES.map((s) => `- \`${s}\``),
          "",
          "状态机：draft ─提交→ in_review ─放行→ approved ─发布→ released ─废弃→ deprecated",
          "（内容变更会自动回到 draft；已发布资产不能直接编辑，需先改版）",
          "",
          "## 规则严重级",
          "",
          "- `error` 阻断",
          "- `warn` 警告（默认同样阻断，需显式豁免才能放行）",
          "- `info` 提示（不阻断）",
        ].join("\n")
      )
  );
}

/* ------------------------------------------------------------------ */

interface LocatedAsset {
  projectId: string;
  asset: ReturnType<typeof listAssets>[number];
  kind: "text" | "binary";
  text?: string | null;
  buffer?: Buffer | null;
  diskPath: string;
}

/** 按 asset id 在全部项目中定位资产 */
function locateAsset(ctx: OpContext, assetId: string): LocatedAsset {
  for (const project of listProjects(ctx)) {
    const hit = listAssets(ctx, project.id).find((a) => a.id === assetId);
    if (!hit) continue;

    const c = readAssetContent(ctx, project.id, { assetId });

    return {
      projectId: project.id,
      asset: hit,
      kind: hit.isBinary ? "binary" : "text",
      text: c.text,
      buffer: c.buffer,
      diskPath: assetFilePath(ctx.root, project.id, hit.path),
    };
  }

  throw new CoreError("E_NOT_FOUND", `未找到资产：${assetId}`, { assetId });
}
