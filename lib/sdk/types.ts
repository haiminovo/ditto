/**
 * Ditto SDK - Core Types
 */

import type {
  HarnessMessage,
  HarnessMessageContentPart,
  HarnessToolCall,
} from "../harness/types";

/**
 * 预定义的提供商配置。
 *
 * **刻意不含 `models` 数组。** 模型列表改为向 provider 的 /v1/models 拉取：
 * 硬编码的种子既会过期（这里曾长期停留在 Claude 3.x / GPT-4o 世代），
 * 又对本地与私有网关完全失准 —— 而那恰恰是最需要配置的场景。
 *
 * 留一份陈旧数组只会让选择卡上的「N 个可用模型」说谎，并让「离线兜底」
 * 看起来成立其实不成立。真正的兜底是用户已保存的
 * `config.providers[k].models`（在 config 里，不在预设里）。
 */
export const PROVIDERS = {
  anthropic: {
    name: "Anthropic",
    type: "anthropic" as const,
    baseURL: "https://api.anthropic.com",
  },
  openai: {
    name: "OpenAI",
    type: "openai" as const,
    baseURL: "https://api.openai.com/v1",
  },
  deepseek: {
    name: "DeepSeek",
    type: "deepseek" as const,
    baseURL: "https://api.deepseek.com/v1",
  },
  custom: {
    name: "自定义 Provider",
    type: "openai" as const,
    baseURL: "",
  },
} as const;

/** 曾经存在、现已并入「自定义 Provider」的预设 */
export const REMOVED_PROVIDERS: Record<string, { name: string; baseURL: string }> = {
  openrouter: { name: "OpenRouter", baseURL: "https://openrouter.ai/api/v1" },
  qwen: { name: "Qwen（通义千问）", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  ollama: { name: "Ollama（本地）", baseURL: "http://localhost:11434/v1" },
};

/** 配置结构版本。缺失视为 0，读盘后由 migrateConfig 升到当前值。 */
export const CONFIG_VERSION = 2;

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
  /** 结构版本。缺失视为 0 —— 早期配置没有这个字段。 */
  version?: number;
}

export type MessageContentPart = HarnessMessageContentPart;

/**
 * 一次工具调用。
 *
 * `arguments` 保持**原始 JSON 字符串**，不做解析：
 *   - 两个 provider 线上就是这个形状（OpenAI 的 function.arguments、
 *     Anthropic 的 input_json_delta 拼出来的串）；
 *   - 解析失败必须能被看见并当作错误回给模型，而不是在这里抛掉。
 */
export type ToolCall = HarnessToolCall;

/**
 * 归一化的消息形状。
 *
 * assistant 带 `toolCalls`、以及 `role: "tool"` 这两条，是工具调用能成立的前提：
 * 模型必须在下一轮看得到「我上一轮调用了什么、拿到了什么」。
 * 各 provider 的差异（Anthropic 的 tool_use/tool_result block、OpenAI 的
 * tool_calls/tool 角色）在 server.ts 的转换函数里各自展开。
 */
export type Message = HarnessMessage;

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
  /**
   * 是否给模型挂当前 harness profile 的工具。
   *
   * 搭在 LLMOptions 上是因为这是从界面一路传到 /api/chat 的最短通路 ——
   * BrowserModel 本来就是原样转发 options 的。
   * ⚠️ 它**不是** provider 参数：BrowserModel 会把它提到请求体顶层
   * （ChatRequest.enableTools），而不是塞进 options 里转给模型 API。
   */
  enableTools?: boolean;
  /**
   * 当前聊天使用的工作区 id。
   *
   * 与 enableTools 一样，这不是 Provider 参数；BrowserModel 会把它提到
   * ChatRequest 顶层，服务端再通过注册表解析真实路径。
   */
  workspaceId?: string;
}

/**
 * 流式回调产出的结构化片段。
 *
 * 从 `AsyncIterable<string>` 升上来的原因很直接：文本之外还有工具调用要传，
 * 而一个 string 装不下「这是一次工具调用」这件事。
 */
export type StreamChunk =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; argsJson: string }
  | { type: "tool_result"; id: string; result: string; isError: boolean };

export interface ChatModel {
  generate(messages: Message[], options?: LLMOptions): Promise<LLMResponse>;
  generateStream(messages: Message[], options?: LLMOptions): AsyncIterable<StreamChunk>;
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
 * 把旧配置升到当前结构版本。幂等。
 *
 * 唯一的实质工作：`openrouter` / `qwen` / `ollama` 三个预设已删除，
 * 但 localStorage 里可能还留着指向它们的条目。**保留原键名**，
 * 所以 `config.provider` 与 `modelName` 无需重写，用户零感知。
 *
 * ⚠️ 必须补上 `baseURL` 与 `type`。缺了 baseURL 的条目会命中
 * `resolveBaseURL` 的默认分支，最终落到 https://api.openai.com/v1 ——
 * 拿 OpenRouter 的 key 去打 OpenAI，静默错路由，最难排查的那种坏法。
 *
 * 只填空、绝不覆盖非空字段：否则每次重载都会重跑一遍，把用户后来改的名字冲掉。
 */
export function migrateConfig(cfg: Config): Config {
  if ((cfg.version ?? 0) >= CONFIG_VERSION) return cfg;

  const providers: Record<string, ProviderConfig> = {};

  for (const [key, pc] of Object.entries(cfg.providers ?? {})) {
    const removed = REMOVED_PROVIDERS[key];
    if (!removed) {
      providers[key] = pc;
      continue;
    }

    // type 是内部判别字段，不是用户填的东西，所以不能沿用「只填空」的规则：
    // 旧配置里它的值就是被删掉的键名（"openrouter"），留着就是个已不存在的取值。
    // 这三个都是 OpenAI 兼容接口，归一为 "openai"。
    // 但如果用户显式把它改成了别的有效类型（比如 anthropic），那要保留。
    const type = pc.type && !(pc.type in REMOVED_PROVIDERS) ? pc.type : "openai";

    providers[key] = {
      ...pc,
      baseURL: pc.baseURL || removed.baseURL,
      type,
      // 名字是给用户看的，顺便说明它去哪了
      name: pc.name || `${removed.name}（已并入自定义 Provider）`,
    };
  }

  return { ...cfg, providers, version: CONFIG_VERSION };
}

/* ------------------------------------------------------------------ */
/* provider 解析                                                       */
/* ------------------------------------------------------------------ */

/**
 * ★ 解析逻辑只此一份。
 *
 * 这三件事（type / baseURL / 名称）原本在 types.ts、llm.ts、server.ts 里
 * 各抄了一遍。抄三份的代价不是代码重复，是**行为可能不一致**：
 * 如果列模型时解析出的 baseURL 与聊天时不同，就会出现
 * 「按 A 协议列模型、按 B 协议聊天」—— 必然 404，而且极难定位。
 *
 * 所以 llm.ts 与 server.ts 必须调用这里的函数，不许再写自己的 switch。
 */

/** provider 配置的最小形状 —— 只依赖这两个字段，便于各处复用 */
export interface ProviderResolutionInput {
  type?: string;
  baseURL?: string;
}

function predefinedFor(providerKey: string): { type?: string; baseURL?: string; name?: string } | undefined {
  return (PROVIDERS as Record<string, { type?: string; baseURL?: string; name?: string }>)[providerKey];
}

/**
 * 解析出应当使用哪套协议。
 *
 * 默认值统一为 "openai"（server.ts 曾用 providerKey 作默认，但两者最终都落到
 * api.openai.com/v1，行为一致）。
 */
export function resolveProviderType(
  providerKey: string,
  providerConfig?: ProviderResolutionInput
): string {
  return providerConfig?.type || predefinedFor(providerKey)?.type || "openai";
}

/**
 * 解析出接口地址。**注意：拿不到时它会按 type 猜一个默认值。**
 *
 * 对聊天这是想要的行为；但对「列模型」不是 —— 猜出来的地址会让
 * 一个忘了填地址的自定义 provider 拿第三方 key 去打 OpenAI。
 * 所以列模型那条路必须先判断地址是不是**明写的**，不能直接用这个函数的结果。
 */
export function resolveBaseURL(
  providerKey: string,
  providerConfig?: ProviderResolutionInput
): string {
  if (providerConfig?.baseURL) return providerConfig.baseURL;

  const predefined = predefinedFor(providerKey);
  if (predefined?.baseURL) return predefined.baseURL;

  switch (resolveProviderType(providerKey, providerConfig)) {
    case "anthropic":
      return "https://api.anthropic.com";
    case "deepseek":
      return "https://api.deepseek.com/v1";
    case "openai":
    default:
      return "https://api.openai.com/v1";
  }
}

/**
 * 是否只接受**明写**的地址（用户填的或预设带的），不接受按 type 猜出来的。
 * 供列模型使用。
 */
export function explicitBaseURL(
  providerKey: string,
  providerConfig?: ProviderResolutionInput
): string {
  return (providerConfig?.baseURL || predefinedFor(providerKey)?.baseURL || "").trim();
}

/**
 * 获取 provider 的显示名称
 */
export function getProviderName(providerKey: string, config: Config): string {
  const providerConfig = config.providers[providerKey];
  if (providerConfig?.name) {
    return providerConfig.name;
  }

  const predefined = predefinedFor(providerKey);
  if (predefined?.name) {
    return predefined.name;
  }

  return providerKey;
}

/**
 * 获取 provider 的类型
 */
export function getProviderType(providerKey: string, config: Config): string {
  return resolveProviderType(providerKey, config.providers[providerKey]);
}

/**
 * 获取 provider 的默认 Base URL
 */
export function getProviderBaseURL(providerKey: string, config: Config): string {
  return resolveBaseURL(providerKey, config.providers[providerKey]);
}
