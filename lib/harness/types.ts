/**
 * Ditto Agent Harness - public contracts
 *
 * The harness owns the model/tool loop. Providers, tools, policies and approval
 * handlers are adapters so the same runtime can drive different agents.
 */

export type HarnessMessageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface HarnessToolCall {
  id: string;
  name: string;
  /**
   * Keep the provider's raw JSON string. Parse failures must be visible to the
   * model as tool errors instead of being swallowed by the runtime.
   */
  arguments: string;
}

export type HarnessMessage =
  | { role: "user"; content: string | HarnessMessageContentPart[] }
  | { role: "assistant"; content: string; toolCalls?: HarnessToolCall[] }
  | { role: "tool"; toolCallId: string; content: string }
  | { role: "system"; content: string };

export interface HarnessToolDefinition {
  name: string;
  description: string;
  /** JSON Schema accepted by the model provider. */
  inputSchema: Record<string, unknown>;
  /** Optional MCP-style annotations. They are metadata, not authorization. */
  annotations?: Record<string, unknown>;
}

export interface HarnessToolResult {
  text: string;
  isError: boolean;
  metadata?: Record<string, unknown>;
}

export interface HarnessToolContext {
  runId: string;
  sessionId?: string;
  round: number;
  toolName: string;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface HarnessToolSource {
  id: string;
  listTools(signal?: AbortSignal): Promise<HarnessToolDefinition[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    context?: HarnessToolContext
  ): Promise<HarnessToolResult>;
  close?(): Promise<void>;
}

export interface HarnessModelOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

export type HarnessModelRoundEvent =
  | { type: "text_delta"; text: string }
  | {
      type: "round_end";
      text: string;
      toolCalls: HarnessToolCall[];
      stopReason: string | null;
    };

export interface HarnessModelRoundInput {
  messages: HarnessMessage[];
  tools: HarnessToolDefinition[];
  options?: HarnessModelOptions;
  signal?: AbortSignal;
}

export interface HarnessModelAdapter {
  id: string;
  streamRound(input: HarnessModelRoundInput): AsyncIterable<HarnessModelRoundEvent>;
}

export type HarnessToolDecision =
  | { type: "allow" }
  | { type: "deny"; reason: string }
  | { type: "ask"; reason: string };

export interface HarnessToolPolicyContext extends HarnessToolContext {
  tool: HarnessToolDefinition;
}

export interface HarnessToolPolicy {
  decide(context: HarnessToolPolicyContext): Promise<HarnessToolDecision> | HarnessToolDecision;
}

export interface HarnessApprovalRequest extends HarnessToolPolicyContext {
  reason: string;
}

export interface HarnessApprovalDecision {
  approved: boolean;
  reason?: string;
}

export type HarnessApprovalHandler = (
  request: HarnessApprovalRequest
) => Promise<HarnessApprovalDecision> | HarnessApprovalDecision;

export type HarnessRunEndReason =
  | "completed"
  | "round_limit"
  | "cancelled"
  | "failed";

export type HarnessErrorCode =
  | "MODEL_ERROR"
  | "TOOL_ERROR"
  | "RUN_CANCELLED"
  | "UNKNOWN";

export type HarnessRunEvent =
  | {
      type: "run_start";
      runId: string;
      sessionId?: string;
      modelId: string;
      toolCount: number;
      maxRounds: number;
      metadata?: Record<string, unknown>;
    }
  | { type: "round_start"; round: number }
  | { type: "text_delta"; text: string }
  | { type: "round_end"; round: number; stopReason: string | null }
  | { type: "tool_call"; round: number; call: HarnessToolCall }
  | {
      type: "tool_decision";
      round: number;
      call: HarnessToolCall;
      decision: Exclude<HarnessToolDecision["type"], "ask">;
      reason?: string;
    }
  | {
      type: "tool_result";
      round: number;
      call: HarnessToolCall;
      result: HarnessToolResult;
    }
  | { type: "warning"; code: string; message: string }
  | { type: "error"; code: HarnessErrorCode; message: string }
  | {
      type: "run_end";
      runId: string;
      reason: HarnessRunEndReason;
      rounds: number;
      message?: string;
    };

export interface HarnessRunInput {
  runId?: string;
  sessionId?: string;
  messages: HarnessMessage[];
  model: HarnessModelAdapter;
  modelOptions?: HarnessModelOptions;
  tools?: HarnessToolDefinition[];
  toolSource?: HarnessToolSource | null;
  toolPolicy?: HarnessToolPolicy;
  approvalHandler?: HarnessApprovalHandler;
  maxRounds?: number;
  toolTimeoutMs?: number;
  runTimeoutMs?: number;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}
