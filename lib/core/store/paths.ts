/**
 * Ditto 实施平台 - 工作区路径解析与路径安全
 *
 * ⚠️ 本模块使用 node:fs，只能在服务端（Next Server Component / route handler /
 *    MCP 服务端 / tsx 脚本）使用，绝不能被 "use client" 组件 import。
 */

import fs from "node:fs";
import path from "node:path";
import {
  WORKSPACE_MARKER,
  PROJECT_FILE,
  ASSETS_INDEX_FILE,
  CAPABILITY_MANIFEST_FILE,
} from "../types";
import { CoreError, invalid } from "../errors";

export const WORKSPACE_ENV = "DITTO_WORKSPACE";

/**
 * 解析工作区根目录。优先级：
 *   1. DITTO_WORKSPACE 环境变量
 *   2. 从 cwd 向上查找含 workspace/ditto.workspace.json 的目录
 *   3. <cwd>/workspace
 *
 * cwd 依赖是 stdio MCP 服务端的头号运维坑：claude mcp add 会用 Claude Code
 * 会话自己的 cwd 启动服务端。所以第二步的祖先标记搜索是必要的兜底。
 */
export function resolveWorkspaceRoot(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): string {
  const fromEnv = env[WORKSPACE_ENV]?.trim();
  if (fromEnv) {
    return path.resolve(cwd, fromEnv);
  }

  let dir = path.resolve(cwd);
  const root = path.parse(dir).root;
  while (true) {
    const candidate = path.join(dir, "workspace");
    if (fs.existsSync(path.join(candidate, WORKSPACE_MARKER))) {
      return candidate;
    }
    if (dir === root) break;
    dir = path.dirname(dir);
  }

  return path.join(path.resolve(cwd), "workspace");
}

/* ------------------------------------------------------------------ */
/* 工作区内的固定路径                                                  */
/* ------------------------------------------------------------------ */

export interface WorkspacePaths {
  root: string;
  marker: string;
  auditDir: string;
  projectsDir: string;
  capabilitiesDir: string;
  rulepacksDir: string;
  exportsDir: string;
  cacheDir: string;
}

export function workspacePaths(root: string): WorkspacePaths {
  return {
    root,
    marker: path.join(root, WORKSPACE_MARKER),
    auditDir: path.join(root, "audit"),
    projectsDir: path.join(root, "projects"),
    capabilitiesDir: path.join(root, "capabilities"),
    rulepacksDir: path.join(root, "rulepacks"),
    exportsDir: path.join(root, "exports"),
    cacheDir: path.join(root, "cache"),
  };
}

export interface ProjectPaths {
  root: string;
  projectFile: string;
  assetsIndex: string;
  assetsDir: string;
  versionsDir: string;
  runsDir: string;
  approvalsDir: string;
  lockDir: string;
}

export function projectPaths(wsRoot: string, projectId: string): ProjectPaths {
  const root = path.join(wsRoot, "projects", assertSafeSegment(projectId, "项目 id"));
  return {
    root,
    projectFile: path.join(root, PROJECT_FILE),
    assetsIndex: path.join(root, ASSETS_INDEX_FILE),
    assetsDir: path.join(root, "assets"),
    versionsDir: path.join(root, "versions"),
    runsDir: path.join(root, "runs"),
    approvalsDir: path.join(root, "approvals"),
    lockDir: path.join(root, ".lock.d"),
  };
}

export function capabilityPaths(wsRoot: string, capabilityId: string) {
  const root = path.join(
    wsRoot,
    "capabilities",
    assertSafeSegment(capabilityId, "能力包 id")
  );
  return {
    root,
    manifest: path.join(root, CAPABILITY_MANIFEST_FILE),
    templatesDir: path.join(root, "templates"),
    rulesDir: path.join(root, "rules"),
  };
}

/* ------------------------------------------------------------------ */
/* 路径安全                                                            */
/* ------------------------------------------------------------------ */

/** 校验单个路径段不含分隔符与上跳 */
export function assertSafeSegment(segment: string, what = "标识"): string {
  if (!segment || segment === "." || segment === "..") {
    throw invalid(`${what}不合法：${JSON.stringify(segment)}`);
  }
  if (/[/\\]/.test(segment) || segment.includes("\0")) {
    throw invalid(`${what}不得包含路径分隔符：${segment}`);
  }
  return segment;
}

/**
 * 把逻辑路径规范化成安全的工作区内相对路径。
 *
 * MCP 工具的逻辑路径由 AI 客户端提供，这里是必须的防线：
 * 拒绝绝对路径、盘符、`..` 上跳、空段与 NUL。
 */
export function normalizeLogicalPath(input: string, what = "路径"): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw invalid(`${what}不能为空`);
  }
  if (input.includes("\0")) {
    throw invalid(`${what}包含非法字符`);
  }

  const withSlashes = input.replace(/\\/g, "/").trim();

  if (withSlashes.startsWith("/")) {
    throw new CoreError("E_PATH_ESCAPE", `${what}不得是绝对路径：${input}`);
  }
  if (/^[A-Za-z]:/.test(withSlashes)) {
    throw new CoreError("E_PATH_ESCAPE", `${what}不得包含盘符：${input}`);
  }

  const parts: string[] = [];
  for (const raw of withSlashes.split("/")) {
    const seg = raw.trim();
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      throw new CoreError("E_PATH_ESCAPE", `${what}不得包含 ".."：${input}`);
    }
    parts.push(seg);
  }

  if (parts.length === 0) {
    throw invalid(`${what}不能为空`);
  }

  return parts.join("/");
}

/**
 * 把一个工作区内的相对路径解析成绝对路径，并断言它仍在 base 之下。
 * 这是防止符号链接与编码绕过逃逸出项目目录的第二道防线。
 */
export function resolveInside(base: string, relative: string, what = "路径"): string {
  const abs = path.resolve(base, relative);
  const rel = path.relative(base, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new CoreError("E_PATH_ESCAPE", `${what}逃逸出项目目录：${relative}`, {
      base,
      relative,
    });
  }
  return abs;
}

/** 确保目录存在 */
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** 递归列目录下的相对文件路径（正斜杠），不存在则返回空数组 */
export function listFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        out.push(path.relative(dir, full).split(path.sep).join("/"));
      }
    }
  };
  walk(dir);
  return out.sort();
}

/** 工作区是否已初始化 */
export function workspaceInitialized(root: string): boolean {
  return fs.existsSync(path.join(root, WORKSPACE_MARKER));
}
