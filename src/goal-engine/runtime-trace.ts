import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const TRACE_FILE = "runtime-trace.jsonl";
type RuntimeTraceOptions = { root: string; config?: { runtimeTrace?: { enabled?: boolean } }; env?: NodeJS.ProcessEnv; sessionId?: string; clock?: () => string };
type TraceEntry = { schema: string; seq: number; ts: string; kind: string; sessionId?: string; [key: string]: unknown };

/** Resolve the debug-only trace switch. An explicit environment value wins. */
export function runtimeTraceEnabled({ config = {}, env = process.env }: { config?: { runtimeTrace?: { enabled?: boolean } }; env?: NodeJS.ProcessEnv } = {}) {
  const override = env?.PI_GOAL_ENGINE_TRACE;
  if (override === "0" || override === "false") return false;
  if (override === "1" || override === "true") return true;
  return config?.runtimeTrace?.enabled === true;
}

/**
 * Append-only, observer-only Goal runtime trace. It has no Goal Store access
 * and therefore cannot create or alter Goal state. Debug mode intentionally
 * preserves hook payloads for complete diagnosis; disabled mode avoids all
 * filesystem work.
 */
export function createGoalRuntimeTrace({ root, config, env, sessionId, clock = () => new Date().toISOString() }: RuntimeTraceOptions) {
  const enabled = runtimeTraceEnabled({ config, env });
  const file = join(root, TRACE_FILE);
  let seq = 0;
  let currentSessionId = sessionId;
  const trace = {
    enabled,
    file,
    setSessionId(value) { currentSessionId = typeof value === "string" && value ? value : null; },
    record(kind, fields = {}) {
      if (!enabled) return false;
      if (typeof kind !== "string" || !kind) return false;
      const entry: TraceEntry = { schema: "goal-runtime.trace.v1", seq: ++seq, ts: clock(), kind };
      if (currentSessionId) entry.sessionId = currentSessionId;
      for (const [key, value] of Object.entries(fields || {})) {
        if (value !== undefined) entry[key] = value;
      }
      try {
        mkdirSync(root, { recursive: true, mode: 0o700 });
        appendFileSync(file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
        chmodSync(file, 0o600);
        return true;
      } catch {
        // Diagnostics must never change Goal control semantics.
        return false;
      }
    },
  };
  if (enabled) trace.record("trace_config", { enabled: true, sessionId: sessionId || null });
  return trace;
}
