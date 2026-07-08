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
  PROVIDERS,
} from "./types";
import { getDefaultRegistry } from "./registry";
import {
  parseSSELine,
  StreamState,
  applyEvent,
  getFullText,
  createStreamState,
  StreamEvent,
} from "./protocol";

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
        options,
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

  async *generateStream(messages: Message[], options?: LLMOptions): AsyncIterable<string> {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: this.providerKey,
        modelName: this.model,
        providerConfig: this.providerConfig,
        messages,
        options,
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
    let lastText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const event = parseSSELine(line);
        if (!event) continue;

        // 初始化状态
        if (!state) {
          state = createStreamState(event.stream_id);
        }

        // 应用事件
        const newState = applyEvent(state, event);
        state = newState;

        // 检查错误
        if (state.error) {
          throw new Error(`${state.error.code}: ${state.error.message}`);
        }

        // 检查文本变化
        const currentText = getFullText(state);
        if (currentText.length > lastText.length) {
          const delta = currentText.slice(lastText.length);
          lastText = currentText;
          yield delta;
        }

        // 流结束
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

  // 优先使用配置中的 type，如果没有则用 providerKey 匹配预定义 provider，最后默认为 openai
  let providerType = providerConfig.type;
  if (!providerType) {
    const predefined = (PROVIDERS as any)[providerKey];
    if (predefined?.type) {
      providerType = predefined.type;
    } else {
      providerType = providerKey;
    }
  }

  if (providerType === "anthropic") {
    return new AnthropicModel(
      providerKey,
      modelName,
      providerConfig.baseURL,
      providerConfig.apiKey || "",
      providerConfig.extraBody
    );
  }

  let baseURL = providerConfig.baseURL;
  if (!baseURL) {
    switch (providerType) {
      case "openai":
        baseURL = "https://api.openai.com/v1";
        break;
      case "openrouter":
        baseURL = "https://openrouter.ai/api/v1";
        break;
      case "deepseek":
        baseURL = "https://api.deepseek.com/v1";
        break;
      case "qwen":
        baseURL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
        break;
      case "ollama":
        baseURL = "http://localhost:11434/v1";
        break;
      default:
        baseURL = "https://api.openai.com/v1";
    }
  }

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

  async *generateStream(messages: Message[], options?: LLMOptions): AsyncIterable<string> {
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
        yield chunk.delta.text;
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

  async *generateStream(messages: Message[], options?: LLMOptions): AsyncIterable<string> {
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
        yield content;
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

  generateStream(messages: Message[], options?: LLMOptions): AsyncIterable<string> {
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
