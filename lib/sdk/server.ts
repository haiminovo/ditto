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
} from "./types";
import { getDefaultRegistry, trimMessagesToContextWindow } from "./registry";
import {
  createItemStart,
  createTextDelta,
  createItemEnd,
  createStreamEnd,
  createStreamError,
  toSSE,
} from "./protocol";

export interface ChatRequest {
  provider: string;
  modelName: string;
  providerConfig: ProviderConfig;
  messages: Message[];
  options?: LLMOptions;
  stream: boolean;
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

export async function handleChatRequest(request: ChatRequest): Promise<Response> {
  const { provider, modelName, providerConfig, messages, options, stream } = request;
  const providerType = getProviderType(provider, providerConfig);
  const baseURL = getBaseURL(provider, providerConfig);
  const apiKey = providerConfig.apiKey || "";

  if (!apiKey) {
    return new Response(JSON.stringify({ error: "No API key provided" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 获取模型信息并截断消息以适应上下文窗口
  const registry = getDefaultRegistry();
  const modelEntry = registry.resolve(modelName);

  let processedMessages = messages;
  if (modelEntry) {
    processedMessages = trimMessagesToContextWindow(messages, modelEntry, modelEntry.maxTokens);
    if (processedMessages.length !== messages.length) {
      console.log(`Trimmed messages from ${messages.length} to ${processedMessages.length} to fit context window`);
    }
  }

  if (providerType === "anthropic" || providerType === "claude") {
    return handleAnthropicRequest(modelName, baseURL, apiKey, processedMessages, options, stream);
  } else {
    return handleOpenAICompatibleRequest(modelName, baseURL, apiKey, processedMessages, options, stream);
  }
}

function convertMessagesForAnthropic(messages: Message[]): {
  system: string | undefined;
  anthropicMessages: Anthropic.MessageParam[];
} {
  let system: string | undefined;
  const anthropicMessages: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      system = system ? system + "\n" + msg.content : msg.content;
    } else if (Array.isArray(msg.content)) {
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
        role: msg.role as "user" | "assistant",
        content: content.length > 0 ? content : [],
      });
    } else {
      // 纯文本消息
      anthropicMessages.push({
        role: msg.role as "user" | "assistant",
        content: msg.content,
      });
    }
  }

  return { system, anthropicMessages };
}

async function handleAnthropicRequest(
  modelName: string,
  baseURL: string,
  apiKey: string,
  messages: Message[],
  options: LLMOptions = {},
  stream: boolean
): Promise<Response> {
  const client = new Anthropic({
    baseURL: baseURL || "https://api.anthropic.com",
    apiKey: apiKey,
  });

  const { system, anthropicMessages } = convertMessagesForAnthropic(messages);
  const maxTokens = options.maxTokens ?? 8192;

  if (!stream) {
    const response = await client.messages.create({
      model: modelName,
      messages: anthropicMessages,
      system: system,
      temperature: options.temperature ?? 0.7,
      max_tokens: maxTokens,
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

  const streamResponse = await client.messages.create({
    model: modelName,
    messages: anthropicMessages,
    system: system,
    temperature: options.temperature ?? 0.7,
    max_tokens: maxTokens,
    top_p: options.topP,
    stream: true,
  });

  const streamId = `stream_${Date.now()}`;
  const itemId = `text_${Date.now()}`;
  const encoder = new TextEncoder();

  const readable = new ReadableStream({
    async start(controller) {
      let buffer = "";
      let flushTimeout: NodeJS.Timeout | null = null;
      let isFlushing = false;
      let hasStarted = false;

      const flush = async () => {
        if (buffer && !isFlushing) {
          isFlushing = true;
          if (!hasStarted) {
            controller.enqueue(encoder.encode(toSSE(createItemStart(streamId, itemId, "text"))));
            hasStarted = true;
          }
          controller.enqueue(encoder.encode(toSSE(createTextDelta(streamId, itemId, buffer))));
          buffer = "";
          isFlushing = false;
        }
      };

      try {
        for await (const chunk of streamResponse) {
          if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
            buffer += chunk.delta.text;

            if (buffer.length >= 50) {
              await flush();
              if (flushTimeout) {
                clearTimeout(flushTimeout);
                flushTimeout = null;
              }
            } else if (!flushTimeout) {
              flushTimeout = setTimeout(() => {
                flush();
                flushTimeout = null;
              }, 50);
            }
          }
        }
      } catch (error) {
        // 发送错误事件
        const err = error as Error;
        controller.enqueue(encoder.encode(toSSE(createStreamError(
          streamId,
          "MODEL_ERROR",
          err.message || "Unknown error"
        ))));
      } finally {
        if (flushTimeout) {
          clearTimeout(flushTimeout);
        }
        await flush();

        if (hasStarted) {
          controller.enqueue(encoder.encode(toSSE(createItemEnd(streamId, itemId))));
        }
        controller.enqueue(encoder.encode(toSSE(createStreamEnd(streamId))));
        controller.close();
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

async function handleOpenAICompatibleRequest(
  modelName: string,
  baseURL: string,
  apiKey: string,
  messages: Message[],
  options: LLMOptions = {},
  stream: boolean
): Promise<Response> {
  const client = new OpenAI({
    baseURL,
    apiKey: apiKey,
  });

  const maxTokens = options.maxTokens ?? 2048;

  if (!stream) {
    const response = await client.chat.completions.create({
      model: modelName,
      messages: messages as any[],
      temperature: options.temperature ?? 0.7,
      max_tokens: maxTokens,
      top_p: options.topP,
    });

    const content = response.choices[0]?.message?.content || "";
    return new Response(JSON.stringify({ content }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const streamResponse = await client.chat.completions.create({
    model: modelName,
    messages: messages as any[],
    temperature: options.temperature ?? 0.7,
    max_tokens: maxTokens,
    top_p: options.topP,
    stream: true,
  });

  const streamId = `stream_${Date.now()}`;
  const itemId = `text_${Date.now()}`;
  const encoder = new TextEncoder();

  const readable = new ReadableStream({
    async start(controller) {
      let buffer = "";
      let flushTimeout: NodeJS.Timeout | null = null;
      let isFlushing = false;
      let hasStarted = false;

      const flush = async () => {
        if (buffer && !isFlushing) {
          isFlushing = true;
          if (!hasStarted) {
            controller.enqueue(encoder.encode(toSSE(createItemStart(streamId, itemId, "text"))));
            hasStarted = true;
          }
          controller.enqueue(encoder.encode(toSSE(createTextDelta(streamId, itemId, buffer))));
          buffer = "";
          isFlushing = false;
        }
      };

      try {
        for await (const chunk of streamResponse) {
          const content = chunk.choices[0]?.delta?.content;
          if (content) {
            buffer += content;

            if (buffer.length >= 50) {
              await flush();
              if (flushTimeout) {
                clearTimeout(flushTimeout);
                flushTimeout = null;
              }
            } else if (!flushTimeout) {
              flushTimeout = setTimeout(() => {
                flush();
                flushTimeout = null;
              }, 50);
            }
          }
        }
      } catch (error) {
        const err = error as Error;
        controller.enqueue(encoder.encode(toSSE(createStreamError(
          streamId,
          "MODEL_ERROR",
          err.message || "Unknown error"
        ))));
      } finally {
        if (flushTimeout) {
          clearTimeout(flushTimeout);
        }
        await flush();

        if (hasStarted) {
          controller.enqueue(encoder.encode(toSSE(createItemEnd(streamId, itemId))));
        }
        controller.enqueue(encoder.encode(toSSE(createStreamEnd(streamId))));
        controller.close();
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
