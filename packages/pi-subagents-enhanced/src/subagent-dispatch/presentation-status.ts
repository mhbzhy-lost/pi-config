export type SubagentPresentationStatus = "running" | "completed" | "reported" | "needs-context" | "limited" | "paused" | "stopped" | "runtime-failed";

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordValue : undefined;
}

function hasNeedsContext(event: RecordValue): boolean {
  return ["output", "summary", "content"].some((key) =>
    typeof event[key] === "string" && /\bNEEDS_CONTEXT\b/.test(event[key] as string),
  );
}

function hasPresentOutput(event: RecordValue): boolean {
  return typeof event.outputState === "string" && event.outputState.toLowerCase() === "present";
}

function hasRuntimeError(event: RecordValue): boolean {
  return event.protocolError === true || typeof event.protocolError === "string"
    || (event.outputState === "absent" && (event.error !== undefined || event.runtimeError !== undefined));
}

/** Classifies one normalized pi-subagents completion child. */
export function classifySubagentChildPresentation(value: unknown): SubagentPresentationStatus {
  const event = record(value) ?? {};
  // Normalized completion children use `status`; older events use `state`.
  const lifecycle = typeof event.status === "string" ? event.status.toLowerCase()
    : typeof event.state === "string" ? event.state.toLowerCase() : "";
  const acceptance = record(event.acceptance);
  const acceptanceStatus = typeof acceptance?.status === "string" ? acceptance.status.toLowerCase() : "";
  const signal = typeof event.processSignal === "string" ? event.processSignal : "";

  if (event.timedOut === true || event.turnBudgetExceeded === true || event.usageLimitExceeded === true
    || record(event.usageBudget)?.exhausted === true || lifecycle === "timed-out") return "limited";
  if (event.stopped === true || lifecycle === "stopped" || lifecycle === "detached") return "stopped";
  if (event.interrupted === true || event.paused === true || lifecycle === "paused") return "paused";
  if (hasNeedsContext(event)) return "needs-context";
  if (event.protocolError || (signal && !["SIGTERM", "SIGINT"].includes(signal)) || hasRuntimeError(event)) return "runtime-failed";
  if (lifecycle === "running" || lifecycle === "queued" || lifecycle === "pending") return "running";
  if (hasPresentOutput(event)) {
    return event.success === true || lifecycle === "complete" || lifecycle === "completed"
      || acceptanceStatus === "accepted" || acceptance?.accepted === true ? "completed" : "reported";
  }
  if (event.success === true || lifecycle === "complete" || lifecycle === "completed" || acceptanceStatus === "accepted" || acceptance?.accepted === true) return "completed";
  // A raw failed/rejected lifecycle alone does not prove a runtime fault.
  return lifecycle === "failed" || lifecycle === "rejected" ? "reported" : "running";
}

const AGGREGATE_PRIORITY: Readonly<Record<SubagentPresentationStatus, number>> = Object.freeze({
  running: 0, completed: 1, reported: 2, "needs-context": 3, limited: 4, paused: 5, stopped: 6, "runtime-failed": 7,
});

export function classifySubagentPresentation(value: unknown): SubagentPresentationStatus {
  const event = record(value) ?? {};
  if (!Array.isArray(event.results)) return classifySubagentChildPresentation(event);
  const children = event.results.map(classifySubagentChildPresentation);
  // A parent raw `failed` is an aggregate lifecycle, not a child outcome. Merge
  // only its meaningful structured projection with child projections.
  const topLevel = classifySubagentChildPresentation({ ...event, results: undefined, state: undefined, status: undefined, success: undefined });
  if (AGGREGATE_PRIORITY[topLevel] >= AGGREGATE_PRIORITY["needs-context"]) children.push(topLevel);
  return children.reduce((aggregate, child) =>
    AGGREGATE_PRIORITY[child] > AGGREGATE_PRIORITY[aggregate] ? child : aggregate,
  "running" as SubagentPresentationStatus);
}

export const PRESENTATION_GLYPH: Readonly<Record<SubagentPresentationStatus, string>> = Object.freeze({
  running: "●", completed: "✓", reported: "◇", "needs-context": "?", limited: "!", paused: "Ⅱ", stopped: "■", "runtime-failed": "✗",
});
