"use server";

/**
 * 控制台写操作 —— MCP 工具之外的**第二个薄壳**。
 *
 * ★ 铁律：这里只做「FormData → lib/core/ops → revalidatePath」，不写业务逻辑。
 *   一旦控制台和 MCP 各写一份逻辑，审计流水就会分叉，
 *   同一个动作在两个入口得出不同结论，闸门随之失去意义。
 *
 * 为什么用 Server Actions 而不是 REST：
 *   MCP HTTP 端点已经是**机器接口**（JSON-RPC over SSE，自带会话与协商语义）。
 *   拿它驱动人类 UI 等于在浏览器里再写一个 MCP 客户端；
 *   而另包一层 REST 会是第三个需要同步的接口面，且没有外部消费者。
 *   代价要认：Server Actions **不是公开 API** —— 将来要脚本化，
 *   答案是 MCP HTTP 端点，而不是回补一个 REST。
 */

import { revalidatePath } from "next/cache";
import { consoleActor } from "@/lib/core/actors";
import { createContext } from "@/lib/core/ops/context";
import { resolveWorkspaceRoot } from "@/lib/core/store/paths";
import {
  createProject,
  transitionProject,
  updateProject,
} from "@/lib/core/ops/project-ops";
import {
  createAsset,
  deleteAsset,
  reviseAsset,
  updateAsset,
} from "@/lib/core/ops/asset-ops";
import {
  decideApproval,
  releaseAsset,
  submitForApproval,
} from "@/lib/core/ops/approval-ops";
import { applyTemplate } from "@/lib/core/ops/template-ops";
import { runProjectRules } from "@/lib/core/ops/rule-ops";
import { exportProject } from "@/lib/core/ops/delivery-ops";
import { installBuiltinCapability } from "@/lib/core/ops/project-ops";
import { isCoreError } from "@/lib/core/errors";

export interface ActionState {
  ok: boolean;
  message: string;
}

function ctxFor(actorName?: string) {
  return createContext(resolveWorkspaceRoot(), consoleActor(actorName));
}

function toState(error: unknown): ActionState {
  if (isCoreError(error)) {
    return { ok: false, message: `${error.message}` };
  }
  return { ok: false, message: error instanceof Error ? error.message : String(error) };
}

function refresh(projectId?: string) {
  revalidatePath("/impl");
  revalidatePath("/impl/projects");
  revalidatePath("/impl/approvals");
  revalidatePath("/impl/audit");
  if (projectId) {
    revalidatePath(`/impl/projects/${projectId}`);
  }
}

const str = (fd: FormData, key: string): string => String(fd.get(key) ?? "").trim();
const opt = (fd: FormData, key: string): string | undefined => {
  const v = str(fd, key);
  return v === "" ? undefined : v;
};

/* ------------------------------------------------------------------ */
/* 工作区                                                              */
/* ------------------------------------------------------------------ */

export async function actionWorkspaceInit(): Promise<ActionState> {
  try {
    const r = installBuiltinCapability(ctxFor("控制台用户"), "general");
    refresh();
    return { ok: true, message: r.installed ? "已安装内置能力包「通用底座」" : "能力包已存在，未覆盖" };
  } catch (e) {
    return toState(e);
  }
}

/* ------------------------------------------------------------------ */
/* 项目                                                                */
/* ------------------------------------------------------------------ */

export async function actionCreateProject(fd: FormData): Promise<ActionState> {
  try {
    const vars: Record<string, string> = {};
    for (const key of ["domain", "env.name", "app.version", "ops.contact"]) {
      const v = opt(fd, `var.${key}`);
      if (v !== undefined) vars[key] = v;
    }

    const { project } = await createProject(ctxFor(str(fd, "actor")), {
      name: str(fd, "name"),
      customer: str(fd, "customer"),
      code: opt(fd, "code"),
      owner: opt(fd, "owner"),
      description: opt(fd, "description"),
      vars,
    });

    refresh(project.id);
    return { ok: true, message: `已创建项目「${project.name}」` };
  } catch (e) {
    return toState(e);
  }
}

export async function actionUpdateProjectVars(fd: FormData): Promise<ActionState> {
  try {
    const projectId = str(fd, "projectId");
    const vars: Record<string, string> = {};
    for (const [key, value] of fd.entries()) {
      if (!key.startsWith("var.")) continue;
      // 空字符串在 ops 层表示"删除该变量"
      vars[key.slice(4)] = String(value).trim();
    }

    await updateProject(ctxFor(str(fd, "actor")), projectId, {
      vars,
      message: "控制台更新项目变量",
    });

    refresh(projectId);
    return { ok: true, message: "项目变量已保存" };
  } catch (e) {
    return toState(e);
  }
}

export async function actionTransitionProject(fd: FormData): Promise<ActionState> {
  try {
    const projectId = str(fd, "projectId");
    const to = str(fd, "to") as "in_review" | "released" | "draft";
    const project = await transitionProject(ctxFor(str(fd, "actor")), projectId, to, "控制台流转");
    refresh(projectId);
    return { ok: true, message: `项目状态已变更为「${project.status}」` };
  } catch (e) {
    return toState(e);
  }
}

/* ------------------------------------------------------------------ */
/* 资产                                                                */
/* ------------------------------------------------------------------ */

export async function actionApplyTemplate(fd: FormData): Promise<ActionState> {
  try {
    const projectId = str(fd, "projectId");
    const r = await applyTemplate(ctxFor(str(fd, "actor")), {
      projectId,
      templateId: str(fd, "templateId"),
      overwrite: str(fd, "overwrite") === "1",
    });
    refresh(projectId);
    return {
      ok: true,
      message: `${r.created ? "已生成" : "已重新生成"}资产「${r.asset.path}」`,
    };
  } catch (e) {
    return toState(e);
  }
}

export async function actionSaveAsset(fd: FormData): Promise<ActionState> {
  try {
    const projectId = str(fd, "projectId");
    const assetId = str(fd, "assetId");

    await updateAsset(ctxFor(str(fd, "actor")), projectId, {
      assetId,
      content: String(fd.get("content") ?? ""),
      message: opt(fd, "message") ?? "控制台编辑正文",
    });

    refresh(projectId);
    return { ok: true, message: "正文已保存（已产生新版本，状态回到草稿）" };
  } catch (e) {
    return toState(e);
  }
}

export async function actionCreateAsset(fd: FormData): Promise<ActionState> {
  try {
    const projectId = str(fd, "projectId");
    const r = await createAsset(ctxFor(str(fd, "actor")), projectId, {
      path: str(fd, "path"),
      content: String(fd.get("content") ?? ""),
      message: "控制台新建资产",
    });
    refresh(projectId);
    return { ok: true, message: `已创建资产「${r.asset.path}」` };
  } catch (e) {
    return toState(e);
  }
}

export async function actionReviseAsset(fd: FormData): Promise<ActionState> {
  try {
    const projectId = str(fd, "projectId");
    const assetId = str(fd, "assetId");
    const a = await reviseAsset(ctxFor(str(fd, "actor")), projectId, assetId, "控制台改版");
    refresh(projectId);
    return { ok: true, message: `「${a.path}」已改版，可以继续编辑` };
  } catch (e) {
    return toState(e);
  }
}

export async function actionDeleteAsset(fd: FormData): Promise<ActionState> {
  try {
    const projectId = str(fd, "projectId");
    const r = await deleteAsset(ctxFor(str(fd, "actor")), projectId, {
      assetId: str(fd, "assetId"),
      hard: str(fd, "hard") === "1",
      reason: opt(fd, "reason"),
    });
    refresh(projectId);
    return { ok: true, message: r.hard ? `已物理删除「${r.asset.path}」` : `已废弃「${r.asset.path}」` };
  } catch (e) {
    return toState(e);
  }
}

/* ------------------------------------------------------------------ */
/* 规则与审批                                                          */
/* ------------------------------------------------------------------ */

export async function actionRunRules(fd: FormData): Promise<ActionState> {
  try {
    const projectId = str(fd, "projectId");
    const assetId = opt(fd, "assetId");
    const run = runProjectRules(ctxFor(str(fd, "actor")), { projectId, assetId });
    refresh(projectId);
    return {
      ok: true,
      message: `规则执行完成：阻断 ${run.counts.error} / 警告 ${run.counts.warn} / 提示 ${run.counts.info}`,
    };
  } catch (e) {
    return toState(e);
  }
}

export async function actionSubmitForApproval(fd: FormData): Promise<ActionState> {
  try {
    const projectId = str(fd, "projectId");
    const assetId = opt(fd, "assetId");
    const r = await submitForApproval(ctxFor(str(fd, "actor")), projectId, assetId);
    refresh(projectId);
    return {
      ok: true,
      message: r.gate.blocked
        ? `已提交评审，闸门仍拦着 ${r.gate.errors.length} 项阻断、${r.gate.warnings.length} 项警告`
        : "已提交评审，闸门已放行，可以审批通过",
    };
  } catch (e) {
    return toState(e);
  }
}

/**
 * 审批决策。
 *
 * overrides 从表单里的 `override.<ruleId>` 字段收集。
 * 有内容即视为豁免，理由为必填 —— 空理由会被 ops 层拒绝。
 */
export async function actionDecideApproval(fd: FormData): Promise<ActionState> {
  try {
    const projectId = str(fd, "projectId");
    const assetId = opt(fd, "assetId");
    const decision = str(fd, "decision") as "approved" | "rejected";

    const overrides: Array<{ ruleId: string; reason: string }> = [];
    for (const [key, value] of fd.entries()) {
      if (!key.startsWith("override.")) continue;
      const reason = String(value).trim();
      if (reason === "") continue; // 没填理由的视为未豁免
      overrides.push({ ruleId: key.slice("override.".length), reason });
    }

    const r = await decideApproval(ctxFor(str(fd, "actor")), {
      projectId,
      assetId,
      decision,
      reason: opt(fd, "reason"),
      overrides,
    });

    refresh(projectId);
    return {
      ok: true,
      message:
        `已${decision === "approved" ? "放行" : "驳回"}` +
        (r.approval.overrides.length > 0 ? `，含 ${r.approval.overrides.length} 条豁免（已留痕）` : ""),
    };
  } catch (e) {
    return toState(e);
  }
}

export async function actionReleaseAsset(fd: FormData): Promise<ActionState> {
  try {
    const projectId = str(fd, "projectId");
    const a = await releaseAsset(ctxFor(str(fd, "actor")), projectId, str(fd, "assetId"));
    refresh(projectId);
    return { ok: true, message: `「${a.path}」已发布` };
  } catch (e) {
    return toState(e);
  }
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

export async function actionExportProject(fd: FormData): Promise<ActionState> {
  try {
    const projectId = str(fd, "projectId");
    const r = exportProject(ctxFor(str(fd, "actor")), {
      projectId,
      releasedOnly: str(fd, "releasedOnly") !== "0",
    });
    refresh(projectId);
    return { ok: true, message: `已导出 ${r.fileCount} 个文件到 ${r.dir}` };
  } catch (e) {
    return toState(e);
  }
}
