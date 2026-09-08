import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const EVENTS = new Set(["host-idle", "completion-received", "ownership-match", "ownership-mismatch", "send-message", "delivery-result", "agent-start", "agent-end", "agent-settled", "ui-prompt-start", "ui-prompt-end"]);
const ALLOWED = new Set(["version", "hostSessionId", "completionOwnerId", "event", "monotonicMs", "source", "runId", "eventSessionId", "eventCompletionOwnerId", "ownershipDecision", "customType", "triggerTurn", "deliverAs", "display", "deliveryResult"]);

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
  return { records: [], cause: "unproven", partialLeadingLine, partialTrailingLine, truncated, invalidTrace: code };
}

function validate(record: unknown, previous: number | undefined) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return "invalid-record";
  const entry = record as Record<string, unknown>;
  if (entry.version !== 1) return "invalid-version";
  if (typeof entry.hostSessionId !== "string" || !entry.hostSessionId || typeof entry.completionOwnerId !== "string" || !entry.completionOwnerId) return "invalid-identity";
  if (typeof entry.event !== "string" || !EVENTS.has(entry.event)) return "invalid-event";
  if (!Number.isSafeInteger(entry.monotonicMs)) return "invalid-monotonic-ms";
  if (previous !== undefined && entry.monotonicMs < previous) return "non-monotonic-time";
  if (Object.keys(entry).some((key) => !ALLOWED.has(key))) return "invalid-schema";
  if (["source", "runId", "eventSessionId", "eventCompletionOwnerId", "ownershipDecision", "customType", "deliverAs", "deliveryResult"].some((key) => entry[key] !== undefined && typeof entry[key] !== "string") || ["triggerTurn", "display"].some((key) => entry[key] !== undefined && typeof entry[key] !== "boolean")) return "invalid-schema";
  if (entry.event === "completion-received" && (!(["async", "foreground"].includes(entry.source as string)) || typeof entry.runId !== "string" || typeof entry.eventSessionId !== "string" || typeof entry.eventCompletionOwnerId !== "string")) return "invalid-completion-identity";
  return undefined;
}

export function readWorkingStateTrace({ file, hostSessionId, maxBytes = 64 * 1024, maxRecords = 256, windowMs = 180_000, outputBudget = 32 * 1024 }: { file: string; hostSessionId: string; maxBytes?: number; maxRecords?: number; windowMs?: number; outputBudget?: number }) {
  if (!file || !hostSessionId || ![maxBytes, maxRecords, windowMs, outputBudget].every((value) => Number.isSafeInteger(value) && value > 0)) return { records: [], cause: "unproven", invalidTrace: "invalid-input" };
  let tail;
  try { tail = readTail(file, maxBytes); } catch { return { records: [], cause: "unproven", invalidTrace: "read-failed" }; }
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
  const records = entries.filter((entry) => entry.hostSessionId === hostSessionId).slice(-maxRecords);
  const latest = records.at(-1)?.monotonicMs;
  const windowed = Number.isSafeInteger(latest) ? records.filter((entry) => latest - entry.monotonicMs <= windowMs) : [];
  const result = { records: windowed, cause: "unproven", partialLeadingLine, partialTrailingLine, truncated: tail.truncated };
  return Buffer.byteLength(JSON.stringify(result), "utf8") > outputBudget ? { records: [], cause: "unproven", partialLeadingLine, partialTrailingLine, truncated: true, outputBudgetExceeded: true } : result;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [file, hostSessionId] = process.argv.slice(2);
  process.stdout.write(`${JSON.stringify(readWorkingStateTrace({ file, hostSessionId }))}\n`);
}
