/**
 * Ditto 实施平台 - 项目读写（纯 I/O）
 *
 * 业务规则与审计在 ops/project-ops.ts，这里只负责落盘与读取。
 *
 * ⚠️ 使用 node:fs，只能在服务端使用。
 */

import fs from "node:fs";
import path from "node:path";
import { SCHEMA_VERSION, type Project, type ProjectSettings } from "../types";
import { writeJsonAtomic, readJsonOrNull } from "./fsjson";
import { ensureDir, projectPaths, workspacePaths } from "./paths";
import { notFound } from "../errors";

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  allowAiApproval: true,
  requireDistinctApprover: false,
};

export function newProject(input: {
  id: string;
  name: string;
  code: string;
  customer: string;
  description?: string;
  platforms?: string[];
  capabilityPackageIds?: string[];
  owner?: string;
  tags?: string[];
  vars?: Record<string, string>;
  settings?: Partial<ProjectSettings>;
}): Project {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: input.id,
    name: input.name,
    code: input.code,
    customer: input.customer,
    description: input.description,
    platforms: input.platforms ?? ["generic"],
    capabilityPackageIds: input.capabilityPackageIds ?? [],
    status: "draft",
    owner: input.owner,
    tags: input.tags ?? [],
    vars: input.vars ?? {},
    settings: { ...DEFAULT_PROJECT_SETTINGS, ...input.settings },
    createdAt: now,
    updatedAt: now,
  };
}

export function projectExists(wsRoot: string, projectId: string): boolean {
  return fs.existsSync(projectPaths(wsRoot, projectId).projectFile);
}

export function readProject(wsRoot: string, projectId: string): Project {
  const p = projectPaths(wsRoot, projectId);
  const project = readJsonOrNull<Project>(p.projectFile);
  if (!project) throw notFound("项目", projectId);
  return project;
}

export function readProjectOrNull(wsRoot: string, projectId: string): Project | null {
  return readJsonOrNull<Project>(projectPaths(wsRoot, projectId).projectFile);
}

export function writeProject(wsRoot: string, project: Project): void {
  const p = projectPaths(wsRoot, project.id);
  ensureDir(p.root);
  project.updatedAt = new Date().toISOString();
  writeJsonAtomic(p.projectFile, project);
}

export interface ProjectSummary extends Project {
  assetCount: number;
  pendingApprovalCount: number;
}

export function listProjects(wsRoot: string): Project[] {
  const dir = workspacePaths(wsRoot).projectsDir;
  if (!fs.existsSync(dir)) return [];

  const out: Project[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const project = readProjectOrNull(wsRoot, entry.name);
    if (project) out.push(project);
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 生成不与现有项目冲突的项目 id */
export function allocateProjectId(wsRoot: string, base: string): string {
  let candidate = base;
  let n = 2;
  while (projectExists(wsRoot, candidate)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}

/** 项目目录下全部相关路径 */
export function pathsFor(wsRoot: string, projectId: string) {
  return projectPaths(wsRoot, projectId);
}

export function projectDirName(projectId: string): string {
  return path.basename(projectId);
}
