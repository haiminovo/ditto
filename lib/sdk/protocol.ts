/**
 * Ditto Streaming Protocol - 工业级 SSE 协议
 *
 * 基于 Sequence + Item Lifecycle + Append-only Delta
 */

// ============================================================================
// 核心类型定义
// ============================================================================

export type EventType =
  | "ITEM_START"
  | "ITEM_DELTA"
  | "ITEM_END"
  | "STREAM_END"
  | "STREAM_ERROR"
  | "PING"
  | "PONG";

export type ItemType =
  | "text"
  | "tool"
  | "tool_result"
  | "image"
  | "audio"
  | "code"
  | "citation"
  | "reasoning"
  | "control";

export interface StreamEvent {
  stream_id: string;
  sequence: number;
  event: EventType;
  item?: Item;
  error?: StreamError;
}

export interface Item {
  item_id: string;
  item_type: ItemType;
  data?: ItemData;
}

export type ItemData =
  | TextData
  | ToolData
  | ToolResultData
  | ImageData
  | AudioData
  | CodeData
  | CitationData
  | ReasoningData
  | ControlData;

// ============================================================================
// 各类型的 Data 定义
// ============================================================================

export interface TextData {
  append?: string;
}

/**
 * 工具调用项。
 *
 * 关联 id 用的是 **item 自己的 item_id**，不在 data 里另存一份 ——
 * 一条调用就是一个 item，item_id 就是模型看到的 tool_call id。
 */
export interface ToolData {
  tool_name?: string;
  arguments?: Record<string, unknown>;
  append_arguments?: string;
}

/**
 * 工具结果项。
 *
 * 与调用项分开成两个 item 类型，而不是挂在同一个 item 上：
 * ITEM_END 之后不该再收 DELTA，把结果塞进已结束的 item 会破坏生命周期。
 * 结果正文走 `append`（复用 TextData 的形状），错误标志在 ITEM_START 的 data 里。
 */
export interface ToolResultData {
  /** 指回发起这次调用的 item_id */
  tool_call_id?: string;
  is_error?: boolean;
}

export interface ImageData {
  url?: string;
  base64?: string;
  mime_type?: string;
}

export interface AudioData {
  url?: string;
  base64?: string;
  mime_type?: string;
}

export interface CodeData {
  language?: string;
  append?: string;
}

export interface CitationData {
  index?: number;
  title?: string;
  url?: string;
}

export interface ReasoningData {
  append?: string;
}

export interface ControlData {
  action?: "pause" | "resume" | "stop";
}

export interface StreamError {
  code: "TIMEOUT" | "MODEL_ERROR" | "CANCELLED" | "UNKNOWN";
  message: string;
}

// ============================================================================
// Session 初始化
// ============================================================================

export interface StreamInit {
  stream_id: string;
  timeout?: {
    first_token?: number;
    stream_idle?: number;
  };
}

// ============================================================================
// 重连请求
// ============================================================================

export interface StreamResume {
  stream_id: string;
  last_sequence: number;
}

// ============================================================================
// 事件构造器
// ============================================================================

let globalSequence = 0;

export function nextSequence(): number {
  return ++globalSequence;
}

export function createItemStart(
  streamId: string,
  itemId: string,
  itemType: ItemType
): StreamEvent {
  return {
    stream_id: streamId,
    sequence: nextSequence(),
    event: "ITEM_START",
    item: {
      item_id: itemId,
      item_type: itemType,
    },
  };
}

export function createTextDelta(
  streamId: string,
  itemId: string,
  content: string
): StreamEvent {
  return {
    stream_id: streamId,
    sequence: nextSequence(),
    event: "ITEM_DELTA",
    item: {
      item_id: itemId,
      item_type: "text",
      data: {
        append: content,
      },
    },
  };
}

/**
 * item 结束。
 *
 * itemType 是**必填**的：曾经它硬编码成 "text"，理由是「实际可忽略」——
 * 一旦一个流里出现多种 item（工具调用就是这么来的），
 * 那就从「可忽略」变成了「客户端无从判断结束的是什么」。
 * data 用于携带收尾信息（如工具结果的 is_error）。
 */
export function createItemEnd(
  streamId: string,
  itemId: string,
  itemType: ItemType,
  data?: ItemData
): StreamEvent {
  return {
    stream_id: streamId,
    sequence: nextSequence(),
    event: "ITEM_END",
    item: {
      item_id: itemId,
      item_type: itemType,
      ...(data ? { data } : {}),
    },
  };
}

// ---- 工具调用：ITEM_START 带工具名，参数一次性给全 --------------------------
//
// 参数不做逐字流式：两个 provider 确实是增量吐 arguments 的，但服务端要
// 攒齐了才能执行，而 UI 那边没有逐字动画的需求（见方案「不做」一节）。
// 与其发一串半截 JSON 让客户端去容错，不如攒齐了一次发。

export function createToolCallStart(
  streamId: string,
  itemId: string,
  toolName: string
): StreamEvent {
  return {
    stream_id: streamId,
    sequence: nextSequence(),
    event: "ITEM_START",
    item: {
      item_id: itemId,
      item_type: "tool",
      data: { tool_name: toolName } satisfies ToolData,
    },
  };
}

export function createToolCallArgs(
  streamId: string,
  itemId: string,
  argsJson: string
): StreamEvent {
  return {
    stream_id: streamId,
    sequence: nextSequence(),
    event: "ITEM_DELTA",
    item: {
      item_id: itemId,
      item_type: "tool",
      data: { append_arguments: argsJson } satisfies ToolData,
    },
  };
}

export function createToolResultStart(
  streamId: string,
  itemId: string,
  toolCallId: string,
  isError: boolean
): StreamEvent {
  return {
    stream_id: streamId,
    sequence: nextSequence(),
    event: "ITEM_START",
    item: {
      item_id: itemId,
      item_type: "tool_result",
      data: { tool_call_id: toolCallId, is_error: isError } satisfies ToolResultData,
    },
  };
}

export function createToolResultDelta(
  streamId: string,
  itemId: string,
  text: string
): StreamEvent {
  return {
    stream_id: streamId,
    sequence: nextSequence(),
    event: "ITEM_DELTA",
    item: {
      item_id: itemId,
      item_type: "tool_result",
      data: { append: text } satisfies TextData,
    },
  };
}

export function createStreamEnd(streamId: string): StreamEvent {
  return {
    stream_id: streamId,
    sequence: nextSequence(),
    event: "STREAM_END",
  };
}

export function createStreamError(
  streamId: string,
  code: StreamError["code"],
  message: string
): StreamEvent {
  return {
    stream_id: streamId,
    sequence: nextSequence(),
    event: "STREAM_ERROR",
    error: {
      code,
      message,
    },
  };
}

export function createPing(): StreamEvent {
  return {
    stream_id: "",
    sequence: nextSequence(),
    event: "PING",
  };
}

// ============================================================================
// SSE 格式转换
// ============================================================================

export function toSSE(event: StreamEvent): string {
  const data = JSON.stringify(event);
  return `data: ${data}\n\n`;
}

// ============================================================================
// SSE 解析
// ============================================================================

export function parseSSELine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":")) return null;

  if (trimmed.startsWith("data: ")) {
    const dataStr = trimmed.slice(6);
    try {
      return JSON.parse(dataStr) as StreamEvent;
    } catch {
      return null;
    }
  }

  return null;
}

// ============================================================================
// 客户端状态管理
// ============================================================================

export interface StreamState {
  streamId: string;
  lastSequence: number;
  items: Map<string, ItemState>;
  isComplete: boolean;
  error: StreamError | null;
}

export interface ItemState {
  itemId: string;
  itemType: ItemType;
  content: string;
  isComplete: boolean;
  data: Record<string, unknown>;
}

export function createStreamState(streamId: string): StreamState {
  return {
    streamId,
    lastSequence: 0,
    items: new Map(),
    isComplete: false,
    error: null,
  };
}

export function applyEvent(state: StreamState, event: StreamEvent): StreamState {
  // 检查 sequence，处理乱序/重复
  if (event.sequence <= state.lastSequence) {
    return state; // 忽略旧事件
  }

  const newState: StreamState = {
    ...state,
    lastSequence: event.sequence,
  };

  switch (event.event) {
    case "ITEM_START": {
      if (event.item) {
        const newItems = new Map(state.items);
        newItems.set(event.item.item_id, {
          itemId: event.item.item_id,
          itemType: event.item.item_type,
          content: "",
          isComplete: false,
          // ITEM_START 的 data 必须带上：工具名（tool_name）与结果指回的
          // 调用 id（tool_call_id）都在这里，丢掉它们的话 item 建出来
          // 就是一个「不知道自己在调什么」的空壳。
          data: { ...(event.item.data ?? {}) },
        });
        newState.items = newItems;
      }
      break;
    }

    case "ITEM_DELTA": {
      if (event.item?.item_id) {
        const newItems = new Map(state.items);
        const item = newItems.get(event.item.item_id);
        if (item && event.item.data) {
          // content 是**统一的累加器**：文本项累 append，工具调用项累
          // append_arguments。两者都是「这个 item 到目前为止的内容」，
          // 分开存只会让每个消费点都要重新分支一次。
          const data = event.item.data as ToolData & TextData;
          const appended =
            item.itemType === "tool"
              ? data.append_arguments || ""
              : data.append || "";

          const newItem: ItemState = {
            ...item,
            content: item.content + appended,
            data: { ...item.data, ...data },
          };
          newItems.set(event.item.item_id, newItem);
          newState.items = newItems;
        }
      }
      break;
    }

    case "ITEM_END": {
      if (event.item?.item_id) {
        const newItems = new Map(state.items);
        const item = newItems.get(event.item.item_id);
        if (item) {
          newItems.set(event.item.item_id, {
            ...item,
            isComplete: true,
            // 收尾信息要并进来：工具结果的 is_error 就走这条路
            data: { ...item.data, ...(event.item.data ?? {}) },
          });
          newState.items = newItems;
        }
      }
      break;
    }

    case "STREAM_END": {
      newState.isComplete = true;
      break;
    }

    case "STREAM_ERROR": {
      if (event.error) {
        newState.error = event.error;
      }
      break;
    }
  }

  return newState;
}

// ============================================================================
// 从状态里取内容
// ============================================================================

/**
 * 到目前为止的全部文本 —— **所有** text item 按到达顺序拼接。
 *
 * 曾经它返回「第一个 text item」就 return。单轮对话里两者等价，所以这个
 * bug 一直没露头；一旦一个流里跑多轮（工具循环就是），第二轮生成的文本
 * 会落在新的 item 上，旧写法会把它整个丢掉。
 */
export function getFullText(state: StreamState): string {
  let text = "";
  for (const [, item] of state.items) {
    if (item.itemType === "text") {
      text += item.content;
    }
  }
  return text;
}

/** 一次完整的工具调用：调用 + 它的结果 */
export interface ToolInvocation {
  /** 即调用项的 item_id，也就是模型给出的 tool_call id */
  id: string;
  name: string;
  /** 原始 JSON 字符串，未经解析 —— 解析失败要能被看见，而不是被吞掉 */
  argsJson: string;
  result: string;
  isError: boolean;
  /** 结果是否已经回来了 */
  hasResult: boolean;
}

/**
 * 取出全部工具调用及其结果。
 *
 * 结果项通过 data.tool_call_id 指回调用项；调用还没拿到结果时
 * hasResult 为 false —— UI 据此显示「执行中」。
 */
export function getToolInvocations(state: StreamState): ToolInvocation[] {
  const results = new Map<string, { text: string; isError: boolean }>();

  for (const [, item] of state.items) {
    if (item.itemType !== "tool_result") continue;
    const callId = (item.data as ToolResultData).tool_call_id;
    if (callId) {
      results.set(callId, {
        text: item.content,
        isError: (item.data as ToolResultData).is_error === true,
      });
    }
  }

  const invocations: ToolInvocation[] = [];
  for (const [itemId, item] of state.items) {
    if (item.itemType !== "tool") continue;
    const hit = results.get(itemId);
    invocations.push({
      id: itemId,
      name: (item.data as ToolData).tool_name ?? "unknown",
      argsJson: item.content,
      result: hit?.text ?? "",
      isError: hit?.isError ?? false,
      hasResult: hit !== undefined,
    });
  }

  return invocations;
}
