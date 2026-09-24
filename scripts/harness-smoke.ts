/**
 * Generic harness smoke test.
 *
 * Uses fake models and tools only: no network, provider SDK or Ditto workspace.
 */

import {
  createAllowlistPolicy,
  runHarness,
  type HarnessModelAdapter,
  type HarnessModelRoundEvent,
  type HarnessRunEvent,
  type HarnessToolDefinition,
  type HarnessToolSource,
} from "../lib/harness";

let passed = 0;
let failed = 0;

function section(title: string): void {
  console.log(`\n${"─".repeat(62)}\n${title}\n${"─".repeat(62)}`);
}

function assert(condition: unknown, label: string, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`✓ ${label}${detail === undefined ? "" : `  ${String(detail)}`}`);
    return;
  }

  failed += 1;
  console.error(`✗ ${label}${detail === undefined ? "" : `  ${String(detail)}`}`);
}

function assertEq(actual: unknown, expected: unknown, label: string): void {
  assert(
    Object.is(actual, expected),
    label,
    `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`
  );
}

function fakeModel(rounds: HarnessModelRoundEvent[][]): HarnessModelAdapter {
  let index = 0;
  return {
    id: "fake-model",
    async *streamRound() {
      const round = rounds[index];
      index += 1;
      if (!round) throw new Error(`fake model has no round ${index}`);
      for (const event of round) yield event;
    },
  };
}

function tool(name: string): HarnessToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: { type: "object", properties: {} },
  };
}

async function collect(events: AsyncIterable<HarnessRunEvent>): Promise<HarnessRunEvent[]> {
  const out: HarnessRunEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function testHappyPath(): Promise<void> {
  section("1. 模型 → 工具 → 模型");

  const invocations: Array<{ name: string; args: Record<string, unknown> }> = [];
  const source: HarnessToolSource = {
    id: "test-tools",
    async listTools() {
      return [tool("lookup")];
    },
    async callTool(name, args) {
      invocations.push({ name, args });
      return { text: `result:${args.id}`, isError: false };
    },
  };

  const events = await collect(
    runHarness({
      messages: [{ role: "user", content: "look it up" }],
      model: fakeModel([
        [
          { type: "text_delta", text: "checking" },
          {
            type: "round_end",
            text: "checking",
            stopReason: "tool_calls",
            toolCalls: [
              { id: "call_1", name: "lookup", arguments: '{"id":"42"}' },
            ],
          },
        ],
        [
          { type: "text_delta", text: "done" },
          { type: "round_end", text: "done", stopReason: "stop", toolCalls: [] },
        ],
      ]),
      tools: [tool("lookup")],
      toolSource: source,
    })
  );

  assertEq(invocations.length, 1, "工具只执行一次");
  assertEq(invocations[0]?.name, "lookup", "执行了正确的工具");
  assertEq(invocations[0]?.args.id, "42", "JSON 参数已解析");
  assert(
    events.some((event) => event.type === "tool_result" && !event.result.isError),
    "事件流包含工具结果"
  );
  const end = events.at(-1);
  assertEq(end?.type, "run_end", "最后一个事件是 run_end");
  assert(end?.type === "run_end" && end.reason === "completed", "运行正常完成");
  assert(end?.type === "run_end" && end.rounds === 2, "总共执行两轮模型调用");
}

async function testPolicyDenial(): Promise<void> {
  section("2. 权限策略可以在执行前拦截工具");

  let called = false;
  const source: HarnessToolSource = {
    id: "test-tools",
    async listTools() {
      return [tool("read"), tool("delete")];
    },
    async callTool() {
      called = true;
      return { text: "unexpected", isError: false };
    },
  };

  const events = await collect(
    runHarness({
      messages: [{ role: "user", content: "delete it" }],
      model: fakeModel([
        [
          {
            type: "round_end",
            text: "",
            stopReason: "tool_calls",
            toolCalls: [{ id: "call_1", name: "delete", arguments: "{}" }],
          },
        ],
        [{ type: "round_end", text: "blocked", stopReason: "stop", toolCalls: [] }],
      ]),
      tools: [tool("read"), tool("delete")],
      toolSource: source,
      toolPolicy: createAllowlistPolicy(["read"]),
    })
  );

  assertEq(called, false, "被拒绝的工具没有执行");
  assert(
    events.some(
      (event) =>
        event.type === "tool_decision" &&
        event.call.name === "delete" &&
        event.decision === "deny"
    ),
    "事件流记录了 deny 决策"
  );
  assert(
    events.some(
      (event) =>
        event.type === "tool_result" &&
        event.result.text.startsWith("【E_TOOL_DENIED】")
    ),
    "拒绝以工具错误返回给模型"
  );
}

async function testApproval(): Promise<void> {
  section("3. ask 策略接入审批处理器");

  let approvedRuns = 0;
  const source: HarnessToolSource = {
    id: "test-tools",
    async listTools() {
      return [tool("deploy")];
    },
    async callTool() {
      approvedRuns += 1;
      return { text: "deployed", isError: false };
    },
  };

  const events = await collect(
    runHarness({
      messages: [{ role: "user", content: "deploy" }],
      model: fakeModel([
        [
          {
            type: "round_end",
            text: "",
            stopReason: "tool_calls",
            toolCalls: [{ id: "call_1", name: "deploy", arguments: "{}" }],
          },
        ],
        [{ type: "round_end", text: "ok", stopReason: "stop", toolCalls: [] }],
      ]),
      tools: [tool("deploy")],
      toolSource: source,
      toolPolicy: { decide: () => ({ type: "ask", reason: "需要人工确认" }) },
      approvalHandler: () => ({ approved: true, reason: "approved in test" }),
    })
  );

  assertEq(approvedRuns, 1, "审批通过后工具执行");
  assert(
    events.some(
      (event) =>
        event.type === "tool_decision" &&
        event.decision === "allow" &&
        event.reason === "approved in test"
    ),
    "审批结果进入运行事件"
  );
}

async function testRoundLimit(): Promise<void> {
  section("4. 轮数上限阻止无限工具循环");

  let calls = 0;
  const source: HarnessToolSource = {
    id: "test-tools",
    async listTools() {
      return [tool("loop")];
    },
    async callTool() {
      calls += 1;
      return { text: "again", isError: false };
    },
  };
  const model = fakeModel([
    [
      {
        type: "round_end",
        text: "",
        stopReason: "tool_calls",
        toolCalls: [{ id: "call_1", name: "loop", arguments: "{}" }],
      },
    ],
    [
      {
        type: "round_end",
        text: "",
        stopReason: "tool_calls",
        toolCalls: [{ id: "call_2", name: "loop", arguments: "{}" }],
      },
    ],
  ]);

  const events = await collect(
    runHarness({
      messages: [{ role: "user", content: "loop" }],
      model,
      tools: [tool("loop")],
      toolSource: source,
      maxRounds: 2,
    })
  );

  assertEq(calls, 1, "最后一轮的工具不会再执行");
  const limit = events.find(
    (event) =>
      event.type === "tool_result" && event.result.text.startsWith("【E_ROUND_LIMIT】")
  );
  assert(limit !== undefined, "返回明确的轮数上限错误");
  const end = events.at(-1);
  assert(end?.type === "run_end" && end.reason === "round_limit", "结束原因是 round_limit");
}

async function testToolSourceFailure(): Promise<void> {
  section("5. 工具源故障不会拖垮纯模型对话");

  const source: HarnessToolSource = {
    id: "broken-tools",
    async listTools() {
      throw new Error("offline");
    },
    async callTool() {
      throw new Error("unreachable");
    },
  };
  const events = await collect(
    runHarness({
      messages: [{ role: "user", content: "hello" }],
      model: fakeModel([
        [{ type: "round_end", text: "hello", stopReason: "stop", toolCalls: [] }],
      ]),
      toolSource: source,
    })
  );

  assert(
    events.some(
      (event) => event.type === "warning" && event.code === "E_TOOL_SOURCE"
    ),
    "工具源故障产生 warning"
  );
  const end = events.at(-1);
  assert(
    end?.type === "run_end" && end.reason === "completed",
    "没有工具时模型对话正常完成"
  );
}

async function testCancellation(): Promise<void> {
  section("6. AbortSignal 能取消运行");

  const controller = new AbortController();
  controller.abort();
  const events = await collect(
    runHarness({
      messages: [{ role: "user", content: "stop" }],
      model: fakeModel([
        [{ type: "round_end", text: "never", stopReason: "stop", toolCalls: [] }],
      ]),
      signal: controller.signal,
    })
  );

  assert(
    events.some((event) => event.type === "error" && event.code === "RUN_CANCELLED"),
    "产生取消错误事件"
  );
  const end = events.at(-1);
  assert(end?.type === "run_end" && end.reason === "cancelled", "结束原因是 cancelled");
}

async function testToolTimeout(): Promise<void> {
  section("7. 工具源忽略取消信号时仍会被超时截断");

  const source: HarnessToolSource = {
    id: "slow-tools",
    async listTools() {
      return [tool("slow")];
    },
    async callTool() {
      return new Promise((resolve) => {
        const timer = setTimeout(
          () => resolve({ text: "too late", isError: false }),
          500
        );
        timer.unref();
      });
    },
  };
  const startedAt = Date.now();
  const events = await collect(
    runHarness({
      messages: [{ role: "user", content: "run slow tool" }],
      model: fakeModel([
        [
          {
            type: "round_end",
            text: "",
            stopReason: "tool_calls",
            toolCalls: [{ id: "call_1", name: "slow", arguments: "{}" }],
          },
        ],
        [{ type: "round_end", text: "stopped", stopReason: "stop", toolCalls: [] }],
      ]),
      tools: [tool("slow")],
      toolSource: source,
      toolTimeoutMs: 10,
    })
  );
  const elapsed = Date.now() - startedAt;

  assert(elapsed < 200, "运行没有等待不配合的工具完整结束", `实际 ${elapsed}ms`);
  assert(
    events.some(
      (event) =>
        event.type === "tool_result" &&
        event.result.text.startsWith("【E_TOOL_TIMEOUT】")
    ),
    "超时结果明确返回给模型"
  );
}

async function main(): Promise<void> {
  await testHappyPath();
  await testPolicyDenial();
  await testApproval();
  await testRoundLimit();
  await testToolSourceFailure();
  await testCancellation();
  await testToolTimeout();

  console.log(`\n${"═".repeat(62)}`);
  console.log(
    failed === 0 ? `全部通过（${passed} 项断言）` : `失败 ${failed} 项，通过 ${passed} 项`
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\n✗ 未捕获错误：${error?.stack ?? error}`);
  process.exitCode = 1;
});
