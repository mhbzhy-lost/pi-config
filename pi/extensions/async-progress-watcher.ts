import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { watch } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

const POLL_INTERVAL_MS = 5000;

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

export async function tailEventsFile(
  filePath: string,
  fromOffset: number,
): Promise<{ lines: string[]; offset: number }> {
  let fh;
  try {
    fh = await open(filePath, "r");
    const stat = await fh.stat();
    if (stat.size <= fromOffset) return { lines: [], offset: fromOffset };
    const buf = Buffer.alloc(stat.size - fromOffset);
    await fh.read(buf, 0, buf.length, fromOffset);
    const text = buf.toString("utf8");
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    return { lines, offset: stat.size };
  } catch {
    return { lines: [], offset: fromOffset };
  } finally {
    await fh?.close();
  }
}

export function startWatching(
  eventsPath: string,
  onProgress: (summary: string) => void,
): { stop: () => void } {
  let offset = 0;
  let state: ProgressState = { turnCount: 0 };
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    const { lines, offset: newOffset } = await tailEventsFile(eventsPath, offset);
    if (lines.length === 0) return;
    offset = newOffset;
    const result = parseProgressEvents(lines, state);
    if (result) {
      state = result.state;
      onProgress(result.summary);
    }
  };

  // fs.watch for immediate notification, poll as fallback
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(eventsPath, () => { void tick(); });
  } catch { /* file may not exist yet */ }
  const interval = setInterval(() => { void tick(); }, POLL_INTERVAL_MS);

  return {
    stop() {
      stopped = true;
      watcher?.close();
      clearInterval(interval);
    },
  };
}

export default function asyncProgressWatcher(pi: ExtensionAPI) {
  const watchers = new Map<string, { stop: () => void }>();

  pi.events.on("subagent:async-started", (event: any) => {
    const runId = event?.runId;
    const asyncDir = event?.asyncDir;
    if (!runId || !asyncDir || watchers.has(runId)) return;
    const eventsPath = join(asyncDir, "events.jsonl");
    const watcher = startWatching(eventsPath, (summary) => {
      pi.sendMessage(
        { customType: "async-progress", content: `[${runId.slice(0, 8)}] ${summary}`, display: true },
        { triggerTurn: false },
      );
    });
    watchers.set(runId, watcher);
  });

  pi.events.on("subagent:async-complete", (event: any) => {
    const runId = event?.runId;
    if (!runId) return;
    const watcher = watchers.get(runId);
    if (watcher) {
      watcher.stop();
      watchers.delete(runId);
    }
  });

  pi.on("session_shutdown", () => {
    for (const [, watcher] of watchers) watcher.stop();
    watchers.clear();
  });
}
