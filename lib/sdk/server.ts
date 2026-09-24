/**
 * Ditto Server SDK - 用于 Next.js API Route
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  LLMOptions,
  Message,
  ProviderConfig,
  PROVIDERS,
  ToolCall,
} from "./types";
import { estimateTokens, getDefaultRegistry, trimMessagesToContextWindow } from "./registry";
import {
  createItemStart,
  createTextDelta,
  createItemEnd,
  createStreamEnd,
  createStreamError,
  createToolCallStart,
  createToolCallArgs,
  createToolResultStart,
  createToolResultDelta,
  toSSE,
  StreamEvent,
} from "./protocol";
import { createToolBridge, type ProviderTool, type ToolBridge } from "./tools";
import { mcpActor } from "../core/actors";

export interface ChatRequest {
  provider: string;
  modelName: string;
  providerConfig: ProviderConfig;
  messages: Message[];
  options?: LLMOptions;
  stream: boolean;
  /** 是否给模型挂实施平台的工具。省略视为 true；见 llm.ts 里 BrowserModel 的传参 */
  enableTools?: boolean;
}

/**
 * 工具循环的轮数上限。
 *
 * 设上限不是为了防模型「想太多」，是为了防它死循环：模型完全可能
 * 反复调同一个工具、拿到同样的结果、再调一次。到顶了就如实告诉用户，
 * 而不是无声地一直转下去。
 */
const MAX_TOOL_ROUNDS = 6;

/** 文本攒多少字符就先发出去 */
const FLUSH_CHARS = 50;
/** 或者攒多久 */
const FLUSH_MS = 50;

/** 一轮 provider 调用的产出 */
interface RoundOutcome {
  text: string;
  toolCalls: ToolCall[];
  /** provider 给的结束原因；null 表示这一轮没读到 */
  stopReason: string | null;
}

/* ------------------------------------------------------------------ */
/* 模型列表                                                            */
/* ------------------------------------------------------------------ */

export interface ModelsRequest {
  provider: string;
  providerConfig: ProviderConfig;
}

export interface FetchedModel {
  id: string;
  /** 仅 Anthropic 提供 display_name */
  name?: string;
  /** 上下文窗口。只有 Anthropic 的 max_input_tokens 能填上 */
  contextWindow?: number;
  /** 输出上限。只有 Anthropic 的 max_tokens 能填上 */
  maxTokens?: number;
}

export interface ModelsResponse {
  models: FetchedModel[];
  /** 非致命问题（过滤掉了多少、404 可能是少了 /v1 等） */
  warnings: string[];
  error?: string;
}

export interface ModelsOptions {
  /** 覆盖默认超时，仅供测试使用 */
  timeoutMs?: number;
}

const DEFAULT_MODELS_TIMEOUT_MS = 8000;

/**
 * OpenAI 的 /v1/models 会把 embedding / tts / whisper / dall-e / moderation
 * 一起返回。不过滤的话列表大半是选了就报错的模型。
 *
 * 两条取舍：
 *
 * 1. **按名称过滤，不按 host 过滤。** 一开始我限定只在 api.openai.com 上启用，
 *    但那会漏掉一个很常见的场景：用户用 LiteLLM / one-api 之类的兼容网关
 *    代理 OpenAI，host 不是 api.openai.com，于是 embedding 照样堆在列表里。
 *
 * 2. **只列无歧义的非对话家族。** 刻意不含 davinci / babbage 这类遗留补全模型 ——
 *    它们是能对话的，误伤比放过更难排查。
 *
 * 而且过滤永远不是静默的：数量会进 warnings，用户不同意还能用手填补回来。
 */
const NON_CHAT_PREFIXES = [
  "text-embedding",
  "text-moderation",
  "omni-moderation",
  "dall-e",
  "tts-",
  "whisper-",
  "gpt-image",
];

export function isNonChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  return NON_CHAT_PREFIXES.some((p) => lower.startsWith(p));
}

/**
 * 洗掉上游错误体里可能回显的密钥。
 *
 * 仅"不回显我们自己的 key"是不够的：DeepSeek 的 401 会写
 * `Your api key: sk-****xxxx is invalid`，OpenAI 会回显 `sk-...abcd`。
 * 这些消息会被原样转发给浏览器，所以必须在这里过一道。
 */
function scrubSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_\-]{3,}/g, "sk-***")
    .replace(/(authorization|x-api-key)\s*[:=]\s*\S+/gi, "$1: ***");
}

function jsonResponse(status: number, body: ModelsResponse): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 从各种可能的信封里把模型数组抠出来。兼容网关的形状五花八门。 */
function extractModelArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.data)) return o.data;
    if (Array.isArray(o.models)) return o.models;
  }
  return [];
}

/** 元素可能是字符串，也可能是带 id / name / model 的对象 */
function coerceModel(item: unknown): FetchedModel | null {
  if (typeof item === "string") {
    return item.trim() ? { id: item.trim() } : null;
  }
  if (item && typeof item === "object") {
    const o = item as Record<string, unknown>;
    const id = o.id ?? o.name ?? o.model;
    if (typeof id === "string" && id.trim()) {
      const name = typeof o.display_name === "string" ? o.display_name : undefined;
      const ctx =
        typeof o.max_input_tokens === "number"
          ? o.max_input_tokens
          : typeof o.context_window === "number"
            ? o.context_window
            : undefined;
      const maxTok =
        typeof o.max_tokens === "number" ? o.max_tokens : undefined;
      return { id: id.trim(), name, contextWindow: ctx, maxTokens: maxTok };
    }
  }
  return null;
}

export async function handleModelsRequest(
  request: ModelsRequest,
  options: ModelsOptions = {}
): Promise<Response> {
  const { provider, providerConfig } = request;
  const providerType = getProviderType(provider, providerConfig);
  const apiKey = (providerConfig.apiKey || "").trim();
  const warnings: string[] = [];

  if (!apiKey) {
    return jsonResponse(400, { models: [], warnings, error: "缺少 API Key" });
  }

  // ⚠️ 这里刻意**不用** getBaseURL。
  //
  // getBaseURL 在拿不到用户地址或预设地址时，会按 provider type 猜一个默认值
  // （最终落到 https://api.openai.com/v1）。对聊天那是既有行为，但对列模型是灾难：
  // 用户建了 custom 却忘了填地址，就会拿第三方网关的 key 去打 OpenAI ——
  // 静默错路由，最难排查的那种。所以此处只接受**明写的**地址，
  // 用户填的或预设里带的一律算数，猜出来的不算。
  const baseURL = explicitBaseURL(provider, providerConfig);

  if (!baseURL) {
    return jsonResponse(400, {
      models: [],
      warnings,
      error: "请先填写 Base URL（自定义 Provider 必须显式指定接口地址）",
    });
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_MODELS_TIMEOUT_MS;
  // maxRetries: 0 —— SDK 默认重试 2 次，叠加坏主机就是转圈几分钟
  const clientOpts = { maxRetries: 0, timeout: timeoutMs };

  try {
    let raw: unknown;

    if (providerType === "anthropic" || providerType === "claude") {
      const client = new Anthropic({ baseURL, apiKey, ...clientOpts });
      const items: unknown[] = [];
      // AbstractPage 实现了 AsyncIterable，for await 会自动翻页
      for await (const m of client.models.list({ limit: 1000 })) {
        items.push(m);
      }
      raw = { data: items };
    } else {
      const client = new OpenAI({ baseURL, apiKey, ...clientOpts });
      const page = await client.models.list();
      raw = page;
    }

    return finishModels(raw, baseURL, warnings);
  } catch (error) {
    return modelsErrorResponse(error, baseURL, warnings, providerType);
  }
}

function finishModels(raw: unknown, baseURL: string, warnings: string[]): Response {
  const items = extractModelArray(raw);
  const parsed = items.map(coerceModel).filter((m): m is FetchedModel => m !== null);

  // 去重，保序
  const seen = new Set<string>();
  const unique = parsed.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  const models = unique.filter((m) => !isNonChatModel(m.id));
  const dropped = unique.length - models.length;
  if (dropped > 0) {
    warnings.push(
      `已过滤掉 ${dropped} 个非对话模型（embedding / tts / whisper / 图像等）；` +
        `如仍需使用可手工添加`
    );
  }

  return jsonResponse(200, { models, warnings });
}

function modelsErrorResponse(
  error: unknown,
  baseURL: string,
  warnings: string[],
  providerType: string
): Response {
  const err = error as { status?: number; message?: string; name?: string };
  const message = scrubSecrets(err?.message ?? String(error));

  // 超时与连不上要分开 —— 排查方向完全不同
  const isTimeout =
    err?.name === "TimeoutError" ||
    err?.name === "AbortError" ||
    /timed? ?out/i.test(message);

  if (isTimeout) {
    warnings.push(`请求未在超时时间内返回：${baseURL}`);
    return jsonResponse(504, { models: [], warnings, error: `上游超时：${message}` });
  }

  const status = typeof err?.status === "number" ? err.status : undefined;

  if (status === 404) {
    warnings.push(
      `provider 返回 404。常见成因是 Base URL 少了 /v1 —— ` +
        `OpenAI 兼容接口的模型列表在 {BaseURL}/models。当前 Base URL：${baseURL}`
    );
  }

  if (/fetch failed|ECONNREFUSED|ENOTFOUND|certificate/i.test(message)) {
    warnings.push(
      `无法连接到 ${baseURL}。请确认地址可达；` +
        `若是本地自签名 HTTPS，服务端会因证书校验失败而拒绝。`
    );
  }

  const detail = status ? `HTTP ${status}：${message}` : message;
  return jsonResponse(502, {
    models: [],
    warnings,
    error: `${providerType} 模型列表请求失败 — ${detail}`,
  });
}

// 解析逻辑统一放在 types.ts —— 曾经这里、llm.ts、types.ts 各有一份 switch，
// 一旦三份解析出不同的 baseURL，就会出现「列模型用 A 协议、聊天用 B 协议」。
import {
  resolveBaseURL as getBaseURL,
  resolveProviderType as getProviderType,
  explicitBaseURL,
} from "./types";

/* ------------------------------------------------------------------ */
/* SSE 写入器                                                          */
/* ------------------------------------------------------------------ */

/**
 * 把一个流的事件按序写进 controller。
 *
 * 两个 handle*Request 曾经各自复制了一份「攒够 50 字符或 50ms 就 flush」
 * 的逻辑，各带一个 hasStarted 标志位。加了工具循环之后，一个流里会出现
 * 多个文本项 + 工具项，那个复制方案没法继续撑 —— 所以收拢到这里。
 */
class StreamWriter {
  private readonly encoder = new TextEncoder();
  private buffer = "";
  /** 当前文本项的 id；null 表示这一段文本还没开始，或已经结束 */
  private textItemId: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  /** 对端已经断了 —— 之后所有写入都直接丢弃 */
  private broken = false;

  constructor(
    private readonly controller: ReadableStreamDefaultController<Uint8Array>,
    private readonly streamId: string
  ) {}

  /**
   * 写入一个事件。
   *
   * 用户关掉页面、或点了停止时，controller 会进入 errored 状态，之后每次
   * enqueue 都抛。**必须在这里吞掉**：抛出去会先命中 handleChatRequest 的
   * catch（于是又写一次错误事件 —— 再抛一次），再穿到 finally 里 close()
   * 又一次，最后变成一个没人处理的 rejection。断了就是断了，收摊即可。
   */
  private send(event: StreamEvent): void {
    // 只看 broken，不看 closed —— close() 自己还要发 STREAM_END，
    // 让 closed 挡住写入会把收尾事件吞掉
    if (this.broken) return;
    try {
      this.controller.enqueue(this.encoder.encode(toSSE(event)));
    } catch {
      this.broken = true;
    }
  }

  /**
   * 惰性开一个文本项。
   *
   * 拿到实例就等于发出了 ITEM_START —— 所以「没有文本就不该有 item」
   * 这条旧行为被保住了，同时不需要一个 hasStarted 标志位。
   */
  private get textItem(): string {
    if (!this.textItemId) {
      this.textItemId = newItemId("text");
      this.send(createItemStart(this.streamId, this.textItemId, "text"));
    }
    return this.textItemId;
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private flush(): void {
    if (!this.buffer) return;
    this.send(createTextDelta(this.streamId, this.textItem, this.buffer));
    this.buffer = "";
  }

  /** 模型吐出一个文本增量 */
  pushText(delta: string): void {
    this.buffer += delta;
    if (this.buffer.length >= FLUSH_CHARS) {
      this.clearTimer();
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, FLUSH_MS);
    }
  }

  /**
   * 结束当前文本项。
   *
   * 每轮模型调用结束都要调一次：一个流里有两轮就必然有两段文本
   * （工具调用前的一段、拿到结果后的一段），它们必须是**两个 item**，
   * 否则界面会把工具卡片之后的话渲染到卡片之前去。
   */
  endTextItem(): void {
    this.clearTimer();
    this.flush();
    if (this.textItemId) {
      this.send(createItemEnd(this.streamId, this.textItemId, "text"));
      this.textItemId = null;
    }
  }

  /** 一次工具调用：参数攒齐了一次性发（见 protocol.ts 的说明） */
  writeToolCall(call: ToolCall): void {
    this.send(createToolCallStart(this.streamId, call.id, call.name));
    this.send(createToolCallArgs(this.streamId, call.id, call.arguments));
    this.send(createItemEnd(this.streamId, call.id, "tool"));
  }

  writeToolResult(callId: string, text: string, isError: boolean): void {
    const resultId = newItemId("result");
    this.send(createToolResultStart(this.streamId, resultId, callId, isError));
    this.send(createToolResultDelta(this.streamId, resultId, text));
    this.send(createItemEnd(this.streamId, resultId, "tool_result"));
  }

  writeError(code: "TIMEOUT" | "MODEL_ERROR" | "CANCELLED" | "UNKNOWN", message: string): void {
    this.send(createStreamError(this.streamId, code, message));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    this.clearTimer();
    if (!this.broken) {
      this.endTextItem();
      this.send(createStreamEnd(this.streamId));
    }

    try {
      this.controller.close();
    } catch {
      // 已经关了（对端断开时流会自行关闭），没什么可做的
    }
  }
}

function newItemId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/* ------------------------------------------------------------------ */
/* 工具定义：转成各 provider 的格式                                     */
/* ------------------------------------------------------------------ */

function toAnthropicTools(tools: ProviderTool[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
  }));
}

function toOpenAITools(tools: ProviderTool[]): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

/** 两家 provider 表达「我在等工具结果」的 stop_reason 取值 */
function isToolStop(stopReason: string | null): boolean {
  return stopReason === "tool_use" || stopReason === "tool_calls";
}

/** 模型给的参数是 JSON 字符串，解析失败要如实回给模型，而不是抛掉 */
function parseToolArgs(raw: string): { args: Record<string, unknown> } | { parseError: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { args: {} };
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { parseError: `参数必须是一个 JSON 对象，实际是 ${Array.isArray(parsed) ? "数组" : typeof parsed}` };
    }
    return { args: parsed as Record<string, unknown> };
  } catch (e) {
    return { parseError: e instanceof Error ? e.message : String(e) };
  }
}

export async function handleChatRequest(request: ChatRequest): Promise<Response> {
  const { provider, modelName, providerConfig, messages, options, stream, enableTools } = request;
  const providerType = getProviderType(provider, providerConfig);
  const baseURL = getBaseURL(provider, providerConfig);
  const apiKey = providerConfig.apiKey || "";

  if (!apiKey) {
    return new Response(JSON.stringify({ error: "No API key provided" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const isAnthropic = providerType === "anthropic" || providerType === "claude";

  // 非流式路径不带工具：工具循环的意义在于把中间过程推给用户看，
  // 而这正是流式才有的能力。模型拿不到工具，也就不会要求调工具。
  if (!stream) {
    const registry = getDefaultRegistry();
    const modelEntry = registry.resolve(modelName);
    const trimmed =
      modelEntry && messages.length
        ? trimMessagesToContextWindow(messages, modelEntry, modelEntry.maxTokens)
        : messages;

    return isAnthropic
      ? handleAnthropicRequest(modelName, baseURL, apiKey, trimmed, options)
      : handleOpenAICompatibleRequest(modelName, baseURL, apiKey, trimmed, options);
  }

  // 桥接层要**赶在裁剪之前**建好：工具定义本身也占输入 token，
  // 不先把它们算出来，裁剪就会按「没有工具」的预算放行 —— 加上工具后
  // 正好超窗，而报错发生在 provider 那侧，看起来像消息有问题。
  let bridge: ToolBridge | null = null;
  let tools: ProviderTool[] = [];

  try {
    if (enableTools !== false) {
      // 对话界面以 AI 身份记账：动作确实是模型决定执行的，
      // 记成人会让审计分不清一次写入是人点的还是模型自己调的工具
      bridge = await createToolBridge(
        mcpActor({ name: "chat-ui", version: "0.1.0" }, "chat")
      );
      tools = await bridge.listTools();
    }
  } catch (error) {
    // 建不起来就如实退回无工具的对话，而不是整个请求失败 ——
    // 实施平台没配好不该连聊天都用不了
    if (bridge) await bridge.close().catch(() => undefined);
    bridge = null;
    tools = [];
    console.error("实施平台工具不可用，本次对话不带工具:", error);
  }

  const registry = getDefaultRegistry();
  const modelEntry = registry.resolve(modelName);

  let processedMessages = messages;
  if (modelEntry) {
    // 工具定义是原样拼进请求的 JSON，直接量一下它的实际大小
    const toolTokens = tools.length ? estimateTokens(JSON.stringify(tools)) : 0;
    processedMessages = trimMessagesToContextWindow(
      messages,
      modelEntry,
      modelEntry.maxTokens,
      toolTokens
    );
    if (processedMessages.length !== messages.length) {
      console.log(`Trimmed messages from ${messages.length} to ${processedMessages.length} to fit context window`);
    }
  }

  const streamId = `stream_${Date.now()}`;
  const activeBridge = bridge;
  const activeTools = tools;

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      const writer = new StreamWriter(controller, streamId);

      try {
        let convo = processedMessages;

        for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
          const outcome = isAnthropic
            ? await runAnthropicRound(modelName, baseURL, apiKey, convo, options ?? {}, activeTools, writer)
            : await runOpenAICompatibleRound(modelName, baseURL, apiKey, convo, options ?? {}, activeTools, writer);

          writer.endTextItem();

          if (outcome.toolCalls.length === 0) {
            // provider 说要调工具，却一个都没攒出来 —— 流被截断了。
            // 不吭声的话，用户只会看到一段莫名其妙断掉的话。
            if (isToolStop(outcome.stopReason)) {
              writer.writeError(
                "MODEL_ERROR",
                `模型要求调用工具，但没收到完整的调用信息（stop_reason=${outcome.stopReason}）`
              );
            }
            break;
          }

          if (round === MAX_TOOL_ROUNDS - 1) {
            // 最后一轮还是要求调工具：不能再转了，但要让用户知道为什么停
            for (const call of outcome.toolCalls) {
              writer.writeToolCall(call);
              writer.writeToolResult(
                call.id,
                `【E_ROUND_LIMIT】已达到工具调用轮数上限（${MAX_TOOL_ROUNDS}），本次未执行。`,
                true
              );
            }
            writer.pushText(
              `\n\n（已达到工具调用轮数上限 ${MAX_TOOL_ROUNDS}，我先停下来。可以把问题拆小一点再问。）`
            );
            break;
          }

          const assistantMsg: Message = {
            role: "assistant",
            content: outcome.text,
            toolCalls: outcome.toolCalls,
          };
          const toolMsgs: Message[] = [];

          for (const call of outcome.toolCalls) {
            writer.writeToolCall(call);

            const parsed = parseToolArgs(call.arguments);
            const result =
              "parseError" in parsed
                ? {
                    text: `【E_TOOL_ARGS】参数不是合法 JSON，无法执行：${parsed.parseError}\n收到的原文：${call.arguments.slice(0, 500)}`,
                    isError: true,
                  }
                : activeBridge
                  ? await activeBridge.callTool(call.name, parsed.args)
                  : {
                      text: `【E_TOOL_UNAVAILABLE】工具通道未建立，${call.name} 未执行。`,
                      isError: true,
                    };

            writer.writeToolResult(call.id, result.text, result.isError);
            toolMsgs.push({
              role: "tool",
              toolCallId: call.id,
              content: result.text,
            });
          }

          convo = [...convo, assistantMsg, ...toolMsgs];
        }
      } catch (error) {
        // 流已经发出去了，HTTP 状态码改不动了 —— 只能作为流内错误事件告知
        writer.writeError(
          "MODEL_ERROR",
          error instanceof Error ? error.message : String(error)
        );
      } finally {
        // 桥接层必须在这里收：每轮对话建了一个 McpServer + 两条 transport，
        // 漏掉就是稳定的内存泄漏
        if (activeBridge) {
          await activeBridge.close();
        }
        writer.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function convertMessagesForAnthropic(messages: Message[]): {
  system: string | undefined;
  anthropicMessages: Anthropic.MessageParam[];
} {
  let system: string | undefined;
  const anthropicMessages: Anthropic.MessageParam[] = [];

  // Anthropic 要求一次 assistant 里所有 tool_use 的结果，都放在紧随其后的
  // **同一条** user 消息里。而我们的归一化消息是「一个结果一条 role:"tool"」，
  // 所以这里先攒着，遇到下一条非工具消息再一起冲出去。
  let pendingToolResults: Anthropic.ToolResultBlockParam[] = [];

  const flushToolResults = () => {
    if (pendingToolResults.length === 0) return;
    anthropicMessages.push({ role: "user", content: pendingToolResults });
    pendingToolResults = [];
  };

  for (const msg of messages) {
    if (msg.role === "system") {
      system = system ? system + "\n" + msg.content : msg.content;
      continue;
    }

    if (msg.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: msg.toolCallId,
        content: msg.content,
      });
      continue;
    }

    flushToolResults();

    if (msg.role === "assistant") {
      const calls = msg.toolCalls ?? [];
      if (calls.length === 0) {
        anthropicMessages.push({ role: "assistant", content: msg.content });
        continue;
      }

      const blocks: Anthropic.ContentBlockParam[] = [];
      if (msg.content) {
        blocks.push({ type: "text", text: msg.content });
      }
      for (const call of calls) {
        // 这是对模型上一轮输出的**重建**。参数当时没解析成功的话，只能给 {}：
        // Anthropic 不接受非 JSON 的 input，而真实情况已经通过 tool_result
        // 里的 E_TOOL_ARGS 如实告诉模型了。
        const parsed = parseToolArgs(call.arguments);
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: ("args" in parsed ? parsed.args : {}) as Anthropic.ToolUseBlockParam["input"],
        });
      }
      anthropicMessages.push({ role: "assistant", content: blocks });
      continue;
    }

    // user
    if (Array.isArray(msg.content)) {
      // 处理多模态内容
      const content: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = [];
      for (const part of msg.content) {
        if (part.type === "text") {
          content.push({ type: "text", text: part.text });
        } else if (part.type === "image_url") {
          // 处理 Base64 图片
          const url = part.image_url.url;
          if (url.startsWith("data:")) {
            const [header, data] = url.split(",");
            const mimeType = header.match(/data:([^;]+)/)?.[1] || "image/png";
            content.push({
              type: "image",
              source: {
                type: "base64",
                media_type: mimeType as any,
                data,
              },
            });
          } else {
            // 远程 URL - 需要转换为 base64 或者使用其他方式
            // 暂时只支持 base64
          }
        }
      }
      anthropicMessages.push({
        role: "user",
        content: content.length > 0 ? content : [],
      });
    } else {
      // 纯文本消息
      anthropicMessages.push({ role: "user", content: msg.content });
    }
  }

  flushToolResults();

  return { system, anthropicMessages };
}

/**
 * 归一化消息 → OpenAI 形状。
 *
 * 曾经这里是 `messages as any[]` 直接透传 —— 归一化消息的字段名恰好与
 * OpenAI 一致，所以能歪打正着。加上工具调用之后不再成立：`toolCalls`
 * 与 `toolCallId` 都不是 OpenAI 的字段名（它要的是 `tool_calls` /
 * `tool_call_id`)，继续透传会把工具调用**静默丢掉**。
 */
function convertMessagesForOpenAI(
  messages: Message[]
): OpenAI.ChatCompletionMessageParam[] {
  const out: OpenAI.ChatCompletionMessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      out.push({ role: "system", content: msg.content });
    } else if (msg.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: msg.toolCallId,
        content: msg.content,
      });
    } else if (msg.role === "assistant") {
      const calls = msg.toolCalls ?? [];
      if (calls.length === 0) {
        out.push({ role: "assistant", content: msg.content });
      } else {
        out.push({
          role: "assistant",
          // 带 tool_calls 时 content 允许为 null；空串会让部分网关报错
          content: msg.content || null,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: "function" as const,
            function: { name: c.name, arguments: c.arguments },
          })),
        });
      }
    } else {
      out.push({ role: "user", content: msg.content as any });
    }
  }

  return out;
}

/**
 * 非流式单轮。
 *
 * 流式那条路整个搬去了 runAnthropicRound —— 它要在一个 ReadableStream 里
 * 被调用多次（工具循环），没法再自己建一个 Response 返回。
 * 非流式不带工具，理由见 handleChatRequest。
 */
async function handleAnthropicRequest(
  modelName: string,
  baseURL: string,
  apiKey: string,
  messages: Message[],
  options: LLMOptions = {}
): Promise<Response> {
  const client = new Anthropic({
    baseURL: baseURL || "https://api.anthropic.com",
    apiKey: apiKey,
  });

  const { system, anthropicMessages } = convertMessagesForAnthropic(messages);

  const response = await client.messages.create({
    model: modelName,
    messages: anthropicMessages,
    system: system,
    temperature: options.temperature ?? 0.7,
    max_tokens: options.maxTokens ?? 8192,
    top_p: options.topP,
  });

  let content = "";
  for (const block of response.content) {
    if (block.type === "text") {
      content += block.text;
    }
  }

  return new Response(JSON.stringify({ content }), {
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * 一轮 Anthropic 流式调用。
 *
 * 文本边到边推给 writer；工具调用攒齐了作为返回值交出去
 * （参数要 JSON 完整才能执行，边流边执行是做不到的）。
 */
async function runAnthropicRound(
  modelName: string,
  baseURL: string,
  apiKey: string,
  messages: Message[],
  options: LLMOptions,
  tools: ProviderTool[],
  writer: StreamWriter
): Promise<RoundOutcome> {
  const client = new Anthropic({
    baseURL: baseURL || "https://api.anthropic.com",
    apiKey,
  });

  const { system, anthropicMessages } = convertMessagesForAnthropic(messages);

  const stream = await client.messages.create({
    model: modelName,
    messages: anthropicMessages,
    system,
    temperature: options.temperature ?? 0.7,
    max_tokens: options.maxTokens ?? 8192,
    top_p: options.topP,
    stream: true,
    ...(tools.length ? { tools: toAnthropicTools(tools) } : {}),
  });

  let text = "";
  let pending: { id: string; name: string; json: string } | null = null;
  const toolCalls: ToolCall[] = [];
  let stopReason: string | null = null;

  for await (const chunk of stream) {
    if (chunk.type === "content_block_start" && chunk.content_block.type === "tool_use") {
      pending = {
        id: chunk.content_block.id,
        name: chunk.content_block.name,
        json: "",
      };
    } else if (chunk.type === "content_block_delta") {
      if (chunk.delta.type === "text_delta") {
        text += chunk.delta.text;
        writer.pushText(chunk.delta.text);
      } else if (chunk.delta.type === "input_json_delta" && pending) {
        // 参数是分片吐的，攒成一个串再解析
        pending.json += chunk.delta.partial_json;
      }
    } else if (chunk.type === "content_block_stop" && pending) {
      toolCalls.push({ id: pending.id, name: pending.name, arguments: pending.json });
      pending = null;
    } else if (chunk.type === "message_delta") {
      // stop_reason 此前被完全忽略。不看它就无从区分「说完了」与
      // 「在等工具结果」—— 循环的推进依据正是后者。
      if (chunk.delta.stop_reason) {
        stopReason = chunk.delta.stop_reason;
      }
    }
  }

  return { text, toolCalls, stopReason };
}

/** 非流式单轮。同 handleAnthropicRequest 的说明。 */
async function handleOpenAICompatibleRequest(
  modelName: string,
  baseURL: string,
  apiKey: string,
  messages: Message[],
  options: LLMOptions = {}
): Promise<Response> {
  const client = new OpenAI({
    baseURL,
    apiKey: apiKey,
  });

  const response = await client.chat.completions.create({
    model: modelName,
    messages: convertMessagesForOpenAI(messages),
    temperature: options.temperature ?? 0.7,
    max_tokens: options.maxTokens ?? 2048,
    top_p: options.topP,
  });

  const content = response.choices[0]?.message?.content || "";
  return new Response(JSON.stringify({ content }), {
    headers: { "Content-Type": "application/json" },
  });
}

/** 一轮 OpenAI 兼容流式调用。DeepSeek 等走的也是这条路。 */
async function runOpenAICompatibleRound(
  modelName: string,
  baseURL: string,
  apiKey: string,
  messages: Message[],
  options: LLMOptions,
  tools: ProviderTool[],
  writer: StreamWriter
): Promise<RoundOutcome> {
  const client = new OpenAI({
    baseURL,
    apiKey,
  });

  const stream = await client.chat.completions.create({
    model: modelName,
    messages: convertMessagesForOpenAI(messages),
    temperature: options.temperature ?? 0.7,
    max_tokens: options.maxTokens ?? 2048,
    top_p: options.topP,
    stream: true,
    ...(tools.length ? { tools: toOpenAITools(tools) } : {}),
  });

  let text = "";
  let stopReason: string | null = null;
  // 按 index 累积：OpenAI 的流式工具调用是按 index 分片吐的，
  // 同一轮里多个工具的片会交错到达
  const partial = new Map<number, { id: string; name: string; json: string }>();

  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    if (!choice) continue;

    const delta = choice.delta;
    if (delta?.content) {
      text += delta.content;
      writer.pushText(delta.content);
    }

    for (const piece of delta?.tool_calls ?? []) {
      const index = piece.index ?? 0;
      const acc = partial.get(index) ?? { id: "", name: "", json: "" };
      if (piece.id) acc.id = piece.id;
      if (piece.function?.name) acc.name = piece.function.name;
      if (piece.function?.arguments) acc.json += piece.function.arguments;
      partial.set(index, acc);
    }

    // finish_reason 此前同样被忽略；"tool_calls" 就是「在等工具结果」
    if (choice.finish_reason) {
      stopReason = choice.finish_reason;
    }
  }

  const toolCalls: ToolCall[] = [...partial.values()]
    .filter((c) => c.name)
    .map((c) => ({ id: c.id, name: c.name, arguments: c.json }));

  return { text, toolCalls, stopReason };
}
