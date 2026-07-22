export interface ProgressState {
  turnCount: number;
  lastTool?: string;
  lastToolDurationMs?: number;
  totalTokens?: number;
}

export function parseProgressEvents(
  lines: string[],
  state: ProgressState,
): { summary: string; state: ProgressState } | null {
  const next = { ...state };
  let hasActivity = false;
  const tools: string[] = [];

  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === "turn_start") {
      next.turnCount++;
      hasActivity = true;
    } else if (event.type === "tool_execution_start" && typeof event.tool === "string") {
      next.lastTool = event.tool;
    } else if (event.type === "tool_execution_end" && typeof event.tool === "string") {
      const durationMs = typeof event.durationMs === "number" ? event.durationMs : undefined;
      next.lastToolDurationMs = durationMs;
      tools.push(
        durationMs === undefined ? event.tool : `${event.tool} (${(durationMs / 1000).toFixed(1)}s)`,
      );
      hasActivity = true;
    } else if (
      event.type === "message_end"
      && event.usage !== null
      && typeof event.usage === "object"
      && typeof (event.usage as Record<string, unknown>).totalTokens === "number"
    ) {
      next.totalTokens = (event.usage as Record<string, number>).totalTokens;
      hasActivity = true;
    }
  }

  if (!hasActivity) return null;

  const parts = [`turn ${next.turnCount}`];
  if (tools.length > 0) parts.push(tools.join(", "));
  if (next.totalTokens !== undefined) parts.push(`${Math.round(next.totalTokens / 1000)}k tok`);

  return { summary: parts.join(" | "), state: next };
}

export default function asyncProgressWatcher(_pi: unknown) {}
