import { Type } from "@earendil-works/pi-ai";

export type ContextUsageInput = {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
};

export type HandoffStatus = "unknown" | "normal" | "prepare-handoff" | "urgent-handoff";

export type HandoffPolicy = {
  handoffRatio: number;
  urgentRatio: number;
  handoffPath: string;
};

export type ContextUsageSnapshot = {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
  remainingTokens: number | null;
  remainingRatio: number | null;
  tokensBeforeHandoff: number | null;
  tokensBeforeUrgentHandoff: number | null;
  estimated: true;
  status: HandoffStatus;
  shouldPrepareHandoff: boolean;
  shouldUrgentlyPrepareHandoff: boolean;
  handoffPath: string;
};

export type ContextUsageToolDetails = ContextUsageSnapshot;
export type ContextUsageOutput = ContextUsageSnapshot & { note: string };

export const ContextUsageOutputSchema = Type.Object({
  tokens: Type.Union([Type.Number(), Type.Null()]),
  contextWindow: Type.Number(),
  percent: Type.Union([Type.Number(), Type.Null()]),
  remainingTokens: Type.Union([Type.Number(), Type.Null()]),
  remainingRatio: Type.Union([Type.Number(), Type.Null()]),
  tokensBeforeHandoff: Type.Union([Type.Number(), Type.Null()]),
  tokensBeforeUrgentHandoff: Type.Union([Type.Number(), Type.Null()]),
  estimated: Type.Literal(true),
  status: Type.Union([Type.Literal("unknown"), Type.Literal("normal"), Type.Literal("prepare-handoff"), Type.Literal("urgent-handoff")]),
  shouldPrepareHandoff: Type.Boolean(),
  shouldUrgentlyPrepareHandoff: Type.Boolean(),
  handoffPath: Type.String(),
  note: Type.String(),
});

export const DEFAULT_HANDOFF_POLICY: HandoffPolicy = {
  handoffRatio: 0.8,
  urgentRatio: 0.9,
  handoffPath: ".pi/handoff/context-handoff.md",
};

export function validateHandoffPolicy(policy: HandoffPolicy): HandoffPolicy {
  if (!Number.isFinite(policy.handoffRatio) || policy.handoffRatio <= 0 || policy.handoffRatio > 1) {
    throw new Error("handoffRatio 必须大于 0 且不超过 1");
  }
  if (!Number.isFinite(policy.urgentRatio) || policy.urgentRatio <= 0 || policy.urgentRatio > 1) {
    throw new Error("urgentRatio 必须大于 0 且不超过 1");
  }
  if (policy.urgentRatio < policy.handoffRatio) {
    throw new Error("urgentRatio 必须大于或等于 handoffRatio");
  }
  if (!policy.handoffPath.trim()) {
    throw new Error("handoffPath 不能为空");
  }
  return policy;
}

export function createContextUsageSnapshot(
  usage: ContextUsageInput | undefined,
  policy: HandoffPolicy = DEFAULT_HANDOFF_POLICY,
): ContextUsageSnapshot {
  validateHandoffPolicy(policy);
  const contextWindow = usage?.contextWindow ?? 0;
  if (!usage || contextWindow <= 0 || usage.tokens === null || usage.percent === null) {
    return {
      tokens: usage?.tokens ?? null,
      contextWindow,
      percent: usage?.percent ?? null,
      remainingTokens: null,
      remainingRatio: null,
      tokensBeforeHandoff: null,
      tokensBeforeUrgentHandoff: null,
      estimated: true,
      status: "unknown",
      shouldPrepareHandoff: false,
      shouldUrgentlyPrepareHandoff: false,
      handoffPath: policy.handoffPath,
    };
  }

  const remainingTokens = Math.max(0, contextWindow - usage.tokens);
  const remainingRatio = Math.max(0, 1 - usage.tokens / contextWindow);
  const tokensBeforeHandoff = Math.max(0, contextWindow * policy.handoffRatio - usage.tokens);
  const tokensBeforeUrgentHandoff = Math.max(0, contextWindow * policy.urgentRatio - usage.tokens);
  const status: HandoffStatus =
    usage.percent >= policy.urgentRatio * 100
      ? "urgent-handoff"
      : usage.percent >= policy.handoffRatio * 100
        ? "prepare-handoff"
        : "normal";

  return {
    tokens: usage.tokens,
    contextWindow,
    percent: usage.percent,
    remainingTokens,
    remainingRatio,
    tokensBeforeHandoff,
    tokensBeforeUrgentHandoff,
    estimated: true,
    status,
    shouldPrepareHandoff: status !== "normal",
    shouldUrgentlyPrepareHandoff: status === "urgent-handoff",
    handoffPath: policy.handoffPath,
  };
}

export function createContextUsageToolResult(
  usage: ContextUsageInput | undefined,
  policy: HandoffPolicy = DEFAULT_HANDOFF_POLICY,
): { content: Array<{ type: "text"; text: string }>; details: ContextUsageToolDetails; structuredContent: ContextUsageOutput } {
  const details = createContextUsageSnapshot(usage, policy);
  const payload: ContextUsageOutput = {
    ...details,
    note: "这是 Pi 的当前上下文估计值，不是 provider 保证的精确 tokenizer 计数。",
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details,
    structuredContent: payload,
  };
}
