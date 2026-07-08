/**
 * Ditto SDK - Core Types
 */

// 预定义的提供商配置
export const PROVIDERS = {
  anthropic: {
    name: "Anthropic",
    type: "anthropic" as const,
    baseURL: "https://api.anthropic.com",
    models: [
      "claude-3-7-sonnet-latest",
      "claude-3-5-sonnet-latest",
      "claude-3-opus-latest",
      "claude-3-haiku-20240307",
    ],
  },
  openai: {
    name: "OpenAI",
    type: "openai" as const,
    baseURL: "https://api.openai.com/v1",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
  },
  openrouter: {
    name: "OpenRouter",
    type: "openrouter" as const,
    baseURL: "https://openrouter.ai/api/v1",
    models: [
      "anthropic/claude-3-7-sonnet",
      "openai/gpt-4o",
      "google/gemini-2-5-pro",
    ],
  },
  deepseek: {
    name: "DeepSeek",
    type: "deepseek" as const,
    baseURL: "https://api.deepseek.com/v1",
    models: ["deepseek-chat"],
  },
  qwen: {
    name: "Qwen (通义千问)",
    type: "qwen" as const,
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-plus", "qwen-turbo", "qwen-max"],
  },
  ollama: {
    name: "Ollama (本地)",
    type: "ollama" as const,
    baseURL: "http://localhost:11434/v1",
    models: ["llama3.2", "mistral", "gemma2"],
  },
  custom: {
    name: "自定义 Provider",
    type: "openai" as const,
    baseURL: "",
    models: [],
  },
} as const;

export type ProviderKey = keyof typeof PROVIDERS;

export interface ProviderConfig {
  type?: string;
  name?: string;
  apiKey?: string;
  baseURL?: string;
  models?: string[];
  extraBody?: Record<string, unknown>;
}

export interface Config {
  provider: string;
  modelName: string;
  providers: Record<string, ProviderConfig>;
  roles: Record<string, unknown>;
}

export type MessageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type Message =
  | { role: "user"; content: string | MessageContentPart[] }
  | { role: "assistant"; content: string }
  | { role: "system"; content: string };

export interface LLMResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

export interface ChatModel {
  generate(messages: Message[], options?: LLMOptions): Promise<LLMResponse>;
  generateStream(messages: Message[], options?: LLMOptions): AsyncIterable<string>;
  providerName(): string;
  modelName(): string;
}

export interface ModelEntry {
  provider: string;
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  inputCostPer1M: number;
  outputCostPer1M: number;
}

/**
 * 创建默认配置
 */
export function createDefaultConfig(): Config {
  return {
    provider: "",
    modelName: "",
    providers: {},
    roles: {},
  };
}

/**
 * 检查配置是否有效
 */
export function isValidConfig(cfg: Config): boolean {
  return !!(
    cfg.provider &&
    cfg.modelName &&
    cfg.providers[cfg.provider]?.apiKey
  );
}

/**
 * 获取 provider 的可用模型列表（优先使用配置中的自定义列表）
 */
export function getProviderModels(providerKey: string, config: Config): string[] {
  const providerConfig = config.providers[providerKey];
  if (providerConfig?.models && providerConfig.models.length > 0) {
    return providerConfig.models;
  }

  const predefined = (PROVIDERS as any)[providerKey];
  if (predefined?.models && predefined.models.length > 0) {
    return predefined.models;
  }

  return [];
}

/**
 * 获取 provider 的显示名称
 */
export function getProviderName(providerKey: string, config: Config): string {
  const providerConfig = config.providers[providerKey];
  if (providerConfig?.name) {
    return providerConfig.name;
  }

  const predefined = (PROVIDERS as any)[providerKey];
  if (predefined?.name) {
    return predefined.name;
  }

  return providerKey;
}

/**
 * 获取 provider 的类型
 */
export function getProviderType(providerKey: string, config: Config): string {
  const providerConfig = config.providers[providerKey];
  if (providerConfig?.type) {
    return providerConfig.type;
  }

  const predefined = (PROVIDERS as any)[providerKey];
  if (predefined?.type) {
    return predefined.type;
  }

  return "openai";
}

/**
 * 获取 provider 的默认 Base URL
 */
export function getProviderBaseURL(providerKey: string, config: Config): string {
  const providerConfig = config.providers[providerKey];
  if (providerConfig?.baseURL) {
    return providerConfig.baseURL;
  }

  const predefined = (PROVIDERS as any)[providerKey];
  if (predefined?.baseURL) {
    return predefined.baseURL;
  }

  return "";
}
