/**
 * Ditto 实施平台 - MCP 服务端装配
 *
 * 一套工具定义，两个入口：
 *   mcp/stdio.ts            → StdioServerTransport（本地 AI 客户端）
 *   app/api/mcp/route.ts    → WebStandardStreamableHTTPServerTransport（远程）
 *
 * 两个入口共用本文件，所以工具行为不可能在两个通道间漂移。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Actor } from "../core/types";
import { createContext, type OpContext } from "../core/ops/context";
import { resolveWorkspaceRoot } from "../core/store/paths";
import { registerOrientationTools, registerProjectTools, registerAssetTools } from "./tools/project-asset";
import { registerCapabilityTools, registerRuleTools } from "./tools/capability-rule";
import { registerApprovalTools, registerAuditTools } from "./tools/approval-audit";
import { registerResources } from "./resources";
import { registerPrompts } from "./prompts";

export const SERVER_NAME = "ditto";
export const SERVER_VERSION = "0.1.0";

export interface CreateServerOptions {
  /** 工作区根目录；不传则按 DITTO_WORKSPACE → 祖先标记 → cwd/workspace 解析 */
  root?: string;
  actor: Actor;
  /** 注入时钟与 id 生成器，便于测试确定化 */
  now?: () => Date;
  newId?: (prefix?: string) => string;
}

/**
 * 组装一个完整的 MCP 服务端实例。
 *
 * 每个请求（HTTP 无状态模式）或每次进程启动（stdio）都会调用它。
 * 注意：它不做任何 I/O，只有真正调用工具时才会读写工作区 ——
 * 所以构造本身很便宜，可以放心地按请求构造。
 */
export function createMcpServer(options: CreateServerOptions): {
  server: McpServer;
  ctx: OpContext;
} {
  const root = options.root ?? resolveWorkspaceRoot();

  const ctx = createContext(root, options.actor, {
    now: options.now,
    newId: options.newId,
  });

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      instructions: buildInstructions(root),
    }
  );

  registerOrientationTools(server, ctx);
  registerProjectTools(server, ctx);
  registerAssetTools(server, ctx);
  registerCapabilityTools(server, ctx);
  registerRuleTools(server, ctx);
  registerApprovalTools(server, ctx);
  registerAuditTools(server, ctx);

  registerResources(server, ctx);
  registerPrompts(server, ctx);

  return { server, ctx };
}

/**
 * instructions 会随 initialize 返回并被客户端注入模型上下文。
 * 把已解析的工作区根路径写在这里，AI 就不必先做一轮发现。
 */
function buildInstructions(root: string): string {
  return `ditto 实施平台 —— 以项目为中心的实施交付平台。

工作区根目录：${root}

## 五个核心概念

- **项目**：一切的中心。资产属于项目，规则挂载在项目上，审批发生在项目内。
- **实施资产**：交付物对象，是工作区磁盘上的**真实文件**，可被 git 管理和人工直接查看。
- **能力包**：平台适配载体。决定项目能用哪些模板、受哪些规则约束。加新平台只需往
  workspace/capabilities/ 丢一个目录，不需要改代码。
- **规则引擎**：声明式数据，不是代码。产出 error / warn / info 三级结论。
- **审批闸门**：error 与 warn 默认都阻断，需显式豁免（必须给理由，永久留痕）才能放行。

## 推荐工作流

1. \`ditto_handoff\` —— **总是从这里开始**。一次调用拿到全量状态与建议的下一步动作。
2. \`ditto_workspace_init\` —— 工作区未初始化时先执行（幂等）。
3. \`ditto_project_create\` —— 建项目时一次性把能力包要求的变量补齐。
4. \`ditto_template_apply\` —— 从能力包生成交付物骨架。
5. \`ditto_rule_run\` —— 规则自检，按结论整改，循环到通过。
6. \`ditto_gate_check\` —— dry-run 确认放行结论（不改变任何状态）。
7. \`ditto_approval_submit\` → \`ditto_approval_decide\` → \`ditto_asset_release\`。
8. \`ditto_project_export\` —— 导出交付包（只有已发布的资产会进包）。

## 重要约束

- 模板生成的是**骨架**，默认一定过不了规则。这是设计如此，不是故障。
- 已发布的资产**不能直接编辑**，需先 \`ditto_asset_revise\`；原版本会保留在版本历史中。
- 放行时闸门会**重新计算**规则，不信任存量结论 —— 所以整改后重跑是必须的。
- 豁免是留给"确认可接受"的，不是留给"懒得处理"的。理由会进入审计与交付清单。
- 写入时传 \`expectedRev\` 可避免覆盖他人的并发修改。

## 鉴权说明

操作者身份（actor）来自客户端自报，**不构成安全边界**，仅用于流程留痕。
真正的鉴权不在本平台范围内。`;
}

export { resolveWorkspaceRoot };
