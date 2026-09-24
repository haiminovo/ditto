import type { HarnessToolPolicy, HarnessToolPolicyContext, HarnessToolDecision } from "./types";

export const allowAllTools: HarnessToolPolicy = {
  decide: () => ({ type: "allow" }),
};

export function createAllowlistPolicy(
  allowedTools: Iterable<string>,
  options: { reason?: string } = {}
): HarnessToolPolicy {
  const allowed = new Set(allowedTools);

  return {
    decide(context: HarnessToolPolicyContext): HarnessToolDecision {
      if (allowed.has(context.tool.name)) return { type: "allow" };
      return {
        type: "deny",
        reason:
          options.reason ??
          `工具 ${context.tool.name} 不在当前 harness profile 的允许列表内。`,
      };
    },
  };
}

export function createDenyPolicy(reason: string): HarnessToolPolicy {
  return {
    decide: () => ({ type: "deny", reason }),
  };
}
