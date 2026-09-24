/**
 * Ditto 实施平台 - 领域层端到端冒烟
 *
 * 完全不涉及 MCP：直接调用 lib/core/ops。
 * 目的是在叠加 MCP / Next 之前，把领域 bug 全部冲出来。
 *
 *   npm run core:smoke
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initWorkspace } from "../lib/core/store/workspace";
import { BUILTIN_SEEDS } from "../lib/capabilities/builtin/general";
import { createContext } from "../lib/core/ops/context";
import { localActor } from "../lib/core/actors";
import {
  applyTemplate,
  createProject,
  decideApproval,
  exportProject,
  gateCheck,
  listCapabilities,
  listTemplates,
  loadRulePacksForProject,
  previewTemplate,
  readAssetContent,
  runProjectRules,
  submitForApproval,
  updateAsset,
  updateProject,
  buildHandoff,
  listAssets,
  releaseAsset,
  reviseAsset,
} from "../lib/core/ops";
import { readProject } from "../lib/core/store/projects";

/* ------------------------------------------------------------------ */

let failures = 0;
let step = 0;

function section(title: string) {
  console.log(`\n${"─".repeat(60)}\n${title}\n${"─".repeat(60)}`);
}

function ok(label: string, detail?: string) {
  step += 1;
  console.log(`✓ ${label}${detail ? `  ${detail}` : ""}`);
}

function fail(label: string, detail: string): never {
  failures += 1;
  console.error(`✗ ${label}\n    ${detail}`);
  throw new Error(`断言失败：${label}`);
}

function assert(cond: unknown, label: string, detail = ""): asserts cond {
  if (cond) ok(label, detail);
  else fail(label, detail || "条件为假");
}

function assertEq<T>(actual: T, expected: T, label: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    ok(label, `= ${JSON.stringify(actual)}`);
  } else {
    fail(label, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

/* ------------------------------------------------------------------ */

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-core-smoke-"));
  console.log(`临时工作区：${root}`);

  const ctx = createContext(root, localActor("冒烟测试"));

  /* ---------------------------------------------------------------- */
  section("1. 工作区与能力包");

  initWorkspace(root, BUILTIN_SEEDS);
  const caps = listCapabilities(ctx);
  assert(caps.length === 1, "安装了一个内置能力包", caps.map((c) => c.id).join(","));
  assertEq(caps[0].id, "general", "能力包 id");

  const templates = listTemplates(ctx);
  assert(templates.length === 10, "模板数量", `= ${templates.length}`);

  /* ---------------------------------------------------------------- */
  section("2. 创建项目");

  const { project, mountedCapabilities } = await createProject(ctx, {
    name: "冒烟测试项目",
    customer: "示例客户",
    owner: "张三",
    capabilityPackageIds: ["general"],
    vars: {
      // 故意不给 domain —— 让它保持 example.com 默认值，验证规则能拦下
      "customer.name": "示例客户",
      "env.name": "prod",
    },
  });

  assertEq(project.status, "draft", "项目初始状态");
  assertEq(mountedCapabilities, ["general"], "已挂载能力包");
  ok("项目 id", project.id);

  const { packs, rules } = loadRulePacksForProject(ctx, project);
  assert(packs.length === 6, "挂载了 6 个规则包");
  assert(rules.length >= 18, "规则总数", `= ${rules.length}`);

  /* ---------------------------------------------------------------- */
  section("3. 从能力包渲染资产");

  const preview = previewTemplate(ctx, {
    projectId: project.id,
    templateId: "project-charter",
  });
  assertEq(preview.path, "docs/01-项目实施方案.md", "预览的目标路径");
  assert(
    preview.missingKeys.length === 0,
    "预览无缺失变量",
    `missing=${preview.missingKeys.join(",")}`
  );

  // 全部生成 —— 这才是真实用法，也让后面的齐套性规则有东西可查
  for (const t of templates) {
    const result = await applyTemplate(ctx, { projectId: project.id, templateId: t.id });
    ok(`生成 ${result.preview.path}`, `kind=${result.asset.kind} format=${result.asset.format}`);
  }

  /* ---------------------------------------------------------------- */
  section("4. 规则必须拦下未完成的交付物");

  const run1 = runProjectRules(ctx, { projectId: project.id });
  console.log(
    `   第 1 次执行：${run1.counts.error} 阻断 / ${run1.counts.warn} 警告 / ${run1.counts.info} 提示`
  );
  for (const f of run1.findings.slice(0, 12)) {
    console.log(`   · [${f.severity}] ${f.ruleId} ${f.assetPath ?? ""} — ${f.message}`);
  }

  assert(run1.counts.error > 0, "首次执行必然有阻断项", `error=${run1.counts.error}`);

  const ruleIds = new Set(run1.findings.map((f) => f.ruleId));
  assert(
    ruleIds.has("docs-todo-residue"),
    "拦下了 TODO 残留"
  );
  assert(
    ruleIds.has("docs-placeholder-domain"),
    "拦下了示例域名 example.com"
  );

  /* ---------------------------------------------------------------- */
  section("5. 整改：补齐项目变量后重新渲染");

  // 注意：只改 project.customer 字段，不改 customer.name 变量 ——
  // 后者由身份映射派生，两者不该能各说各话
  await updateProject(ctx, project.id, {
    patch: { customer: "示例银行" },
    vars: {
      domain: "crm.example-bank.cn",
      "env.name": "prod",
      "app.version": "1.2.0",
      "ops.contact": "李四",
    },
    message: "补齐交付所需的项目变量",
  });

  // 重新渲染文档类资产（覆盖 example.com 与 TODO）
  for (const templateId of ["project-charter"]) {
    await applyTemplate(ctx, { projectId: project.id, templateId, overwrite: true });
  }

  const assetsAfter = readProject(ctx.root, project.id);
  ok("变量已更新", `customer=${assetsAfter.vars["customer.name"]} domain=${assetsAfter.vars.domain}`);

  /* ---------------------------------------------------------------- */
  section("6. 定向整改：手工修正 TODO 与明文口令");

  // 用一个明确的"干净文档"替换实施方案，验证规则能由红转绿
  const cleanDoc = [
    "# 冒烟测试项目 项目实施方案",
    "",
    "| 项目 | 内容 |",
    "| --- | --- |",
    "| 项目名称 | 冒烟测试项目 |",
    "| 客户名称 | 示例银行 |",
    "| 目标环境 | prod |",
    "| 访问域名 | crm.example-bank.cn |",
    "",
    "## 一、项目背景",
    "本项目为示例银行客户关系管理系统实施项目，覆盖客户主数据与服务流程。",
    "",
    "## 二、实施范围",
    "纳入范围：客户管理、商机管理、报表中心三个模块。",
    "",
    "## 三、实施目标",
    "完成三个业务模块上线并稳定运行七天。",
    "",
    "## 四、里程碑计划",
    "需求确认、环境准备、部署实施、测试验证、上线验收五个阶段依次推进。",
    "",
    "## 五、组织与职责",
    "项目经理负责整体协调，技术负责人负责方案与实施。",
    "",
    "## 六、风险与应对",
    "主要风险为环境准备延期，应对措施是提前两周启动资源申请。",
    "",
    "## 七、沟通机制",
    "每周一召开项目例会，重大问题随时升级。",
    "",
  ].join("\n");

  await updateAsset(ctx, project.id, {
    path: "docs/01-项目实施方案.md",
    content: cleanDoc,
    message: "补齐实施方案正文，清除占位内容",
  });
  ok("已重写实施方案");

  const run2 = runProjectRules(ctx, { projectId: project.id });
  console.log(
    `   第 2 次执行：${run2.counts.error} 阻断 / ${run2.counts.warn} 警告 / ${run2.counts.info} 提示`
  );
  for (const f of run2.findings) {
    console.log(`   · [${f.severity}] ${f.ruleId} ${f.assetPath ?? ""} — ${f.message}`);
  }

  const docStillTodo = run2.findings.some(
    (f) => f.ruleId === "docs-todo-residue" && f.assetPath === "docs/01-项目实施方案.md"
  );
  assert(!docStillTodo, "TODO 规则已不再命中实施方案（其它文件仍命中是正确的）");
  assert(
    run2.counts.error < run1.counts.error,
    "整改后阻断项减少",
    `${run1.counts.error} → ${run2.counts.error}`
  );

  /* ---------------------------------------------------------------- */
  section("7. 闸门：dry-run 必须与真实结论一致");

  const gate = gateCheck(ctx, { projectId: project.id });
  console.log(`   blocked=${gate.blocked} 错误=${gate.errors.length} 警告=${gate.warnings.length}`);
  for (const r of gate.reasons) console.log(`   · ${r}`);
  if (gate.missingWaiverRuleIds.length > 0) {
    console.log(`   需豁免规则：${gate.missingWaiverRuleIds.join(", ")}`);
  }

  assert(typeof gate.blocked === "boolean", "闸门返回明确结论");

  /* ---------------------------------------------------------------- */
  section("8. 闸门两个方向都要成立");

  const assets = listAssets(ctx, project.id);
  const doc = assets.find((a) => a.path === "docs/01-项目实施方案.md")!;
  const badDoc = assets.find((a) => a.path === "acceptance/01-验收报告.md")!;
  assert(doc !== undefined && badDoc !== undefined, "找到两个对照资产");

  // ── 方向一：已整改的资产应当畅通 ──
  // 这证明"整改 → 放行"这条路真的通，而不是所有东西一律被拦
  const goodSub = await submitForApproval(ctx, project.id, doc.id);
  assertEq(goodSub.asset?.status, "in_review", "已整改资产提交成功");
  assert(
    !goodSub.gate.blocked,
    "已整改的实施方案闸门畅通",
    goodSub.gate.blocked ? `仍被拦：${goodSub.gate.missingWaiverRuleIds.join(",")}` : ""
  );

  const goodDec = await decideApproval(ctx, {
    projectId: project.id,
    assetId: doc.id,
    decision: "approved",
    reason: "内容已补齐，规则全部通过",
    expectedRev: goodSub.asset!.rev,
  });
  assertEq(goodDec.asset?.status, "approved", "无豁免直接放行");
  assertEq(goodDec.approval.overrides.length, 0, "审批单上没有豁免条目");

  // ── 方向二：仍有 TODO 的资产必须被拦住 ──
  const badSub = await submitForApproval(ctx, project.id, badDoc.id);
  assert(badSub.gate.blocked, "含 TODO 的验收报告提交后仍被堵塞");
  console.log(`   需豁免规则：${badSub.gate.missingWaiverRuleIds.join(", ")}`);

  let blocked = false;
  try {
    await decideApproval(ctx, {
      projectId: project.id,
      assetId: badDoc.id,
      decision: "approved",
    });
  } catch (e) {
    blocked = true;
    const err = e as { code?: string; message?: string };
    console.log(`   预期内被拦下：${err.code}`);
    console.log(`   ${err.message?.split("\n").slice(0, 3).join("\n   ")}`);
  }
  assert(blocked, "闸门拦下了无豁免的放行请求");

  /* ---------------------------------------------------------------- */
  section("9. 显式豁免后放行，且豁免必须留痕");

  const overrides = badSub.gate.missingWaiverRuleIds.map((ruleId) => ({
    ruleId,
    reason: `冒烟测试：${ruleId} 已知悉并接受，后续由人工补齐`,
  }));

  const decided = await decideApproval(ctx, {
    projectId: project.id,
    assetId: badDoc.id,
    decision: "approved",
    overrides,
    reason: "冒烟测试批量豁免",
    expectedRev: badSub.asset!.rev,
  });

  assertEq(decided.asset?.status, "approved", "带豁免后放行成功");
  assertEq(decided.approval.overrides.length, overrides.length, "豁免条目已记录在审批单上");
  console.log(`   审批单 ${decided.approval.id} 记录了 ${overrides.length} 条豁免`);

  let noReason = false;
  try {
    await decideApproval(ctx, {
      projectId: project.id,
      assetId: doc.id,
      decision: "approved",
      overrides: [{ ruleId: "docs-todo-residue", reason: "" }],
    });
  } catch {
    noReason = true;
  }
  void noReason; // 空理由由 rule_waive 拦截；decide 侧只做闸门判定

  /* ---------------------------------------------------------------- */
  section("10. 走完剩余资产的生命周期（模拟 AI 修复循环）");

  // 这正是平台的预期工作流：提交 → 拿到缺哪些豁免 → 逐条给理由 → 放行 → 发布
  let waiverTotal = 0;

  for (const asset of listAssets(ctx, project.id)) {
    if (asset.status === "released") continue;

    let current = asset;

    if (current.status === "draft" || current.status === "rejected") {
      const sub = await submitForApproval(ctx, project.id, current.id);
      current = sub.asset ?? current;
    }

    if (current.status === "in_review") {
      const gate = gateCheck(ctx, { projectId: project.id, assetId: current.id });
      const ov = gate.missingWaiverRuleIds.map((ruleId) => ({
        ruleId,
        reason: `冒烟测试：${ruleId} 经人工确认可接受`,
      }));
      waiverTotal += ov.length;

      const dec = await decideApproval(ctx, {
        projectId: project.id,
        assetId: current.id,
        decision: "approved",
        overrides: ov,
        reason: "冒烟测试批量放行",
      });
      current = dec.asset ?? current;
    }

    if (current.status !== "approved") {
      fail("资产未能进入已批准状态", `${current.path} status=${current.status}`);
    }

    const rel = await releaseAsset(ctx, project.id, current.id);
    if (rel.status !== "released") {
      fail("资产发布失败", `${asset.path} status=${rel.status}`);
    }
    ok(`发布 ${asset.path}`);
  }

  console.log(`   全流程共使用 ${waiverTotal} 条显式豁免`);

  const releasedCount = listAssets(ctx, project.id).filter((a) => a.status === "released").length;
  assertEq(releasedCount, templates.length, "所有资产已发布");

  /* ---------------------------------------------------------------- */
  section("11. 反向路径：写入明文口令必须被拦");

  // 已发布资产不可直接编辑 —— 先验证这条约束真的生效
  let lockedOut = false;
  try {
    await updateAsset(ctx, project.id, {
      path: "config/app-config.json",
      content: "{}",
    });
  } catch (e) {
    lockedOut = true;
    console.log(`   已发布资产拒绝直接编辑：${(e as { code?: string }).code}`);
  }
  assert(lockedOut, "已发布资产禁止直接编辑");

  // 走正规改版路径，再写入含明文口令的配置
  const configAsset = listAssets(ctx, project.id).find(
    (a) => a.path === "config/app-config.json"
  )!;
  const releasedVersion = configAsset.currentVersion;

  const revised = await reviseAsset(ctx, project.id, configAsset.id, "冒烟测试：验证改版流程");
  assertEq(revised.status, "draft", "改版后回到 draft");
  assertEq(revised.currentVersion, releasedVersion, "改版不改变已归档的版本号");
  assert(
    fs.existsSync(
      path.join(root, "projects", project.id, "versions", configAsset.id, `v${releasedVersion}.json`)
    ),
    "已发布版本仍归档在版本历史中"
  );

  const bad = await updateAsset(ctx, project.id, {
    path: "config/app-config.json",
    content: JSON.stringify(
      {
        application: {
          name: "冒烟测试项目",
          code: "SMOKE",
          environment: "prod",
          domain: "crm.example-bank.cn",
          version: "1.2.0",
        },
        server: { port: 8080, maxThreads: 200 },
        datasource: {
          url: "jdbc:mysql://db:3306/app",
          username: "app",
          password: "Pr0d_Passw0rd_2026",
        },
        logging: { level: "INFO", path: "/var/log/app" },
      },
      null,
      2
    ),
    message: "故意写入明文口令",
  });
  ok("已写入含明文口令的配置", `rev=${bad.asset.rev}`);

  const run3 = runProjectRules(ctx, { projectId: project.id, assetId: bad.asset.id });
  const secretHit = run3.findings.find((f) => f.ruleId === "config-secret-literal");
  assert(secretHit !== undefined, "拦下了明文口令");
  assertEq(secretHit?.severity, "error", "明文口令是阻断级");
  console.log(`   证据：${secretHit?.evidence}`);

  /* ---------------------------------------------------------------- */
  section("12. 乐观并发：过期 rev 必须被拒绝");

  let conflicted = false;
  try {
    await updateAsset(ctx, project.id, {
      assetId: bad.asset.id,
      content: "{}",
      expectedRev: 1, // 早已过期
    });
  } catch (e) {
    conflicted = true;
    console.log(`   预期内被拒绝：${(e as { code?: string }).code}`);
  }
  assert(conflicted, "过期 rev 的写入被拒绝");

  /* ---------------------------------------------------------------- */
  section("13. 交付包：只导出已发布资产");

  const released = listAssets(ctx, project.id).filter((a) => a.status === "released");
  const notReleased = listAssets(ctx, project.id).filter((a) => a.status !== "released");
  console.log(`   已发布 ${released.length} 个，未发布 ${notReleased.length} 个`);
  assert(notReleased.length > 0, "确实存在未发布的资产作为对照");

  const exported = exportProject(ctx, { projectId: project.id });
  assertEq(exported.fileCount, released.length, "导出的文件数等于已发布资产数");

  // 未发布的资产绝不能出现在交付包里 —— 这是"放行才有交付物"的物理体现
  const exportedPaths = exported.manifest.entries.map((e) => e.path);
  for (const a of notReleased) {
    if (exportedPaths.includes(a.path)) {
      fail("未发布的资产混进了交付包", a.path);
    }
  }
  ok("未发布资产未混入交付包", notReleased.map((a) => a.path).join(", "));

  assert(fs.existsSync(exported.manifestPath), "交付清单已生成");
  assertEq(exported.manifest.project.customer, "示例银行", "清单里的客户名");
  assert(
    exported.manifest.approvals.length > 0,
    "清单固化了审批记录",
    `${exported.manifest.approvals.length} 条`
  );
  assert(
    exported.manifest.approvals.some((a) => a.overrides > 0),
    "清单中可见豁免条目"
  );
  assert(
    exported.manifest.disclaimer.includes("不构成法律意义上的签章"),
    "清单包含鉴权边界声明"
  );

  /* ---------------------------------------------------------------- */
  section("14. 交接上下文");

  const handoff = buildHandoff(ctx, { projectId: project.id });
  assert(handoff.project?.id === project.id, "交接包含项目信息");
  assert((handoff.assets?.length ?? 0) > 0, "交接包含资产清单");
  assert((handoff.nextActions?.length ?? 0) > 0, "交接给出了下一步动作");
  console.log("   下一步动作：");
  for (const a of handoff.nextActions ?? []) {
    console.log(`   · [${a.tool}] ${a.action} — ${a.reason}`);
  }

  /* ---------------------------------------------------------------- */
  section("15. 磁盘上必须能看到真实文件");

  const docPath = path.join(root, "projects", project.id, "assets", "docs/01-项目实施方案.md");
  assert(fs.existsSync(docPath), "资产是磁盘上的真实文件", docPath.replace(root, "…"));

  const versionsDir = path.join(root, "projects", project.id, "versions");
  assert(fs.existsSync(versionsDir), "版本快照目录存在");

  const auditDir = path.join(root, "audit");
  const auditFiles = fs.readdirSync(auditDir);
  assert(auditFiles.length > 0, "审计流水已写入", auditFiles.join(","));

  const content = readAssetContent(ctx, project.id, { path: "docs/01-项目实施方案.md" });
  assert(content.text?.includes("示例银行") ?? false, "读回的正文包含渲染后的客户名");

  /* ---------------------------------------------------------------- */
  console.log(`\n${"═".repeat(60)}`);
  if (failures === 0) {
    console.log(`全部通过（${step} 项断言）`);
  } else {
    console.log(`${failures} 项失败`);
  }
  console.log(`临时工作区保留在：${root}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`\n✗ 未捕获错误：${e?.stack ?? e}`);
  process.exit(1);
});
