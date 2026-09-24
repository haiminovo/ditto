/**
 * Ditto SDK - LLM Client
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

import {
  ChatModel,
  Config,
  LLMOptions,
  LLMResponse,
  Message,
  ProviderConfig,
  resolveBaseURL,
  resolveProviderType,
} from "./types";
import { getDefaultRegistry } from "./registry";
import {
  parseSSELine,
  StreamState,
  applyEvent,
  createStreamState,
  StreamEvent,
  ToolData,
  ToolResultData,
} from "./protocol";
import type { StreamChunk } from "./types";

/**
 * 把一个流的当前状态里「还没吐出去的部分」吐出来。
 *
 * 文本项边到边吐（流式文本本来就是这层的目的）；工具调用项与结果项
 * **攒齐一次给** —— 参数是 JSON，把半截的 JSON 推给界面只能逼它去容错
 * 一串解析不了的东西，而这里并不需要逐字动画。
 *
 * 调用顺序依赖 `state.items` 是 Map：它保持插入顺序，所以多轮工具循环里
 * 第二轮生成的文本会排在第一次工具调用之后，不会乱序。
 */
function* drainItems(
  state: StreamState,
  emittedText: Map<string, number>,
  emittedItems: Set<string>
): Generator<StreamChunk> {
  for (const [itemId, item] of state.items) {
    if (item.itemType === "text") {
      const seen = emittedText.get(itemId) ?? 0;
      if (item.content.length > seen) {
        emittedText.set(itemId, item.content.length);
        yield { type: "text", text: item.content.slice(seen) };
      }
      continue;
    }

    if (!item.isComplete || emittedItems.has(itemId)) continue;
    emittedItems.add(itemId);

    if (item.itemType === "tool") {
      yield {
        type: "tool_call",
        id: itemId,
        name: (item.data as ToolData).tool_name ?? "unknown",
        argsJson: item.content,
      };
    } else if (item.itemType === "tool_result") {
      const data = item.data as ToolResultData;
      yield {
        type: "tool_result",
        id: data.tool_call_id ?? itemId,
        result: item.content,
        isError: data.is_error === true,
      };
    }
  }
}

/**
 * Browser Model - 通过本地 API Route 调用，避免 CORS 问题
 */
export class BrowserModel implements ChatModel {
  private providerKey: string;
  private model: string;
  private providerConfig: ProviderConfig;

  constructor(
    providerKey: string,
    model: string,
    providerConfig: ProviderConfig
  ) {
    this.providerKey = providerKey;
    this.model = model;
    this.providerConfig = providerConfig;
  }

  providerName(): string {
    return this.providerKey;
  }

  modelName(): string {
    return this.model;
  }

  async generate(messages: Message[], options?: LLMOptions): Promise<LLMResponse> {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: this.providerKey,
        modelName: this.model,
        providerConfig: this.providerConfig,
        messages,
        options: options ? { ...options, workspaceId: undefined } : options,
        workspaceId: options?.workspaceId,
        stream: false,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(error.error || `API error: ${response.status}`);
    }

    const data = await response.json();
    return { content: data.content };
  }

  async *generateStream(
    messages: Message[],
    options?: LLMOptions
  ): AsyncIterable<StreamChunk> {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: this.providerKey,
        modelName: this.model,
        providerConfig: this.providerConfig,
        messages,
        // enableTools 提到顶层：它是 harness 的开关，不是要给模型 API 的参数，
        // 混在 options 里会被 server 当 provider 参数透传出去
        options: options
          ? { ...options, enableTools: undefined, workspaceId: undefined }
          : options,
        enableTools: options?.enableTools,
        workspaceId: options?.workspaceId,
        stream: true,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(error.error || `API error: ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("No response body");
    }

    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let state: StreamState | null = null;
    // 已吐出去的量。曾经这里是用 getFullText 做字符串长度差分 —— 那个写法
    // 只认文本，工具项发过来会被静默丢弃（getFullText 只返回 text item）。
    const emittedText = new Map<string, number>();
    const emittedItems = new Set<string>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const event = parseSSELine(line);
        if (!event) continue;

        if (!state) {
          state = createStreamState(event.stream_id);
        }

        state = applyEvent(state, event);

        if (state.error) {
          throw new Error(`${state.error.code}: ${state.error.message}`);
        }

        yield* drainItems(state, emittedText, emittedItems);

        if (state.isComplete) {
          break;
        }
      }
    }
  }
}

/**
 * 检查是否在浏览器环境中
 */
function isBrowser(): boolean {
  return typeof window !== "undefined";
}

/**
 * 从配置创建模型实例
 */
export function createModelFromConfig(
  providerKey: string,
  modelName: string,
  providerConfig: ProviderConfig
): ChatModel {
  // 浏览器环境使用本地 API Route 代理，避免 CORS 问题
  if (isBrowser()) {
    return new BrowserModel(providerKey, modelName, providerConfig);
  }

  // 解析逻辑统一在 types.ts。这里原有一份 switch，server.ts 与 types.ts 各有一份 ——
  // 三份一旦解析出不同的 baseURL，就会出现「列模型用 A 协议、聊天用 B 协议」。
  const providerType = resolveProviderType(providerKey, providerConfig);

  if (providerType === "anthropic") {
    return new AnthropicModel(
      providerKey,
      modelName,
      providerConfig.baseURL,
      providerConfig.apiKey || "",
      providerConfig.extraBody
    );
  }

  const baseURL = resolveBaseURL(providerKey, providerConfig);

  return new OpenAICompatibleModel(
    providerKey,
    modelName,
    baseURL,
    providerConfig.apiKey || "",
    providerConfig.extraBody
  );
}

/**
 * Anthropic Native API Model
 *
 * ⚠️ 这个类和下面的 OpenAICompatibleModel 在运行的应用里**永远不会被实例化**：
 *    createModelFromConfig 的第一件事就是 `if (isBrowser()) return new BrowserModel(...)`，
 *    而唯一的调用链起点 app/providers.tsx 带着 "use client"。
 *    浏览器侧真正的 provider 调用在 server.ts 的两个 handle*Request 里。
 *
 *    所以这里只做了「让它继续编译」的最小适配（把文本包成 StreamChunk），
 *    **没有**接工具调用 —— 那是给没人跑的路径维护第二份实现。
 *    真要复活它们，请先把 server.ts 与这里的重复逻辑合并（types.ts 里已经
 *    抱怨过三份复制的转换代码），而不是再抄一份。
 */
export class AnthropicModel implements ChatModel {
  private client: Anthropic;
  private provider: string;
  private model: string;
  private extraBody?: Record<string, unknown>;

  constructor(
    provider: string,
    model: string,
    baseURL: string | undefined,
    apiKey: string,
    extraBody?: Record<string, unknown>
  ) {
    this.provider = provider;
    this.model = model;
    this.extraBody = extraBody;

    this.client = new Anthropic({
      baseURL: baseURL || "https://api.anthropic.com",
      apiKey: apiKey || "dummy",
      dangerouslyAllowBrowser: true,
    });
  }

  providerName(): string {
    return this.provider;
  }

  modelName(): string {
    return this.model;
  }

  private convertMessages(messages: Message[]): {
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
            }
          }
        }
        anthropicMessages.push({
          role: msg.role as "user" | "assistant",
          content: content.length > 0 ? content : [],
        });
      } else {
        anthropicMessages.push({
          role: msg.role as "user" | "assistant",
          content: msg.content,
        });
      }
    }

    return { system, anthropicMessages };
  }

  async generate(messages: Message[], options?: LLMOptions): Promise<LLMResponse> {
    const registry = getDefaultRegistry();
    const entry = registry.resolve(this.model);
    const maxTokens = options?.maxTokens ?? entry?.maxTokens ?? 8192;

    const { system, anthropicMessages } = this.convertMessages(messages);

    const response = await this.client.messages.create({
      model: this.model,
      messages: anthropicMessages,
      system: system,
      temperature: options?.temperature ?? 0.7,
      max_tokens: maxTokens,
      top_p: options?.topP,
      ...this.extraBody,
    });

    let content = "";
    for (const block of response.content) {
      if (block.type === "text") {
        content += block.text;
      }
    }

    return {
      content,
      usage: response.usage
        ? {
            promptTokens: response.usage.input_tokens,
            completionTokens: response.usage.output_tokens,
            totalTokens: response.usage.input_tokens + response.usage.output_tokens,
          }
        : undefined,
    };
  }

  async *generateStream(
    messages: Message[],
    options?: LLMOptions
  ): AsyncIterable<StreamChunk> {
    const registry = getDefaultRegistry();
    const entry = registry.resolve(this.model);
    const maxTokens = options?.maxTokens ?? entry?.maxTokens ?? 8192;

    const { system, anthropicMessages } = this.convertMessages(messages);

    const stream = await this.client.messages.create({
      model: this.model,
      messages: anthropicMessages,
      system: system,
      temperature: options?.temperature ?? 0.7,
      max_tokens: maxTokens,
      top_p: options?.topP,
      stream: true,
      ...this.extraBody,
    });

    for await (const chunk of stream) {
      if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
        // 只转文本，工具调用 block 被忽略 —— 见类文档：这是死代码，
        // 不在这里维护第二份工具实现
        yield { type: "text", text: chunk.delta.text };
      }
    }
  }
}

/**
 * OpenAI Compatible API Model
 */
export class OpenAICompatibleModel implements ChatModel {
  private client: OpenAI;
  private provider: string;
  private model: string;
  private extraBody?: Record<string, unknown>;

  constructor(
    provider: string,
    model: string,
    baseURL: string,
    apiKey: string,
    extraBody?: Record<string, unknown>
  ) {
    this.provider = provider;
    this.model = model;
    this.extraBody = extraBody;

    this.client = new OpenAI({
      baseURL,
      apiKey: apiKey || "dummy",
      dangerouslyAllowBrowser: true,
    });
  }

  providerName(): string {
    return this.provider;
  }

  modelName(): string {
    return this.model;
  }

  async generate(messages: Message[], options?: LLMOptions): Promise<LLMResponse> {
    const registry = getDefaultRegistry();
    const entry = registry.resolve(this.model);
    const maxTokens = options?.maxTokens ?? entry?.maxTokens ?? 2048;

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: messages as any[],
      temperature: options?.temperature ?? 0.7,
      max_tokens: maxTokens,
      top_p: options?.topP,
      ...this.extraBody,
    });

    const content = response.choices[0]?.message?.content || "";

    return {
      content,
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : undefined,
    };
  }

  async *generateStream(
    messages: Message[],
    options?: LLMOptions
  ): AsyncIterable<StreamChunk> {
    const registry = getDefaultRegistry();
    const entry = registry.resolve(this.model);
    const maxTokens = options?.maxTokens ?? entry?.maxTokens ?? 2048;

    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: messages as any[],
      temperature: options?.temperature ?? 0.7,
      max_tokens: maxTokens,
      top_p: options?.topP,
      stream: true,
      ...this.extraBody,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        // 同 AnthropicModel：死代码，只转文本
        yield { type: "text", text: content };
      }
    }
  }
}

/**
 * Swappable Model Wrapper
 */
export class SwappableModel implements ChatModel {
  private current: ChatModel;
  private provider: string;
  private model: string;

  constructor(provider: string, model: string, inner: ChatModel) {
    this.current = inner;
    this.provider = provider;
    this.model = model;
  }

  swap(provider: string, model: string, inner: ChatModel): void {
    this.current = inner;
    this.provider = provider;
    this.model = model;
  }

  currentModel(): { provider: string; model: string } {
    return { provider: this.provider, model: this.model };
  }

  generate(messages: Message[], options?: LLMOptions): Promise<LLMResponse> {
    return this.current.generate(messages, options);
  }

  generateStream(
    messages: Message[],
    options?: LLMOptions
  ): AsyncIterable<StreamChunk> {
    return this.current.generateStream(messages, options);
  }

  providerName(): string {
    return this.provider;
  }

  modelName(): string {
    return this.model;
  }
}

/**
 * Model Set
 */
export class ModelSet {
  default: SwappableModel;
  private models: Map<string, SwappableModel>;
  private config: Config;

  constructor(config: Config, defaultModel: SwappableModel) {
    this.config = config;
    this.default = defaultModel;
    this.models = new Map();
  }

  forRole(role: string): ChatModel {
    return this.models.get(role) || this.default;
  }

  static fromConfig(config: Config): ModelSet {
    const defaultPC = config.providers[config.provider] || {};
    const defaultModel = createModelFromConfig(
      config.provider,
      config.modelName,
      defaultPC
    );

    return new ModelSet(
      config,
      new SwappableModel(config.provider, config.modelName, defaultModel)
    );
  }
}
