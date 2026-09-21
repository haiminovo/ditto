/**
 * Ditto 实施平台 - 项目操作
 *
 * 所有写操作都在项目写锁内执行，并发射审计。
 */

import fs from "node:fs";
import path from "node:path";
import { slugify } from "../ids";
import { canTransition, type Asset, type Project, type ProjectSettings } from "../types";
import { CoreError, conflict, invalid } from "../errors";
import {
  allocateProjectId,
  newProject,
  projectExists,
  readProject,
  writeProject,
} from "../store/projects";
import { readAssets, writeAssets } from "../store/assets";
import { appendAudit } from "../store/audit";
import { ensureDir, projectPaths, workspacePaths } from "../store/paths";
import { withProjectWriteLock } from "../store/lock";
import { initWorkspace } from "../store/workspace";
import { BUILTIN_SEEDS } from "../../capabilities/builtin/general";
import { findCapability, loadCapabilities } from "../../capabilities/loader";
import type { OpContext } from "./context";

/* ------------------------------------------------------------------ */
/* 读                                                                  */
/* ------------------------------------------------------------------ */

export interface ProjectFilter {
  status?: string;
  q?: string;
}

export function listProjects(ctx: OpContext, filter: ProjectFilter = {}): Project[] {
  const dir = workspacePaths(ctx.root).projectsDir;
  if (!fs.existsSync(dir)) return [];

  let out: Project[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      out.push(readProject(ctx.root, entry.name));
    } catch {
      // 坏的项目目录跳过，不影响其它项目
    }
  }

  if (filter.status) out = out.filter((p) => p.status === filter.status);
  if (filter.q) {
    const q = filter.q.toLowerCase();
    out = out.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.code.toLowerCase().includes(q) ||
        p.customer.toLowerCase().includes(q)
    );
  }

  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getProject(ctx: OpContext, projectId: string): Project {
  return readProject(ctx.root, projectId);
}

/* ------------------------------------------------------------------ */
/* 写                                                                  */
/* ------------------------------------------------------------------ */

export interface CreateProjectInput {
  name: string;
  code?: string;
  customer: string;
  description?: string;
  platforms?: string[];
  capabilityPackageIds?: string[];
  owner?: string;
  tags?: string[];
  vars?: Record<string, string>;
  settings?: Partial<ProjectSettings>;
  /** 项目 id，不传则由名称生成 */
  id?: string;
}

export interface CreateProjectResult {
  project: Project;
  /** 已自动挂载的能力包 */
  mountedCapabilities: string[];
}

export async function createProject(
  ctx: OpContext,
  input: CreateProjectInput
): Promise<CreateProjectResult> {
  // 项目 id 用名称生成，保证是路径安全的 slug
  const base = input.id ? slugify(input.id) : slugify(input.name);
  if (!base) throw invalid("项目名称无法生成合法的项目 id");

  const projectId = allocateProjectId(ctx.root, base);
  const paths = projectPaths(ctx.root, projectId);

  return withProjectWriteLock(paths.lockDir, projectId, () => {
    if (projectExists(ctx.root, projectId)) {
      throw conflict(`项目已存在：${projectId}`);
    }

    ensureDir(paths.root);
    ensureDir(paths.assetsDir);
    ensureDir(paths.versionsDir);
    ensureDir(paths.runsDir);
    ensureDir(paths.approvalsDir);

    const project = newProject({
      id: projectId,
      name: input.name,
      code: input.code?.trim() || projectId.toUpperCase(),
      customer: input.customer,
      description: input.description,
      platforms: input.platforms,
      capabilityPackageIds: input.capabilityPackageIds,
      owner: input.owner,
      tags: input.tags,
      vars: input.vars,
      settings: input.settings,
    });

    // 挂载随机性校验：要求的能力包必须真实存在
    const mounted: string[] = [];
    if (project.capabilityPackageIds.length > 0) {
      const capabilities = loadCapabilities(ctx.root);
      for (const id of project.capabilityPackageIds) {
        if (!findCapability(capabilities, id)) {
          throw new CoreError(
            "E_CAPABILITY_NOT_FOUND",
            `无法挂载能力包「${id}」：未安装。可先执行 ditto_workspace_init 安装内置能力包。`,
            { capabilityId: id }
          );
        }
        mounted.push(id);
      }
    }

    writeProject(ctx.root, project);
    writeAssets(ctx.root, projectId, []);

    appendAudit(workspacePaths(ctx.root).auditDir, {
      actor: ctx.actor,
      action: "project.create",
      projectId,
      summary: `创建项目「${project.name}」`,
      details: { customer: project.customer, platforms: project.platforms, mounted },
    });

    return { project, mountedCapabilities: mounted };
  });
}

export interface UpdateProjectInput {
  patch?: Partial<
    Pick<Project, "name" | "code" | "customer" | "description" | "owner" | "tags" | "platforms">
  >;
  vars?: Record<string, string>;
  /** 挂载（增量）能力包 */
  mountCapabilities?: string[];
  /** 卸载能力包 */
  unmountCapabilities?: string[];
  settings?: Partial<ProjectSettings>;
  message?: string;
}

export async function updateProject(
  ctx: OpContext,
  projectId: string,
  input: UpdateProjectInput
): Promise<Project> {
  const paths = projectPaths(ctx.root, projectId);

  return withProjectWriteLock(paths.lockDir, projectId, () => {
    const project = readProject(ctx.root, projectId);

    if (input.patch) {
      Object.assign(project, input.patch);
    }

    if (input.vars) {
      project.vars = { ...project.vars, ...input.vars };
      // 空字符串代表清除该变量
      for (const [k, v] of Object.entries(project.vars)) {
        if (v === "") delete project.vars[k];
      }
    }

    if (input.settings) {
      project.settings = { ...project.settings, ...input.settings };
    }

    if (input.mountCapabilities?.length) {
      const capabilities = loadCapabilities(ctx.root);
      for (const id of input.mountCapabilities) {
        if (!findCapability(capabilities, id)) {
          throw new CoreError("E_CAPABILITY_NOT_FOUND", `无法挂载能力包「${id}」：未安装。`, {
            capabilityId: id,
          });
        }
      }
      project.capabilityPackageIds = Array.from(
        new Set([...project.capabilityPackageIds, ...input.mountCapabilities])
      );
    }

    if (input.unmountCapabilities?.length) {
      const drop = new Set(input.unmountCapabilities);
      project.capabilityPackageIds = project.capabilityPackageIds.filter((id) => !drop.has(id));
    }

    writeProject(ctx.root, project);

    appendAudit(workspacePaths(ctx.root).auditDir, {
      actor: ctx.actor,
      action: "project.update",
      projectId,
      summary: input.message ?? `更新项目「${project.name}」`,
      details: {
        patch: input.patch,
        vars: input.vars,
        mounted: input.mountCapabilities,
        unmounted: input.unmountCapabilities,
      },
    });

    return project;
  });
}

/** 确保工作区已初始化，并在需要时安装内置能力包 */
export function ensureWorkspace(ctx: OpContext): { created: boolean; seeded: string[] } {
  const result = initWorkspace(ctx.root, BUILTIN_SEEDS);
  return { created: result.created, seeded: result.seeded };
}

/** 安装一个内置能力包到工作区 */
export function installBuiltinCapability(
  ctx: OpContext,
  capabilityId: string
): { installed: boolean; id: string } {
  const seed = BUILTIN_SEEDS.find((s) => s.manifest.id === capabilityId);
  if (!seed) {
    throw new CoreError(
      "E_CAPABILITY_NOT_FOUND",
      `没有名为「${capabilityId}」的内置能力包。内置包：${BUILTIN_SEEDS.map(
        (s) => s.manifest.id
      ).join(", ")}`,
      { capabilityId }
    );
  }

  const before = fs.existsSync(
    path.join(workspacePaths(ctx.root).capabilitiesDir, capabilityId, "capability.json")
  );

  // force=false：已存在则不覆盖，用户可能已经改过
  initWorkspace(ctx.root, [seed]);

  if (!before) {
    appendAudit(workspacePaths(ctx.root).auditDir, {
      actor: ctx.actor,
      action: "capability.install",
      summary: `安装能力包「${seed.manifest.name}」`,
      details: { capabilityId },
    });
  }

  return { installed: !before, id: capabilityId };
}

/* ------------------------------------------------------------------ */
/* 状态流转                                                            */
/* ------------------------------------------------------------------ */

export async function transitionProject(
  ctx: OpContext,
  projectId: string,
  to: Project["status"],
  reason?: string
): Promise<Project> {
  const paths = projectPaths(ctx.root, projectId);

  return withProjectWriteLock(paths.lockDir, projectId, () => {
    const project = readProject(ctx.root, projectId);

    if (!canTransition(project.status, to)) {
      throw new CoreError(
        "E_STATUS_TRANSITION",
        `项目「${project.name}」不能从「${project.status}」流转到「${to}」`,
        { from: project.status, to }
      );
    }

    const from = project.status;
    project.status = to;
    writeProject(ctx.root, project);

    appendAudit(workspacePaths(ctx.root).auditDir, {
      actor: ctx.actor,
      action: to === "released" ? "project.release" : "project.submit",
      projectId,
      summary: reason ?? `项目状态：${from} → ${to}`,
      details: { from, to },
    });

    return project;
  });
}

/* ------------------------------------------------------------------ */
/* 项目全貌（供 ditto_project_get / ditto_handoff 使用）                */
/* ------------------------------------------------------------------ */

export interface ProjectOverview {
  project: Project;
  assets: Asset[];
  assetCount: number;
}

export function projectOverview(ctx: OpContext, projectId: string): ProjectOverview {
  const project = readProject(ctx.root, projectId);
  const assets = readAssets(ctx.root, projectId);
  return { project, assets, assetCount: assets.length };
}
