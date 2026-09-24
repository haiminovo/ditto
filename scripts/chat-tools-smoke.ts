/**
 * Ditto 实施平台 - 聊天工具桥接端到端冒烟
 *
 * 验证「对话界面通过 MCP 调实施平台」这条链路里**不需要 LLM 就能验的部分**：
 *
 *   1. 白名单真的是白名单 —— 写操作与审批一个都进不来
 *   2. 只读工具能跑通，且审计里如实记成 via:"chat"
 *   3. 工具 item 经 SSE 协议往返后，名与参数都对得上
 *   4. 上下文裁剪不会留下孤立的 tool 消息（那会让 provider 直接 400）
 *
 * 不验的部分：模型会不会正确地决定调工具。那要靠真实 provider 手工验，
 * 见方案「验证」一节。
 *
 *   npm run chat-tools:smoke
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { initWorkspace } from "../lib/core/store/workspace";
import { BUILTIN_SEEDS } from "../lib/capabilities/builtin/general";
import { mcpActor, localActor, describeActor } from "../lib/core/actors";
import { createContext } from "../lib/core/ops/context";
import { createProject } from "../lib/core/ops";
import { createToolBridge, CHAT_TOOL_ALLOWLIST } from "../lib/sdk/tools";
import {
  applyEvent,
  createStreamState,
  createItemStart,
  createTextDelta,
  createItemEnd,
  createToolCallStart,
  createToolCallArgs,
  createToolResultStart,
  createToolResultDelta,
  createStreamEnd,
  getFullText,
  getToolInvocations,
  toSSE,
  parseSSELine,
  type StreamEvent,
} from "../lib/sdk/protocol";
import { trimMessagesToContextWindow } from "../lib/sdk/registry";
import { handleChatRequest } from "../lib/sdk/server";
import type { Message, ModelEntry } from "../lib/sdk/types";
import { queryAudit } from "../lib/core/store/audit";
import { workspacePaths } from "../lib/core/store/paths";

/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;

function section(title: string) {
  console.log(`\n${"─".repeat(62)}\n${title}\n${"─".repeat(62)}`);
}

function ok(label: string, detail = "") {
  passed += 1;
  console.log(`✓ ${label}${detail ? `  ${detail}` : ""}`);
}

function bad(label: string, detail = ""): never {
  failed += 1;
  console.error(`✗ ${label}${detail ? `\n    ${detail}` : ""}`);
  throw new Error(label);
}

function assert(cond: unknown, label: string, detail = ""): asserts cond {
  if (cond) ok(label, detail);
  else bad(label, detail || "条件为假");
}

function assertEq<T>(actual: T, expected: T, label: string, detail = "") {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    ok(label, `= ${JSON.stringify(actual)}`);
  } else {
    bad(
      label,
      `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}${detail ? `\n    ${detail}` : ""}`
    );
  }
}

/* ------------------------------------------------------------------ */

/**
 * 绝不能出现在对话里的工具 —— 每一条都对应一个真实的越权后果。
 * 这份清单是手写的，**故意**不从 CHAT_TOOL_ALLOWLIST 反推：
 * 反推的话，白名单被误改成「全部允许」时这个测试会跟着一起通过。
 */
const MUST_BE_BLOCKED = [
  "ditto_project_create",
  "ditto_project_update",
  "ditto_project_submit",
  "ditto_project_release",
  "ditto_project_export",
  "ditto_asset_create",
  "ditto_asset_update",
  "ditto_asset_revise",
  "ditto_asset_delete",
  "ditto_asset_release",
  "ditto_approval_submit",
  "ditto_approval_decide",
  "ditto_rule_waive",
  "ditto_template_apply",
  "ditto_capability_install",
  "ditto_workspace_init",
];

/* ------------------------------------------------------------------ */

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-chat-tools-"));
  console.log(`临时工作区：${root}`);

  initWorkspace(root, BUILTIN_SEEDS);

  const actor = mcpActor({ name: "chat-ui", version: "0.1.0" }, "chat");
  const bridge = await createToolBridge(actor, { root });

  try {
    /* ---------------------------------------------------------------- */
    section("1. 工具清单：白名单之外一律不出现");

    const tools = await bridge.listTools();
    const names = tools.map((t) => t.name).sort();

    assertEq(names.length, CHAT_TOOL_ALLOWLIST.length, "暴露的工具数量等于白名单长度");
    assertEq(
      names,
      [...CHAT_TOOL_ALLOWLIST].sort(),
      "暴露的工具与白名单逐条一致"
    );

    for (const blocked of MUST_BE_BLOCKED) {
      assert(!names.includes(blocked), `写操作被挡住：${blocked}`);
    }

    for (const t of tools) {
      assert(
        t.inputSchema && typeof t.inputSchema === "object",
        `${t.name} 带上了 JSON Schema`
      );
      // Anthropic 对未知 JSON Schema 关键字是严格的，一个 $schema 就 400
      assert(!("$schema" in t.inputSchema), `${t.name} 的 schema 已剥掉 $schema`);
    }

    /* ---------------------------------------------------------------- */
    section("2. 挑一个工具看看 schema 长什么样");

    const handoffSchema = tools.find((t) => t.name === "ditto_handoff");
    assert(handoffSchema, "handoff 在清单里");
    assert(
      typeof handoffSchema.description === "string" && handoffSchema.description.length > 0,
      "描述非空（模型靠它决定调不调）"
    );
    const props = (handoffSchema.inputSchema as any).properties ?? {};
    assert("projectId" in props, "参数里有 projectId");
    console.log(`   description: ${handoffSchema.description.slice(0, 60)}…`);

    /* ---------------------------------------------------------------- */
    section("3. 只读工具真的能跑");

    const info = await bridge.callTool("ditto_workspace_info", {});
    assert(!info.isError, "workspace_info 成功");
    assert(info.text.length > 0, "workspace_info 有内容返回");

    const handoff = await bridge.callTool("ditto_handoff", {});
    assert(!handoff.isError, "handoff 成功", "（推荐的总入口）");
    assert(handoff.text.includes("工作区"), "handoff 返回了工作区信息");

    /* ---------------------------------------------------------------- */
    section("4. 白名单是纵深防御，不只是「没暴露」");

    // 即使模型凭空点名一个没见过的工具，也要被拒 —— 参数是模型给的，
    // 不能假设它只会调它见过的东西
    const denied = await bridge.callTool("ditto_asset_delete", {
      assetId: "whatever",
    });
    assert(denied.isError, "直接点名写操作被拒绝");
    assert(
      denied.text.includes("E_TOOL_NOT_ALLOWED"),
      "拒绝理由是明确的 E_TOOL_NOT_ALLOWED"
    );
    console.log(`   拒绝信息：${denied.text.slice(0, 80)}…`);

    /* ---------------------------------------------------------------- */
    section("5. rule_run：白名单里唯一会落盘的工具");

    // 先拿领域层直接建一个项目。**故意不走桥接层** —— 建项目是写操作，
    // 桥接层按设计不提供。这也正是本层要证明的：写操作不能从对话界面绕过。
    const { project } = await createProject(
      createContext(root, localActor("冒烟建项人")),
      {
        name: "对话工具冒烟项目",
        customer: "示例客户",
        owner: "张三",
        capabilityPackageIds: ["general"],
        vars: { "customer.name": "示例客户", "env.name": "prod" },
      }
    );

    const badProject = await bridge.callTool("ditto_rule_run", {
      projectId: "nonexistent",
    });
    assert(badProject.isError, "对不存在的项目跑规则明确报错（而不是静默通过）");
    assert(
      badProject.text.includes("E_"),
      "错误带错误码",
      `= ${badProject.text.slice(0, 50)}…`
    );

    const ruleRun = await bridge.callTool("ditto_rule_run", {
      projectId: project.id,
    });
    assert(!ruleRun.isError, "对真实项目跑规则成功");
    assert(
      ruleRun.text.includes("error") || ruleRun.text.includes("阻断"),
      "结果里有结论分级"
    );

    /* ---------------------------------------------------------------- */
    section("6. 审计里记成「AI·对话」");

    // 到这一步才有审计可言：前面的 workspace_info / handoff 是纯查询，
    // 本来就不写审计。rule_run 是白名单里唯一会落盘的一个。
    const entries = queryAudit(workspacePaths(root).auditDir, { limit: 50 });
    const chatEntries = entries.filter((e) => e.actor.via === "chat");
    assert(chatEntries.length > 0, "审计里有对话来源的记录", `= ${chatEntries.length} 条`);

    const sample = chatEntries[chatEntries.length - 1];
    assertEq(sample.actor.type, "ai", "记成 AI 而不是人");
    assertEq(sample.actor.id, "mcp:chat-ui", "id 可辨认");
    assertEq(sample.action, "rule.run", "动作是规则执行");
    assert(
      describeActor(sample.actor).includes("对话"),
      "describeActor 渲染成对话",
      `= ${describeActor(sample.actor)}`
    );

    // 建项目的人是本地脚本，跑规则的是「对话」—— 两个来源在同一条
    // 流水里分得开，这正是 via 取值的意义
    const localEntries = entries.filter((e) => e.actor.via === "cli");
    assert(localEntries.length > 0, "同一条流水里能看到本地来源的操作");

    /* ---------------------------------------------------------------- */
    section("7. 工具 item 走 SSE 协议往返");

    const events: StreamEvent[] = [
      createItemStart("s1", "t1", "text"),
      createTextDelta("s1", "t1", "让我查一下"),
      createItemEnd("s1", "t1", "text"),
      createToolCallStart("s1", "call_1", "ditto_handoff"),
      createToolCallArgs("s1", "call_1", '{"projectId":"p1"}'),
      createItemEnd("s1", "call_1", "tool"),
      createToolResultStart("s1", "r1", "call_1", false),
      createToolResultDelta("s1", "r1", "项目状态：draft"),
      createItemEnd("s1", "r1", "tool_result", { is_error: false }),
      createItemStart("s1", "t2", "text"),
      createTextDelta("s1", "t2", "答案是……"),
      createItemEnd("s1", "t2", "text"),
      createStreamEnd("s1"),
    ];

    let state = createStreamState("s1");
    for (const event of events) {
      // 真的走一遍序列化：toSSE → 切行 → parseSSELine，
      // 只测 applyEvent 的话，SSE 层的 bug 会在浏览器里才现形
      const wire = toSSE(event);
      for (const line of wire.split("\n")) {
        const parsed = parseSSELine(line);
        if (parsed) state = applyEvent(state, parsed);
      }
    }

    assert(state.isComplete, "流走到 STREAM_END");

    const invocations = getToolInvocations(state);
    assertEq(invocations.length, 1, "解出一次工具调用");
    assertEq(invocations[0].id, "call_1", "调用 id 就是 item_id");
    assertEq(invocations[0].name, "ditto_handoff", "工具名对得上");
    assertEq(invocations[0].argsJson, '{"projectId":"p1"}', "参数串对得上");
    assertEq(invocations[0].result, "项目状态：draft", "结果挂回了正确的调用");
    assertEq(invocations[0].hasResult, true, "标记为已拿到结果");
    assertEq(invocations[0].isError, false, "非错误");

    // 多轮的关键回归：两段文本必须都在。旧版 getFullText 只返回第一个
    // text item，第二轮生成的话会被整段丢掉
    assertEq(getFullText(state), "让我查一下答案是……", "两轮文本都被拼进来");

    /* ---------------------------------------------------------------- */
    section("8. 裁剪不会留下孤立的 tool 消息");

    const model: ModelEntry = {
      provider: "test",
      id: "test-model",
      name: "test",
      contextWindow: 2000,
      maxTokens: 512,
      inputCostPer1M: 0,
      outputCostPer1M: 0,
    };

    const long = "很长的一段内容。".repeat(60);
    const history: Message[] = [
      { role: "user", content: "帮我看看项目" },
      {
        role: "assistant",
        content: "我来查一下",
        toolCalls: [{ id: "call_1", name: "ditto_handoff", arguments: "{}" }],
      },
      { role: "tool", toolCallId: "call_1", content: long },
      { role: "assistant", content: long },
    ];

    const trimmed = trimMessagesToContextWindow(history, model, 512);
    assert(trimmed.length > 0, "裁剪后还有消息");
    assert(
      trimmed[0].role !== "tool",
      "裁剪后第一条不是孤立的 tool 消息",
      `= ${trimmed[0].role}`
    );

    // 反向确认：没裁的情况下不许动手脚，完好的配对必须原样保留
    const roomy: ModelEntry = { ...model, contextWindow: 200_000 };
    const untouched = trimMessagesToContextWindow(history, roomy, 512);
    assertEq(untouched.length, history.length, "窗口够大时一条都不动");
    assertEq(
      untouched.map((m) => m.role),
      ["user", "assistant", "tool", "assistant"],
      "完好的 tool 配对未被破坏"
    );

    /* ---------------------------------------------------------------- */
    section("9. 超窗时，assistant 与它的 tool 结果同进同出");

    // 构造一个「必须丢点东西」的历史，检查不会出现
    // assistant(tool_calls) 留下、它的 tool 结果被丢掉的情况
    const many: Message[] = [
      { role: "user", content: long },
      { role: "assistant", content: long },
      { role: "user", content: "继续" },
      {
        role: "assistant",
        content: "查一下",
        toolCalls: [{ id: "call_9", name: "ditto_handoff", arguments: "{}" }],
      },
      { role: "tool", toolCallId: "call_9", content: "结果" },
      { role: "assistant", content: "结论如上" },
    ];
    const cut = trimMessagesToContextWindow(many, model, 512);
    const ids = cut
      .filter((m) => m.role === "assistant")
      .flatMap((m) => (m.role === "assistant" ? m.toolCalls ?? [] : []))
      .map((c) => c.id);
    const toolIds = cut
      .filter((m) => m.role === "tool")
      .map((m) => (m.role === "tool" ? m.toolCallId : ""));

    assertEq(
      ids.every((id) => toolIds.includes(id)),
      true,
      "每个留下的 tool_use 都有对应的 tool 结果",
      `= calls:[${ids}] results:[${toolIds}]`
    );
    assert(cut.length > 0, "裁剪后非空");
  } finally {
    await bridge.close();
  }

  /* ------------------------------------------------------------------ */
  section("10. 工具循环：拿一个假的 provider 把整条路跑通");

  // 这一步验的是本轮改动里最绕的部分 —— server.ts 里的多轮循环。
  // 用真实模型跑不了 CI（要 key、要钱、结果不确定），所以起一个假的
  // OpenAI 兼容端点：第一轮要求调工具，第二轮给答案。循环对不对，
  // 看它能不能自己把这两轮接起来。
  const requests: any[] = [];
  const fake = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const payload = JSON.parse(raw);
      requests.push(payload);

      // 历史里有没有工具结果，就是「第几轮」的判据 ——
      // 循环如果把结果丢了，这里会永远停在第一轮，测试随之失败
      const secondRound = payload.messages.some((m: any) => m.role === "tool");

      res.writeHead(200, { "Content-Type": "text/event-stream" });

      const chunk = (delta: unknown, finish: string | null = null) => {
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion.chunk",
            created: 1,
            model: payload.model,
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`
        );
      };

      if (!secondRound) {
        // 工具名与参数分片吐，模拟真实 provider 的行为
        chunk({ role: "assistant", content: "" });
        chunk({ content: "我查一下。" });
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_a",
              type: "function",
              function: { name: "ditto_handoff", arguments: "" },
            },
          ],
        });
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"projectId":' } }] });
        chunk({
          tool_calls: [{ index: 0, function: { arguments: `"${fakeProjectId}"}` } }],
        });
        chunk({}, "tool_calls");
      } else {
        chunk({ content: "查到了，项目存在。" });
        chunk({}, "stop");
      }

      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  // 先建一个真项目，好让 handoff 有东西可查
  const { project: fakeProject } = await createProject(
      createContext(root, localActor("冒烟建项人")),
    {
      name: "循环冒烟项目",
      customer: "示例客户",
      owner: "李四",
      capabilityPackageIds: ["general"],
      vars: { "customer.name": "示例客户", "env.name": "prod" },
    }
  );
  const fakeProjectId = fakeProject.id;

  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const port = (fake.address() as AddressInfo).port;

  // handleChatRequest 里的桥接层走 resolveWorkspaceRoot()，
  // 得让它指到临时工作区
  const previousWorkspace = process.env.DITTO_WORKSPACE;
  process.env.DITTO_WORKSPACE = root;

  try {
    const response = await handleChatRequest({
      provider: "custom",
      modelName: "fake-model",
      providerConfig: {
        apiKey: "sk-test",
        baseURL: `http://127.0.0.1:${port}/v1`,
        type: "openai",
      },
      messages: [{ role: "user", content: "帮我看看项目状态" }],
      stream: true,
      enableTools: true,
    });

    assertEq(response.status, 200, "返回 200");
    assert(
      response.headers.get("content-type")?.includes("text/event-stream") === true,
      "响应是 SSE"
    );

    const wire = await response.text();
    let state = createStreamState("live");
    for (const line of wire.split("\n")) {
      const parsed = parseSSELine(line);
      if (parsed) state = applyEvent(state, parsed);
    }

    assert(state.error === null, "流内没有错误事件", state.error ? `= ${JSON.stringify(state.error)}` : "");
    assert(state.isComplete, "流正常结束");

    const invocations = getToolInvocations(state);
    assertEq(invocations.length, 1, "循环执行了一次工具调用");
    assertEq(invocations[0].name, "ditto_handoff", "调的是 handoff");
    assertEq(
      invocations[0].argsJson,
      `{"projectId":"${fakeProjectId}"}`,
      "分片参数被正确拼成了完整 JSON"
    );
    assertEq(invocations[0].isError, false, "工具执行成功");
    assert(
      invocations[0].result.includes(fakeProject.name),
      "结果是真的来自实施平台（而不是模型编的）",
      `= ${invocations[0].result.slice(0, 60)}…`
    );

    // 两轮文本都要在：第一轮的「我查一下。」与第二轮的答案
    const fullText = getFullText(state);
    assert(fullText.includes("我查一下"), "第一轮文本没丢");
    assert(fullText.includes("查到了，项目存在"), "第二轮文本也在");

    // 顺序也对：文本 → 工具 → 结果 → 文本
    const kinds = [...state.items.values()].map((i) => i.itemType);
    assertEq(
      kinds,
      ["text", "tool", "tool_result", "text"],
      "item 顺序与界面的阅读顺序一致"
    );

    /* --- 请求侧的断言：循环有没有把结果递回去 --- */
    assertEq(requests.length, 2, "provider 被调了两轮");

    const second = requests[1];
    assertEq(second.messages[second.messages.length - 1].role, "tool", "第二轮带上了工具结果");
    assert(
      JSON.stringify(second.messages).includes(fakeProjectId),
      "第二轮的历史里有真实的项目 id"
    );
    assert(
      Array.isArray(second.tools) && second.tools.length === CHAT_TOOL_ALLOWLIST.length,
      "两轮都带上了白名单工具",
      `= ${second.tools?.length} 个`
    );
    assert(
      second.tools.every((t: any) => CHAT_TOOL_ALLOWLIST.includes(t.function.name)),
      "递给模型的工具全在白名单内"
    );

    const assistantMsg = second.messages.find(
      (m: any) => m.role === "assistant" && m.tool_calls
    );
    assert(assistantMsg, "第二轮历史里有带 tool_calls 的 assistant 消息");
    assertEq(assistantMsg.tool_calls[0].id, "call_a", "tool_call id 保持一致");
    assertEq(assistantMsg.tool_calls[0].function.name, "ditto_handoff", "工具名保持一致");
    assertEq(
      assistantMsg.tool_calls[0].function.arguments,
      `{"projectId":"${fakeProjectId}"}`,
      "回传的参数是拼好的完整 JSON"
    );
  } finally {
    if (previousWorkspace === undefined) delete process.env.DITTO_WORKSPACE;
    else process.env.DITTO_WORKSPACE = previousWorkspace;
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  }

  /* ------------------------------------------------------------------ */
  console.log(`\n${"═".repeat(62)}`);
  if (failed === 0) {
    console.log(`全部通过（${passed} 项断言）`);
    console.log(`临时工作区保留在：${root}`);
  } else {
    console.error(`失败 ${failed} 项，通过 ${passed} 项`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(`\n冒烟中断：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
