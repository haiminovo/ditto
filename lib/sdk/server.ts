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

function getProviderType(providerKey: string, providerConfig: ProviderConfig): string {
  if (providerConfig.type) return providerConfig.type;
  const predefined = (PROVIDERS as any)[providerKey];
  if (predefined?.type) return predefined.type;
  return providerKey;
}

function getBaseURL(providerKey: string, providerConfig: ProviderConfig): string {
  if (providerConfig.baseURL) return providerConfig.baseURL;
  const predefined = (PROVIDERS as any)[providerKey];
  if (predefined?.baseURL) return predefined.baseURL;

  const providerType = getProviderType(providerKey, providerConfig);
  switch (providerType) {
    case "anthropic":
      return "https://api.anthropic.com";
    case "openai":
      return "https://api.openai.com/v1";
    case "openrouter":
      return "https://openrouter.ai/api/v1";
    case "deepseek":
      return "https://api.deepseek.com/v1";
    case "qwen":
      return "https://dashscope.aliyuncs.com/compatible-mode/v1";
    case "ollama":
      return "http://localhost:11434/v1";
    default:
      return "https://api.openai.com/v1";
  }
}

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
