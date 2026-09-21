/**
 * Ditto 实施平台 - 「通用底座」能力包
 *
 * 用 TypeScript 模块承载种子数据，而不是仓库里的真实文件：
 * tsx 与 Next 两种运行时都需要能拿到它，而靠 __dirname 去猜仓库根目录
 * 在 Next 的服务端 bundle 里会失效。模块导出对两边都一样。
 *
 * 落盘后（ditto_workspace_init）用户可以直接改 workspace/capabilities/general/
 * 下的 JSON —— 那时它就是普通数据了。
 */

import type { CapabilityPackage } from "../../core/types";
import { GENERAL_TEMPLATES } from "./general-templates";
import { GENERAL_RULE_PACKS } from "./general-rules";

export const GENERAL_MANIFEST: CapabilityPackage = {
  schemaVersion: 1,
  id: "general",
  name: "通用底座",
  version: "1.0.0",
  description:
    "任何项目都可挂载的基础交付能力：实施方案、需求确认、部署拓扑与步骤、应用配置、部署与回滚脚本、测试方案、验收报告、运维交接手册，以及配套的六套质量规则。",
  author: "ditto",
  platforms: ["generic"],
  requires: [],
  vars: [
    {
      key: "customer.name",
      label: "客户名称",
      type: "string",
      required: true,
      description: "出现在方案、验收报告等正式文档的抬头",
    },
    {
      key: "env.name",
      label: "目标环境",
      type: "enum",
      allowed: ["dev", "test", "staging", "prod"],
      default: "prod",
      required: true,
    },
    {
      key: "domain",
      label: "访问域名",
      type: "string",
      required: true,
      default: "example.com",
      description: "占位域名会被规则拦下，交付前必须换成真实域名",
    },
    {
      key: "app.version",
      label: "应用版本号",
      type: "string",
      default: "1.0.0",
    },
    {
      key: "ops.contact",
      label: "运维联系人",
      type: "string",
      description: "交接手册中的应急联系人",
    },
  ],
  rulePacks: GENERAL_RULE_PACKS.map((p) => p.id),
  templates: [
    {
      id: "project-charter",
      name: "项目实施方案",
      kind: "doc",
      format: "markdown",
      targetPath: "docs/01-项目实施方案.md",
      contentFile: "project-charter.md",
      checklist: [
        { id: "scope", text: "实施范围已与客户确认" },
        { id: "milestone", text: "里程碑与时间点已确认" },
      ],
    },
    {
      id: "requirements",
      name: "需求确认单",
      kind: "doc",
      format: "markdown",
      targetPath: "docs/02-需求确认单.md",
      contentFile: "requirements.md",
    },
    {
      id: "handover",
      name: "运维交接手册",
      kind: "doc",
      format: "markdown",
      targetPath: "docs/03-运维交接手册.md",
      contentFile: "handover.md",
    },
    {
      id: "topology",
      name: "部署拓扑",
      kind: "design",
      format: "markdown",
      targetPath: "design/01-部署拓扑.md",
      contentFile: "topology.md",
    },
    {
      id: "deploy-plan",
      name: "部署实施步骤",
      kind: "design",
      format: "markdown",
      targetPath: "design/02-部署实施步骤.md",
      contentFile: "deploy-plan.md",
    },
    {
      id: "app-config",
      name: "应用配置",
      kind: "config",
      format: "json",
      targetPath: "config/app-config.json",
      contentFile: "app-config.json",
    },
    {
      id: "deploy-script",
      name: "部署脚本",
      kind: "script",
      format: "shell",
      targetPath: "scripts/deploy.sh",
      contentFile: "deploy.sh",
    },
    {
      id: "rollback-script",
      name: "回滚脚本",
      kind: "script",
      format: "shell",
      targetPath: "scripts/rollback.sh",
      contentFile: "rollback.sh",
    },
    {
      id: "test-plan",
      name: "测试方案",
      kind: "doc",
      format: "markdown",
      targetPath: "test/01-测试方案.md",
      contentFile: "test-plan.md",
    },
    {
      id: "acceptance",
      name: "验收报告",
      kind: "acceptance",
      format: "markdown",
      targetPath: "acceptance/01-验收报告.md",
      contentFile: "acceptance.md",
      checklist: [
        { id: "signoff", text: "客户签字确认", requiresEvidence: true },
        { id: "env", text: "生产环境已交付", requiresEvidence: true },
        { id: "docs", text: "交付文档已移交" },
      ],
    },
  ],
};

export const GENERAL_SEED = {
  manifest: GENERAL_MANIFEST,
  templates: GENERAL_TEMPLATES,
  rulePacks: GENERAL_RULE_PACKS,
};

/** 全部随仓库发布的内置能力包 */
export const BUILTIN_SEEDS = [GENERAL_SEED];
