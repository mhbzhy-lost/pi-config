import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const PHASES = new Set(["tool-entered", "agent-discovery-started", "agent-discovery-finished", "rpc-ping-sent", "rpc-ping-replied", "rpc-spawn-sent", "rpc-spawn-replied", "leaf-wait-started", "leaf-wait-finished", "tool-returned", "tool-failed"]);
// stage 的合法 producer 取值：extension.ts 的 trace.stage 与 errors.ts SUBAGENT_RPC_STAGES 的并集。
// 固定枚举，未知值一律 invalid-schema，不因“不认识”而放行。
const STAGES = new Set(["preallocate", "rpc-ping", "workflow-spawn", "child-binding", "grant-registration", "bind-run"]);
const ALLOWED = new Set(["version", "parentSessionId", "toolCallId", "phase", "monotonicMs", "method", "requestId", "rootRunId", "leafRunId", "errorCode", "stage", "negotiation"]);

// negotiation 是 producer 写入的 D0 `rpc-negotiation-diagnostic.v1` 投影：只允许固定键集、
// 固定枚举与布尔值。本 CLI 保持 import-free（不深引 package 内部生产模块），因此在此
// 独立执行同一白名单；任何额外键、路径形态值、正文或未知 capability 名均 fail closed。
const NEGOTIATION_BOOLEAN_FIELDS = [
  "capabilitiesEnvelopePresent", "versionOk", "spawnMethodOk", "sessionIdPresent",
  "lifecycleIdentityPresent", "sessionCwdPresent", "cwdEqual",
];
const NEGOTIATION_KEYS = new Set([
  "schemaVersion", "stage", "dispatchPath", ...NEGOTIATION_BOOLEAN_FIELDS, "missingCapabilities",
]);
const NEGOTIATION_DISPATCH_PATHS = new Set(["coding", "generic", "unknown"]);
const NEGOTIATION_MISSING_CAPABILITIES = new Set([
  "asyncSpawn", "processTerminalProof", "launchResolvedExtensions",
  "runtimeAcknowledgedExtensions", "rpc:v1/session",
]);

function validNegotiation(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const projection = value as Record<string, unknown>;
  if (Object.keys(projection).some((key) => !NEGOTIATION_KEYS.has(key))) return false;
  if (projection.schemaVersion !== "rpc-negotiation-diagnostic.v1") return false;
  if (projection.stage !== "spawn-capability-assertion") return false;
  if (typeof projection.dispatchPath !== "string" || !NEGOTIATION_DISPATCH_PATHS.has(projection.dispatchPath)) return false;
  if (NEGOTIATION_BOOLEAN_FIELDS.some((key) => typeof projection[key] !== "boolean")) return false;
  const missing = projection.missingCapabilities;
  if (!Array.isArray(missing)) return false;
  return missing.every((name) => typeof name === "string" && NEGOTIATION_MISSING_CAPABILITIES.has(name));
}

// D3：supervisor 诊断包络是与 dispatch trace 并列的另一种记录形态。producer 是 package
// sink 的独立 supervisor 分支（字段集等于 D0 SafeSupervisorTraceV1），它没有也不得伪造
// dispatch 身份（parentSessionId/toolCallId）。本 CLI 保持 import-free，因此在此独立执行
// 同一严格白名单：只允许 9 类 phase、固定 eventKind、安全 ID/枚举/布尔/有限正整数；
// 未知键、任意嵌套对象、正文/路径/digest 形态一律 invalid-schema，绝不“不认识就放行”。
const SUPERVISOR_EVENT_KIND = "supervisor-diagnostic";
const SUPERVISOR_PHASES = new Set([
  "supervisor-registration-failed", "supervisor-delivery-compensation-failed", "supervisor-owner-read-failed",
  "supervisor-runtime-read-failed", "supervisor-consumption-rejected", "supervisor-consumption-failed",
  "supervisor-persistence-corrupt", "supervisor-persistence-rejected", "supervisor-replay-failed",
]);
const SUPERVISOR_ALLOWED = new Set([
  "version", "eventKind", "phase", "monotonicMs", "runId", "requestId", "receiptId", "rootSessionId",
  "errorCode", "receiptStatus", "consumed", "requestGeneration", "ownerGeneration",
]);
const SUPERVISOR_ID_FIELDS = ["runId", "requestId", "receiptId", "rootSessionId"];
const SUPERVISOR_GENERATION_FIELDS = ["requestGeneration", "ownerGeneration"];
const SUPERVISOR_RECEIPT_STATUSES = new Set(["queued", "delivered", "failed"]);
// 与 diagnostics.ts / supervisor-control-plane.ts 同规则：安全 ID 与标识符形态错误码。
const SUPERVISOR_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const SUPERVISOR_ERROR_CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function validSupervisorDiagnostic(entry: Record<string, unknown>): boolean {
  if (entry.version !== 1 || entry.eventKind !== SUPERVISOR_EVENT_KIND) return false;
  if (typeof entry.phase !== "string" || !SUPERVISOR_PHASES.has(entry.phase)) return false;
  if (!Number.isSafeInteger(entry.monotonicMs) || (entry.monotonicMs as number) < 0) return false;
  if (Object.keys(entry).some((key) => !SUPERVISOR_ALLOWED.has(key))) return false;
  for (const field of SUPERVISOR_ID_FIELDS) {
    const value = entry[field];
    if (value !== undefined && (typeof value !== "string" || !SUPERVISOR_ID.test(value) || value.includes(".."))) return false;
  }
  if (entry.errorCode !== undefined && (typeof entry.errorCode !== "string" || !SUPERVISOR_ERROR_CODE.test(entry.errorCode))) return false;
  if (entry.receiptStatus !== undefined && (typeof entry.receiptStatus !== "string" || !SUPERVISOR_RECEIPT_STATUSES.has(entry.receiptStatus))) return false;
  if (entry.consumed !== undefined && typeof entry.consumed !== "boolean") return false;
  for (const field of SUPERVISOR_GENERATION_FIELDS) {
    const value = entry[field];
    if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 1)) return false;
  }
  return true;
}

/** 只有明确声称 supervisor 包络（eventKind 或 supervisor-* phase）的记录才走该分支。 */
function claimsSupervisorDiagnostic(entry: Record<string, unknown>): boolean {
  return entry.eventKind === SUPERVISOR_EVENT_KIND
    || (typeof entry.phase === "string" && entry.phase.startsWith("supervisor-"));
}

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
  // D3：supervisor 包络独立校验，且不回落 dispatch 身份门禁（它本来就不携带该身份）。
  // 声称 supervisor 却不合格 → invalid-schema；合格则只参与单调时序，不作为 dispatch 证据。
  if (claimsSupervisorDiagnostic(entry)) {
    if (!validSupervisorDiagnostic(entry)) return "invalid-schema";
    const clock = entry.monotonicMs as number;
    if (previous !== undefined && clock < previous) return "non-monotonic-time";
    return undefined;
  }
  if (typeof entry.parentSessionId !== "string" || !entry.parentSessionId || typeof entry.toolCallId !== "string" || !entry.toolCallId) return "invalid-identity";
  if (typeof entry.phase !== "string" || !PHASES.has(entry.phase)) return "invalid-phase";
  if (!Number.isSafeInteger(entry.monotonicMs)) return "invalid-monotonic-ms";
  if (previous !== undefined && entry.monotonicMs < previous) return "non-monotonic-time";
  if (Object.keys(entry).some((key) => !ALLOWED.has(key)) || ["method", "requestId", "rootRunId", "leafRunId", "errorCode"].some((key) => entry[key] !== undefined && typeof entry[key] !== "string")) return "invalid-schema";
  if (entry.stage !== undefined && (typeof entry.stage !== "string" || !STAGES.has(entry.stage))) return "invalid-schema";
  // negotiation 只允许出现在 tool-failed 记录上，与 producer sink 的写入合同一致。
  if (entry.negotiation !== undefined && (entry.phase !== "tool-failed" || !validNegotiation(entry.negotiation))) return "invalid-schema";
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
