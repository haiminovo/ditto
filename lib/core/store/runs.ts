/**
 * Ditto 实施平台 - 规则执行记录
 *
 * ⚠️ 使用 node:fs，只能在服务端使用。
 */

import fs from "node:fs";
import path from "node:path";
import type { RuleRun } from "../types";
import { readJsonOrNull, writeJsonAtomic } from "./fsjson";
import { ensureDir, projectPaths } from "./paths";
import { notFound } from "../errors";

export function writeRun(wsRoot: string, run: RuleRun): void {
  const p = projectPaths(wsRoot, run.projectId);
  ensureDir(p.runsDir);
  writeJsonAtomic(path.join(p.runsDir, `${run.id}.json`), run);
}

export function readRun(wsRoot: string, projectId: string, runId: string): RuleRun {
  const p = projectPaths(wsRoot, projectId);
  const run = readJsonOrNull<RuleRun>(path.join(p.runsDir, `${runId}.json`));
  if (!run) throw notFound("规则执行记录", runId);
  return run;
}

export function readRunOrNull(
  wsRoot: string,
  projectId: string,
  runId: string
): RuleRun | null {
  return readJsonOrNull<RuleRun>(path.join(projectPaths(wsRoot, projectId).runsDir, `${runId}.json`));
}

export function listRuns(wsRoot: string, projectId: string): RuleRun[] {
  const dir = projectPaths(wsRoot, projectId).runsDir;
  if (!fs.existsSync(dir)) return [];

  const out: RuleRun[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const run = readJsonOrNull<RuleRun>(path.join(dir, file));
    if (run) out.push(run);
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** 取某资产最近一次 run（按开始时间） */
export function latestRunForAsset(
  wsRoot: string,
  projectId: string,
  assetId: string
): RuleRun | null {
  return listRuns(wsRoot, projectId).find((r) => r.assetId === assetId) ?? null;
}

/** 取项目级最近一次 run */
export function latestProjectRun(wsRoot: string, projectId: string): RuleRun | null {
  return listRuns(wsRoot, projectId).find((r) => r.scope === "project") ?? null;
}

export function runFilePath(wsRoot: string, projectId: string, runId: string): string {
  return path.join(projectPaths(wsRoot, projectId).runsDir, `${runId}.json`);
}
