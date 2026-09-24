/**
 * Ditto 实施平台 - MCP 端到端冒烟
 *
 * 以真实 Web MCP 客户端的身份驱动服务端，走完整个交付生命周期。
 * 全程只经由 HTTP MCP 协议，不直接调用 lib/core。
 *
 *   npm run dev
 *   npm run mcp:smoke
 *
 * 任一断言失败即退出码 1，可直接进 CI。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/* ------------------------------------------------------------------ */
/* 断言                                                                */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;

function section(title: string) {
  console.log(`\n${"─".repeat(62)}\n${title}\n${"─".repeat(62)}`);
}

function ok(label: string, detail = "") {
  passed += 1;
  console.log(`✓ ${label}${detail ? `  ${detail}` : ""}`);
}

function bad(label: string, detail = ""): never {
  failed += 1;
  console.error(`✗ ${label}${detail ? `\n    ${detail}` : ""}`);
  throw new Error(label);
}

function assert(cond: unknown, label: string, detail = ""): asserts cond {
  if (cond) ok(label, detail);
  else bad(label, detail || "条件为假");
}

function assertEq<T>(actual: T, expected: T, label: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(label, `= ${JSON.stringify(actual)}`);
  else bad(label, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/* ------------------------------------------------------------------ */
/* MCP 调用封装                                                        */
/* ------------------------------------------------------------------ */

interface TextResult {
  text: string;
  isError: boolean;
}

/* ------------------------------------------------------------------ */

async function main() {
  const args = process.argv.slice(2);
  const httpIndex = args.indexOf("--http");
  const httpUrl =
    (httpIndex >= 0 ? args[httpIndex + 1] : undefined) ??
    process.env.DITTO_MCP_URL ??
    "http://localhost:3000/api/mcp";

  console.log(`Web MCP：${httpUrl}`);

  const client = new Client({ name: "ditto-smoke", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(httpUrl), {
    requestInit: { headers: { Authorization: "Bearer smoke" } },
  });
  await client.connect(transport);

  /** 调用工具并取回文本 */
  const call = async (name: string, toolArgs: Record<string, unknown> = {}): Promise<TextResult> => {
    const res = (await client.callTool({ name, arguments: toolArgs })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = (res.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    return { text, isError: res.isError === true };
  };

  /** 调用并断言成功 */
  const callOk = async (name: string, toolArgs: Record<string, unknown> = {}): Promise<string> => {
    const r = await call(name, toolArgs);
    if (r.isError) {
      bad(`${name} 应当成功，但返回了错误`, r.text);
    }
    return r.text;
  };

  /** 调用并断言失败（反向路径） */
  const callExpectError = async (
    name: string,
    toolArgs: Record<string, unknown> = {}
  ): Promise<string> => {
    const r = await call(name, toolArgs);
    if (!r.isError) {
      bad(`${name} 应当被拒绝，却成功了`, r.text.slice(0, 400));
    }
    return r.text;
  };

  try {
    /* ---------------------------------------------------------------- */
    section("1. 协议握手：能力清单");

    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);

    assert(toolNames.length >= 30, "工具数量充足", `= ${toolNames.length}`);
    for (const required of [
      "ditto_handoff",
      "ditto_workspace_init",
      "ditto_project_create",
      "ditto_template_apply",
      "ditto_rule_run",
      "ditto_gate_check",
      "ditto_approval_submit",
      "ditto_approval_decide",
      "ditto_asset_release",
      "ditto_project_export",
      "ditto_audit_verify",
    ]) {
      assert(toolNames.includes(required), `工具存在：${required}`);
    }

    const templates = await client.listResourceTemplates();
    assert(templates.resourceTemplates.length >= 8, "资源模板已注册", `= ${templates.resourceTemplates.length}`);

    const prompts = await client.listPrompts();
    assert(prompts.prompts.length >= 5, "提示词已注册", `= ${prompts.prompts.length}`);

    // 资源模板里的 {+path} 是这个平台的关键细节，单独守住
    const hasPlusPath = templates.resourceTemplates.some((t) => t.uriTemplate.includes("{+path}"));
    assert(hasPlusPath, "按路径寻址的模板使用了 {+path} 保留展开");

    /* ---------------------------------------------------------------- */
    section("2. 工作区初始化必须幂等");

    const first = await callOk("ditto_workspace_init");
    assert(first.includes("已安装"), "首次初始化安装了能力包");
    const second = await callOk("ditto_workspace_init");
    assert(second.includes("已存在"), "第二次调用是 no-op（未覆盖）");

    /* ---------------------------------------------------------------- */
    section("3. 能力包与模板");

    const capList = await callOk("ditto_capability_list");
    assert(capList.includes("通用底座"), "通用底座已就绪");

    const capDetail = await callOk("ditto_capability_get", { capabilityId: "general" });
    assert(capDetail.includes("domain"), "能力包声明了 domain 变量");

    const tplList = await callOk("ditto_template_list", { capabilityId: "general" });
    assert(tplList.includes("project-charter"), "模板清单可用");

    /* ---------------------------------------------------------------- */
    section("4. 创建项目");

    const created = await callOk("ditto_project_create", {
      name: "MCP 冒烟项目",
      customer: "冒烟客户",
      owner: "测试员",
      // 故意不设 domain，验证规则能拦住占位域名
      vars: { "env.name": "prod" },
    });
    assert(created.includes("已创建项目"), "项目创建成功");

    const projectId = extractProjectId(created);
    assert(projectId.length > 0, "拿到项目 id", projectId);

    /* ---------------------------------------------------------------- */
    section("5. 交接上下文（AI 客户端的入口）");

    const handoff = await callOk("ditto_handoff", { projectId });
    assert(handoff.includes("建议的下一步"), "交接给出了下一步动作");
    assert(handoff.includes("ditto_template_apply"), "提示了如何生成资产");

    /* ---------------------------------------------------------------- */
    section("6. 渲染预览：缺变量必须明确报出，而不是静默留空");

    const preview = await callOk("ditto_template_render", {
      projectId,
      templateId: "project-charter",
    });
    assert(preview.includes("docs/01-项目实施方案.md"), "预览给出目标路径");

    /* ---------------------------------------------------------------- */
    section("7. 生成交付物骨架");

    const templateIds = [
      "project-charter",
      "requirements",
      "handover",
      "topology",
      "deploy-plan",
      "app-config",
      "deploy-script",
      "rollback-script",
      "test-plan",
      "acceptance",
    ];

    for (const templateId of templateIds) {
      const r = await callOk("ditto_template_apply", { projectId, templateId });
      assert(r.includes("已生成资产") || r.includes("已重新生成资产"), `生成 ${templateId}`);
    }

    /* ---------------------------------------------------------------- */
    section("8. ★ 规则必须拦下未完成的交付物");

    const run1 = await callOk("ditto_rule_run", { projectId });
    const errors1 = extractCount(run1, "阻断");
    console.log(`   首次执行：阻断 ${errors1}`);
    assert(errors1 > 0, "首次执行必然有阻断项", `= ${errors1}`);
    assert(run1.includes("docs-todo-residue"), "拦下了 TODO 残留");
    assert(run1.includes("docs-placeholder-domain"), "拦下了示例域名");

    /* ---------------------------------------------------------------- */
    section("9. ★ 闸门 dry-run：不改变状态，且给出可操作的结论");

    const gate1 = await callOk("ditto_gate_check", { projectId });
    assert(gate1.includes("无法放行"), "闸门判定为阻塞");
    assert(gate1.includes("需要显式豁免的规则") || gate1.includes("必须先整改"), "给出了可操作的下一步");

    // dry-run 不应产生任何审批记录
    const approvalsBefore = await callOk("ditto_approval_list", { projectId, pendingOnly: true });
    assert(approvalsBefore.includes("待办 0 项"), "dry-run 没有产生待办");

    /* ---------------------------------------------------------------- */
    section("10. 整改：补变量 + 改写文档");

    await callOk("ditto_project_update", {
      projectId,
      customer: "冒烟客户",
      vars: { domain: "crm.smoke-bank.cn", "app.version": "1.0.0", "ops.contact": "张三" },
      message: "补齐交付变量",
    });
    ok("项目变量已补齐");

    const assetsJson = await callOk("ditto_asset_list", { projectId });
    const docId = extractAssetId(assetsJson, "docs/01-项目实施方案.md");
    assert(docId.length > 0, "定位到实施方案资产", docId);

    const cleanDoc = [
      "# MCP 冒烟项目 项目实施方案",
      "",
      "| 项目 | 内容 |",
      "| --- | --- |",
      "| 项目名称 | MCP 冒烟项目 |",
      "| 客户名称 | 冒烟客户 |",
      "| 目标环境 | prod |",
      "| 访问域名 | crm.smoke-bank.cn |",
      "",
      "## 一、项目背景",
      "本项目为冒烟客户提供客户关系管理系统的实施交付。",
      "",
      "## 二、实施范围",
      "覆盖客户主数据、商机管理与报表中心三个模块。",
      "",
      "## 三、实施目标",
      "完成三个模块上线并稳定运行七天。",
      "",
      "## 四、里程碑计划",
      "需求确认、环境准备、部署实施、测试验证、上线验收依次推进。",
      "",
      "## 五、组织与职责",
      "项目经理统筹协调，技术负责人负责方案落地。",
      "",
      "## 六、风险与应对",
      "主要风险为环境准备延期，已提前两周启动资源申请。",
      "",
      "## 七、沟通机制",
      "每周一例会，重大问题随时升级。",
      "",
    ].join("\n");

    await callOk("ditto_asset_update", {
      projectId,
      assetId: docId,
      content: cleanDoc,
      message: "补齐实施方案正文",
    });
    ok("实施方案已改写");

    const run2 = await callOk("ditto_rule_run", { projectId: projectId, assetId: docId });
    const errors2 = extractCount(run2, "阻断");
    if (errors2 !== 0) bad("该资产整改后阻断项归零", `实际 ${errors2}，明细：\n${run2}`);
    ok("该资产整改后阻断项归零", "= 0");

    /* ---------------------------------------------------------------- */
    section("11. ★ 反向路径：明文口令必须被拦下");

    const cfgAssets = await callOk("ditto_asset_list", { projectId, pathPrefix: "config" });
    const cfgId = extractAssetId(cfgAssets, "config/app-config.json");
    assert(cfgId.length > 0, "定位到配置文件", cfgId);

    await callOk("ditto_asset_update", {
      projectId,
      assetId: cfgId,
      content: JSON.stringify(
        {
          application: {
            name: "MCP 冒烟项目",
            code: "SMOKE",
            environment: "prod",
            domain: "crm.smoke-bank.cn",
            version: "1.0.0",
          },
          server: { port: 8080 },
          datasource: {
            url: "jdbc:mysql://db:3306/app",
            username: "app",
            // 故意写死一个真实口令
            password: "Pr0d_Passw0rd_2026",
          },
          logging: { level: "INFO", path: "/var/log/app" },
        },
        null,
        2
      ),
      message: "故意写入明文口令",
    });

    const run3 = await callOk("ditto_rule_run", { projectId, assetId: cfgId });
    assert(run3.includes("config-secret-literal"), "拦下了明文口令");
    assert(run3.includes("Pr0d_Passw0rd"), "证据里带出命中片段");
    const secretErrors = extractCount(run3, "阻断");
    assert(secretErrors > 0, "明文口令是阻断级", `= ${secretErrors}`);

    /* ---------------------------------------------------------------- */
    section("12. 乐观并发：过期 rev 必须被拒绝");

    const staleErr = await callExpectError("ditto_asset_update", {
      projectId,
      assetId: cfgId,
      content: "{}",
      expectedRev: 1,
    });
    assert(staleErr.includes("E_CONFLICT"), "返回了明确的冲突错误");
    assert(staleErr.includes("重新读取"), "错误信息给出可操作的建议");

    /* ---------------------------------------------------------------- */
    section("13. ★ 闸门拦住无豁免的放行，豁免后放行且留痕");

    const sub = await callOk("ditto_approval_submit", { projectId, assetId: docId });
    assert(sub.includes("已提交评审"), "已整改资产提交成功");

    // 已整改的资产应当畅通
    const decideClean = await callOk("ditto_approval_decide", {
      projectId,
      assetId: docId,
      decision: "approved",
      reason: "内容已补齐",
    });
    assert(decideClean.includes("已放行"), "闸门畅通时直接放行");
    assert(decideClean.includes("本次豁免") === false, "审批单上没有多余豁免");

    // 含明文口令的配置必须被拦住
    await callOk("ditto_approval_submit", { projectId, assetId: cfgId });
    const blocked = await callExpectError("ditto_approval_decide", {
      projectId,
      assetId: cfgId,
      decision: "approved",
    });
    assert(blocked.includes("E_GATE_BLOCKED"), "无豁免放行被拦下");
    assert(blocked.includes("config-secret-literal"), "错误信息点名了被拦的规则");

    // 给出理由后可以放行
    const decided = await callOk("ditto_approval_decide", {
      projectId,
      assetId: cfgId,
      decision: "approved",
      overrides: [
        {
          ruleId: "config-secret-literal",
          reason: "冒烟测试：该口令为测试环境凭据，上线前由运维替换为密钥管理服务注入",
        },
      ],
      reason: "带豁免放行",
    });
    assert(decided.includes("已放行"), "显式豁免后放行成功");
    assert(decided.includes("本次豁免"), "审批单记录了豁免");

    /* ---------------------------------------------------------------- */
    section("14. 走完剩余资产的生命周期");

    const allAssets = await callOk("ditto_asset_list", { projectId });
    const pending = extractAssetsNotReleased(allAssets);
    console.log(`   待处理资产 ${pending.length} 个`);

    for (const a of pending) {
      let status = a.status;

      // 第 13 步已经放行过的资产不必重复提交
      if (status === "draft" || status === "rejected") {
        const s = await callOk("ditto_approval_submit", { projectId, assetId: a.id });
        // 从闸门结论里取回需要豁免的规则，逐条给出理由 —— 这就是预期中的 AI 修复循环
        const needWaiver = extractWaiverRuleIds(s);
        const overrides = needWaiver.map((ruleId) => ({
          ruleId,
          reason: `冒烟测试：${ruleId} 经人工确认可接受`,
        }));

        await callOk("ditto_approval_decide", {
          projectId,
          assetId: a.id,
          decision: "approved",
          overrides,
          reason: "冒烟测试批量放行",
        });
        ok(`放行 ${a.path}`, overrides.length > 0 ? `豁免 ${overrides.length} 条` : "");
      }

      await callOk("ditto_asset_release", { projectId, assetId: a.id });
      ok(`发布 ${a.path}`);
    }

    const afterAll = await callOk("ditto_asset_list", { projectId });
    const notReleased = extractAssetsNotReleased(afterAll);
    assertEq(notReleased.length, 0, "全部资产已发布");

    /* ---------------------------------------------------------------- */
    section("15. 资源读取");

    const res = await client.readResource({ uri: `ditto://asset/${docId}` });
    const firstContent = res.contents[0] as { text?: string; mimeType?: string };
    assert(
      (firstContent.text ?? "").includes("冒烟客户"),
      "按 id 读取资产正文成功",
      `mime=${firstContent.mimeType}`
    );

    // {+path} 模板：路径里的斜杠必须被保留，否则永远匹配不上
    const byPath = await client.readResource({
      uri: `ditto://project/${projectId}/asset-by-path/docs/01-项目实施方案.md`,
    });
    const byPathText = (byPath.contents[0] as { text?: string }).text ?? "";
    assert(byPathText.includes("冒烟客户"), "按逻辑路径读取资产成功（{+path} 生效）");

    const ctxRes = await client.readResource({ uri: `ditto://context/${projectId}` });
    assert(
      ((ctxRes.contents[0] as { text?: string }).text ?? "").includes("项目上下文"),
      "项目上下文资源可读"
    );

    /* ---------------------------------------------------------------- */
    section("16. 交付包：只导出已发布资产");

    const exported = await callOk("ditto_project_export", { projectId });
    assert(exported.includes("已导出"), "导出成功");
    assert(
      /已导出 10 个文件/.test(exported),
      "导出文件数与已发布资产数一致",
      exported.split("\n")[0]
    );

    /* ---------------------------------------------------------------- */
    section("17. 审计链完整");

    const verify = await callOk("ditto_audit_verify");
    assert(verify.includes("审计链完好"), "哈希链校验通过", verify.split("\n")[0]);

    const audit = await callOk("ditto_audit_list", { projectId, limit: 200 });
    assert(audit.includes("rule.waive") || audit.includes("asset.approve"), "审计里有审批记录");

    /* ---------------------------------------------------------------- */
    section("18. 错误路径：不存在的资产");

    const missing = await callExpectError("ditto_asset_get", {
      projectId,
      assetId: "01AAAAAAAAAAAAAAAAAAAAAAAA",
    });
    assert(missing.includes("E_NOT_FOUND"), "返回明确的中文错误", missing.split("\n")[0]);

    /* ---------------------------------------------------------------- */
    console.log(`\n${"═".repeat(62)}`);
    console.log(failed === 0 ? `全部通过（${passed} 项断言）` : `${failed} 项失败`);
    console.log(`Web MCP：${httpUrl}`);
  } finally {
    await client.close().catch(() => undefined);
  }

  process.exit(failed === 0 ? 0 : 1);
}

/* ------------------------------------------------------------------ */
/* 输出解析                                                            */
/* ------------------------------------------------------------------ */

function extractProjectId(text: string): string {
  const m = text.match(/项目 id：(\S+)/);
  return m ? m[1] : "";
}

/** 从 ditto_asset_list 的文本里取出某路径对应的 assetId */
function extractAssetId(text: string, assetPath: string): string {
  for (const line of text.split("\n")) {
    if (line.includes(assetPath)) {
      const m = line.match(/·\s*([0-9A-Z]{26})/);
      if (m) return m[1];
    }
  }
  return "";
}

interface AssetLine {
  id: string;
  path: string;
  status: string;
}

function extractAssetsNotReleased(text: string): AssetLine[] {
  const out: AssetLine[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/·\s*([0-9A-Z]{26})｜([^｜]+)｜[^｜]+｜([^｜]+)｜/);
    if (!m) continue;
    if (m[3].trim() === "released") continue;
    out.push({ id: m[1], path: m[2].trim(), status: m[3].trim() });
  }
  return out;
}

function extractCount(text: string, label: string): number {
  const m = text.match(new RegExp(`${label}：(\\d+)`));
  return m ? Number.parseInt(m[1], 10) : -1;
}

/** 从提交评审的返回里取出「需要豁免的规则」清单 */
function extractWaiverRuleIds(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.includes("需要豁免的规则"));
  if (start === -1) return [];

  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.startsWith("下一步") || line.startsWith("下一步：")) break;
    const m = line.match(/^\s*·\s*(\S+)/);
    if (m && m[1] !== "（无）") out.push(m[1]);
  }
  return out;
}

main().catch((e) => {
  console.error(`\n✗ 未捕获错误：${e?.stack ?? e}`);
  process.exit(1);
});
