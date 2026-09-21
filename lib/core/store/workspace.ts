/**
 * Ditto 实施平台 - 工作区初始化与概览
 *
 * ⚠️ 使用 node:fs，只能在服务端使用。
 */

import fs from "node:fs";
import path from "node:path";
import {
  SCHEMA_VERSION,
  WORKSPACE_MARKER,
  type CapabilityPackage,
  type RulePack,
} from "../types";
import { writeJsonAtomic, writeFileAtomic, readJsonOrNull } from "./fsjson";
import { ensureDir, workspacePaths } from "./paths";
import { appendAudit } from "./audit";
import { SYSTEM_ACTOR } from "../actors";

/**
 * 种子能力包。
 *
 * 刻意用 TypeScript 模块承载而不是仓库里的真实文件：这样 tsx 与 Next
 * 两种运行时都不需要靠 __dirname 去猜仓库根目录，行为完全一致。
 */
export interface CapabilitySeed {
  manifest: CapabilityPackage;
  /** 模板文件名 → 内容 */
  templates: Record<string, string>;
  rulePacks: RulePack[];
}

export interface WorkspaceMeta {
  schemaVersion: number;
  name: string;
  createdAt: string;
}

export interface InitResult {
  root: string;
  created: boolean;
  seeded: string[];
}

export function readWorkspaceMeta(root: string): WorkspaceMeta | null {
  const p = workspacePaths(root);
  return readJsonOrNull<WorkspaceMeta>(p.marker);
}

export function isInitialized(root: string): boolean {
  return fs.existsSync(path.join(root, WORKSPACE_MARKER));
}

/**
 * 初始化工作区目录树并把种子能力包写入 workspace/capabilities/。
 *
 * 幂等：已存在的能力包不会被覆盖（用户可能已经改过），
 * 只有缺失的才写入。重复调用只会补齐。
 */
export function initWorkspace(
  root: string,
  seeds: CapabilitySeed[] = [],
  options: { name?: string; force?: boolean } = {}
): InitResult {
  const p = workspacePaths(root);
  const existed = isInitialized(root);

  ensureDir(p.root);
  ensureDir(p.auditDir);
  ensureDir(p.projectsDir);
  ensureDir(p.capabilitiesDir);
  ensureDir(p.rulepacksDir);
  ensureDir(p.exportsDir);
  ensureDir(p.cacheDir);

  if (!existed) {
    writeJsonAtomic(p.marker, {
      schemaVersion: SCHEMA_VERSION,
      name: options.name ?? "ditto-workspace",
      createdAt: new Date().toISOString(),
    } satisfies WorkspaceMeta);
  }

  const seeded: string[] = [];
  for (const seed of seeds) {
    const dir = path.join(p.capabilitiesDir, seed.manifest.id);
    const manifestPath = path.join(dir, "capability.json");

    if (fs.existsSync(manifestPath) && !options.force) continue;

    ensureDir(dir);
    ensureDir(path.join(dir, "templates"));
    ensureDir(path.join(dir, "rules"));

    writeJsonAtomic(manifestPath, seed.manifest);

    for (const [file, content] of Object.entries(seed.templates)) {
      writeFileAtomic(path.join(dir, "templates", file), content);
    }
    for (const pack of seed.rulePacks) {
      writeJsonAtomic(path.join(dir, "rules", `${pack.id}.json`), pack);
    }

    seeded.push(seed.manifest.id);
  }

  if (!existed) {
    appendAudit(p.auditDir, {
      actor: SYSTEM_ACTOR,
      action: "workspace.init",
      summary: `初始化工作区：${root}`,
      details: { seeded },
    });
  }

  return { root, created: !existed, seeded };
}

export interface WorkspaceInfo {
  root: string;
  initialized: boolean;
  schemaVersion: number | null;
  createdAt: string | null;
  name: string | null;
  counts: {
    projects: number;
    capabilities: number;
    rulepacks: number;
  };
}

export function workspaceInfo(root: string): WorkspaceInfo {
  const p = workspacePaths(root);
  const meta = readWorkspaceMeta(root);

  return {
    root,
    initialized: meta !== null,
    schemaVersion: meta?.schemaVersion ?? null,
    createdAt: meta?.createdAt ?? null,
    name: meta?.name ?? null,
    counts: {
      projects: countDirs(p.projectsDir),
      capabilities: countDirs(p.capabilitiesDir),
      rulepacks: countFiles(p.rulepacksDir, ".json"),
    },
  };
}

function countDirs(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
}

function countFiles(dir: string, ext: string): number {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => f.endsWith(ext)).length;
}
