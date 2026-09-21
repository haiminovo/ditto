/**
 * Ditto - 模型列表接口冒烟
 *
 * 直接调用 handleModelsRequest —— 它是一个纯的 (body) => Response 函数，
 * 不需要起 next dev，也就没有端口冲突与就绪轮询的问题。
 *
 * 全程不需要真实 API Key：起几个本地 mock，分别扮演 OpenAI 兼容协议与
 * Anthropic 协议，以及 404 / 401 / 超时几种失败形态。
 *
 *   npm run models:smoke
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { handleModelsRequest, type ModelsResponse } from "../lib/sdk/server";

/* ------------------------------------------------------------------ */
/* 断言                                                                */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;

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

function assertEq<T>(actual: T, expected: T, label: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(label, `= ${JSON.stringify(actual)}`);
  else bad(label, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

function section(title: string) {
  console.log(`\n${"─".repeat(62)}\n${title}\n${"─".repeat(62)}`);
}

/* ------------------------------------------------------------------ */
/* mock provider                                                       */
/* ------------------------------------------------------------------ */

interface Mock {
  port: number;
  /** 收到的请求数 —— 用来断言「根本没发请求」 */
  hits: number;
  paths: string[];
  close: () => Promise<void>;
}

type MockReply = (req: http.IncomingMessage) => {
  status: number;
  body?: unknown;
} | "hang";

function startMock(reply: MockReply): Promise<Mock> {
  return new Promise((resolve) => {
    const state = { hits: 0, paths: [] as string[] };

    const server = http.createServer((req, res) => {
      state.hits += 1;
      state.paths.push(req.url ?? "");

      const result = reply(req);

      if (result === "hang") return; // 不响应，用于触发超时

      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.body ?? {}));
    });

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        get hits() {
          return state.hits;
        },
        get paths() {
          return state.paths;
        },
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

/** 只取路径部分，忽略 query（Anthropic 会带 ?limit=1000） */
function pathnameOf(url: string): string {
  return url.split("?")[0];
}

/** 找一个确定没人监听的端口 */
async function findClosedPort(): Promise<number> {
  const m = await startMock(() => ({ status: 200, body: {} }));
  const p = m.port;
  await m.close();
  return p;
}

/* ------------------------------------------------------------------ */

const KEY = "sk-test-key-0123456789abcdef"; // 长度 > 12，且形如真实 key

async function call(
  providerConfig: Record<string, unknown>,
  provider = "custom",
  timeoutMs?: number
): Promise<{ status: number; body: ModelsResponse & { error?: string } }> {
  const res = await handleModelsRequest(
    { provider, providerConfig: providerConfig as never },
    timeoutMs === undefined ? undefined : { timeoutMs }
  );
  const body = (await res.json()) as ModelsResponse & { error?: string };
  return { status: res.status, body };
}

/* ------------------------------------------------------------------ */

async function main() {
  /* ---------------------------------------------------------------- */
  section("1. OpenAI 兼容协议");

  const openaiMock = await startMock(() => ({
    status: 200,
    body: {
      object: "list",
      data: [
        { id: "gpt-4o", object: "model", created: 1, owned_by: "openai" },
        { id: "gpt-4o-mini", object: "model", created: 1, owned_by: "openai" },
        // 非对话模型：必须被过滤掉
        { id: "text-embedding-3-small", object: "model" },
        { id: "whisper-1", object: "model" },
        { id: "tts-1", object: "model" },
        { id: "dall-e-3", object: "model" },
        { id: "omni-moderation-latest", object: "model" },
      ],
    },
  }));

  const r1 = await call({
    type: "openai",
    baseURL: `http://127.0.0.1:${openaiMock.port}/v1`,
    apiKey: KEY,
  });

  assertEq(r1.status, 200, "状态码");
  assertEq(
    r1.body.models.map((m) => m.id),
    ["gpt-4o", "gpt-4o-mini"],
    "只保留对话模型"
  );
  assert(
    r1.body.warnings.some((w) => w.includes("5")),
    "被排除的数量出现在 warnings 里",
    r1.body.warnings.join(" | ")
  );
  assertEq(pathnameOf(openaiMock.paths[0]), "/v1/models", "请求路径");

  /* ---------------------------------------------------------------- */
  section("2. Anthropic 协议（含元数据与自动翻页）");

  const anthropicMock = await startMock(() => ({
    status: 200,
    body: {
      data: [
        {
          id: "claude-opus-5",
          type: "model",
          display_name: "Claude Opus 5",
          created_at: "2026-07-24T00:00:00Z",
          // 这两个字段在 @anthropic-ai/sdk@0.39.0 的类型里还没有
          max_input_tokens: 200000,
          max_tokens: 8192,
        },
      ],
      has_more: false,
      first_id: "claude-opus-5",
      last_id: "claude-opus-5",
    },
  }));

  const r2 = await call({
    type: "anthropic",
    baseURL: `http://127.0.0.1:${anthropicMock.port}`,
    apiKey: KEY,
  });

  assertEq(r2.status, 200, "状态码");
  assertEq(r2.body.models.length, 1, "模型数量");
  assertEq(r2.body.models[0]?.id, "claude-opus-5", "模型 id");
  assertEq(r2.body.models[0]?.name, "Claude Opus 5", "显示名来自 display_name");
  assertEq(r2.body.models[0]?.contextWindow, 200000, "上下文窗口来自 max_input_tokens");
  assertEq(r2.body.models[0]?.maxTokens, 8192, "输出上限来自 max_tokens");
  assertEq(pathnameOf(anthropicMock.paths[0]), "/v1/models", "Anthropic 也落在 /v1/models");

  /* ---------------------------------------------------------------- */
  section("3. 无 key / 无 baseURL：必须在发请求之前就拒绝");

  const guardMock = await startMock(() => ({ status: 200, body: { data: [] } }));

  const noKey = await call({
    type: "openai",
    baseURL: `http://127.0.0.1:${guardMock.port}/v1`,
    apiKey: "",
  });
  assertEq(noKey.status, 400, "无 key → 400");
  assertEq(guardMock.hits, 0, "无 key 时根本没有发出请求");

  const noBase = await call({ type: "openai", baseURL: "", apiKey: KEY });
  assertEq(noBase.status, 400, "custom 未填 baseURL → 400");
  assert(
    (noBase.body.error ?? "").includes("Base URL"),
    "错误信息指向 Base URL",
    noBase.body.error ?? ""
  );
  // 这条路的重点：绝不能因为 baseURL 为空就回落到 https://api.openai.com/v1
  // （OpenAI SDK 在 baseURL 为空串时正是这么做的）

  /* ---------------------------------------------------------------- */
  section("4. 失败形态");

  // 4a 不可达
  const deadPort = await findClosedPort();
  const unreachable = await call({
    type: "openai",
    baseURL: `http://127.0.0.1:${deadPort}/v1`,
    apiKey: KEY,
  });
  assertEq(unreachable.status, 502, "不可达 → 502");

  // 4b 超时
  const hangMock = await startMock(() => "hang");
  const started = Date.now();
  const timedOut = await call(
    { type: "openai", baseURL: `http://127.0.0.1:${hangMock.port}/v1`, apiKey: KEY },
    "custom",
    700
  );
  const elapsed = Date.now() - started;
  assertEq(timedOut.status, 504, "超时 → 504（与 502 区分开）");
  assert(elapsed < 5000, "超时按设定生效，没有拖到 SDK 默认的 10 分钟", `${elapsed}ms`);
  await hangMock.close();

  // 4c baseURL 少了 /v1
  const noV1Mock = await startMock((req) =>
    req.url?.startsWith("/v1/") ? { status: 200, body: { data: [] } } : { status: 404, body: { error: "not found" } }
  );
  const missingV1 = await call({
    type: "openai",
    // 故意不给 /v1 —— OpenAI SDK 会去请求 {baseURL}/models
    baseURL: `http://127.0.0.1:${noV1Mock.port}`,
    apiKey: KEY,
  });
  assertEq(missingV1.status, 502, "缺 /v1 → 上游 404，整体报错");
  assert(
    missingV1.body.warnings.some((w) => w.includes("/v1")),
    "warning 指向「多半是少了 /v1」这个成因",
    missingV1.body.warnings.join(" | ")
  );

  /* ---------------------------------------------------------------- */
  section("5. 上游错误体里的 key 必须被洗掉");

  // DeepSeek 的 401 长这样：Authentication Fails, Your api key: sk-****xxxx is invalid
  // OpenAI 的 401 会回显 sk-...abcd。仅「不回显我们自己的 key」是不够的。
  const leakyMock = await startMock(() => ({
    status: 401,
    body: { error: { message: `Authentication Fails, Your api key: ${KEY} is invalid` } },
  }));

  const leaked = await call({
    type: "openai",
    baseURL: `http://127.0.0.1:${leakyMock.port}/v1`,
    apiKey: KEY,
  });
  const asText = JSON.stringify(leaked.body);
  assertEq(leaked.status, 502, "上游 401 → 502");
  assert(!asText.includes(KEY), "完整 key 未出现在返回里");
  assert(!/sk-[A-Za-z0-9_-]{8,}/.test(asText), "任何形如 sk-xxx 的串都被洗掉", asText.slice(0, 200));
  assert(asText.includes("invalid"), "但保留了可诊断的上游信息");

  /* ---------------------------------------------------------------- */
  await Promise.all([openaiMock, anthropicMock, guardMock, noV1Mock, leakyMock].map((m) => m.close()));

  console.log(`\n${"═".repeat(62)}`);
  console.log(failed === 0 ? `全部通过（${passed} 项断言）` : `${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`\n✗ 未捕获错误：${e?.stack ?? e}`);
  process.exit(1);
});
