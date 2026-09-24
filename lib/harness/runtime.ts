import { allowAllTools } from "./policy";
import type {
  HarnessErrorCode,
  HarnessMessage as Message,
  HarnessModelRoundEvent,
  HarnessRunEvent,
  HarnessRunInput,
  HarnessToolCall as ToolCall,
  HarnessToolContext,
  HarnessToolDecision,
  HarnessToolResult,
} from "./types";

const DEFAULT_MAX_ROUNDS = 8;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

function newRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseToolArgs(raw: string): { args: Record<string, unknown> } | { parseError: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { args: {} };

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        parseError: `参数必须是一个 JSON 对象，实际是 ${
          Array.isArray(parsed) ? "数组" : typeof parsed
        }`,
      };
    }
    return { args: parsed as Record<string, unknown> };
  } catch (error) {
    return { parseError: errorMessage(error) };
  }
}

function isToolStop(stopReason: string | null): boolean {
  return stopReason === "tool_use" || stopReason === "tool_calls";
}

function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? "cancelled";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Run cancelled", "AbortError");
  }
}

/**
 * Link a run-level signal to optional timeout signals without dropping the
 * caller's cancellation reason.
 */
function createLinkedController(
  external: AbortSignal | undefined,
  timeoutMs: number | undefined
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abort = (reason?: unknown) => controller.abort(reason);
  const onAbort = () => abort(abortReason(external));

  if (external?.aborted) abort(abortReason(external));
  else external?.addEventListener("abort", onAbort, { once: true });

  const timer =
    timeoutMs && timeoutMs > 0
      ? setTimeout(() => abort(new Error(`Harness run timed out after ${timeoutMs}ms`)), timeoutMs)
      : null;

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
  };
}

async function callToolWithTimeout(
  source: NonNullable<HarnessRunInput["toolSource"]>,
  call: ToolCall,
  args: Record<string, unknown>,
  context: HarnessToolContext,
  timeoutMs: number
): Promise<HarnessToolResult> {
  throwIfAborted(context.signal);

  const controller = new AbortController();
  let rejectAborted: ((reason?: unknown) => void) | null = null;
  const aborted = new Promise<never>((_, reject) => {
    rejectAborted = reject;
  });
  const abort = (reason: unknown) => {
    controller.abort(reason);
    rejectAborted?.(new DOMException(String(reason), "AbortError"));
  };
  const onAbort = () => abort(context.signal?.reason ?? "cancelled");
  context.signal?.addEventListener("abort", onAbort, { once: true });

  const timer =
    timeoutMs > 0
      ? setTimeout(() => abort(`Tool ${call.name} timed out after ${timeoutMs}ms`), timeoutMs)
      : null;

  try {
    return await Promise.race([
      source.callTool(call.name, args, {
        ...context,
        signal: controller.signal,
      }),
      aborted,
    ]);
  } catch (error) {
    if (isAbortError(error)) {
      return {
        text: `【E_TOOL_TIMEOUT】工具 ${call.name} 执行超过 ${timeoutMs}ms 或运行已取消。`,
        isError: true,
      };
    }
    return {
      text: `【E_TOOL_ERROR】工具 ${call.name} 执行失败：${errorMessage(error)}`,
      isError: true,
    };
  } finally {
    if (timer) clearTimeout(timer);
    context.signal?.removeEventListener("abort", onAbort);
  }
}

async function resolveDecision(
  input: HarnessRunInput,
  context: HarnessToolContext,
  tool: NonNullable<HarnessRunInput["tools"]>[number]
): Promise<{ decision: Exclude<HarnessToolDecision["type"], "ask">; reason?: string }> {
  const policy = input.toolPolicy ?? allowAllTools;
  const initial = await policy.decide({ ...context, tool });

  if (initial.type === "allow") return { decision: "allow" };
  if (initial.type === "deny") return { decision: "deny", reason: initial.reason };

  if (!input.approvalHandler) {
    return {
      decision: "deny",
      reason: `${initial.reason}（当前没有可用的审批处理器）`,
    };
  }

  const approval = await input.approvalHandler({
    ...context,
    tool,
    reason: initial.reason,
  });

  return approval.approved
    ? { decision: "allow", reason: approval.reason }
    : { decision: "deny", reason: approval.reason || initial.reason };
}

/**
 * Run a provider-neutral agent loop.
 *
 * The runtime is intentionally stateless: callers own message persistence.
 * Each invocation emits a complete event stream that can be rendered, logged,
 * persisted, or consumed by a non-streaming endpoint.
 */
export async function* runHarness(input: HarnessRunInput): AsyncGenerator<HarnessRunEvent> {
  const runId = input.runId ?? newRunId();
  const maxRounds = Math.max(1, Math.min(input.maxRounds ?? DEFAULT_MAX_ROUNDS, 100));
  const toolTimeoutMs = input.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const linked = createLinkedController(input.signal, input.runTimeoutMs);
  const signal = linked.signal;

  let tools = input.tools ?? [];
  let rounds = 0;
  let ended = false;

  try {
    throwIfAborted(signal);

    if (!input.tools && input.toolSource) {
      try {
        tools = await input.toolSource.listTools(signal);
      } catch (error) {
        yield {
          type: "warning",
          code: "E_TOOL_SOURCE",
          message: `工具源 ${input.toolSource.id} 不可用，本次运行不挂载工具：${errorMessage(error)}`,
        };
        tools = [];
      }
    }

    yield {
      type: "run_start",
      runId,
      sessionId: input.sessionId,
      modelId: input.model.id,
      toolCount: tools.length,
      maxRounds,
      metadata: input.metadata,
    };

    let convo = [...input.messages];

    for (let round = 1; round <= maxRounds; round += 1) {
      throwIfAborted(signal);
      rounds = round;
      yield { type: "round_start", round };

      let text = "";
      let toolCalls: ToolCall[] = [];
      let stopReason: string | null = null;
      let sawRoundEnd = false;

      try {
        for await (const event of input.model.streamRound({
          messages: convo,
          tools,
          options: input.modelOptions,
          signal,
        })) {
          throwIfAborted(signal);
          if (event.type === "text_delta") {
            text += event.text;
            yield { type: "text_delta", text: event.text };
          } else {
            sawRoundEnd = true;
            text = event.text;
            toolCalls = event.toolCalls;
            stopReason = event.stopReason;
          }
        }
      } catch (error) {
        if (isAbortError(error)) {
          yield { type: "error", code: "RUN_CANCELLED", message: "运行已取消。" };
          yield { type: "run_end", runId, reason: "cancelled", rounds };
          ended = true;
          return;
        }

        yield { type: "error", code: "MODEL_ERROR", message: errorMessage(error) };
        yield { type: "run_end", runId, reason: "failed", rounds };
        ended = true;
        return;
      }

      if (!sawRoundEnd) {
        yield {
          type: "error",
          code: "MODEL_ERROR",
          message: "模型流在返回本轮结束事件前中断。",
        };
        yield { type: "run_end", runId, reason: "failed", rounds };
        ended = true;
        return;
      }

      yield { type: "round_end", round, stopReason };

      if (toolCalls.length === 0) {
        if (isToolStop(stopReason)) {
          yield {
            type: "error",
            code: "MODEL_ERROR",
            message: `模型要求调用工具，但没收到完整的调用信息（stop_reason=${stopReason}）`,
          };
          yield { type: "run_end", runId, reason: "failed", rounds };
        } else {
          yield { type: "run_end", runId, reason: "completed", rounds };
        }
        ended = true;
        return;
      }

      if (round === maxRounds) {
        for (const call of toolCalls) {
          yield { type: "tool_call", round, call };
          yield {
            type: "tool_result",
            round,
            call,
            result: {
              text: `【E_ROUND_LIMIT】已达到工具调用轮数上限（${maxRounds}），本次未执行。`,
              isError: true,
            },
          };
        }
        yield { type: "run_end", runId, reason: "round_limit", rounds };
        ended = true;
        return;
      }

      const assistantMessage: Message = {
        role: "assistant",
        content: text,
        toolCalls,
      };
      const toolMessages: Message[] = [];

      for (const call of toolCalls) {
        throwIfAborted(signal);
        yield { type: "tool_call", round, call };

        const context: HarnessToolContext = {
          runId,
          sessionId: input.sessionId,
          round,
          toolName: call.name,
          metadata: input.metadata,
          signal,
        };
        const tool = tools.find((candidate) => candidate.name === call.name);
        let result: HarnessToolResult;
        let decision: { decision: "allow" | "deny"; reason?: string };

        try {
          decision = tool
            ? await resolveDecision(input, context, tool)
            : { decision: "deny", reason: `未找到名为 ${call.name} 的工具。` };
        } catch (error) {
          decision = {
            decision: "deny",
            reason: `工具权限检查失败：${errorMessage(error)}`,
          };
        }

        yield {
          type: "tool_decision",
          round,
          call,
          decision: decision.decision,
          reason: decision.reason,
        };

        if (decision.decision === "deny") {
          result = {
            text: `【E_TOOL_DENIED】${decision.reason}`,
            isError: true,
          };
        } else {
          const parsed = parseToolArgs(call.arguments);
          if ("parseError" in parsed) {
            result = {
              text: `【E_TOOL_ARGS】参数不是合法 JSON，无法执行：${parsed.parseError}\n收到的原文：${call.arguments.slice(0, 500)}`,
              isError: true,
            };
          } else if (!input.toolSource) {
            result = {
              text: `【E_TOOL_UNAVAILABLE】工具通道未建立，${call.name} 未执行。`,
              isError: true,
            };
          } else {
            result = await callToolWithTimeout(
              input.toolSource,
              call,
              parsed.args,
              context,
              toolTimeoutMs
            );
          }
        }

        yield { type: "tool_result", round, call, result };
        toolMessages.push({
          role: "tool",
          toolCallId: call.id,
          content: result.text,
        });
      }

      convo = [...convo, assistantMessage, ...toolMessages];
    }

    yield { type: "run_end", runId, reason: "completed", rounds };
    ended = true;
  } catch (error) {
    if (isAbortError(error)) {
      yield { type: "error", code: "RUN_CANCELLED", message: "运行已取消。" };
      yield { type: "run_end", runId, reason: "cancelled", rounds };
    } else {
      yield { type: "error", code: "UNKNOWN", message: errorMessage(error) };
      yield { type: "run_end", runId, reason: "failed", rounds };
    }
    ended = true;
  } finally {
    linked.cleanup();
    if (!ended) {
      yield { type: "run_end", runId, reason: "failed", rounds };
    }
  }
}
