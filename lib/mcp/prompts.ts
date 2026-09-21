/**
 * Ditto 实施平台 - MCP 提示词
 *
 * 每个 prompt 都是一份**中文作业指导书**：它把平台的工作流、约束和
 * 术语一次性交代给 AI，让第一次协作就能写对，而不是靠多轮试错。
 *
 * 共同要求：先调 ditto_handoff。跳过这一步的代价是 AI 凭猜测行动，
 * 而平台的每一步写入都会落盘留痕，猜错是要清理的。
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OpContext } from "../core/ops/context";

function userMessage(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

const COMMON_HEADER = `你正在通过 MCP 操作「ditto 实施平台」。

平台的核心约定（务必遵守）：
1. **一切以项目为中心**。资产属于项目，规则挂载在项目上，审批也发生在项目内。
2. **实施资产是真实文件**。写进去的内容会落到工作区磁盘上，人可以直接打开、git 可以版本管理。不要写一次性内容。
3. **规则是数据，不是代码**。规则结论不可协商，但可以显式豁免（必须给理由，且永久留痕）。
4. **已发布的资产不可直接编辑**。要改必须先改版（ditto_asset_revise），原版本会保留在版本历史里。
5. **闸门会在放行时刻重新计算规则**。存量结论只是证据，不是权威 —— 所以放行前不需要"再跑一遍"，但整改后必须重跑。

第一步永远是调用 ditto_handoff 了解当前状态。`;

export function registerPrompts(server: McpServer, _ctx: OpContext): void {
  server.registerPrompt(
    "ditto_new_project",
    {
      title: "新建实施项目",
      description: "引导完成一个实施项目从建项到生成交付物骨架的完整起步流程",
      argsSchema: {
        projectName: z.string().describe("项目名称"),
        customer: z.string().describe("客户名称"),
      },
    },
    (args) =>
      userMessage(
        `${COMMON_HEADER}

---

## 任务：新建实施项目「${args.projectName}」，客户为「${args.customer}」

请按以下顺序执行：

1. \`ditto_handoff\` —— 确认工作区状态、已安装能力包与它要求的变量。

2. 如果还没有任何能力包，先 \`ditto_workspace_init\` 安装内置的「通用底座」。

3. \`ditto_capability_get\` 查看「通用底座」需要哪些变量。特别是 \`domain\`：
   它的默认值 \`example.com\` 是占位符，会被规则拦下，必须换成真实域名。

4. \`ditto_project_create\` 创建项目，**一次性把 vars 补齐**：
   - \`domain\`：真实访问域名
   - \`env.name\`：dev / test / staging / prod 之一
   - \`app.version\`：应用版本号
   - \`ops.contact\`：运维联系人

   不要先建项目再补变量 —— 少一步就会生成出一批带占位符的资产，之后要逐个返工。

5. \`ditto_template_list\` 查看可用模板，然后对每个模板调 \`ditto_template_apply\` 生成交付物骨架。

6. \`ditto_rule_run\` 执行规则自检。

7. 向用户汇报：生成了哪些资产、规则拦下了哪些问题、建议优先处理哪几项。

**注意**：第 6 步**一定会**报出一批问题，这是设计如此 —— 模板给的是骨架，
里面的 TODO 与占位内容本来就需要按项目实情填写。不要试图绕过规则，
也不要在没有真正补齐内容时用豁免"清掉"它们。豁免是留给"确认可接受"的，
不是留给"我懒得填"的。`
      )
  );

  server.registerPrompt(
    "ditto_asset_authoring",
    {
      title: "撰写实施资产",
      description: "指导撰写或补齐某个资产的正文内容",
      argsSchema: {
        projectId: z.string().describe("项目 id"),
        assetPath: z.string().describe("资产逻辑路径，如 docs/01-项目实施方案.md"),
      },
    },
    (args) =>
      userMessage(
        `${COMMON_HEADER}

---

## 任务：撰写 / 补齐资产 \`${args.assetPath}\`（项目 ${args.projectId}）

1. \`ditto_handoff\` 带上 \`projectId\`，了解项目全貌与当前资产的规则结论。

2. \`ditto_asset_get\` 读该资产当前正文（\`includeContent: true\`），并 \`ditto_rule_list\`
   看清它受哪些规则约束 —— 特别是严重级别为 error 的那几条。

3. 撰写时注意这些会被规则拦下的写法：
   - \`TODO\`、\`待补充\`、\`待确认\` 等占位标记
   - \`example.com\` 等示例域名
   - 明文口令（\`password: "真实值"\` 这类字面量）
   - 未替换的 \`{{变量}}\`
   - 部署脚本里硬编码的内网 IP
   - 引用了不存在的资产（用 \`[[asset:路径]]\` 语法建立的引用必须能解析）

4. 用 \`ditto_asset_update\` 写回，传入 \`expectedRev\`（值取自第 2 步读到的 rev），
   避免与别人的修改相互覆盖。

5. \`ditto_rule_run\` 重跑规则，确认该资产的问题已清除。

6. 汇报：改了什么、还剩什么问题、下一步建议。

**不要**为了让规则闭嘴而删掉实质内容。规则拦的是"交付物不合格"，
把不合格的内容删掉只是换了一种不合格。`
      )
  );

  server.registerPrompt(
    "ditto_fix_findings",
    {
      title: "按规则结论整改",
      description: "把规则命中项变成逐条修复清单，并在修完后验证",
      argsSchema: {
        projectId: z.string().describe("项目 id"),
        assetId: z.string().optional().describe("只整改某个资产；留空则整改整个项目"),
      },
    },
    (args) =>
      userMessage(
        `${COMMON_HEADER}

---

## 任务：整改项目 ${args.projectId} 的规则命中项${args.assetId ? `（限资产 ${args.assetId}）` : ""}

1. \`ditto_asset_get\`（不带 \`includeContent\`）或 \`ditto_handoff\` 把资产 id 与路径对上号 ——
   规则结论里给的是路径，写回时需要 id 或路径。

2. \`ditto_rule_run\` 拿到**当前**结论。不要用记忆里的旧结论，资产可能已经被改过。

3. 按规则分组处理，**先全部解决 error 级，再处理 warn 级**：
   - 能真正改好的 → \`ditto_asset_update\` 改正文
   - 确实不适用的 → 停下来问用户，说明为什么这条规则对该项目不适用

4. 每改完一组就 \`ditto_rule_run\` 复跑，确认这一类确实消失了。
   **不要**把全部改动攒到最后一次验证 —— 出问题时会不知道是哪一处引起的。

5. 全部 error 清除后，用 \`ditto_gate_check\` 做 dry-run，确认放行结论。

6. 汇报时请明确区分：
   - 已整改并通过的
   - 仍需用户决定的
   - 尚未处理的

**关于豁免**：如果某条规则确实不适用，可以建议豁免，但必须向用户说明理由，
并且理由会被写进审计流水和最终交付清单。不要自己编一个理由糊弄过去。`
      )
  );

  server.registerPrompt(
    "ditto_pre_acceptance_review",
    {
      title: "验收前全量自检",
      description: "交付验收前的完整自检：齐套性、规则、引用、审批状态",
      argsSchema: {
        projectId: z.string().describe("项目 id"),
      },
    },
    (args) =>
      userMessage(
        `${COMMON_HEADER}

---

## 任务：对项目 ${args.projectId} 做验收前全量自检

请逐项核对并给出结论，**不要跳过任何一项**：

### 1. 交付物齐套性
\`ditto_handoff\` 看资产清单，核对是否该有的都有：
实施方案、需求确认单、部署拓扑、部署步骤、应用配置、部署脚本、回滚脚本、
测试方案、验收报告、运维交接手册。
缺失的用 \`ditto_template_apply\` 补，或向用户确认是否确实不需要。

### 2. 规则结论
\`ditto_gate_check\` 做项目级 dry-run（不传 assetId）。列出所有仍被拦的问题，
按 error / warn 分开呈现。

### 3. 跨资产引用
检查各文档里 \`[[asset:路径]]\` 形式的引用是否都能解析到真实资产。
规则 base-reference-integrity 会报，但请你也复核一遍语义是否正确 ——
路径存在不等于引用的是对的东西。

### 4. 验收检查单
验收报告里的 \`- [ ]\` 清单是交付方与客户共同确认的关键项。
逐项核对是否真的完成，**尤其是有"（需证据）"标记的条目**。
不要在没有证据的情况下勾选。

### 5. 审批状态
\`ditto_approval_list\` 看每个资产的审批状态。处于 draft 的说明还没提交评审；
处于 in_review 的看是否被闸门拦着。

### 6. 汇总结论
给出明确判断：**是否具备提交验收的条件**。
如果不具备，列出必须由人解决的问题清单（不要自己代做决定）。

**红线**：回滚脚本缺失、验收清单未完成、存在明文口令 —— 这三项任何一项不满足，
都不应给出"具备验收条件"的结论。`
      )
  );

  server.registerPrompt(
    "ditto_handover_summary",
    {
      title: "生成交接说明",
      description: "为项目生成一份给下一位工程师的交接说明",
      argsSchema: {
        projectId: z.string().describe("项目 id"),
      },
    },
    (args) =>
      userMessage(
        `${COMMON_HEADER}

---

## 任务：为项目 ${args.projectId} 生成交接说明

1. \`ditto_handoff\` 拿全上下文（项目、资产、规则、审批、下一步）。
2. \`ditto_audit_list\`（\`projectId\` 过滤，\`limit\` 取 100 左右）看最近发生了什么。
3. \`ditto_asset_history\` 抽查关键资产的版本演进。

然后写出一份交接说明，包含：

- **项目现状**：一句话说清处在什么阶段
- **已完成**：哪些资产已发布，对应的交付物是什么
- **未完成 / 进行中**：卡在哪里，为什么卡住
- **关键决策与豁免**：哪些规则被豁免了、理由是什么 ——
  这是交接里最容易被漏掉、也最容易让下一位踩坑的部分
- **下一步建议**：从 \`nextActions\` 提炼
- **风险提示**：还有什么没解决

写成 Markdown，可直接作为 \`docs/\` 下的一份资产交付。
如果用户同意，用 \`ditto_asset_create\` 落盘为 \`docs/04-项目交接说明.md\`。

**诚实要求**：不要把"不知道"写成"应该没问题"。交接文档的价值恰恰在于
如实传递不确定性 —— 下一位工程师需要知道哪里是坑，而不是被告知一切顺利。`
      )
  );
}
