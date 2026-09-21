/**
 * 初始化 Ditto 工作区
 *
 *   npm run workspace:init
 *   DITTO_WORKSPACE=/path/to/ws npm run workspace:init
 *
 * 幂等：重复执行只会补齐缺失的内置能力包，不会覆盖你已经改过的文件。
 */

import { resolveWorkspaceRoot, workspacePaths, listFilesRecursive } from "../lib/core/store/paths";
import { initWorkspace, workspaceInfo } from "../lib/core/store/workspace";
import { BUILTIN_SEEDS } from "../lib/capabilities/builtin/general";
import { loadCapabilities } from "../lib/capabilities/loader";

const root = resolveWorkspaceRoot();

console.log(`工作区：${root}`);

const result = initWorkspace(root, BUILTIN_SEEDS, { name: "ditto-workspace" });

console.log(result.created ? "✓ 已创建工作区" : "· 工作区已存在");
if (result.seeded.length > 0) {
  console.log(`✓ 写入内置能力包：${result.seeded.join(", ")}`);
} else {
  console.log("· 内置能力包已存在，未覆盖");
}

const info = workspaceInfo(root);
console.log(
  `\n统计：项目 ${info.counts.projects} · 能力包 ${info.counts.capabilities} · 工作区规则包 ${info.counts.rulepacks}`
);

// 验证刚写下去的能力包能被加载器读回来 —— 写入与读取走的是两条代码路径，
// 只验证写入成功是自欺欺人。
const caps = loadCapabilities(root);
if (caps.length === 0) {
  console.error("\n✗ 能力包写入后无法被加载器读回，请检查 capability.json");
  process.exit(1);
}

for (const cap of caps) {
  console.log(
    `✓ ${cap.manifest.name}（${cap.manifest.id} v${cap.manifest.version}）：` +
      `${cap.manifest.templates.length} 个模板、${cap.manifest.rulePacks.length} 个规则包、` +
      `${Object.keys(cap.templates).length} 个模板文件`
  );
}

const p = workspacePaths(root);
console.log("\n目录结构：");
for (const rel of listFilesRecursive(p.capabilitiesDir).slice(0, 8)) {
  console.log(`  capabilities/${rel}`);
}
console.log(`  audit/  projects/  rulepacks/  exports/`);
