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

export interface ToolData {
  tool_name?: string;
  arguments?: Record<string, unknown>;
  append_arguments?: string;
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

export function createItemEnd(
  streamId: string,
  itemId: string
): StreamEvent {
  return {
    stream_id: streamId,
    sequence: nextSequence(),
    event: "ITEM_END",
    item: {
      item_id: itemId,
      item_type: "text", // 默认 text，实际可忽略
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
          data: {},
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
          const data = event.item.data as TextData;
          const newItem: ItemState = {
            ...item,
            content: item.content + (data.append || ""),
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
// 获取完整文本（从 text item）
// ============================================================================

export function getFullText(state: StreamState): string {
  for (const [, item] of state.items) {
    if (item.itemType === "text") {
      return item.content;
    }
  }
  return "";
}
