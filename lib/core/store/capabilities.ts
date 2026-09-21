/**
 * Ditto 实施平台 - 能力包与规则包的磁盘读取（纯 I/O，不做校验）
 *
 * 数据驱动的关键：加载器只认 capability.json 这个结构，
 * 不认具体是 general / k8s / linux / cloud-*。往
 * workspace/capabilities/ 里丢一个新目录即可生效，零代码改动。
 *
 * ⚠️ 使用 node:fs，只能在服务端使用。
 */

import fs from "node:fs";
import path from "node:path";
import type { CapabilityPackage, RulePack } from "../types";
import { readJsonOrNull, readTextOrNull } from "./fsjson";
import { listFilesRecursive, workspacePaths } from "./paths";

export interface LoadedCapability {
  /** 磁盘上的目录名（未必等于 manifest.id，但通常相等） */
  dirName: string;
  dir: string;
  manifest: CapabilityPackage;
}

/** 扫描 workspace/capabilities 下的每个子目录，找 capability.json */
export function scanCapabilityDirs(wsRoot: string): { dirName: string; dir: string }[] {
  const dir = workspacePaths(wsRoot).capabilitiesDir;
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => ({ dirName: e.name, dir: path.join(dir, e.name) }))
    .sort((a, b) => a.dirName.localeCompare(b.dirName));
}

export function readCapabilityManifest(
  dir: string
): CapabilityPackage | null {
  return readJsonOrNull<CapabilityPackage>(path.join(dir, "capability.json"));
}

/** 读取能力包 templates/ 下的全部文件 */
export function readCapabilityTemplates(dir: string): Record<string, string> {
  const tplDir = path.join(dir, "templates");
  const out: Record<string, string> = {};
  for (const rel of listFilesRecursive(tplDir)) {
    const content = readTextOrNull(path.join(tplDir, rel));
    if (content !== null) out[rel] = content;
  }
  return out;
}

/** 读取能力包 rules/ 下的全部规则包 */
export function readCapabilityRulePacks(dir: string): RulePack[] {
  const rulesDir = path.join(dir, "rules");
  if (!fs.existsSync(rulesDir)) return [];

  const out: RulePack[] = [];
  for (const file of fs.readdirSync(rulesDir).sort()) {
    if (!file.endsWith(".json")) continue;
    const pack = readJsonOrNull<RulePack>(path.join(rulesDir, file));
    if (pack) out.push(pack);
  }
  return out;
}

/** 读取工作区级规则包（可覆盖内置与能力包规则） */
export function readWorkspaceRulePacks(wsRoot: string): RulePack[] {
  const dir = workspacePaths(wsRoot).rulepacksDir;
  if (!fs.existsSync(dir)) return [];

  const out: RulePack[] = [];
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith(".json")) continue;
    const pack = readJsonOrNull<RulePack>(path.join(dir, file));
    if (pack) out.push(pack);
  }
  return out;
}

export function capabilityDirFor(wsRoot: string, dirName: string): string {
  return path.join(workspacePaths(wsRoot).capabilitiesDir, dirName);
}
