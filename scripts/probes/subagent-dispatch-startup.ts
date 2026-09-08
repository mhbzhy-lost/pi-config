import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const PHASES = new Set(["tool-entered", "agent-discovery-started", "agent-discovery-finished", "rpc-ping-sent", "rpc-ping-replied", "rpc-spawn-sent", "rpc-spawn-replied", "leaf-wait-started", "leaf-wait-finished", "tool-returned", "tool-failed"]);
const ALLOWED = new Set(["version", "parentSessionId", "toolCallId", "phase", "monotonicMs", "method", "requestId", "rootRunId", "leafRunId", "errorCode"]);

function readTail(file: string, maxBytes: number) {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return { text: buffer.toString("utf8"), truncated: size > maxBytes };
  } finally { closeSync(fd); }
}

function invalid(code: string, partialLeadingLine: boolean, partialTrailingLine: boolean, truncated: boolean) {
  return { version: 1, records: [], cause: "unproven", partialLeadingLine, partialTrailingLine, truncated, invalidTrace: code };
}

function validate(record: unknown, previous: number | undefined) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return "invalid-record";
  const entry = record as Record<string, unknown>;
  if (entry.version !== 1) return "invalid-version";
  if (typeof entry.parentSessionId !== "string" || !entry.parentSessionId || typeof entry.toolCallId !== "string" || !entry.toolCallId) return "invalid-identity";
  if (typeof entry.phase !== "string" || !PHASES.has(entry.phase)) return "invalid-phase";
  if (!Number.isSafeInteger(entry.monotonicMs)) return "invalid-monotonic-ms";
  if (previous !== undefined && entry.monotonicMs < previous) return "non-monotonic-time";
  if (Object.keys(entry).some((key) => !ALLOWED.has(key)) || ["method", "requestId", "rootRunId", "leafRunId", "errorCode"].some((key) => entry[key] !== undefined && typeof entry[key] !== "string")) return "invalid-schema";
  return undefined;
}

export function readBoundedDispatchTrace({ file, parentSessionId, toolCallId, maxBytes = 64 * 1024, maxRecords = 256, windowMs = 130_000, outputBudget = 32 * 1024 }: { file: string; parentSessionId: string; toolCallId: string; maxBytes?: number; maxRecords?: number; windowMs?: number; outputBudget?: number }) {
  if (!parentSessionId || !toolCallId || ![maxBytes, maxRecords, windowMs, outputBudget].every((value) => Number.isSafeInteger(value) && value > 0)) return { version: 1, records: [], cause: "unproven", invalidTrace: "invalid-input" };
  let tail;
  try { tail = readTail(file, maxBytes); } catch { return { version: 1, records: [], cause: "unproven", invalidTrace: "read-failed" }; }
  const partialLeadingLine = tail.truncated && !tail.text.startsWith("\n");
  const partialTrailingLine = !tail.text.endsWith("\n");
  const lines = tail.text.split("\n");
  if (partialLeadingLine) lines.shift();
  if (partialTrailingLine) lines.pop();
  const entries = [];
  let previous;
  for (const line of lines.filter(Boolean)) {
    let entry;
    try { entry = JSON.parse(line); } catch { return invalid("invalid-json", partialLeadingLine, partialTrailingLine, tail.truncated); }
    const error = validate(entry, previous);
    if (error) return invalid(error, partialLeadingLine, partialTrailingLine, tail.truncated);
    previous = entry.monotonicMs;
    entries.push(entry);
  }
  const records = entries.filter((entry) => entry.toolCallId === toolCallId && entry.parentSessionId === parentSessionId).slice(-maxRecords);
  const latest = records.at(-1)?.monotonicMs;
  const windowed = Number.isSafeInteger(latest) ? records.filter((entry) => latest - entry.monotonicMs <= windowMs) : [];
  const result = { version: 1, parentSessionId, toolCallId, records: windowed, cause: windowed.length ? "observed" : "unproven", partialLeadingLine, partialTrailingLine, truncated: tail.truncated };
  return Buffer.byteLength(JSON.stringify(result), "utf8") > outputBudget ? { version: 1, records: [], cause: "unproven", partialLeadingLine, partialTrailingLine, truncated: true, outputBudgetExceeded: true } : result;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [file, parentSessionId, toolCallId] = process.argv.slice(2);
  process.stdout.write(`${JSON.stringify(readBoundedDispatchTrace({ file, parentSessionId, toolCallId }))}\n`);
}
