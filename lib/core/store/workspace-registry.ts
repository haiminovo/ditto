/**
 * Web 工作区注册表。
 *
 * 浏览器只传 workspace id，服务端负责把 id 解析为真实路径。注册表本身
 * 使用原子写保存，默认位于 <cwd>/.ditto/workspaces.json，且不纳入 git。
 */

import fs from "node:fs";
import path from "node:path";
import { CoreError, invalid, notFound } from "../errors";
import { ulid } from "../ids";
import { BUILTIN_SEEDS } from "../../capabilities/builtin/general";
import type { WorkspaceKind, WorkspaceOption, WorkspaceState } from "../../workspace/types";
import { readJsonOrNull, writeJsonAtomic } from "./fsjson";
import { resolveWorkspaceRoot, workspaceInitialized } from "./paths";
import { initWorkspace, readWorkspaceMeta } from "./workspace";

export const WORKSPACE_REGISTRY_ENV = "DITTO_WORKSPACE_REGISTRY";

const REGISTRY_VERSION = 1;

interface WorkspaceRecord {
  id: string;
  name: string;
  path: string;
  kind: WorkspaceKind;
  createdAt: string;
  lastUsedAt: string;
}

interface WorkspaceRegistryFile {
  version: 1;
  activeId: string;
  workspaces: WorkspaceRecord[];
}

let mutationChain: Promise<unknown> = Promise.resolve();

function withMutationLock<T>(operation: () => T | Promise<T>): Promise<T> {
  const run = mutationChain.then(operation, operation);
  mutationChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function registryPath(): string {
  const configured = process.env[WORKSPACE_REGISTRY_ENV]?.trim();
  return configured
    ? path.resolve(process.cwd(), configured)
    : path.join(process.cwd(), ".ditto", "workspaces.json");
}

function defaultRoot(): string {
  return path.resolve(resolveWorkspaceRoot());
}

function emptyRegistry(): WorkspaceRegistryFile {
  const now = new Date().toISOString();
  return {
    version: REGISTRY_VERSION,
    activeId: "default",
    workspaces: [
      {
        id: "default",
        name: "默认工作区",
        path: defaultRoot(),
        kind: "default",
        createdAt: now,
        lastUsedAt: now,
      },
    ],
  };
}

function isRecord(value: unknown): value is WorkspaceRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<WorkspaceRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    typeof record.path === "string" &&
    (record.kind === "default" || record.kind === "external") &&
    typeof record.createdAt === "string" &&
    typeof record.lastUsedAt === "string"
  );
}

function loadRegistry(): WorkspaceRegistryFile {
  const file = registryPath();
  let parsed: unknown = null;

  try {
    parsed = readJsonOrNull<unknown>(file);
  } catch {
    parsed = null;
  }

  const candidate =
    parsed && typeof parsed === "object"
      ? (parsed as Partial<WorkspaceRegistryFile>)
      : null;
  const records = Array.isArray(candidate?.workspaces)
    ? candidate.workspaces.filter(isRecord)
    : [];

  if (records.length === 0) return emptyRegistry();

  const now = new Date().toISOString();
  const existingDefault = records.find((record) => record.id === "default");
  const defaultRecord: WorkspaceRecord = {
    id: "default",
    name: existingDefault?.name || "默认工作区",
    path: defaultRoot(),
    kind: "default",
    createdAt: existingDefault?.createdAt || now,
    lastUsedAt: existingDefault?.lastUsedAt || now,
  };
  const workspaces = [
    defaultRecord,
    ...records.filter((record) => record.id !== "default"),
  ];
  const activeId = workspaces.some((record) => record.id === candidate?.activeId)
    ? (candidate?.activeId as string)
    : "default";

  return { version: REGISTRY_VERSION, activeId, workspaces };
}

function saveRegistry(registry: WorkspaceRegistryFile): void {
  writeJsonAtomic(registryPath(), registry);
}

function toOption(record: WorkspaceRecord): WorkspaceOption {
  return {
    ...record,
    initialized: workspaceInitialized(record.path),
  };
}

function toState(registry: WorkspaceRegistryFile): WorkspaceState {
  const workspaces = registry.workspaces
    .map(toOption)
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "default" ? -1 : 1;
      return b.lastUsedAt.localeCompare(a.lastUsedAt);
    });
  return {
    active: workspaces.find((workspace) => workspace.id === registry.activeId) ?? null,
    workspaces,
  };
}

function findRecord(registry: WorkspaceRegistryFile, id: string): WorkspaceRecord {
  const record = registry.workspaces.find((workspace) => workspace.id === id);
  if (!record) throw notFound("工作区", id);
  return record;
}

function expandHome(input: string): string {
  if (input === "~") return process.env.HOME ?? input;
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(process.env.HOME ?? "~", input.slice(2));
  }
  return input;
}

function assertSafeWorkspaceRoot(root: string): void {
  const cwd = fs.realpathSync(process.cwd());
  const relative = path.relative(root, cwd);
  const containsCwd =
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative));

  if (containsCwd || root === path.parse(root).root || root === process.env.HOME) {
    throw invalid("不能把项目目录、用户主目录或文件系统根目录设为工作区");
  }

  if (fs.existsSync(root) && !fs.statSync(root).isDirectory()) {
    throw invalid("工作区路径必须是一个目录");
  }
}

function canonicalWorkspacePath(input: string): string {
  const expanded = expandHome(input.trim());
  if (!expanded) throw invalid("工作区路径不能为空");
  if (!path.isAbsolute(expanded)) {
    throw invalid("请输入绝对路径");
  }

  const target = path.resolve(expanded);
  if (fs.existsSync(target)) {
    const real = fs.realpathSync(target);
    assertSafeWorkspaceRoot(real);
    return real;
  }

  const parent = path.dirname(target);
  if (!fs.existsSync(parent)) {
    throw invalid(`父目录不存在：${parent}`);
  }
  if (!fs.statSync(parent).isDirectory()) {
    throw invalid(`父路径不是目录：${parent}`);
  }

  const realParent = fs.realpathSync(parent);
  const real = path.join(realParent, path.basename(target));
  assertSafeWorkspaceRoot(real);
  return real;
}

function prepareWorkspace(root: string, name?: string): string {
  fs.mkdirSync(root, { recursive: true });
  const entries = fs.readdirSync(root);
  const marker = path.join(root, "ditto.workspace.json");

  if (!fs.existsSync(marker) && entries.length > 0) {
    throw invalid("目录非空且不是 Ditto 工作区，请选择空目录或已有工作区");
  }

  const displayName = name?.trim() || path.basename(root) || "工作区";
  initWorkspace(root, BUILTIN_SEEDS, { name: displayName });
  return readWorkspaceMeta(root)?.name || displayName;
}

export async function listWorkspaceState(): Promise<WorkspaceState> {
  return withMutationLock(() => {
    const registry = loadRegistry();
    saveRegistry(registry);
    return toState(registry);
  });
}

export async function addWorkspace(input: {
  path: string;
  name?: string;
}): Promise<WorkspaceState> {
  return withMutationLock(() => {
    const registry = loadRegistry();
    const root = canonicalWorkspacePath(input.path);
    const name = prepareWorkspace(root, input.name);
    const now = new Date().toISOString();
    const existing = registry.workspaces.find((workspace) => workspace.path === root);

    if (existing) {
      existing.name = name;
      existing.lastUsedAt = now;
      registry.activeId = existing.id;
    } else {
      const record: WorkspaceRecord = {
        id: `ws_${ulid()}`,
        name,
        path: root,
        kind: "external",
        createdAt: now,
        lastUsedAt: now,
      };
      registry.workspaces.push(record);
      registry.activeId = record.id;
    }

    saveRegistry(registry);
    return toState(registry);
  });
}

export async function selectWorkspace(id: string): Promise<WorkspaceState> {
  return withMutationLock(() => {
    const registry = loadRegistry();
    const record = findRecord(registry, id);
    record.lastUsedAt = new Date().toISOString();
    registry.activeId = record.id;
    saveRegistry(registry);
    return toState(registry);
  });
}

export async function initializeWorkspace(id: string): Promise<WorkspaceState> {
  return withMutationLock(() => {
    const registry = loadRegistry();
    const record = findRecord(registry, id);
    prepareWorkspace(record.path, record.name);
    saveRegistry(registry);
    return toState(registry);
  });
}

export async function removeWorkspace(id: string): Promise<WorkspaceState> {
  return withMutationLock(() => {
    const registry = loadRegistry();
    const record = findRecord(registry, id);
    if (record.kind === "default") {
      throw invalid("默认工作区不能移除");
    }

    registry.workspaces = registry.workspaces.filter((workspace) => workspace.id !== id);
    if (registry.activeId === id) registry.activeId = "default";
    saveRegistry(registry);
    return toState(registry);
  });
}

export function resolveWorkspaceRootById(id: string): string {
  const registry = loadRegistry();
  return findRecord(registry, id).path;
}

export function resolveActiveWorkspaceRoot(): string {
  const registry = loadRegistry();
  return findRecord(registry, registry.activeId).path;
}
