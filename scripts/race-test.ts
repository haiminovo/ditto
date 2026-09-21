/**
 * Ditto 实施平台 - 并发写验证
 *
 * 这是本平台**最值得写的一个测试**。
 *
 * 真实场景里，`next dev`（控制台 + HTTP MCP）与 Claude Code 拉起的 stdio MCP
 * 服务端会同时写同一个工作区。没有保护的话，`assets.json` 会被交错写入覆盖，
 * 丢资产是必然不是偶然。
 *
 * 保护有四种，本脚本验证前三种：
 *   ① 进程内 async mutex（按 projectId 串行）
 *   ② 跨进程 mkdir 锁（+ 过期抢占）
 *   ③ 原子写（tmp + rename）
 *   ④ rev 乐观并发（由 mcp-smoke 第 12 步验证）
 *
 *   npm run race:test
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { initWorkspace } from "../lib/core/store/workspace";
import { BUILTIN_SEEDS } from "../lib/capabilities/builtin/general";
import { createContext } from "../lib/core/ops/context";
import { consoleActor } from "../lib/core/actors";
import { createAsset } from "../lib/core/ops/asset-ops";
import { createProject } from "../lib/core/ops/project-ops";
import { readAssets } from "../lib/core/store/assets";
import { readJson } from "../lib/core/store/fsjson";
import { projectPaths } from "../lib/core/store/paths";

const WORKERS = 2;
const PER_WORKER = 50;
const LOCAL = 50;

/* ------------------------------------------------------------------ */

/** 子进程模式：并发创建一批资产 */
async function workerMode(root: string, projectId: string, tag: string): Promise<void> {
  const ctx = createContext(root, consoleActor(`worker-${tag}`));

  const jobs = Array.from({ length: PER_WORKER }, (_, i) =>
    createAsset(ctx, projectId, {
      path: `docs/worker-${tag}-${String(i).padStart(3, "0")}.md`,
      content: `# worker ${tag} #${i}\n\n由并发测试写入。\n`,
      message: `并发写入 ${tag}-${i}`,
    })
  );

  const results = await Promise.allSettled(jobs);
  const failures = results.filter((r) => r.status === "rejected");

  if (failures.length > 0) {
    const sample = failures
      .slice(0, 3)
      .map((f) => (f as PromiseRejectedResult).reason?.message ?? "unknown")
      .join("; ");
    process.stderr.write(`[worker-${tag}] ${failures.length} 个写入失败：${sample}\n`);
  }

  process.stdout.write(`worker-${tag} 完成：成功 ${PER_WORKER - failures.length}/${PER_WORKER}\n`);
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // 子进程分支
  if (args[0] === "--worker") {
    await workerMode(args[1], args[2], args[3]);
    process.exit(0);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-race-"));
  console.log(`临时工作区：${root}`);

  initWorkspace(root, BUILTIN_SEEDS);

  const ctx = createContext(root, consoleActor("主进程"));
  const { project } = await createProject(ctx, {
    name: "并发测试项目",
    customer: "并发客户",
    capabilityPackageIds: ["general"],
  });

  console.log(`项目：${project.id}`);
  console.log(
    `并发规模：主进程 ${LOCAL} + ${WORKERS} 个子进程 × ${PER_WORKER} = ${LOCAL + WORKERS * PER_WORKER}\n`
  );

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const started = Date.now();

  // 子进程并发写同一工作区
  const children = Array.from({ length: WORKERS }, (_, i) => {
    const tag = String.fromCharCode(65 + i); // A, B
    return new Promise<void>((resolve, reject) => {
      const child = spawn(
        path.join(repoRoot, "node_modules/.bin/tsx"),
        [fileURLToPath(import.meta.url), "--worker", root, project.id, tag],
        { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] }
      );

      let out = "";
      child.stdout.on("data", (d) => (out += String(d)));
      child.stderr.on("data", (d) => (out += String(d)));
      child.on("error", reject);
      child.on("exit", (code) => {
        process.stdout.write(`  ${out.trim().split("\n").join("\n  ")}\n`);
        code === 0 ? resolve() : reject(new Error(`子进程 ${tag} 退出码 ${code}`));
      });
    });
  });

  // 主进程同时也在写
  const localJobs = Array.from({ length: LOCAL }, (_, i) =>
    createAsset(ctx, project.id, {
      path: `docs/local-${String(i).padStart(3, "0")}.md`,
      content: `# 主进程 #${i}\n`,
      message: `主进程并发写入 ${i}`,
    })
  );

  const localResults = await Promise.allSettled(localJobs);
  const localFailures = localResults.filter((r) => r.status === "rejected");
  console.log(`  主进程完成：成功 ${LOCAL - localFailures.length}/${LOCAL}`);

  await Promise.all(children);

  const elapsed = Date.now() - started;

  /* ---------------------------------------------------------------- */
  console.log(`\n${"─".repeat(62)}`);

  let failed = 0;
  const check = (cond: boolean, label: string, detail = "") => {
    if (cond) console.log(`✓ ${label}${detail ? `  ${detail}` : ""}`);
    else {
      failed += 1;
      console.error(`✗ ${label}${detail ? `  ${detail}` : ""}`);
    }
  };

  // ① 索引必须仍可解析（原子写 + 锁的直接验证）
  const indexPath = projectPaths(root, project.id).assetsIndex;
  let parsed: { assets?: unknown[] } | null = null;
  try {
    parsed = readJson<{ assets: unknown[] }>(indexPath);
    check(true, "assets.json 仍是合法 JSON（未被交错写入破坏）");
  } catch (e) {
    check(false, "assets.json 仍是合法 JSON", (e as Error).message);
  }

  const inIndex = parsed?.assets?.length ?? 0;
  const expected = LOCAL + WORKERS * PER_WORKER;
  check(inIndex === expected, "索引条目数与写入次数一致", `${inIndex} / ${expected}`);

  // ② 用 store 读回来也应当一致
  const viaStore = readAssets(root, project.id).length;
  check(viaStore === expected, "经 store 读回的条目数一致", `${viaStore} / ${expected}`);

  // ③ 磁盘上的活跃文件必须齐（资产落在 assets/docs/ 下，需要递归找）
  const collectFiles = (dir: string, predicate: (name: string) => boolean): string[] => {
    const out: string[] = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...collectFiles(full, predicate));
      else if (predicate(entry.name)) out.push(full);
    }
    return out;
  };

  const assetsDir = projectPaths(root, project.id).assetsDir;
  const files = collectFiles(assetsDir, (n) => n.endsWith(".md"));
  check(files.length === expected, "磁盘上的资产文件齐备", `${files.length} / ${expected}`);

  // ④ 不允许有残留的临时文件
  const leftovers = collectFiles(
    projectPaths(root, project.id).root,
    (n) => n.startsWith(".tmp-")
  );
  check(leftovers.length === 0, "没有残留的临时文件", leftovers.slice(0, 3).join(", "));

  const assets = readAssets(root, project.id);

  // ⑤ 每个索引条目都对应一个真实文件
  const roots = new Set(
    files.map((f) => path.relative(assetsDir, f).split(path.sep).join("/"))
  );
  const missing = assets.filter((a) => !roots.has(a.path));
  check(missing.length === 0, "索引与磁盘文件一一对应", missing.slice(0, 3).map((a) => a.path).join(", "));

  // ⑥ 无重复 id
  const uniqueIds = new Set(assets.map((a) => a.id));
  check(uniqueIds.size === assets.length, "资产 id 无重复", `${uniqueIds.size} / ${assets.length}`);

  // ⑦ 无重复路径
  const uniquePaths = new Set(assets.map((a) => a.path));
  check(uniquePaths.size === assets.length, "资产路径无重复", `${uniquePaths.size} / ${assets.length}`);

  console.log(`\n耗时 ${elapsed}ms`);
  console.log(`临时工作区：${root}`);

  if (failed > 0) {
    console.error(`\n${failed} 项失败 —— 并发保护不成立`);
    process.exit(1);
  }
  console.log("\n并发写保护成立");
}

main().catch((e) => {
  console.error(`\n✗ 未捕获错误：${e?.stack ?? e}`);
  process.exit(1);
});
