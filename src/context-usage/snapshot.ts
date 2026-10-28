import { Type } from "@earendil-works/pi-ai";

export type ContextUsageInput = {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
};

export type ContextUsageSnapshot = {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
  remainingTokens: number | null;
  remainingRatio: number | null;
  estimated: true;
  status: "known" | "unknown";
};

export type ContextUsageToolDetails = ContextUsageSnapshot;
export type ContextUsageOutput = ContextUsageSnapshot & { note: string };

export const ContextUsageOutputSchema = Type.Object({
  tokens: Type.Union([Type.Number(), Type.Null()]),
  contextWindow: Type.Number(),
  percent: Type.Union([Type.Number(), Type.Null()]),
  remainingTokens: Type.Union([Type.Number(), Type.Null()]),
  remainingRatio: Type.Union([Type.Number(), Type.Null()]),
  estimated: Type.Literal(true),
  status: Type.Union([Type.Literal("known"), Type.Literal("unknown")]),
  note: Type.String(),
});

export function createContextUsageSnapshot(
  usage: ContextUsageInput | undefined,
): ContextUsageSnapshot {
  const contextWindow = usage?.contextWindow ?? 0;
  if (!usage || contextWindow <= 0 || usage.tokens === null || usage.percent === null) {
    return {
      tokens: usage?.tokens ?? null,
      contextWindow,
      percent: usage?.percent ?? null,
      remainingTokens: null,
      remainingRatio: null,
      estimated: true,
      status: "unknown",
    };
  }

  const remainingTokens = Math.max(0, contextWindow - usage.tokens);
  const remainingRatio = Math.max(0, 1 - usage.tokens / contextWindow);

  return {
    tokens: usage.tokens,
    contextWindow,
    percent: usage.percent,
    remainingTokens,
    remainingRatio,
    estimated: true,
    status: "known",
  };
}

export function createContextUsageToolResult(
  usage: ContextUsageInput | undefined,
): { content: Array<{ type: "text"; text: string }>; details: ContextUsageToolDetails; structuredContent: ContextUsageOutput } {
  const details = createContextUsageSnapshot(usage);
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
