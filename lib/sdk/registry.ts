/**
 * Ditto SDK - Model Registry
 */

import { Message, ModelEntry } from "./types";

const models: ModelEntry[] = [
  {
    provider: "anthropic",
    id: "claude-3-7-sonnet-latest",
    name: "Claude 3.7 Sonnet",
    contextWindow: 200000,
    maxTokens: 8192,
    inputCostPer1M: 3.0,
    outputCostPer1M: 15.0,
  },
  {
    provider: "anthropic",
    id: "claude-3-5-sonnet-latest",
    name: "Claude 3.5 Sonnet",
    contextWindow: 200000,
    maxTokens: 8192,
    inputCostPer1M: 3.0,
    outputCostPer1M: 15.0,
  },
  {
    provider: "anthropic",
    id: "claude-3-opus-latest",
    name: "Claude 3 Opus",
    contextWindow: 200000,
    maxTokens: 8192,
    inputCostPer1M: 15.0,
    outputCostPer1M: 75.0,
  },
  {
    provider: "anthropic",
    id: "claude-3-haiku-20240307",
    name: "Claude 3 Haiku",
    contextWindow: 200000,
    maxTokens: 4096,
    inputCostPer1M: 0.25,
    outputCostPer1M: 1.25,
  },
  {
    provider: "openai",
    id: "gpt-4o",
    name: "GPT-4o",
    contextWindow: 128000,
    maxTokens: 4096,
    inputCostPer1M: 5.0,
    outputCostPer1M: 15.0,
  },
  {
    provider: "openai",
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    contextWindow: 128000,
    maxTokens: 16384,
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.6,
  },
  {
    provider: "deepseek",
    id: "deepseek-chat",
    name: "DeepSeek Chat",
    contextWindow: 128000,
    maxTokens: 8192,
    inputCostPer1M: 0.14,
    outputCostPer1M: 0.28,
  },
];

/**
 * 估算 token 数量（简单版：按字符数估算）
 * 英文约 4 字符 = 1 token，中文约 2 字符 = 1 token
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  let chineseChars = 0;
  let otherChars = 0;

  for (const char of text) {
    if (char.match(/[一-鿿]/)) {
      chineseChars++;
    } else {
      otherChars++;
    }
  }

  return Math.max(0, Math.ceil(chineseChars / 2 + otherChars / 4));
}

/**
 * 估算一组消息的 token 数量
 */
export function estimateMessagesTokens(messages: Message[]): number {
  if (!messages || messages.length === 0) return 0;

  let total = 0;
  for (const msg of messages) {
    if (msg && msg.content) {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "text") {
            total += estimateTokens(part.text);
          } else if (part.type === "image_url") {
            total += 768; // 估算图片占用的 tokens
          }
        }
      } else {
        total += estimateTokens(msg.content);
      }
    }

    // assistant 的 tool_calls 也会原样发给模型（工具名 + 参数 JSON），
    // 漏算它就会在工具用得多的时候低估输入量
    if (msg?.role === "assistant" && msg.toolCalls?.length) {
      for (const call of msg.toolCalls) {
        total += estimateTokens(call.name) + estimateTokens(call.arguments);
        total += 8; // id 与结构开销
      }
    }

    total += 4; // role 的开销
  }
  return Math.max(0, total);
}

/**
 * 截断消息历史以适应上下文窗口
 * 保留最新消息，优先丢弃最早消息
 * 保留 system message
 */
export function trimMessagesToContextWindow(
  messages: Message[],
  model: ModelEntry,
  reserveForOutput: number = 1024,
  /** 工具定义占掉的输入量；由调用方算出实际值传进来，不在这里猜 */
  reserveForTools: number = 0
): Message[] {
  const maxInputTokens = model.contextWindow - reserveForOutput - reserveForTools;

  // 先估算当前 tokens
  let estimatedTokens = estimateMessagesTokens(messages);
  if (estimatedTokens <= maxInputTokens) {
    return [...messages];
  }

  // 分离 system message 和其他消息
  const systemMessages = messages.filter((m) => m.role === "system");
  const conversationMessages = messages.filter((m) => m.role !== "system");

  // 如果没有对话消息，直接返回
  if (conversationMessages.length === 0) {
    return [...systemMessages];
  }

  // 从最近消息开始保留，直到接近限制
  let result: Message[] = [...systemMessages];
  let currentTokens = estimateMessagesTokens(result);

  // 从最新的开始添加
  for (let i = conversationMessages.length - 1; i >= 0; i--) {
    const msg = conversationMessages[i];
    const msgTokens = estimateMessagesTokens([msg]);

    if (currentTokens + msgTokens <= maxInputTokens) {
      result.splice(systemMessages.length, 0, msg); // 插入到 system 之后
      currentTokens += msgTokens;
    } else {
      break;
    }
  }

  return repairToolPairing(result, systemMessages.length);
}

/**
 * 丢掉裁剪切面留下的**孤立工具消息**。
 *
 * 倒着往前收消息时，工具结果（role:"tool"）比它对应的 assistant 更新，
 * 所以会先被收进来。预算正好卡在两者之间时，留下的一对只剩后半截：
 *
 *   [{role:"assistant", content:"…"}          ← 被丢掉了
 *    {role:"tool", toolCallId:"call_1", …}]   ← 留下了，但它没有对应的 tool_use
 *
 * provider 会直接 400，而错误信息通常只说「tool_result 没有对应的
 * tool_use」，看不出根因是裁剪。所以在发出去之前在这里补齐。
 *
 * **只需要处理开头**：tool 结果永远紧跟在自己的 assistant 之后，而
 * 我们保留的是一段**后缀** —— 所以「assistant 被留下、它的结果被丢掉」
 * 这种配对是发生不了的（结果更新，只会更早被收进来）。
 * 反过来说，若在这里顺手把「带 toolCalls 的 assistant」也丢掉，
 * 反而会砍掉一对完好的配对，正好造成这里想避免的那个错误。
 */
function repairToolPairing(messages: Message[], systemCount: number): Message[] {
  const tail = messages.slice(systemCount);

  let start = 0;
  while (start < tail.length && tail[start].role === "tool") {
    start += 1;
  }

  if (start === 0) return messages;
  return [...messages.slice(0, systemCount), ...tail.slice(start)];
}

export class ModelRegistry {
  private models: ModelEntry[];

  constructor(initialModels: ModelEntry[] = models) {
    this.models = [...initialModels];
  }

  resolve(pattern: string): ModelEntry | null {
    const trimmed = pattern.trim();
    if (!trimmed) return null;

    const idx = trimmed.indexOf("/");
    if (idx > 0) {
      const prov = trimmed.slice(0, idx);
      const modelId = trimmed.slice(idx + 1);

      const entry = this.lookupModel(prov, modelId);
      if (entry) return entry;

      const fallback = this.lookupModel("", modelId);
      if (fallback) return fallback;
    }

    const exactMatch = this.lookupModel("", trimmed);
    if (exactMatch) return exactMatch;

    const lower = trimmed.toLowerCase();
    const candidates: ModelEntry[] = [];

    for (const m of this.models) {
      if (
        m.id.toLowerCase().includes(lower) ||
        m.name.toLowerCase().includes(lower)
      ) {
        candidates.push(m);
      }
    }

    if (candidates.length === 0) return null;

    let best = candidates[0];
    for (const c of candidates.slice(1)) {
      if (!this.hasDatedSuffix(c.id) && this.hasDatedSuffix(best.id)) {
        best = c;
      }
    }

    return best;
  }

  /**
   * 把从 provider 接口发现的模型元数据并进来。
   *
   * ⚠️ 作用范围要认清：`getDefaultRegistry()` 是**模块级单例**，
   * 浏览器 bundle 里的实例与 API route 里的实例是两个不同的对象。
   * 所以这里注册的条目只修得好**浏览器端**的上下文计量条；
   * 服务端做消息裁剪时用的仍是静态表。
   *
   * 本期只做展示，不把元数据持久化 —— 要让服务端也用上，
   * 得改 ChatRequest 的契约把元数据带过去，那是另一个改动。
   *
   * 目前只有 Anthropic 的 /v1/models 会给 max_input_tokens / max_tokens；
   * OpenAI 兼容接口只给 id，那些模型在表里查不到，计量条会显示「窗口未知」。
   */
  register(providerKey: string, entries: Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }>): number {
    let added = 0;

    for (const e of entries) {
      // 表里已经有的不动 —— 静态表是人工校准过的，优先于接口的粗粒度值
      if (this.lookupModel("", e.id)) continue;
      if (e.contextWindow === undefined && e.maxTokens === undefined) continue;

      this.models.push({
        provider: providerKey,
        id: e.id,
        name: e.name || e.id,
        contextWindow: e.contextWindow ?? 128000,
        maxTokens: e.maxTokens ?? 4096,
        // 定价无处可得 —— 没有任何接口暴露它。留 0 表示未知。
        inputCostPer1M: 0,
        outputCostPer1M: 0,
      });
      added += 1;
    }

    return added;
  }

  list(filter?: string): ModelEntry[] {
    if (!filter) return [...this.models];

    const lower = filter.toLowerCase();
    return this.models.filter(
      (m) =>
        m.provider.toLowerCase().includes(lower) ||
        m.id.toLowerCase().includes(lower) ||
        m.name.toLowerCase().includes(lower)
    );
  }

  private lookupModel(provider: string, id: string): ModelEntry | null {
    for (const m of this.models) {
      if (provider) {
        if (m.provider === provider && m.id === id) return m;
      } else {
        if (m.id === id) return m;
      }
    }
    return null;
  }

  private hasDatedSuffix(id: string): boolean {
    return /-\d{4}-\d{2}-\d{2}$/.test(id) || /-\d{8}$/.test(id);
  }
}

let defaultRegistry: ModelRegistry | null = null;

export function getDefaultRegistry(): ModelRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new ModelRegistry();
  }
  return defaultRegistry;
}
