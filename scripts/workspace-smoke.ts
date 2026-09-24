/**
 * Web 工作区注册表冒烟测试。
 *
 * 覆盖默认工作区、添加并初始化外部目录、切换、移除绑定，以及危险路径拒绝。
 * 整个过程只使用临时目录和临时注册表。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addWorkspace,
  initializeWorkspace,
  listWorkspaceState,
  removeWorkspace,
  selectWorkspace,
} from "../lib/core/store/workspace-registry";
import { WORKSPACE_MARKER } from "../lib/core/types";

let passed = 0;
let failed = 0;

function assert(condition: unknown, label: string, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`✓ ${label}${detail === undefined ? "" : `  ${String(detail)}`}`);
    return;
  }
  failed += 1;
  console.error(`✗ ${label}${detail === undefined ? "" : `  ${String(detail)}`}`);
}

async function expectFailure(label: string, operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
    assert(false, label, "operation unexpectedly succeeded");
  } catch (error) {
    assert(true, label, error instanceof Error ? error.message : String(error));
  }
}

async function main(): Promise<void> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-workspace-smoke-"));
  const defaultRoot = path.join(tempRoot, "default-workspace");
  const externalRoot = path.join(tempRoot, "external-workspace");
  const occupiedRoot = path.join(tempRoot, "occupied");

  process.env.DITTO_WORKSPACE = defaultRoot;
  process.env.DITTO_WORKSPACE_REGISTRY = path.join(tempRoot, "registry.json");

  try {
    console.log(`临时目录：${tempRoot}`);

    const initial = await listWorkspaceState();
    assert(initial.active?.id === "default", "默认工作区自动注册");
    assert(initial.active?.path === defaultRoot, "默认工作区跟随 DITTO_WORKSPACE");
    assert(initial.active?.initialized === false, "默认工作区可以稍后初始化");

    const initializedDefault = await initializeWorkspace("default");
    assert(initializedDefault.active?.initialized === true, "默认工作区可初始化");
    assert(
      fs.existsSync(path.join(defaultRoot, WORKSPACE_MARKER)),
      "初始化写入了工作区标记"
    );

    const added = await addWorkspace({
      path: externalRoot,
      name: "外部测试工作区",
    });
    const realExternalRoot = fs.realpathSync(externalRoot);
    const external = added.workspaces.find(
      (workspace) => workspace.path === realExternalRoot
    );
    assert(external?.kind === "external", "外部目录注册为自选工作区");
    assert(external?.name === "外部测试工作区", "保存自定义显示名");
    assert(external?.initialized === true, "新增目录自动初始化");
    assert(added.active?.id === external?.id, "新增后自动切换");
    assert(
      fs.existsSync(path.join(externalRoot, WORKSPACE_MARKER)),
      "外部工作区标记已落盘"
    );

    const selected = await selectWorkspace("default");
    assert(selected.active?.id === "default", "可以切回默认工作区");

    const removed = await removeWorkspace(external!.id);
    assert(
      removed.workspaces.every((workspace) => workspace.id !== external!.id),
      "移除自选工作区绑定"
    );
    assert(fs.existsSync(externalRoot), "移除绑定不会删除磁盘目录");

    await expectFailure("默认工作区不能移除", () => removeWorkspace("default"));
    await expectFailure("项目目录不能作为工作区", () =>
      addWorkspace({ path: process.cwd() })
    );
    await expectFailure("文件系统根目录不能作为工作区", () =>
      addWorkspace({ path: path.parse(process.cwd()).root })
    );

    fs.mkdirSync(occupiedRoot, { recursive: true });
    fs.writeFileSync(path.join(occupiedRoot, "keep.txt"), "not a workspace");
    await expectFailure("非空非工作区目录不能自动接管", () =>
      addWorkspace({ path: occupiedRoot })
    );

    console.log(`\n${"═".repeat(62)}`);
    console.log(
      failed === 0 ? `全部通过（${passed} 项断言）` : `失败 ${failed} 项，通过 ${passed} 项`
    );
    if (failed > 0) process.exitCode = 1;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`\n✗ 未捕获错误：${error?.stack ?? error}`);
  process.exitCode = 1;
});
