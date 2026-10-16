import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileDispatchIR, isCodingDispatch, CodingDispatchContractError, renderDispatchPrompt } from "../contracts/dispatch-ir.ts";

import { createManagedWorkspaceRequestV2 } from "../workspace/contract.ts";
import { findManagedWorkspaceService } from "../workspace/registry.ts";
import { createSubagentWorkspaceTool } from "../workspace/tool.ts";
import { createWorkspaceOperationTools } from "../workspace/operation-tools.ts";
import { createTypedSubagentRpcClient, negotiateCapabilities } from "./rpc-client.ts";
import { createHeadlessSubagentApi } from "./runtime-membrane.ts";
import { buildWorkflowSpawn, createWorkflowChildStartCollector, childStartTimeoutMs } from "./workflow-spawn.ts";
import { getTitleRegistry, normalizeSubagentTitle } from "./title-registry.ts";
import { createSupervisorAdapter, createSupervisorTool } from "./supervisor-adapter.ts";
import { createSubagentOperationTools } from "./operation-tools.ts";
import { createSupervisorOperationTools } from "./supervisor-operation-tools.ts";
import { supervisorCanonicalDigest, type SupervisorDiagnosticsRequestV1, type SupervisorDiagnosticsV1 } from "./supervisor-control-plane.ts";
import { findGoalRunCoordinator } from "./root-broker-registry.ts";
import { resolveModelCandidates, resolveModelSelection, type ModelSelectionWarning } from "./model-selection.ts";
import { createRunAuthorization } from "./run-authorization.ts";
import { createAuthorizedDispatch } from "./execution-contract.ts";
import { dispatchExecution, createGenericDispatchAdapter, createCodingDispatchAdapter } from "./execution.ts";
import { createSubagentRpcFailureDetails } from "./errors.ts";
import {
  projectRpcNegotiation,
  projectSupervisorReceipt,
  projectSupervisorTrace,
  type RpcNegotiationDiagnosticV1,
  type RpcNegotiationDispatchPath,
  type RpcNegotiationDispatchPathProjection,
} from "./diagnostics.ts";
import { registerRequiredChildExtensions } from "pi-subagents/required-child-extensions";


const CLEANUP_KEY = "__typedSubagentRuntimeCleanup";
const SHUTDOWN_DEBT_KEY = "__typedSubagentRuntimeShutdownDebt";
const CONTROL_ACTIONS = new Set(["status", "steer", "interrupt", "resume", "stop", "list"]);
const LIST_EXCLUDED_FIELDS = new Set(["description", "frontmatter", "file", "path"]);

const stringList = {
  type: "array",
  items: { type: "string", minLength: 1, maxLength: 4096 },
  maxItems: 32,
};
const pathList = { ...stringList, minItems: 0 };

// The detailed branches guide model calls. Narrow fallbacks allow malformed
// expected containers through to compileCodingDispatchIR(), which owns precise
// coding-contract coercion and keypath diagnostics.
const runtimeValidated = (schema, fallback) => ({ anyOf: [schema, fallback, { type: "string" }] });
const looseObject = { type: "object", additionalProperties: true };
const looseArray = { type: "array" };

// Host 统一覆盖上游 execution deadline 默认值；留出 timer 上限余量，不替代 owner/lease 心跳回收。
const HOST_EXECUTION_TIMEOUT_MS = 2_147_000_000;

// 根节点保持显式单一 object：glm/zai 等严格 OpenAI 兼容端对顶层联合组合子
// （anyOf/oneOf/allOf）会生成空 arguments（docs/bugs/2026-09-14-glm-empty-tool-args-from-root-union-schema.md）。
// 分支互斥由 runtime 路由（action→control、writePaths→coding、其余→generic）与
// compileDispatchIR 的 keypath 诊断权威裁决；schema 只引导字段集与类型。

export const TYPED_SUBAGENT_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {

    title: { type: "string", minLength: 1, maxLength: 4096 },
    agent: { type: "string", minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001F\\u007F-\\u009F]*[^\\s\\u0000-\\u001F\\u007F-\\u009F][^\\u0000-\\u001F\\u007F-\\u009F]*$" },
    model: { type: "string", minLength: 1, maxLength: 512, pattern: ".*\\S.*" },
    thinkingLevel: { enum: ["minimal", "low", "medium", "high", "xhigh", "max"] },

    acceptance: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["criteria"],
          properties: {
            criteria: { ...stringList, minItems: 1 },
          },
        },
        looseObject,
        { type: "array" },
        { type: "string" },
      ],
    },
    writePaths: { ...pathList, minItems: 1 },
    // generic 分支字段
    // Runtime dispatch contract enforces the 32 KiB UTF-8-byte task limit
    // (MAX_TASK_BYTES in contracts/dispatch-ir.ts) and a 128 KiB rendered-prompt limit;
    // JSON Schema maxLength measures characters and cannot express that byte budget,
    // so the contract stays authoritative and no maxLength is declared here.
    task: { type: "string", minLength: 1 },
    cwd: { type: "string", minLength: 1, maxLength: 4096 },
    output: { anyOf: [{ type: "string", minLength: 1 }, { const: false }] },
    outputMode: { enum: ["inline", "file-only"] },
    outputSchema: { type: "object", additionalProperties: true },
    artifacts: { type: "boolean" },
    progress: { type: "boolean" },
    worktree: { type: "boolean" },
    skill: {
      anyOf: [
        { type: "string", minLength: 1 },
        { type: "array", items: { type: "string", minLength: 1 } },
        { type: "boolean" },
      ],
    },
    reads: {
      anyOf: [
        { type: "array", items: { type: "string", minLength: 1 } },
        { type: "boolean" },
      ],
    },
    // control 分支字段
    action: { enum: ["status", "steer", "interrupt", "resume", "stop", "list"] },

    id: { type: "string", minLength: 1, maxLength: 4096 },
    runId: { type: "string", minLength: 1, maxLength: 4096 },
    dir: { type: "string", minLength: 1, maxLength: 4096 },
    index: { type: "integer", minimum: 0 },
    message: { type: "string", minLength: 1, maxLength: 65536 },
  },
});

export const TYPED_SUBAGENT_DESCRIPTION = `通过项目自有的隔离 subagent runtime 委派任务。参数为顶层扁平字段，无 generic/coding 包装键；runtime 按路由决定派发类型：action→control、writePaths→coding、其余→generic。只读调研或纯文本工作用 {agent,task}；仓库变更用 {agent,task,writePaths,acceptance:{criteria:[...]}}。可用 agent：delegate（主力/复杂任务）、executor（确定性执行）、reviewer（评审）。用 {action:"list"} 查看当前 agent 名单。coding 的 acceptance 必须为 {criteria:[...]}，writePaths 至少包含一个仓库相对路径。

coding 任务需提供完整 dispatch-ir.v2 合同；writePaths 与 acceptance 必填，model 是唯一可选的模型选择器。qualified provider/model-id 必须与可用 catalog 精确匹配。agent 声明了 models/model 时，声明候选链先于显式 model 被整体校验，API guard 覆盖全部已解析候选而非仅最终选中者；显式 model 不能绕过不可用候选、profile 全部缺失或 API guard。带 agent 声明的裸 model-id 按声明顺序匹配第一个当前可用且 ID 精确相等的候选；未命中即失败，不会检索全局 catalog。无 agent 声明的裸 model-id 按完整 provider/model-id 升序匹配可用 catalog；该路径成功时在顶层 details.warnings 返回 MODEL_MATCH_USED_GLOBAL_CATALOG。省略 model 时在启动期按声明顺序选择第一个当前可用的 profile 候选；这不是 provider 错误模型回退。modelSelection 在适用时报告 requestedModel、resolvedModel 与 source；requested 与 resolved 均不冒充子代理实际模型，runtime run/status/artifact 的 actual-model 元数据才是权威。worktree 隔离通过顶层 worktree 与 cwd 字段声明。所有 spawn 均经 RPC 以 detached 方式执行。完成通知自动送达；spawn 成功后不要用 sleep、轮询 status 或 supervisor pending 等待完成。只继续与子代理无关的工作，若无则结束当前 turn。status 仅用于用户明确要求、需要干预或诊断。支持的 control action 为 status、steer、interrupt、resume、stop。interrupt 中断当前 turn；resume 必须携带非空新消息，可将 paused/completed/failed 的 run 以新 run（新子会话）方式续跑并注入新指令，不承诺在原存活进程内就地继续；stopped 的 subagent 不可 resume。worktree=true 时响应携带 workspace_id，可用 subagent_worktree({action:"status"}) 查询状态与 allowed_dispositions。publication=allowed 的 coding 托管工作区（Auto Integration）集成由子代理 integration queue 自主拥有：父层不能对其执行 integrate（会返回 CHILD_OWNS_INTEGRATION），宿主不自动重放集成；子代理自行发布并释放，coding 任务待其 released 才算成功完成。已 released 的工作区无需额外处置；仍处于 active/preserved/cleanup-debt 的，按 subagent_worktree 状态权威返回的 allowed_dispositions、可用动作与 action_token 操作。并非所有 worktree 都禁止父层 integrate：publication=forbidden（generic）的工作区能否 integrate 以状态权威返回为准。`;

const ASYNC_SPAWN_GUIDANCE = "Completion notifications arrive automatically; do not sleep, poll status, or call supervisor pending. If no independent work remains, end the turn.";
const TRACE_PHASES = new Set([
  "tool-entered", "agent-discovery-started", "agent-discovery-finished", "rpc-ping-sent", "rpc-ping-replied",
  "rpc-spawn-sent", "rpc-spawn-replied", "leaf-wait-started", "leaf-wait-finished", "grant-created", "grant-failed",
  "tool-returned", "tool-failed",
]);
const WORKING_STATE_EVENTS = new Set([
  "host-idle", "completion-received", "ownership-match", "ownership-mismatch", "send-message",
  "delivery-result", "agent-start", "agent-end", "agent-settled", "ui-prompt-start", "ui-prompt-end",
]);

/** D0 投影允许的 dispatchPath 字面量；白名单外一律拒绝，不回显调用方取值。 */
const RPC_NEGOTIATION_DISPATCH_PATHS: readonly RpcNegotiationDispatchPathProjection[] = Object.freeze([
  "coding", "generic", "unknown",
]);
/** D0 投影的 7 个布尔结论字段；缺任一字段或类型不符即拒绝整条投影。 */
const RPC_NEGOTIATION_BOOLEAN_FIELDS = Object.freeze([
  "capabilitiesEnvelopePresent", "versionOk", "spawnMethodOk", "sessionIdPresent",
  "lifecycleIdentityPresent", "sessionCwdPresent", "cwdEqual",
]);
/** missingCapabilities 只可能是 4 个既有安全 capability 名与复合身份标签。 */
const RPC_NEGOTIATION_MISSING_WHITELIST = Object.freeze([
  "asyncSpawn", "processTerminalProof", "launchResolvedExtensions",
  "runtimeAcknowledgedExtensions", "rpc:v1/session",
]);
/** 完整键集：出现白名单外的键即视为畸形/投毒输入，整条投影 fail closed。 */
const RPC_NEGOTIATION_ALLOWED_KEYS = Object.freeze([
  "schemaVersion", "stage", "dispatchPath", ...RPC_NEGOTIATION_BOOLEAN_FIELDS, "missingCapabilities",
]);

/**
 * D1：trace sink 侧的 negotiation 白名单再校验。只有结构完整的 D0 投影才允许落盘，
 * 且逐字段重建（绝不展开原对象），因此调用方自带的 error.detail、正文、路径或未知
 * capability 名都不可能借该嵌套字段进入诊断文件。
 */
function safeRpcNegotiationDiagnostic(value: unknown): RpcNegotiationDiagnosticV1 | undefined {
  // 本文件的 isRecord() 没有类型谓词，在此就地窄化，不改动共享判定函数。
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const projection = value as Record<string, unknown>;
  for (const key of Object.keys(projection)) {
    if (!RPC_NEGOTIATION_ALLOWED_KEYS.includes(key)) return undefined;
  }
  if (projection.schemaVersion !== "rpc-negotiation-diagnostic.v1") return undefined;
  if (projection.stage !== "spawn-capability-assertion") return undefined;
  const dispatchPath = RPC_NEGOTIATION_DISPATCH_PATHS.find((name) => name === projection.dispatchPath);
  if (dispatchPath === undefined) return undefined;
  for (const field of RPC_NEGOTIATION_BOOLEAN_FIELDS) {
    if (typeof projection[field] !== "boolean") return undefined;
  }
  const missing = projection.missingCapabilities;
  if (!Array.isArray(missing)) return undefined;
  const missingCapabilities: string[] = [];
  for (const name of missing) {
    if (typeof name !== "string" || !RPC_NEGOTIATION_MISSING_WHITELIST.includes(name)) return undefined;
    if (!missingCapabilities.includes(name)) missingCapabilities.push(name);
  }
  return {
    schemaVersion: "rpc-negotiation-diagnostic.v1",
    stage: "spawn-capability-assertion",
    dispatchPath,
    capabilitiesEnvelopePresent: projection.capabilitiesEnvelopePresent as boolean,
    versionOk: projection.versionOk as boolean,
    spawnMethodOk: projection.spawnMethodOk as boolean,
    sessionIdPresent: projection.sessionIdPresent as boolean,
    lifecycleIdentityPresent: projection.lifecycleIdentityPresent as boolean,
    sessionCwdPresent: projection.sessionCwdPresent as boolean,
    cwdEqual: projection.cwdEqual as boolean,
    missingCapabilities: Object.freeze(missingCapabilities),
  };
}

/* ------------------------------------------------------------------ *
 * D3：supervisor 诊断安全包络（status/reply 只读投影 + trace sink 独立分支）
 * ------------------------------------------------------------------ */

/** 与 diagnostics.ts / supervisor-control-plane.ts 同规则的 safe ID 形态：路径、正文、oversize 一律拒绝。 */
const SAFE_DIAGNOSTIC_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
/** D2 readDiagnostics 的唯一 schemaVersion 与唯一 unavailable code（固定值，不含任何底层错误细节）。 */
const SUPERVISOR_DIAGNOSTICS_SCHEMA_VERSION = "supervisor-diagnostics.v1";
const SUPERVISOR_DIAGNOSTICS_UNAVAILABLE_CODE = "SUPERVISOR_DIAGNOSTICS_UNAVAILABLE";
/** 包络顶层键集；出现白名单外的键即视为畸形/投毒输入，整份投影 fail closed。 */
const SUPERVISOR_DIAGNOSTICS_ALLOWED_KEYS = Object.freeze([
  "schemaVersion", "availability", "code", "requests", "receipts", "complete",
]);
/** request 投影行的精确白名单键集与状态枚举（计划 D2/D3 字段）。 */
const SUPERVISOR_DIAGNOSTIC_REQUEST_KEYS = Object.freeze([
  "requestId", "runId", "state", "ownerGeneration", "requestGeneration", "createdAt", "expiresAt", "childIndex", "classification",
]);
const SUPERVISOR_REQUEST_STATES: readonly string[] = Object.freeze([
  "pending", "replying", "replied", "expired", "failed",
]);
/** D2 每组 50 条上限；超出说明合同被违背，整份投影 fail closed，不做部分透传。 */
const SUPERVISOR_DIAGNOSTIC_GROUP_LIMIT = 50;

/** 与既有 trace 记录一致的单调钟（毫秒）；只用于诊断包络层，不作为业务时间事实。 */
function monotonicNowMs(): number {
  return Math.floor(Number(process.hrtime.bigint() / 1_000_000n));
}

/** root 不可验证或读取失败时的 fail-closed 包络；绝不表达成「无 pending」。 */
function unavailableSupervisorDiagnostics(): SupervisorDiagnosticsV1 {
  return Object.freeze({
    schemaVersion: SUPERVISOR_DIAGNOSTICS_SCHEMA_VERSION,
    availability: "unavailable" as const,
    code: SUPERVISOR_DIAGNOSTICS_UNAVAILABLE_CODE,
    requests: Object.freeze([]),
    receipts: Object.freeze([]),
    complete: false,
  });
}

const safeDiagnosticId = (value: unknown): string | undefined =>
  typeof value === "string" && SAFE_DIAGNOSTIC_ID.test(value) && !value.includes("..") ? value : undefined;

const boundedClock = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const positiveGeneration = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;

/** request 投影行：逐字段重建（绝不展开原对象），任一字段畸形即拒绝整份包络。 */
function safeSupervisorDiagnosticRequest(value: unknown): SupervisorDiagnosticsRequestV1 | undefined {
  if (!isRecord(value)) return undefined;
  const row = value as Record<string, unknown>;
  for (const key of Object.keys(row)) {
    if (!SUPERVISOR_DIAGNOSTIC_REQUEST_KEYS.includes(key)) return undefined;
  }
  const requestId = safeDiagnosticId(row.requestId);
  const runId = safeDiagnosticId(row.runId);
  const state = typeof row.state === "string" ? SUPERVISOR_REQUEST_STATES.find((name) => name === row.state) : undefined;
  const ownerGeneration = positiveGeneration(row.ownerGeneration);
  const requestGeneration = positiveGeneration(row.requestGeneration);
  const createdAt = boundedClock(row.createdAt);
  const expiresAt = boundedClock(row.expiresAt);
  if (requestId === undefined || runId === undefined || state === undefined || ownerGeneration === undefined
    || requestGeneration === undefined || createdAt === undefined || expiresAt === undefined) return undefined;
  const childIndex = row.childIndex === undefined ? undefined : boundedClock(row.childIndex);
  const classification = row.classification;
  if (row.childIndex !== undefined && childIndex === undefined) return undefined;
  if (classification !== undefined && !["needs-reply", "reply-submitted", "consumed", "cleared", "terminal", "scope-unverified"].includes(classification as string)) return undefined;
  return Object.freeze({
    requestId, runId, state: state as SupervisorDiagnosticsRequestV1["state"],
    ownerGeneration, requestGeneration, createdAt, expiresAt,
    ...(childIndex === undefined ? {} : { childIndex }),
    ...(classification === undefined ? {} : { classification: classification as string }),
  });
}

/**
 * D3：对 D2 readDiagnostics 的输出再做一次白名单重建后才允许进入工具 details。
 * receipt 行复用 D0 的 projectSupervisorReceipt（同一权威投影），任何偏离都 fail closed
 * 成 unavailable，绝不把畸形/未知字段透传给模型或落进会话 details。
 */
function safeSupervisorDiagnostics(value: unknown): SupervisorDiagnosticsV1 {
  if (!isRecord(value)) return unavailableSupervisorDiagnostics();
  const envelope = value as Record<string, unknown>;
  for (const key of Object.keys(envelope)) {
    if (!SUPERVISOR_DIAGNOSTICS_ALLOWED_KEYS.includes(key)) return unavailableSupervisorDiagnostics();
  }
  if (envelope.schemaVersion !== SUPERVISOR_DIAGNOSTICS_SCHEMA_VERSION) return unavailableSupervisorDiagnostics();
  const availability = envelope.availability === "available" || envelope.availability === "unavailable"
    ? envelope.availability
    : undefined;
  if (availability === undefined || typeof envelope.complete !== "boolean") return unavailableSupervisorDiagnostics();
  // code 只可能是固定 unavailable 码，且只允许出现在 unavailable 包络上。
  if (envelope.code !== undefined
    && (availability !== "unavailable" || envelope.code !== SUPERVISOR_DIAGNOSTICS_UNAVAILABLE_CODE)) {
    return unavailableSupervisorDiagnostics();
  }
  if (!Array.isArray(envelope.requests) || !Array.isArray(envelope.receipts)) return unavailableSupervisorDiagnostics();
  if (envelope.requests.length > SUPERVISOR_DIAGNOSTIC_GROUP_LIMIT
    || envelope.receipts.length > SUPERVISOR_DIAGNOSTIC_GROUP_LIMIT) return unavailableSupervisorDiagnostics();
  // unavailable 是 fail-closed 语义，不允许同时携带任何 request/receipt 事实。
  if (availability === "unavailable" && (envelope.requests.length > 0 || envelope.receipts.length > 0)) {
    return unavailableSupervisorDiagnostics();
  }
  const requests: SupervisorDiagnosticsRequestV1[] = [];
  for (const raw of envelope.requests) {
    const projected = safeSupervisorDiagnosticRequest(raw);
    if (projected === undefined) return unavailableSupervisorDiagnostics();
    requests.push(projected);
  }
  const receipts = [];
  for (const raw of envelope.receipts) {
    const projected = projectSupervisorReceipt(raw);
    if (projected === undefined) return unavailableSupervisorDiagnostics();
    receipts.push(projected);
  }
  return Object.freeze({
    schemaVersion: SUPERVISOR_DIAGNOSTICS_SCHEMA_VERSION,
    availability,
    ...(availability === "unavailable" ? { code: SUPERVISOR_DIAGNOSTICS_UNAVAILABLE_CODE } : {}),
    requests: Object.freeze(requests),
    receipts: Object.freeze(receipts),
    complete: envelope.complete,
  });
}

/**
 * D3：只有 phase/type 声称 `supervisor-` 的记录才进入 sink 的独立 supervisor 分支；
 * 其余记录的 version/monotonicMs 门禁与既有白名单一字未改。前缀只是廉价预筛，
 * 9 类枚举的权威判定仍由 D0 projectSupervisorTrace 完成。
 */
function supervisorDiagnosticCandidate(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  const record = entry as Record<string, unknown>;
  const label = typeof record.phase === "string" ? record.phase
    : typeof record.type === "string" ? record.type : undefined;
  return label !== undefined && label.startsWith("supervisor-");
}

/**
 * D3：只在工具结果的 details 上追加一个诊断字段；content、isError 与其余字段按原值保留，
 * 原结果对象不被改写（可能是 frozen 或调用方持有的 raw）。无法安全追加时原样返回，
 * 绝不为了展示诊断而覆盖或重建 raw details。
 */
function withSupervisorDiagnosticDetail(
  result: unknown,
  key: "supervisorDiagnostic" | "deliveryReceiptDiagnostic",
  value: unknown,
) {
  if (value === undefined || !isRecord(result)) return result;
  const record = result as Record<string, unknown>;
  if (record.details !== undefined && !isRecord(record.details)) return result;
  const details = {
    ...(isRecord(record.details) ? record.details as Record<string, unknown> : {}),
    [key]: value,
  };
  return { ...record, details };
}

export function createSubagentDispatchTraceFileSink(file = process.env.PI_SUBAGENT_DISPATCH_TRACE_FILE): (((entry: unknown) => void) & { dispose?: () => void }) | undefined {
  if (file === undefined || file === "") return undefined;
  if (typeof file !== "string") throw new TypeError("subagent dispatch trace path must be a string");
  const validate = (info) => info.isFile() && !info.isSymbolicLink()
    && info.uid === process.getuid() && (info.mode & 0o777) === 0o600;
  const initial = lstatSync(file);
  if (!validate(initial)) {
    throw new Error("subagent dispatch trace file must be caller-owned 0600 regular file");
  }
  let fd;
  let opened;
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    opened = fstatSync(fd);
    if (!validate(opened) || opened.dev !== initial.dev || opened.ino !== initial.ino) {
      throw new Error("subagent dispatch trace file changed while opening");
    }
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch { /* Opening validation failed. */ }
    throw error;
  }
  let closed = false;
  /** 唯一写入门禁：0600/O_NOFOLLOW/inode 复核、失败即永久关闭（D1 原样保留，仅提取为局部闭包）。 */
  const persist = (record: unknown) => {
    try {
      const current = lstatSync(file);
      const held = fstatSync(fd);
      if (!validate(current) || !validate(held) || current.dev !== opened.dev || current.ino !== opened.ino
          || held.dev !== opened.dev || held.ino !== opened.ino) {
        closed = true;
        closeSync(fd);
        return;
      }
      writeSync(fd, `${JSON.stringify(record)}\n`, undefined, "utf8");
    } catch {
      closed = true;
      try { closeSync(fd); } catch { /* 诊断文件已经不可用。 */ }
    }
  };
  /** 既有 dispatch/working-state 白名单记录（形状、门禁与 D1 完全一致，仅提取为局部函数）。 */
  const traceRecord = (entry: any) => {
    if (!entry || entry.version !== 1 || !Number.isSafeInteger(entry.monotonicMs)) return undefined;
    // D1：只有 tool-failed 可以携带嵌套 negotiation 投影；其余 phase 一律忽略该字段。
    const negotiation = entry.phase === "tool-failed" ? safeRpcNegotiationDiagnostic(entry.negotiation) : undefined;
    return typeof entry.toolCallId === "string" && TRACE_PHASES.has(entry.phase)
      ? {
        version: 1, toolCallId: entry.toolCallId, phase: entry.phase, monotonicMs: entry.monotonicMs,
        ...(typeof entry.parentSessionId === "string" ? { parentSessionId: entry.parentSessionId } : {}),
        ...(typeof entry.method === "string" ? { method: entry.method } : {}),
        ...(typeof entry.requestId === "string" ? { requestId: entry.requestId } : {}),
        ...(typeof entry.rootRunId === "string" ? { rootRunId: entry.rootRunId } : {}),
        ...(typeof entry.leafRunId === "string" ? { leafRunId: entry.leafRunId } : {}),
        ...(typeof entry.errorCode === "string" ? { errorCode: entry.errorCode } : {}),
        ...(typeof entry.stage === "string" ? { stage: entry.stage } : {}),
        ...(typeof entry.timestamp === "string" ? { timestamp: entry.timestamp } : {}),
        ...(negotiation === undefined ? {} : { negotiation }),
      }
      : typeof entry.hostSessionId === "string" && typeof entry.completionOwnerId === "string" && WORKING_STATE_EVENTS.has(entry.event)
        ? {
          version: 1, hostSessionId: entry.hostSessionId, completionOwnerId: entry.completionOwnerId,
          event: entry.event, monotonicMs: entry.monotonicMs,
          ...(typeof entry.source === "string" ? { source: entry.source } : {}),
          ...(typeof entry.runId === "string" ? { runId: entry.runId } : {}),
          ...(typeof entry.eventSessionId === "string" ? { eventSessionId: entry.eventSessionId } : {}),
          ...(typeof entry.eventCompletionOwnerId === "string" ? { eventCompletionOwnerId: entry.eventCompletionOwnerId } : {}),
          ...(typeof entry.ownershipDecision === "string" ? { ownershipDecision: entry.ownershipDecision } : {}),
          ...(typeof entry.customType === "string" ? { customType: entry.customType } : {}),
          ...(typeof entry.triggerTurn === "boolean" ? { triggerTurn: entry.triggerTurn } : {}),
          ...(typeof entry.deliverAs === "string" ? { deliverAs: entry.deliverAs } : {}),
          ...(typeof entry.display === "boolean" ? { display: entry.display } : {}),
          ...(typeof entry.deliveryResult === "string" ? { deliveryResult: entry.deliveryResult } : {}),
        }
        : undefined;
  };
  const sink: ((entry: unknown) => void) & { dispose?: () => void } = (entry: any) => {
    if (closed) return;
    // 既有白名单优先：任何原本能落盘的记录形状不变，即使被投毒附加 supervisor-* 字段。
    const record = traceRecord(entry);
    if (record !== undefined) {
      persist(record);
      return;
    }
    // D3：supervisor 诊断是独立白名单分支，不受上面 dispatch/working-state 的 version+monotonicMs
    // 门禁约束（多数 producer 不带这两个字段）；version 与单调钟只在诊断包络层补齐，不补业务
    // 身份与消费事实。error/cause/secondaryError/compensation 对象、正文、路径、token、payload digest
    // 均不落盘。未知 supervisor-* phase/type fail closed（整条丢弃），也不回落到其它分支。
    if (!supervisorDiagnosticCandidate(entry)) return;
    const supervisor = projectSupervisorTrace(entry, monotonicNowMs());
    if (supervisor !== undefined) persist(supervisor);
  };
  sink.dispose = () => {
    if (closed) return;
    closed = true;
    closeSync(fd);
  };
  return sink;
}

type ModelSelectionResult = {
  source: string;
  model?: string;
  requestedModel?: string;
  warnings?: ModelSelectionWarning[];
};

type LifecycleHook = (event: unknown, context: unknown) => Promise<void>;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value) {
  return typeof value === "string" && value.length > 0;
}

function normalizeAgentProfile(value) {
  if (typeof value !== "string") {
    const error = new Error("agent must be a string");
    error.code = "INVALID_AGENT";
    throw error;
  }
  const normalized = value.trim();
  if (!normalized || /[\u0000-\u001F\u007F-\u009F]/.test(normalized) || Buffer.byteLength(normalized, "utf8") > 256) {
    const error = new Error("agent must be a trimmed non-empty profile without control characters and at most 256 bytes");
    error.code = "INVALID_AGENT";
    throw error;
  }
  return normalized;
}

function failure(code, message, detail = undefined, keypath = undefined) {
  const keypathSuffix = keypath === undefined || message.includes(`keypath=${keypath}`) ? "" : `; keypath=${keypath}`;
  const text = `${code}: ${message}${keypathSuffix}`;
  return {
    content: [{ type: "text", text }],
    isError: true,
    details: {
      code,
      ...(detail !== undefined ? { detail } : {}),
      ...(keypath !== undefined ? { keypath } : {}),
    },
  };
}

function rpcResult(reply) {
  return {
    content: [{ type: "text", text: nonempty(reply?.text) ? reply.text : "Subagent RPC request completed." }],
    isError: reply?.isError === true,
    ...(reply?.details !== undefined ? { details: reply.details } : {}),
  };
}

function lifecycleSessionIdentity(session) {
  const sessionFile = session?.sessionFile;
  if (sessionFile !== null && sessionFile !== undefined && !nonempty(sessionFile)) return undefined;
  const identity = sessionFile ?? session?.sessionId;
  return nonempty(identity) ? identity : undefined;
}

function assertSpawnCapabilities(result, cwd, dispatchPath: RpcNegotiationDispatchPath) {
  const methods = new Set(Array.isArray(result?.methods) ? result.methods : []);
  const session = result?.session;
  const securityMissing = [];
  // Responses with an explicit capabilities envelope are authoritative 0.71+
  // negotiation responses. Legacy test doubles without that envelope retain the
  // static v1 identity assertion; they do not represent a production endpoint.
  if (result?.capabilities && typeof result.capabilities === "object") {
    for (const capability of ["asyncSpawn", "processTerminalProof", "launchResolvedExtensions", "runtimeAcknowledgedExtensions"]) {
      // 0.71 契约形态（rpc.js:307-336）：capability 可为布尔或对象（含 version 等元数据）；
      // 存在且非 null/undefined/false 即视为具备，与 rpc-client 的 capabilityValue 语义一致。
      const value = result.capabilities[capability];
      if (value === undefined || value === null || value === false) securityMissing.push(capability);
    }
  }
  if (
    result?.version !== 1
    || !methods.has("spawn")
    || !nonempty(session?.sessionId)
    || !lifecycleSessionIdentity(session)
    || !nonempty(session?.cwd)
    || session.cwd !== cwd
  ) securityMissing.push("rpc:v1/session");
  if (securityMissing.length) {
    const error: any = new Error(`pi-subagents RPC capability negotiation failed; missing: ${securityMissing.join(", ")}`);
    error.code = "CAPABILITY_NEGOTIATION_FAILED";
    error.missingCapabilities = securityMissing;
    error.upgradeStopped = true;
    // D1：只在失败时附 D0 布尔投影（无正文/路径/身份值）；准入判定、code/message、
    // missingCapabilities、upgradeStopped 与上面的断言顺序全部保持原样。
    error.detail = Object.freeze({ negotiation: projectRpcNegotiation(result, cwd, dispatchPath) });
    throw error;
  }
}

function spawnBinding(reply, capabilities = undefined) {
  const details = reply?.details ?? reply;
  if (capabilities?.capabilities && typeof capabilities.capabilities === "object") {
    for (const [field, capability] of [["runId", "spawnReplyIdentity"], ["asyncDir", "spawnReplyIdentity"], ["cwd", "spawnReplyCwd"]]) {
      if (capabilities.capabilities[capability] === true && !nonempty(details?.[field])) {
        const error = new Error(`pi-subagents spawn reply is missing ${field}`);
        error.code = "SPAWN_REPLY_INVALID";
        throw error;
      }
    }
    if (capabilities.capabilities.spawnReplyCwd === true && details.cwd !== capabilities.session?.cwd) {
      const error = new Error("pi-subagents spawn reply cwd does not match negotiated cwd");
      error.code = "SPAWN_REPLY_INVALID";
      throw error;
    }
  }
  const runId = details?.runId ?? details?.asyncId;
  const asyncDir = details?.asyncDir;
  if (!nonempty(runId) || !nonempty(asyncDir)) {
    const error = new Error("pi-subagents spawn reply is missing runId or asyncDir");
    error.code = "SPAWN_REPLY_INVALID";
    throw error;
  }
  return { runId, asyncDir, ...(nonempty(details?.cwd) ? { cwd: details.cwd } : {}) };
}

function assertCodingSpawnIdentity(identity) {
  if (!isRecord(identity) || !nonempty(identity.requestId) || !nonempty(identity.spawnKey) || identity.requestId !== identity.spawnKey) {
    const error = new Error("coding spawn identity must provide matching non-empty requestId and spawnKey");
    error.code = "SPAWN_IDENTITY_INVALID";
    throw error;
  }
}

const CODING_ACCEPTANCE_EVIDENCE = Object.freeze([
  "changed-files",
  "tests-added",
  "commands-run",
  "validation-output",
  "residual-risks",
  "no-staged-files",
]);
const ROOT_SESSION_OWNER_EXTENSION = fileURLToPath(new URL("../../child-extensions/root-session-owner.ts", import.meta.url));
const ACCEPTANCE_EVIDENCE_EXTENSION = fileURLToPath(new URL("../../child-extensions/acceptance-evidence.ts", import.meta.url));
const INTEGRATION_QUEUE_EXTENSION = fileURLToPath(new URL("../../child-extensions/integration-queue.ts", import.meta.url));

export function codingWorkflowSpawnParams(ir, prompt, workflowKey, goalTicket?) {
  return buildWorkflowSpawn({
    workflowKey,
    agent: ir.agent,
    task: prompt,
    orchestratorCwd: ir.orchestratorCwd ?? ir.cwd,
    childCwd: ir.cwd,

    context: "fresh",
    child: {
      output: false,
      ...(ir.worktree && ir.rootSessionId ? { extensionBindings: { 'pi-config.root/1': { rootSessionId: ir.rootSessionId } } } : {}),
      timeoutMs: HOST_EXECUTION_TIMEOUT_MS,
      ...((ir.worktree || goalTicket) ? {
        subagentOnlyExtensions: [
          ...(ir.worktree ? [INTEGRATION_QUEUE_EXTENSION] : []),
          ...(goalTicket ? [ACCEPTANCE_EVIDENCE_EXTENSION] : []),
        ],
      } : {}),

      ...(ir.model === undefined ? {} : { model: ir.model }),
      ...(ir.thinkingLevel === undefined ? {} : { thinking: ir.thinkingLevel }),
    },
    acceptance: {
      criteria: ir.acceptance.criteria,
      evidence: CODING_ACCEPTANCE_EVIDENCE,
    },
  });
}

function genericWorkflowSpawnParams(input, ctx, workflowKey) {
  const child: Record<string, unknown> = { timeoutMs: HOST_EXECUTION_TIMEOUT_MS };
  for (const key of ["model", "output", "outputMode", "outputSchema", "skill", "reads", "progress", "acceptance"]) {
    if (input[key] !== undefined) child[key] = input[key];
  }
  if (input.thinkingLevel !== undefined) child.thinking = input.thinkingLevel;
  return buildWorkflowSpawn({
    workflowKey,
    agent: input.agent,
    task: input.task,
    orchestratorCwd: input.orchestratorCwd ?? input.cwd ?? ctx.cwd,
    childCwd: input.childCwd,
    cwd: input.cwd ?? ctx.cwd,
    context: input.context ?? "fresh",
    artifacts: input.artifacts ?? true,
    child,
  });
}

// Bug docs/bugs/2026-09-29-authority-lock-contention-orphan-spawn.md 修复面③：
// 派发失败后对已 spawn 的 root/leaf 经既有 typed RPC client 的 stop control method
// 尽力回滚，阻止孤儿 run 与重派副本并行重复执行。尽力语义：stop 失败仅记日志，
// 绝不改变原失败错误；不新造协议、不改 rpc-client。复用上游 stopAsyncRun 语义：
// 运行中的 run（leaf 或仍在运行的 workflow root）会被终止；已完成的 root facade
// 返回 invalid_state，同样仅记日志。
async function stopSpawnedRunsBestEffort(rpc, spawnedRunIds) {
  if (!Array.isArray(spawnedRunIds) || spawnedRunIds.length === 0) return;
  const runIds = [...new Set(spawnedRunIds.filter((runId) => nonempty(runId)))];
  if (runIds.length === 0) return;
  if (typeof rpc?.stop !== "function") {
    console.error(`[typed-subagent-runtime] rollback stop unavailable: spawned runs ${runIds.join(", ")} have no RPC stop channel`);
    return;
  }
  await Promise.all(runIds.map(async (runId) => {
    try {
      await rpc.stop({ runId });
    } catch (error) {
      console.error(`[typed-subagent-runtime] rollback stop failed for spawned run ${runId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
}

async function spawnWorkflowLeaf(pi, rpc, {
  workflowKey,
  agent,
  sessionId,
  timeoutMs,
  params,
  capabilities = undefined,
  identity = undefined,
  titleRegistry,
  onBinding,
  trace,
  spawnedRunIds = undefined,
}) {
  const collector = createWorkflowChildStartCollector(pi.events, {
    workflowKey,
    agent,
    sessionId,
    timeoutMs,
    // leaf 绑定先于调用方 onBinding 记录，后续注册同步抛错时失败路径才能对已 spawn 的 leaf 回滚。
    onBinding: spawnedRunIds === undefined ? onBinding : (observed) => {
      spawnedRunIds.push(observed.runId);
      onBinding?.(observed);
    },
  });
  try {
    const rootReply = await rpc.spawn(params, { ...identity, diagnostic: { toolCallId: trace?.toolCallId, sink: trace } });
    const root = capabilities?.validateSpawnReply
      ? capabilities.validateSpawnReply(rootReply)
      : spawnBinding(rootReply, capabilities);
    spawnedRunIds?.push(root.runId);
    titleRegistry.bindWorkflowRoot(root.runId);
    trace?.("leaf-wait-started", { rootRunId: root.runId });
    let leaf;
    try {
      leaf = await collector.waitFor(root);
      trace?.("leaf-wait-finished", { rootRunId: root.runId, leafRunId: leaf.runId });
    } catch (error) {
      trace?.("leaf-wait-finished", { rootRunId: root.runId, errorCode: error?.code ?? "WORKFLOW_CHILD_START_FAILED" });
      throw error;
    }
    titleRegistry.bindWorkflowLeaf(root.runId, leaf.runId);
    return leaf;
  } catch (error) {
    // 失败路径尽力回滚（修复面③）：对已 spawn 的 root（及已观察到绑定的 leaf）发起 stop；
    // stop 失败仅记日志，原错误照常上抛。
    await stopSpawnedRunsBestEffort(rpc, spawnedRunIds);
    throw error;
  } finally {
    collector.cancel();
  }
}

function workspacePublic(value) {
  const workspace = value?.receipt ?? value;
  const allowed = value?.allowedDispositions;
  const blocked = value?.blockedReasons;
  const hasActionToken = workspace?.state === "active"
    && Array.isArray(allowed) && allowed.length > 0
    && typeof value?.actionToken === "string" && value.actionToken.length > 0;
  return {
    workspace_id: workspace.workspaceId,
    state: workspace.state,
    workspace_state: workspace.state,
    lease_id: workspace.leaseId,
    process_terminal: value?.terminalProof?.state ?? "unknown",
    ...(workspace.dispatchCwd ? { dispatch_cwd: workspace.dispatchCwd } : {}),
    ...(allowed ? { allowed_dispositions: allowed } : {}),
    ...(hasActionToken ? { action_token: value.actionToken } : {}),
    ...(blocked ? { integrate_blocked_reasons: blocked } : {}),
  };
}
function defaultCanonicalOrigin({ requestedCwd }) {
  const cwd = realpathSync(requestedCwd);
  return realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim());
}
function defaultWorkspaceSource({ originRoot }) {
  return {
    originRef: execFileSync("git", ["symbolic-ref", "--quiet", "HEAD"], { cwd: originRoot, encoding: "utf8" }).trim(),
    baseCommit: execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: originRoot, encoding: "utf8" }).trim(),
  };
}

function genericContractHash(input, requestedCwd) {
  return createHash("sha256").update(JSON.stringify({
    agent: input.agent,
    title: input.title,
    task: input.task,
    context: input.context ?? "fresh",
    requestedCwd,
    ...(input.model === undefined ? {} : { model: input.model.trim() }),
  })).digest("hex");
}

type DiscoveredAgent = {
  name: string;
  description?: string;
  systemPrompt?: string;
  models?: string[];
  model?: string;
  fallbackModels?: string[];
  thinking?: string | false;
  tools?: string[];
  disabled?: boolean;
  filePath?: string;
  /** repository admission 附带的完整原始 frontmatter 解析对象；仅 list 展示用，上游 discovery 来源没有。 */
  metadata?: Record<string, unknown>;
};
type AgentDiscovery = { agents: DiscoveredAgent[]; admission?: string };

async function defaultDiscoverAgents(..._args): Promise<AgentDiscovery> {
  // 0.71 exposes registration, not discovery (contract §2.8). Admission must
  // be supplied by the Host/root broker; never scan directories or recreate the
  // upstream discovery authority in this integration layer.
  const error = new Error("AGENT_ADMISSION_UNAVAILABLE");
  error.code = "AGENT_ADMISSION_UNAVAILABLE";
  throw error;
}

async function resolveSpawnModel(input, ctx, discover, trace, blockedProviders = []) : Promise<ModelSelectionResult> {
  const requestedModel = input.model?.trim();
  trace?.("agent-discovery-started");
  let discovery;
  try {
    discovery = await discover(ctx.cwd, "both", ctx.model?.provider);
  } finally {
    trace?.("agent-discovery-finished");
  }
  const agent = discovery.agents.find((candidate) => candidate.name === input.agent);
  if (!agent) {
    const admissionUnavailable = discovery.admission === "repository-configured";
    const error = new Error(admissionUnavailable ? "AGENT_ADMISSION_UNAVAILABLE" : `Unknown agent: ${input.agent}`);
    error.code = admissionUnavailable ? "AGENT_ADMISSION_UNAVAILABLE" : "UNKNOWN_AGENT";
    throw error;
  }
  const declaredProfile = agent.models !== undefined || agent.model !== undefined || agent.fallbackModels !== undefined;
  if (!requestedModel && !declaredProfile) return { source: 'default' };
  const availableModels = ctx.modelRegistry?.getAvailable();
  if (!Array.isArray(availableModels)) {
    const error = new Error("MODEL_REGISTRY_UNAVAILABLE");
    error.code = "MODEL_REGISTRY_UNAVAILABLE";
    throw error;
  }
  const candidates = declaredProfile ? resolveModelCandidates({
    agentName: input.agent,
    models: agent.models,
    model: agent.model,
    fallbackModels: agent.fallbackModels,
    availableModels,
    blockedProviders,
  }) : undefined;
  if (!requestedModel) return { source: "agent-default", model: candidates![0] };
  const selection = resolveModelSelection({
    requestedModel,
    agentName: input.agent,
    agentModels: candidates,
    availableModels,
    blockedProviders,
  });
  return {
    model: selection.model,
    source: selection.source,
    requestedModel,
    ...(selection.warnings ? { warnings: selection.warnings } : {}),
  };
}

function modelSelectionDetails(selection) {
  return {
    source: selection.source,
    ...(selection.model === undefined ? {} : { resolvedModel: selection.model }),
    ...(selection.requestedModel === undefined ? {} : { requestedModel: selection.requestedModel }),
  };
}

function modelSelectionWarningText(selection) {
  if (!selection.warnings) return "";
  return ` Warning: requested model ${selection.requestedModel} matched ${selection.model} from the global model catalog.`;
}

function canonicalStandaloneToolCallId(toolCallId) {
  if (!nonempty(toolCallId)) {
    const error = new Error("WORKSPACE_TOOL_CALL_ID_UNAVAILABLE");
    error.code = "WORKSPACE_TOOL_CALL_ID_UNAVAILABLE";
    throw error;
  }
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(toolCallId) && !toolCallId.includes("..")) return toolCallId;
  return `host-tool-call-${createHash("sha256").update(toolCallId).digest("hex")}`;
}

function goalRunAuthority(ticket) {
  if (!isRecord(ticket) || ticket.version !== "goal-run-binding-ticket.v2") {
    const error = new Error("Goal run ticket does not provide a supported authority shape");
    error.code = "RUN_BINDING_MISMATCH";
    throw error;
  }
  return {
    ticketId: ticket.ticketId,
    goalId: ticket.goalId,
    taskId: ticket.taskId,
    attempt: ticket.attempt,
    contractHash: ticket.contractHash,
    workspaceId: ticket.workspaceId,
    executionRevision: ticket.executionRevision,
    expectedCriteria: ticket.expectedCriteria,
  };
}

function codingRunAuthorization(binding, ticket) {
  return createRunAuthorization({
    kind: "coding",
    binding: {
      runId: binding.runId,
      asyncDir: binding.asyncDir,
      sessionId: binding.sessionId,
      pid: binding.pid,
      agentProfile: binding.agentProfile,
    },
    goal: ticket ? goalRunAuthority(ticket) : null,
  });
}

async function hostAuthorizedDispatch(request, { workspace, rootSessionId, sessionId, dispatchId }) {
  let root = workspace?.originRoot ?? request.orchestratorCwd ?? request.cwd;
  try { root = realpathSync(root); } catch { root = realpathSync(process.cwd()); }
  const authorization = createRunAuthorization({
    kind: request.contractHash ? "coding" : "generic",
    binding: { runId: dispatchId, asyncDir: "/tmp", sessionId: rootSessionId ?? sessionId, pid: process.pid, agentProfile: request.agent },
    goal: null,
  });
  return createAuthorizedDispatch({
    agent: request.agent,
    cwd: root,
    isolation: workspace ? "managed-workspace" : "shared",
    ...(request.model === undefined ? {} : { model: request.model }),
    prompt: request.prompt,
  }, {
    rootSessionId: rootSessionId ?? sessionId,
    allowedProfiles: [request.agent],
    originRoot: root,
    cwdRoot: root,
    isolation: workspace ? "managed-workspace" : "shared",
    authorization,
  });
}

function genericRunAuthorization(binding) {
  return createRunAuthorization({
    kind: "generic",
    binding: {
      runId: binding.runId,
      asyncDir: binding.asyncDir,
      sessionId: binding.sessionId,
      pid: binding.pid,
      agentProfile: binding.agent,
    },
    goal: null,
  });
}

function requireWorkspaceService(pi, configured, rootSessionId) {
  const service = configured ?? findManagedWorkspaceService(pi, rootSessionId);
  if (!service) {
    const error = new Error("managed workspace service is unavailable");
    error.code = "WORKSPACE_SERVICE_UNAVAILABLE";
    throw error;
  }
  return service;
}

// Every allocation — standalone or Goal-ticket — is created through the v2
// request codec so the proof settlement chain (v2 status/action/discard) is
// reachable on every real Auto Integration workspace. v1 is not a creation
// shape anymore.
function standaloneWorkspacePolicy(kind, writePaths) {
  if (kind !== "coding") return { publication: "forbidden", application: "forbidden", writePaths: [] };
  return { publication: "allowed", application: "allowed", writePaths };
}

async function standaloneWorkspaceRequest({ input, ctx, toolCallId, kind, contractHash, createId, resolveCanonicalOrigin, resolveRootSessionId, inspectWorkspaceSource }) {
  if (typeof resolveRootSessionId !== "function") {
    const error = new Error("WORKSPACE_SESSION_ID_UNAVAILABLE"); error.code = "WORKSPACE_SESSION_ID_UNAVAILABLE"; throw error;
  }
  const rootSessionId = resolveRootSessionId(ctx.sessionManager);
  if (!nonempty(rootSessionId)) {
    const error = new Error("WORKSPACE_SESSION_ID_UNAVAILABLE"); error.code = "WORKSPACE_SESSION_ID_UNAVAILABLE"; throw error;
  }
  const rawCwd = input.cwd ?? ctx.cwd;
  const requestedCwd = path.resolve(ctx.cwd, rawCwd);
  let canonicalRequestedCwd = requestedCwd;
  try { canonicalRequestedCwd = realpathSync(requestedCwd); } catch { /* injected/fake origins may not exist until the service allocates them */ }
  const originRoot = await resolveCanonicalOrigin({ requestedCwd: canonicalRequestedCwd, ctx });
  const source = await inspectWorkspaceSource({ originRoot, requestedCwd, ctx });
  return createManagedWorkspaceRequestV2({
    workspaceId: createId(),
    owner: { kind: "standalone-subagent", rootSessionId, toolCallId: canonicalStandaloneToolCallId(toolCallId) },
    originRoot,
    requestedCwd: canonicalRequestedCwd,
    originRef: source.originRef,
    baseCommit: source.baseCommit,
    contractHash: contractHash ?? genericContractHash(input, requestedCwd),
    policy: standaloneWorkspacePolicy(kind, kind === "coding" ? input.writePaths : []),

  });
}

function coerceExecutionContainer(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

// 模型可见 public ABI 不得提供 timeoutMs；只有 Goal trusted contract
// 才能携带 caller-shaped timeout，且必须经 Goal coordinator 签发 ticket 才放行。
function callerSuppliesExecutionTimeout(input) {
  if (!isRecord(input)) return false;
  return Object.hasOwn(input, "timeoutMs");
}

// 公共 coding dispatch 边界：模型不得提供 timeoutMs。
// 一旦含 timeoutMs 即在 discovery/workspace/RPC 前拒绝；

// 否则注入 Host timeout 后交给 canonical codec。Goal 仍通过 compileCodingDispatchIR
// 直接传入可信 timeout，其 hash 语义不受本边界影响。
export function preparePublicCodingDispatch(input, { cwd, timeoutMs }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("Host coding dispatch timeout must be a positive safe integer");
  }
  if (!isRecord(input)) {
    return compileDispatchIR(input, { cwd, timeoutMs });
  }
  if (Object.hasOwn(input, "timeoutMs")) {
    throw new CodingDispatchContractError(
      "INVALID_CONTRACT",
      "caller must not supply timeoutMs; keypath=timeoutMs",
      "timeoutMs",
      "timeoutMs",
    );
  }
  return compileDispatchIR(input, { cwd, timeoutMs });

}

async function executeCoding(pi, toolCallId, input, ctx, rpc, createId, titleRegistry, prepareCodingSpawn, resolveCodingSpawnIdentity, configuredGoalCoordinator, workflowChildStartTimeoutMs, configuredWorkspaceService, resolveCanonicalOrigin, resolveRootSessionId, registerAuthorizedRun, inspectWorkspaceSource, discover, trace, providerBlacklist) {
  const spawnedRunIds: string[] = [];
  // thinkingLevel 是执行参数而非任务合同：不进入 IR/contractHash，
  // 只透传到 spawn 的 child.thinking（与 model 选择器同一消费层）。
  // resolver 与 Goal ticket 仍接收 raw contract 原引用，仅在 compile 入口剥离。
  const dispatchThinkingLevel = typeof input.thinkingLevel === "string" ? input.thinkingLevel : undefined;
  const { thinkingLevel: strippedThinkingLevel, ...compileInput } = input;
  void strippedThinkingLevel;
  const rootSessionId = typeof resolveRootSessionId === "function" ? resolveRootSessionId(ctx.sessionManager) : undefined;
  const goalCoordinator = configuredGoalCoordinator ?? findGoalRunCoordinator(pi, rootSessionId);
  // The Host coordinator is the production contract preflight.  It must run
  // before model discovery, workspace allocation, RPC capability checks, or spawn.
  let ir;
  let ticket;
  if (false && callerSuppliesExecutionTimeout(input)) {
    // Goal trusted contract: keep the caller-shaped timeout and its canonical
    // hash, but continue only when the Goal coordinator signs a ticket.
    ir = compileDispatchIR(compileInput, { cwd: ctx.cwd, timeoutMs: HOST_EXECUTION_TIMEOUT_MS });
    const bindingRequest = { toolCallId, contract: input, contractHash: ir.contractHash, ctx };

    ticket = await goalCoordinator?.prepareSpawn(bindingRequest);
    if (!ticket) {
      throw new CodingDispatchContractError(
        "INVALID_CONTRACT",
        "caller must not supply execution.timeoutMs without a Goal run ticket; keypath=execution.timeoutMs",
        "execution.timeoutMs",
        "execution.timeoutMs",
      );
    }
  } else {
    ir = preparePublicCodingDispatch(compileInput, { cwd: ctx.cwd, timeoutMs: HOST_EXECUTION_TIMEOUT_MS });
    const bindingRequest = { toolCallId, contract: input, contractHash: ir.contractHash, ctx };

    ticket = await goalCoordinator?.prepareSpawn(bindingRequest);
  }
  const selection = await resolveSpawnModel(ir, ctx, discover, trace, providerBlacklist);
  const selectedIr = selection.model === undefined ? ir : { ...ir, model: selection.model };
  let workspaceRequest;
  if (ticket) {
    if (ir.worktree !== true || !ticket.workspaceRequest) {
      const error = new Error("Goal run ticket requires an explicit managed workspace request");
      error.code = "RUN_BINDING_MISMATCH";
      throw error;
    }
    workspaceRequest = createManagedWorkspaceRequestV2(ticket.workspaceRequest);
    if (workspaceRequest.owner.kind !== "goal-task" || workspaceRequest.contractHash !== selectedIr.contractHash) {

      const error = new Error("Goal run workspace request does not match the source contract");
      error.code = "RUN_BINDING_MISMATCH";
      throw error;
    }
  } else if (ir.worktree === true) {
    workspaceRequest = await standaloneWorkspaceRequest({ input, ctx, toolCallId, kind: "coding", contractHash: selectedIr.contractHash, createId, resolveCanonicalOrigin, resolveRootSessionId, inspectWorkspaceSource });
  }
  const workspaceService = workspaceRequest ? requireWorkspaceService(pi, configuredWorkspaceService, rootSessionId) : undefined;
  trace.stage = "preallocate";
  let workspace = workspaceRequest ? await workspaceService.ensureAllocated(workspaceRequest) : undefined;
  if (ticket) {
    await goalCoordinator.workspaceAllocated(ticket, workspace);
    await goalCoordinator.confirmSpawn(ticket, workspace);
  }
  const orchestratorCwd = workspace?.originRoot ?? ctx.cwd;
  const runtimeIr = workspace ? { ...selectedIr, cwd: workspace.dispatchCwd, worktree: true, orchestratorCwd } : selectedIr;
  const runtimePrompt = renderDispatchPrompt(runtimeIr);
  trace.stage = "rpc-ping";
  const capabilities = await rpc.ping({ diagnostic: { toolCallId, sink: trace } });
  // D1：把同次 ping 的 D0 安全投影挂在本次调用的 trace 闭包上，供失败 details/trace 使用。
  // ping 未成功回包时该字段保持未定义，绝不补造投影或保留 raw 回包。
  trace.rpcNegotiation = projectRpcNegotiation(capabilities, orchestratorCwd, "coding");
  trace.stage = "workflow-spawn";

  assertSpawnCapabilities(capabilities, orchestratorCwd, "coding");
  trace.parentSessionId = lifecycleSessionIdentity(capabilities.session);
  await prepareCodingSpawn(runtimeIr, ticket);
  titleRegistry.prepare({ agent: runtimeIr.agent, task: runtimePrompt, title: runtimeIr.title });
  const customIdentity = typeof resolveCodingSpawnIdentity === "function"
    ? await resolveCodingSpawnIdentity({ toolCallId, contract: input, contractHash: selectedIr.contractHash })
    : undefined;
  if (customIdentity !== undefined) assertCodingSpawnIdentity(customIdentity);
  if (ticket?.spawnIdentity && customIdentity
      && (ticket.spawnIdentity.requestId !== customIdentity.requestId || ticket.spawnIdentity.spawnKey !== customIdentity.spawnKey)) {
    const error = new Error("Goal run spawn identity conflicts with the configured resolver");
    error.code = "RUN_BINDING_MISMATCH";
    throw error;
  }
  // Goal tickets bind a deterministic current-RPC idempotency identity.  It is
  // derived solely from the Host-issued ticket, never from a facade handle.
  const ticketIdentity = ticket?.spawnIdentity ?? (ticket ? {
    requestId: `goal-executor-${ticket.ticketId}`,
    spawnKey: `goal-executor-${ticket.ticketId}`,
  } : undefined);
  const identity = ticketIdentity ?? customIdentity;
  if (identity !== undefined) assertCodingSpawnIdentity(identity);
  const dispatchId = identity?.spawnKey ?? createId();
  const workflowKey = `typed-${dispatchId}`;
  let authoritativeBinding: any;
  let authorizationRegistration: Promise<void> | undefined;
  const codingRequest = createCodingDispatchAdapter({
    agent: ir.agent,
    title: ir.title,
    prompt: runtimePrompt,
    cwd: runtimeIr.cwd,
    contractHash: selectedIr.contractHash,

    ...(runtimeIr.model === undefined ? {} : { model: runtimeIr.model }),
  });
  const authorizedDispatch = await hostAuthorizedDispatch(codingRequest, {
    workspace, rootSessionId, sessionId: lifecycleSessionIdentity(capabilities.session), dispatchId,
  });
  trace.stage = "workflow-spawn";

  const binding = await dispatchExecution(codingRequest, {
    workspace,
    authorizedDispatch,
    execute: () => spawnWorkflowLeaf(pi, rpc, {
      workflowKey,
      agent: ir.agent,
      sessionId: lifecycleSessionIdentity(capabilities.session),
        timeoutMs: childStartTimeoutMs(workflowChildStartTimeoutMs, ir.timeoutMs),

      params: codingWorkflowSpawnParams(dispatchThinkingLevel === undefined ? { ...runtimeIr, rootSessionId } : { ...runtimeIr, rootSessionId, thinkingLevel: dispatchThinkingLevel }, runtimePrompt, workflowKey, ticket),
      identity,
      titleRegistry,
      trace,
      spawnedRunIds,

      onBinding: (observed) => {
        trace.stage = "child-binding";
        authoritativeBinding = {
          runId: observed.runId, asyncDir: observed.asyncDir, sessionId: observed.sessionId,
          pid: observed.pid, agentProfile: observed.agent,
        };
        if (ticket && authoritativeBinding.agentProfile !== ticket.agentProfile) {
          const error = new Error("Goal run profile does not match the observed lifecycle binding");
          error.code = "RUN_BINDING_MISMATCH";
          throw error;
        }
        // Managed coding children need Root subscribe authority for integration;
        // only a Host ticket may add Goal settlement authority.
        if (workspace) {
          if (typeof registerAuthorizedRun !== "function") {
            const error = new Error("FACADE_PROOF_UNAVAILABLE");
            error.code = "FACADE_PROOF_UNAVAILABLE";
            throw error;
          }
          const owner = workspace.owner;
          if (authoritativeBinding.agentProfile !== runtimeIr.agent
              || authoritativeBinding.sessionId !== lifecycleSessionIdentity(capabilities.session)
              || !owner || (owner.kind !== "standalone-subagent" && owner.kind !== "goal-task")
              || owner.rootSessionId !== rootSessionId) {
            const error = new Error("Managed coding authorization does not match the authoritative Host binding");
            error.code = "RUN_BINDING_MISMATCH";
            throw error;
          }
          trace.stage = "grant-registration";
          try {
            authorizationRegistration = Promise.resolve(registerAuthorizedRun(codingRunAuthorization(authoritativeBinding, ticket)))
              .then(() => { trace("grant-created", { stage: "grant-registration", timestamp: new Date().toISOString() }); })
              .catch((error) => {
                trace("grant-failed", { stage: "grant-registration", timestamp: new Date().toISOString(), errorCode: error?.code ?? "GRANT_REGISTRATION_FAILED" });
                throw error;
              });
          } catch (error) {
            trace("grant-failed", { stage: "grant-registration", timestamp: new Date().toISOString(), errorCode: error?.code ?? "GRANT_REGISTRATION_FAILED" });
            throw error;
          }
        }
      },
    }),
  });
  if (workspace) {
    if (!authorizationRegistration) {
      const error = new Error("FACADE_PROOF_UNAVAILABLE");
      error.code = "FACADE_PROOF_UNAVAILABLE";
      throw error;
    }
    try {
      await authorizationRegistration;
    } catch (error) {
      // 修复面③：spawn 成功但授权注册失败时对已 spawn 的 root/leaf 尽力 stop 回滚，
      // 阻止孤儿 run；stop 失败仅记日志，原错误照常上抛。
      await stopSpawnedRunsBestEffort(rpc, spawnedRunIds);
      throw error;
    }
  }
  if (workspace) {
    trace.stage = "bind-run";
    workspace = await workspaceService.bindRun({ workspaceId: workspace.workspaceId, run: binding });
  }
  if (ticket) {
    if (!authoritativeBinding || authoritativeBinding.runId !== binding.runId || authoritativeBinding.asyncDir !== binding.asyncDir) {
      const error = new Error("Goal executor authoritative lifecycle binding is unavailable");
      error.code = "EXECUTOR_BINDING_MISMATCH";
      throw error;
    }
    await goalCoordinator.bindSpawn(ticket, authoritativeBinding);
  }
  titleRegistry.remember(binding.runId, ir.title);
  const handle = {
    version: "coding-dispatch-handle.v1",
    dispatchId,
    taskId: ir.taskId,
    agent: ir.agent,
    title: ir.title,
    contractHash: selectedIr.contractHash,
    ...binding,
    ...(workspace ? workspacePublic(workspace) : {}),
  };
  const workspaceNotice = workspace
    ? ` Workspace ${workspace.workspaceId} allocated (state: ${workspace.state}). After the run completes: subagent_worktree({action:"status",workspace_id:"${workspace.workspaceId}"}) to check dispositions; then integrate or discard to finish, or preserve temporarily and later release.`
    : "";
  return {
    content: [{ type: "text", text: `Started ${handle.agent}: ${handle.title} (${handle.runId}).${modelSelectionWarningText(selection)} ${ASYNC_SPAWN_GUIDANCE}${workspaceNotice}` }],
    isError: false,
    details: { ...handle, modelSelection: modelSelectionDetails(selection), ...(selection.warnings ? { warnings: selection.warnings } : {}) },
  };
}

async function executeGeneric(pi, toolCallId, input, ctx, rpc, createId, titleRegistry, workflowChildStartTimeoutMs, configuredWorkspaceService, resolveCanonicalOrigin, resolveRootSessionId, registerAuthorizedRun, inspectWorkspaceSource, discover, trace, providerBlacklist) {
  const spawnedRunIds: string[] = [];
  if (Object.hasOwn(input, "version")) {
    return failure("DEPRECATED_SCHEMA", "This input uses dispatch-ir.v1; migrate to the unified dispatch contract", undefined, "version");
  }
  if (Object.hasOwn(input, "timeoutMs")) {
    return failure("INVALID_CONTRACT", "caller must not supply top-level timeoutMs; keypath=timeoutMs", undefined, "timeoutMs");
  }
  if (!nonempty(input.agent) || !nonempty(input.task)) {

    // 缺 version 的 coding 合同会被静默路由到 generic 分支；含 coding 特征
    // 字段的输入必须得到指向真实原因的自诊断报错，而非误导性的
    // generic agent/title/task 错误（实际派发事故复盘 2026-09-15）。
    if (Object.hasOwn(input, "taskId") || Object.hasOwn(input, "objective")) {
      return failure("INVALID_CODING_ROUTER", "input resembles a coding contract but is missing version: \"dispatch-ir.v1\"; coding dispatch routes on the version field");
    }
    return failure("INVALID_GENERIC_DISPATCH", "generic dispatch requires non-empty agent, title, and task");
  }
  const normalizedInput = { ...input, agent: normalizeAgentProfile(input.agent) };
  const title = normalizeSubagentTitle(input.title ?? input.task.slice(0, 50));
  // 前置统一编译：对完整公共输入校验，确保 coding 专属字段（acceptance/worktree/cwd）
  // 在无 writePaths 时被拒绝，未知字段在 discovery/workspace/RPC 之前被拒绝。
  // 只剥离 runtime 注入的 timeoutMs，其余字段全部传给编译器校验。
  let genericIr;
  try {
    const { timeoutMs: _excluded, ...publicInput } = normalizedInput;
    genericIr = compileDispatchIR(publicInput);
  } catch (error) {
    if (error instanceof CodingDispatchContractError) {
      return failure(error.code, error.message, error.detail, error.keypath);
    }
    throw error;
  }
  const genericPrompt = renderDispatchPrompt(genericIr);

  const selection = await resolveSpawnModel(normalizedInput, ctx, discover, trace, providerBlacklist);
  const selectedInput = selection.model === undefined ? normalizedInput : { ...normalizedInput, model: selection.model };
  const workspaceRequest = selectedInput.worktree === true
    ? await standaloneWorkspaceRequest({
      input: selectedInput,
      ctx,
      toolCallId,
      kind: "generic",
      contractHash: genericContractHash(normalizedInput, path.resolve(ctx.cwd, normalizedInput.cwd ?? ctx.cwd)),
      createId,
      resolveCanonicalOrigin,
      resolveRootSessionId,
      inspectWorkspaceSource,
    })
    : undefined;
  const rootSessionId = typeof resolveRootSessionId === "function" ? resolveRootSessionId(ctx.sessionManager) : undefined;
  const workspaceService = workspaceRequest ? requireWorkspaceService(pi, configuredWorkspaceService, rootSessionId) : undefined;
  trace.stage = "preallocate";
  let workspace = workspaceRequest ? await workspaceService.ensureAllocated(workspaceRequest) : undefined;
  const orchestratorCwd = workspace?.originRoot ?? ctx.cwd;
  trace.stage = "rpc-ping";
  const capabilities = await rpc.ping({ diagnostic: { toolCallId, sink: trace } });
  // D1：generic 的 assertSpawnAllowed 早于统一断言抛出，其错误只带 code/operation，
  // errors.ts 的白名单会丢弃 error.detail；因此这里先把同次 ping 的 D0 投影挂在本次
  // 调用的 trace 闭包上，由 execute 的既有 catch 安全合并。缺 ping 时保持未定义。
  trace.rpcNegotiation = projectRpcNegotiation(capabilities, orchestratorCwd, "generic");
  const negotiatedCapabilities = capabilities?.capabilities
    ? await negotiateCapabilities(rpc, { cwd: orchestratorCwd, diagnostic: { toolCallId, sink: trace }, response: capabilities })
    : undefined;
  negotiatedCapabilities?.assertSpawnAllowed();

  assertSpawnCapabilities(capabilities, orchestratorCwd, "generic");
  trace.parentSessionId = lifecycleSessionIdentity(capabilities.session);
  titleRegistry.prepare({ agent: normalizedInput.agent, task: normalizedInput.task, title });
  const workflowKey = `typed-${createId()}`;
  let authoritativeBinding: any;
  let authorizationRegistration: Promise<void> | undefined;
  const genericRequest = createGenericDispatchAdapter({
    agent: normalizedInput.agent,
    title,
    task: normalizedInput.task,
    cwd: workspace?.dispatchCwd ?? selectedInput.cwd ?? ctx.cwd,
    ...(selectedInput.model === undefined ? {} : { model: selectedInput.model }),

  });
  const authorizedDispatch = await hostAuthorizedDispatch(genericRequest, {
    workspace, rootSessionId, sessionId: lifecycleSessionIdentity(capabilities.session), dispatchId: createId(),
  });
  trace.stage = "workflow-spawn";
  const binding = await dispatchExecution(genericRequest, {
    workspace,
    authorizedDispatch,
    execute: () => spawnWorkflowLeaf(pi, rpc, {
      workflowKey,
      agent: normalizedInput.agent,
      sessionId: lifecycleSessionIdentity(capabilities.session),
      capabilities: negotiatedCapabilities,
      timeoutMs: childStartTimeoutMs(workflowChildStartTimeoutMs, 120_000),
      params: genericWorkflowSpawnParams({
        ...(workspace ? { ...selectedInput, cwd: workspace.dispatchCwd } : selectedInput),
        ...(workspace ? { orchestratorCwd, childCwd: workspace.dispatchCwd } : {}),
        // The shared adapter owns the canonical five-section generic prompt.
        task: genericRequest.prompt,
      }, ctx, workflowKey),
      titleRegistry,
      trace,
      spawnedRunIds,
      onBinding: (observed) => {
          trace.stage = "child-binding";
          authoritativeBinding = observed;
        if (typeof registerAuthorizedRun === "function") {
          authorizationRegistration = Promise.resolve(registerAuthorizedRun(genericRunAuthorization(observed)));
        }
      },
    }),
  });
  if (authorizationRegistration) {
    try {
      await authorizationRegistration;
    } catch (error) {
      // 修复面③：spawn 成功但增强层授权注册失败（现场：authority 锁竞争后的
      // authority_store_unavailable）时，对已 spawn 的 root/leaf 尽力 stop 回滚，
      // 阻止孤儿 run 与重派副本并行重复执行；stop 失败仅记日志，原错误照常上抛。
      await stopSpawnedRunsBestEffort(rpc, spawnedRunIds);
      throw error;
    }
  }
  if (workspace) {

    trace.stage = "bind-run";
    workspace = await workspaceService.bindRun({ workspaceId: workspace.workspaceId, run: binding });
  }
  titleRegistry.remember(binding.runId, title);
  const workspaceNotice = workspace
    ? ` Workspace ${workspace.workspaceId} allocated (state: ${workspace.state}). After the run completes: subagent_worktree({action:"status",workspace_id:"${workspace.workspaceId}"}) to check dispositions; then integrate or discard to finish, or preserve temporarily and later release.`
    : "";
  return {
    content: [{ type: "text", text: `Started ${normalizedInput.agent}: ${title} (${binding.runId}).${modelSelectionWarningText(selection)} ${ASYNC_SPAWN_GUIDANCE}${workspaceNotice}` }],
    isError: false,
    details: { ...binding, agent: normalizedInput.agent, title, modelSelection: modelSelectionDetails(selection), ...(selection.warnings ? { warnings: selection.warnings } : {}), ...(workspace ? workspacePublic(workspace) : {}) },
  };
}
// steer 必须先规范化出唯一目标，再以同一标识做 owner 授权，否则会对「查不到 owner
// 的别名」放行、而上游却投递到真实受管 run，绕过全部控制面围栏。
// 上游语义见 pi-subagents/src/runs/background/async-resume.js:159-196 与
// run-id-query.js（MIN_SAFE=8、FULL=36，[8,36) 会触发前缀扇描）。
// 详见 docs/bugs/2026-09-30-steer-control-plane-target-aliasing.md。
const STEER_PREFIX_MIN_LENGTH = 8;
const STEER_FULL_RUN_ID_LENGTH = 36;
// 本 package tsconfig 未开 strictNullChecks，字面量 true/false 会被 widen 成 boolean，
// 因此不能用 { ok: true } / { ok: false } 做判别式窄化，改用 typeof 窄化。
type SteerTarget = { runId: string | undefined; code: string | undefined };
const steerTargetRejected = (code: string): SteerTarget => ({ runId: undefined, code });
function canonicalSteerTarget(params: Record<string, any>): SteerTarget {
  // dir 可单独定位 run，本层无法据其证明授权目标等于投递目标 → fail-closed。
  if (params.dir !== undefined) return steerTargetRejected("SUPERVISOR_STEER_TARGET_ALIAS");
  const { id, runId } = params;
  for (const value of [id, runId]) {
    // 上游 assertRunId 不做 trim，故此处也保留原始字串，仅拒绝空/非字串。
    if (value !== undefined && (typeof value !== "string" || value.trim() === "")) return steerTargetRejected("SUPERVISOR_STEER_TARGET_INVALID");
  }
  // 上游优先级为 id ?? runId；两者同时存在且不一致时无法确定唯一目标。
  if (typeof id === "string" && typeof runId === "string" && id !== runId) return steerTargetRejected("SUPERVISOR_STEER_TARGET_CONFLICT");
  const canonical = typeof id === "string" ? id : typeof runId === "string" ? runId : undefined;
  if (typeof canonical !== "string") return steerTargetRejected("SUPERVISOR_STEER_TARGET_UNRESOLVED");
  if (path.isAbsolute(canonical) || /[\\/]/.test(canonical) || canonical.includes("..")) return steerTargetRejected("SUPERVISOR_STEER_TARGET_INVALID");
  // 前缀形态会被上游扇描解析成另一个完整 runId，授权目标与投递目标可能不一致。
  if (canonical.length >= STEER_PREFIX_MIN_LENGTH && canonical.length < STEER_FULL_RUN_ID_LENGTH) return steerTargetRejected("SUPERVISOR_STEER_TARGET_AMBIGUOUS");
  return { runId: canonical, code: undefined };
}

function controlFailure(code, receipt = undefined) {
  return {
    content: [{ type: "text", text: `${code}: Supervisor control request blocked.` }],
    isError: true,
    details: { code, ...(receipt?.receiptId ? { receiptId: receipt.receiptId } : {}), ...(receipt?.requestId ? { requestId: receipt.requestId } : {}), ...(receipt?.runId ? { runId: receipt.runId } : {}) },
  };
}

function reportSupervisorDiagnostic(diagnosticSink, entry) {
  if (typeof diagnosticSink !== "function") return;
  try { diagnosticSink(entry); } catch (diagnosticError) {
    console.error("[typed-subagent-supervisor] diagnostic sink failed", diagnosticError);
  }
}

async function compensateSupervisorDelivery({ supervisorControlPlane, intent, hostRootSessionId, code, primaryError, diagnosticSink, phase }) {
  try {
    const result = await supervisorControlPlane.commitDelivery({ intent, success: false, code }, hostRootSessionId);
    if (result?.status !== "committed") {
      const compensationError = Object.assign(new Error(`supervisor delivery compensation blocked: ${result?.code ?? "unknown"}`), { code: result?.code ?? "SUPERVISOR_DELIVERY_COMPENSATION_BLOCKED", receipt: result?.receipt });
      reportSupervisorDiagnostic(diagnosticSink, { version: 1, phase: "supervisor-delivery-compensation-failed", deliveryPhase: phase, error: primaryError, cause: primaryError?.cause, secondaryError: compensationError, compensation: result });
      return compensationError;
    }
    return undefined;
  } catch (compensationError) {
    reportSupervisorDiagnostic(diagnosticSink, { version: 1, phase: "supervisor-delivery-compensation-failed", deliveryPhase: phase, error: primaryError, cause: primaryError?.cause, secondaryError: compensationError });
    return compensationError;
  }
}

async function executeControl(input, rpc, supervisorControlPlane, toolCallId, discover, ctx, resolveRootSessionId, diagnosticSink, titleRegistry) {

  if (!CONTROL_ACTIONS.has(input.action)) {
    return failure("UNSUPPORTED_ACTION", `unsupported subagent RPC action: ${String(input.action)}`);
  }
  if (input.action === "list") {
    try {
      const discovery = await discover(ctx.cwd, "both", ctx.model?.provider);
      // 只返回项目 agent（pi/agents/ 目录），过滤 ~/.agents/ 下的 skill 定义
      const visible = discovery.admission === "repository-configured"
        ? discovery.agents.filter((a) => !a.disabled)
        : discovery.agents.filter((a) => !a.disabled && a.filePath && !a.filePath.includes(".agents"));
      const agents = visible
        .map((a) => ({
          name: a.name, description: a.description ?? "", model: a.model ?? null, models: a.models ?? [], tools: a.tools ?? null,
          // 已准入 agent 附带完整原始 frontmatter（不含 systemPrompt 正文）；来源未提供时不得伪造默认字段。
          ...(isRecord(a.metadata) ? { metadata: structuredClone(a.metadata) } : {}),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      // list 是模型选择入口：agent 实际收到的 content 必须携带 frontmatter 元数据（仅改 TUI renderer 不足够），
      // 输出 name+frontmatter 条目数组；structured details.agents 保留既有字段并附带同一 metadata。
      const roster = agents.map(({ name, metadata }) => ({ name, ...(metadata ? { frontmatter: metadata } : {}) }));
      return {
        content: [{ type: "text", text: JSON.stringify(roster, null, 2) }],
        isError: false,
        details: { agents },
      };
    } catch (error) {
      return failure("AGENT_DISCOVERY_FAILED", error instanceof Error ? error.message : String(error));
    }
  }
  if (input.action === "resume" && !nonempty(input.message)) {
    return failure("INVALID_RESUME_MESSAGE", "resume requires a non-empty message", undefined, "$.message");
  }
  const { action, ...params } = input;
  if (action === "steer" && supervisorControlPlane && supervisorControlPlane.enabled?.() !== false) {
    const target = canonicalSteerTarget(params);
    if (typeof target.runId !== "string") return controlFailure(target.code ?? "SUPERVISOR_STEER_TARGET_UNRESOLVED");
    if (params.index === undefined) return controlFailure("SUPERVISOR_STEER_CHILD_AMBIGUOUS");
    if (!Number.isSafeInteger(params.index) || params.index < 0) return controlFailure("SUPERVISOR_STEER_TARGET_INVALID");
    const identity = await supervisorControlPlane.identityForRun?.(target.runId);
    const owner = identity?.owner;
    // identityForRun 缺失或未返回三态时一律当作 unavailable，不得默认放行。
    const ownerState = identity?.ownerState ?? (owner ? "owned" : "unavailable");
    // 未登记 supervisor request 的明确非受管 run 仍由 upstream steer 投递；
    // 已登记请求即使 replied，也需经控制面核查 pending 和 reply payload 去重。
    const unownedRequest = ownerState === "unowned"
      ? supervisorControlPlane.snapshot?.().requests.find((request) => request.runId === target.runId)
      : undefined;
    if (ownerState !== "unowned" || unownedRequest) {
      if (ownerState !== "owned" && ownerState !== "unowned") return controlFailure("SUPERVISOR_OWNER_UNAVAILABLE");
      if (ownerState === "owned" && !owner) return controlFailure("SUPERVISOR_OWNER_UNAVAILABLE");
      let hostRootSessionId;
      if (unownedRequest) {
        try { hostRootSessionId = resolveRootSessionId?.(ctx?.sessionManager); } catch { return controlFailure("SUPERVISOR_STALE_OWNER"); }
      }
      const runtime = identity?.runtime;
      const childIndex = Number.isSafeInteger(params.index) && params.index >= 0 ? params.index : undefined;
      const decision = await supervisorControlPlane.resolveSupervisorControl({
        schemaVersion: "supervisor-control-intent.v2",
        intentId: toolCallId, runId: target.runId,
        rootSessionId: unownedRequest ? unownedRequest.rootSessionId : owner.rootSessionId,
        ownerGeneration: unownedRequest ? unownedRequest.ownerGeneration : owner.ownerGeneration, kind: "steer",
        ...(childIndex === undefined ? {} : { childIndex }),
        payloadDigest: supervisorCanonicalDigest(params.message), liveRunEpoch: runtime?.liveRunEpoch,
      }, hostRootSessionId);
      if (decision.status === "idempotent") return controlFailure("SUPERVISOR_DELIVERY_IDEMPOTENT", decision.receipt);
      if (decision.status !== "allowed") return controlFailure(decision.code);
      try {
        const result = await rpc[action](params);
        if (result?.isError === true) {
          // 原生RPC错误不能记为成功queued；保留原生结果，只补偿失败事实。
          const compensation = await compensateSupervisorDelivery({ supervisorControlPlane, intent: decision.intent, hostRootSessionId, code: "SUPERVISOR_STEER_DELIVERY_FAILED", primaryError: new Error("native steer returned isError"), diagnosticSink, phase: "steer" });
          if (compensation) return controlFailure("SUPERVISOR_DELIVERY_COMPENSATION_BLOCKED");
          return rpcResult(result);
        }
        const committed = await supervisorControlPlane.commitDelivery({ intent: decision.intent }, hostRootSessionId);

        if (committed.status !== "committed") return controlFailure(committed.code, committed.receipt);
        return rpcResult(result);
      } catch (error) {
        const compensationError = await compensateSupervisorDelivery({ supervisorControlPlane, intent: decision.intent, hostRootSessionId, code: "SUPERVISOR_STEER_DELIVERY_FAILED", primaryError: error, diagnosticSink, phase: "steer" });
        throw compensationError ? new AggregateError([error, compensationError], "supervisor steer delivery and compensation failed", { cause: error }) : error;
      }
    }
  }
  const reply = await rpc[action](params);
  if (action === "resume" && reply?.isError !== true) {
    // 只沿用公开回复确认的新身份；不猜测提前 started 事件或目录、前缀的旧身份。
    const oldRunId = params.id ?? params.runId;
    const newRunId = reply?.details?.runId ?? reply?.details?.asyncId;
    const title = titleRegistry.titleFor(oldRunId);
    if (nonempty(newRunId) && title && !titleRegistry.titleFor(newRunId)) {
      titleRegistry.remember(newRunId, title, titleRegistry.agentFor(oldRunId) ?? reply?.details?.agent);
    }
  }
  return rpcResult(reply);
}

function createControlledSupervisorAdapter(adapter, supervisorControlPlane, registrationFailures, resolveRootSessionId, diagnosticSink) {
  if (!supervisorControlPlane) return adapter;
  const flights = new Map<string, Promise<unknown>>();
  /**
   * D3：status 只读诊断。root 身份只取当前 Host authority（ctx.sessionManager 经
   * resolveRootSessionId），不接受 agent 参数指定的 root，也不查询其它 root；已有 replyTo
   * 只能作为 requestId 精确过滤收窄本 root 投影。只调用 D2 的 readDiagnostics（无 TTL
   * 改写、无 loadRoot/ready/transaction、不铸造 token）；root 不可验证、控制面未启用或
   * 读取异常一律附 unavailable，绝不解释成「无 pending」。
   */
  const readStatusDiagnostic = async (params: any, ctx: any): Promise<SupervisorDiagnosticsV1> => {
    if (typeof supervisorControlPlane.readDiagnostics !== "function") return unavailableSupervisorDiagnostics();
    if (supervisorControlPlane.enabled?.() === false) return unavailableSupervisorDiagnostics();
    let rootSessionId: unknown;
    try { rootSessionId = resolveRootSessionId?.(ctx?.sessionManager); } catch { rootSessionId = undefined; }
    if (typeof rootSessionId !== "string" || rootSessionId.length === 0) return unavailableSupervisorDiagnostics();
    const filter = typeof params?.replyTo === "string" && params.replyTo.length > 0 ? { requestId: params.replyTo } : undefined;
    try {
      return safeSupervisorDiagnostics(await supervisorControlPlane.readDiagnostics(rootSessionId, filter));
    } catch {
      // 诊断读取不得改变 status 结果；异常同样 fail closed。
      return unavailableSupervisorDiagnostics();
    }
  };
  // native status 透传不变：先拿原生结果，再在 details 上追加只读投影；content/其余字段原样。
  const executeStatus = async (toolCallId, params, signal, onUpdate, ctx) => {
    const result = await adapter.execute(toolCallId, params, signal, onUpdate, ctx);
    return withSupervisorDiagnosticDetail(result, "supervisorDiagnostic", await readStatusDiagnostic(params, ctx));
  };
  const executeReply = async (toolCallId, params, signal, onUpdate, ctx) => {
      if (params?.action !== "reply" || supervisorControlPlane.enabled?.() === false) return adapter.execute(toolCallId, params, signal, onUpdate, ctx);
      let hostRootSessionId;
      try { hostRootSessionId = resolveRootSessionId?.(ctx?.sessionManager); } catch { /* fail closed below */ }
      const request = supervisorControlPlane.findRequestAsync
        ? await supervisorControlPlane.findRequestAsync(params.replyTo, hostRootSessionId)
        : supervisorControlPlane.findRequest?.(params.replyTo) ?? supervisorControlPlane.listPending?.().find((entry) => entry.requestId === params.replyTo);
      if (!request) {
        const registrationCode = registrationFailures.get(params.replyTo);
        if (registrationCode) return {
          content: [{ type: "text", text: `SUPERVISOR_REQUEST_REGISTRATION_FAILED: Request ${params.replyTo} was shown by native Supervisor but was not registered for authorized reply (${registrationCode}). Interrupt the run and resume it to recover.` }],
          isError: true,
          details: { code: "SUPERVISOR_REQUEST_REGISTRATION_FAILED", registrationCode, requestId: params.replyTo },
        };
        return controlFailure("SUPERVISOR_REQUEST_NOT_PENDING");
      }
      const replyChildIndex = Number.isSafeInteger(request?.correlation?.childIndex) && request.correlation.childIndex >= 0
        ? request.correlation.childIndex
        : undefined;
      const intent = {
        schemaVersion: "supervisor-control-intent.v2",
        intentId: toolCallId, runId: request?.runId,
        rootSessionId: request?.rootSessionId, ownerGeneration: request?.ownerGeneration, kind: "reply",
        ...(replyChildIndex === undefined ? {} : { childIndex: replyChildIndex }),
        requestId: params.replyTo, requestGeneration: request?.requestGeneration,
        payloadDigest: supervisorCanonicalDigest(params.message),
      };
      try { hostRootSessionId = resolveRootSessionId?.(ctx?.sessionManager); } catch { /* owner receipt remains authoritative for managed runs. */ }
      const decision = await supervisorControlPlane.resolveSupervisorControl(intent, hostRootSessionId);
      if (decision.status === "idempotent") return controlFailure("SUPERVISOR_DELIVERY_IDEMPOTENT", decision.receipt);
      if (decision.status !== "allowed") return controlFailure(decision.code);
      try {
        const result = await adapter.execute(toolCallId, params, signal, onUpdate, ctx);
        if (result?.isError === true) {
          const compensation = await compensateSupervisorDelivery({ supervisorControlPlane, intent: decision.intent, hostRootSessionId, code: "SUPERVISOR_REPLY_DELIVERY_FAILED", primaryError: new Error("native reply returned isError"), diagnosticSink, phase: "reply" });
          if (compensation) return controlFailure("SUPERVISOR_DELIVERY_COMPENSATION_BLOCKED");
          return result;
        }
        const committed = await supervisorControlPlane.commitDelivery({ intent: decision.intent }, hostRootSessionId);

        if (committed.status !== "committed") return controlFailure(committed.code, committed.receipt);
        // D3：只投影本次 committed.receipt（不用 snapshot 猜测）。queued 不等于 consumed；
        // 投影失败（畸形 receipt）时不附字段，也不把提交失败/幂等路径伪装成成功。
        return withSupervisorDiagnosticDetail(result, "deliveryReceiptDiagnostic", projectSupervisorReceipt(committed.receipt));
      } catch (error) {
        const compensationError = await compensateSupervisorDelivery({ supervisorControlPlane, intent: decision.intent, hostRootSessionId, code: "SUPERVISOR_REPLY_DELIVERY_FAILED", primaryError: error, diagnosticSink, phase: "reply" });
        throw compensationError ? new AggregateError([error, compensationError], "supervisor reply delivery and compensation failed", { cause: error }) : error;
      }
  };
  return Object.freeze({
    bind: (...args) => adapter.bind(...args), dispose: () => adapter.dispose?.(), isBound: () => adapter.isBound?.(),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // D3：status 诊断分支必须在 reply 早 return 之前处理，否则 status 永远只能拿到 native 透传。
      if (params?.action === "status") return executeStatus(toolCallId, params, signal, onUpdate, ctx);
      if (params?.action !== 'reply' || typeof params.replyTo !== 'string') return executeReply(toolCallId, params, signal, onUpdate, ctx);
      const key = params.replyTo;
      const prior = flights.get(key);
      const flight = Promise.resolve(prior).catch(() => undefined).then(() => executeReply(toolCallId, params, signal, onUpdate, ctx));
      flights.set(key, flight);
      try { return await flight; } finally { if (flights.get(key) === flight) flights.delete(key); }
    },
  });
}

function shutdownDebtManager(cleanupStore) {
  const current = cleanupStore[SHUTDOWN_DEBT_KEY];
  if (current?.lanes instanceof WeakMap) {
    if (!(current.sessionLanes instanceof Set)) current.sessionLanes = new Set();
    return current;
  }
  const manager = {
    lanes: new WeakMap(),
    sessionLanes: new Set(),
    debts: current?.debts instanceof Array ? current.debts : (current ? [current] : []),
  };
  cleanupStore[SHUTDOWN_DEBT_KEY] = manager;
  return manager;
}

function shutdownDebtLane(manager, pi) {
  // ExtensionAPI objects change on reload; its event bus is only a fallback lineage.
  const identity = pi.events && (typeof pi.events === "object" || typeof pi.events === "function") ? pi.events : pi;
  let lane = manager.lanes.get(identity);
  if (!lane) {
    lane = { debts: [] };
    manager.lanes.set(identity, lane);
  }
  manager.debts = lane.debts;
  return lane;
}

function sessionDebtLane(manager, ctx) {
  // Pi reload recreates ExtensionAPI event facades; the live SessionManager is stable per session.
  const identity = ctx?.sessionManager;
  if (identity === null || (typeof identity !== "object" && typeof identity !== "function")) return undefined;
  let lane = manager.lanes.get(identity);
  if (!lane) {
    lane = { debts: [] };
    manager.lanes.set(identity, lane);
  }
  manager.sessionLanes.add(lane);
  manager.debts = lane.debts;
  return lane;
}

function hasPendingSessionDebt(manager) {
  for (const lane of manager.sessionLanes) {
    if (lane.debts.some((debt) => !debt.completed)) return true;
  }
  return false;
}

function releaseCompletedDebts(lane) {
  while (lane.debts[0]?.completed) lane.debts.shift();
}

async function repayDebts(lane, before, retryCtx) {
  for (const debt of [...lane.debts]) {
    if (debt === before) break;
    if (!debt.completed) await debt.run(debt.event, retryCtx ?? debt.ctx, true);
  }
}

function cleanupRegistry(cleanupStore) {
  const current = cleanupStore[CLEANUP_KEY];
  if (current instanceof WeakMap) return current;
  if (current && typeof current.dispose === "function") current.dispose();
  const registry = new WeakMap();
  cleanupStore[CLEANUP_KEY] = registry;
  return registry;
}

// S4：未 bind 时同步停用三个 supervisor_request_* 模型工具，不留 active 声明；
// gate 计划的 inspect/clear 仍由其自身可用性策略决定，本函数不代替它注册或停用。
function deactivateSupervisorTool(pi, names: readonly string[]) {
  if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
  const activeTools = pi.getActiveTools();
  if (!Array.isArray(activeTools) || !activeTools.some((name) => names.includes(name))) return;
  pi.setActiveTools(activeTools.filter((name) => !names.includes(name)));
}

export function createSupervisorRequestMailbox(route, { limit = 1024 } = {}) {
  if (typeof route !== "function") throw new TypeError("Supervisor request mailbox route must be a function");
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new TypeError("Supervisor request mailbox limit must be a positive safe integer");
  }

  let active = false;
  let disposed = false;
  let draining;
  const queue = [];

  const drain = async () => {
    while (active && queue.length > 0) {
      const { message, context } = queue.shift();
      try {
        await route(message, context);
      } catch (error) {
        active = false;
        throw error;
      }
    }
  };

  return Object.freeze({
    handle(message, context) {
      if (disposed) return;
      if (active && !draining) return route(message, context);
      if (queue.length >= limit) {
        const error = new Error("SUPERVISOR_REQUEST_QUEUE_FULL: Supervisor startup mailbox is full");
        error.code = "SUPERVISOR_REQUEST_QUEUE_FULL";
        throw error;
      }
      queue.push({ message, context });
    },
    activate() {
      if (disposed) return Promise.resolve();
      active = true;
      if (draining) return draining;
      draining = drain().finally(() => { draining = undefined; });
      return draining;
    },
    deactivate() {
      active = false;
      queue.length = 0;
    },
    dispose() {
      disposed = true;
      active = false;
      queue.length = 0;
    },
  });
}

type TypedSubagentExtensionOptions = {
  rpc?: ReturnType<typeof createTypedSubagentRpcClient>;
  supervisorAdapter?: { bind(execute: unknown): unknown; dispose?: () => unknown; isBound?: () => boolean; execute?: (...args: unknown[]) => unknown };
  cleanupStore?: typeof globalThis;
  randomUUID?: () => string;
  titleRegistry?: ReturnType<typeof getTitleRegistry>;
  extraDisposables?: Array<{ dispose?: () => unknown }>;
  renderSubagentCall?: (...args: unknown[]) => unknown;
  renderSubagentResult?: (...args: unknown[]) => unknown;
  renderWorkspaceCall?: (...args: unknown[]) => unknown;
  renderWorkspaceResult?: (...args: unknown[]) => unknown;
  renderSupervisorCall?: (...args: unknown[]) => unknown;
  renderSupervisorResult?: (...args: unknown[]) => unknown;
  prepareCodingSpawn?: (...args: unknown[]) => Promise<void>;
  resolveCodingSpawnIdentity?: (...args: unknown[]) => Promise<unknown>;
  goalExecutorCoordinator?: ReturnType<typeof findGoalRunCoordinator>;
  workflowChildStartTimeoutMs?: number;
  beforeDispose?: (...args: unknown[]) => Promise<void>;
  retainOnBeforeDisposeFailure?: boolean;
  afterBeforeDispose?: (...args: unknown[]) => Promise<void>;
  beforeSessionStart?: (...args: unknown[]) => Promise<void>;
  onSupervisorRequest?: (...args: unknown[]) => Promise<void>;
  supervisorControlPlane?: any;
  workspaceService?: unknown;
  resolveRootSessionId?: (sessionManager: unknown) => string;
  registerAuthorizedRun?: (authorization: unknown) => Promise<void>;
  inspectExecutionProof?: (runId: string) => unknown;
  resolveCanonicalOrigin?: typeof defaultCanonicalOrigin;
  inspectWorkspaceSource?: typeof defaultWorkspaceSource;
  discoverAgents?: typeof defaultDiscoverAgents;
  providerBlacklist?: readonly string[];
  diagnosticSink?: (entry: unknown) => void;
  workingStateTrace?: (entry: unknown) => void;
  // Host 声明的共享 AGENTS 注入项（如 { id: "agents-shared", path: <absolute> }）。
  // 仅由真实 main entry 传入；无 Host 声明时不伪默认，既有调用与测试不受影响。
  requiredSharedChildExtension?: { id: string; path: string };
};

export function createTypedSubagentExtension(
  pi,
  {
    rpc = createTypedSubagentRpcClient(pi.events),
    supervisorAdapter,
    cleanupStore = globalThis,
    randomUUID: createId = randomUUID,
    titleRegistry = getTitleRegistry(cleanupStore),
    extraDisposables = [],
    renderSubagentCall,
    renderSubagentResult,
    renderWorkspaceCall,
    renderWorkspaceResult,
    renderSupervisorCall,
    renderSupervisorResult,
    prepareCodingSpawn = async (..._args: unknown[]) => {},
    resolveCodingSpawnIdentity,
    goalExecutorCoordinator,
    workflowChildStartTimeoutMs,
    beforeDispose = async (_event: unknown, _context: unknown) => {},
    retainOnBeforeDisposeFailure = false,
    afterBeforeDispose = async (_event: unknown, _context: unknown) => {},
    beforeSessionStart = async (_event: unknown, _context: unknown) => {},
    onSupervisorRequest,
    supervisorControlPlane,
    workspaceService,
    resolveRootSessionId,
    registerAuthorizedRun,
    resolveCanonicalOrigin = defaultCanonicalOrigin,
    inspectWorkspaceSource = defaultWorkspaceSource,
    discoverAgents: discover = defaultDiscoverAgents,
    providerBlacklist = [],
    diagnosticSink,
    requiredSharedChildExtension,
  }: TypedSubagentExtensionOptions = {},
) {
  // Durable debt retention supersedes this legacy opt-in; retain it for callers on the old API.
  void retainOnBeforeDisposeFailure;
  if (workflowChildStartTimeoutMs !== undefined
      && (!Number.isSafeInteger(workflowChildStartTimeoutMs) || workflowChildStartTimeoutMs <= 0)) {
    throw new TypeError("workflow child start timeout must be a positive safe integer");
  }
  const registry = cleanupRegistry(cleanupStore);
  const debtManager = shutdownDebtManager(cleanupStore);
  let debtLane = shutdownDebtLane(debtManager, pi);
  let shutdownDebt;
  const bindSessionDebtLane = (ctx) => {
    const lane = sessionDebtLane(debtManager, ctx);
    if (!lane || lane === debtLane) return;
    if (shutdownDebt) {
      const debtIndex = debtLane.debts.indexOf(shutdownDebt);
      if (debtIndex >= 0) debtLane.debts.splice(debtIndex, 1);
      if (!lane.debts.includes(shutdownDebt)) lane.debts.push(shutdownDebt);
    }
    debtLane = lane;
    debtManager.debts = lane.debts;
  };
  const previous = registry.get(pi);
  if (previous?.debt && !previous.debt.completed) {
    Promise.resolve(previous.debt.run(previous.debt.event, previous.debt.ctx, true)).catch((error) => {
      reportSupervisorDiagnostic(diagnosticSink, { version: 1, phase: "subagent-ready-debt-retry-failed", error, cause: error?.cause, retry: true });
      // The replacement generation's ready gate retains and retries this debt.
    });
  }

  const token = Symbol("typed-subagent-runtime");
  const resources = [
    { dispose: () => supervisorAdapter?.dispose?.(), done: !supervisorAdapter?.dispose },
    ...extraDisposables.map((disposable) => ({ dispose: () => disposable?.dispose?.(), done: !disposable?.dispose })),
    { dispose: () => rpc.dispose?.(), done: !rpc.dispose },
  ];
  let disposed = false;
  let disposeFlight;
  const dispose = async () => {
    if (disposed) return;
    if (disposeFlight) return disposeFlight;
    disposeFlight = (async () => {
      const errors = [];
      if (requiredChildExtensionsRegistration) {
        try { requiredChildExtensionsRegistration.dispose(); } catch { /* best effort */ }
        requiredChildExtensionsRegistration = undefined;
      }
      for (const resource of resources) {
        if (resource.done) continue;
        try { await resource.dispose(); resource.done = true; } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "typed subagent runtime disposal failed");
      disposed = true;
    })();
    try {
      return await disposeFlight;
    } finally {
      if (!disposed) disposeFlight = undefined;
    }
  };

  const tool = {
    name: "subagent",
    exposure: "model-only" as const,
    label: "Subagent",
    description: TYPED_SUBAGENT_DESCRIPTION,
    // M05B：单工具提示只表达委派与控制能力摘要；完整派发→决策→恢复→workspace 流程留在 GLOBAL。
    promptSnippet: "把完整合同的任务委派给子代理执行，并控制其生命周期（status/steer/interrupt/resume/stop/list）。",
    promptGuidelines: [
      "subagent 派发必须一次携带完整任务合同：agent、task，以及按类型必填的 writePaths 与 acceptance；不要靠追问补齐关键上下文。",
      "启动与完成是两个阶段：spawn 成功只代表子代理已开始执行，完成以子代理完成通知和结果验收为准。",
      "不得用本会话无权限的工具替代委派去完成本应交给子代理的工作；权限不足时通过带完整合同的派发解决，不绕过权限边界。",
    ],
    parameters: TYPED_SUBAGENT_PARAMETERS,
    ...(typeof renderSubagentCall === "function" ? { renderCall: renderSubagentCall } : {}),
    ...(typeof renderSubagentResult === "function" ? { renderResult: renderSubagentResult } : {}),
    async execute(toolCallId, input, _signal, _onUpdate, ctx) {
      const trace: any = (phase, fields = {}) => {
        if (typeof diagnosticSink !== "function") return;
        const entry = {
          version: 1,
          toolCallId,
          phase,
          monotonicMs: Math.floor(Number(process.hrtime.bigint() / 1_000_000n)),
          ...(typeof trace.parentSessionId === "string" ? { parentSessionId: trace.parentSessionId } : {}),
          ...fields,
        };
        try { diagnosticSink(entry); } catch { /* 诊断输出不得改变派发结果。 */ }
      };
      trace.toolCallId = toolCallId;
      trace("tool-entered");
      try {
        if (!isRecord(input)) {
          const result = failure("INVALID_DISPATCH", `subagent input must be an object; expected object; received ${input === null ? "null" : Array.isArray(input) ? "array" : typeof input}`, "$", "$");
          trace("tool-returned");
          return result;
        }
        if (Object.hasOwn(input, "action")) {
          const result = await executeControl(input, rpc, supervisorControlPlane, toolCallId, discover, ctx, resolveRootSessionId, diagnosticSink, titleRegistry);
          trace("tool-returned");
          return result;
        }
        if (isCodingDispatch(input)) {

          const result = await executeCoding(pi, toolCallId, input, ctx, rpc, createId, titleRegistry, prepareCodingSpawn, resolveCodingSpawnIdentity, goalExecutorCoordinator, workflowChildStartTimeoutMs, workspaceService, resolveCanonicalOrigin, resolveRootSessionId, registerAuthorizedRun, inspectWorkspaceSource, discover, trace, providerBlacklist);
          trace("tool-returned");
          return result;
        }
        const result = await executeGeneric(pi, toolCallId, input, ctx, rpc, createId, titleRegistry, workflowChildStartTimeoutMs, workspaceService, resolveCanonicalOrigin, resolveRootSessionId, registerAuthorizedRun, inspectWorkspaceSource, discover, trace, providerBlacklist);
        trace("tool-returned");
        return result;
      } catch (error) {
        const code = error?.code
          ?? (error instanceof CodingDispatchContractError ? error.code : "SUBAGENT_RPC_FAILED");
        const isRpcFailure = code === "SUBAGENT_RPC_FAILED" || typeof error?.operation === "string";
        // D1：同次 ping 的已验证 D0 投影；再校验一次，保证 details/trace 只可能出现白名单字段。
        const negotiation = safeRpcNegotiationDiagnostic(trace.rpcNegotiation);
        const details = isRpcFailure
          ? {
            ...createSubagentRpcFailureDetails({
              taskId: input?.taskId, toolCallId, stage: trace.stage,
              rpcOperation: error?.operation ?? (trace.stage === "rpc-ping" ? "ping" : trace.stage === "workflow-spawn" ? "spawn" : trace.stage),
              error,
            }),
            // assertSpawnAllowed 的错误不带 detail，原字段全部保留，只在本 catch 追加投影。
            ...(negotiation === undefined ? {} : { negotiation }),
          }
          : error?.detail;
        trace("tool-failed", {
          errorCode: code,
          ...(isRpcFailure ? details : {}),
          // 统一断言失败走非 RPC 分支：details 已由 error.detail 携带投影，trace 单独附白名单字段。
          ...(isRpcFailure || negotiation === undefined ? {} : { negotiation }),
        });
        return failure(code, error instanceof Error ? error.message : String(error), details, error?.keypath);
      }
    },
  };
  const workspaceToolOptions = {
    service: (ownerScope) => requireWorkspaceService(pi, workspaceService, ownerScope.rootSessionId),
    resolveRootSessionId: resolveRootSessionId ?? (() => { throw Object.assign(new Error("WORKSPACE_SESSION_ID_UNAVAILABLE"), { code: "WORKSPACE_SESSION_ID_UNAVAILABLE" }); }),
  };
  // 旧 union 定义保留但不注册（计划 §2.2 硬切换）：它们只是兼容入口与内部 execute
  // 闭包的宿主，不形成第二执行权威；新工具的执行回调就是同一批闭包。
  const workspaceTool = createSubagentWorkspaceTool({
    ...workspaceToolOptions,
    renderCall: renderWorkspaceCall,
    renderResult: renderWorkspaceResult,
  });
  // Host 的 render context 不含工具名（pi tool-execution.js getRenderContext），而新工具
  // 不再携带 args.action；因此注册时按工具名把提示注入已有 renderer 闭包。
  // 只改显示层入参，不改 args/result/details，也不在 headless runtime 里引入 TUI 实现。
  const withToolRendererHint = (definition, renderCall, renderResult) => Object.freeze({
    ...definition,
    ...(typeof renderCall === "function"
      ? { renderCall: (args: unknown, theme: unknown, context: any) => renderCall(args, theme, { ...context, tool: definition.name }) } : {}),
    ...(typeof renderResult === "function"
      ? { renderResult: (result: unknown, options: unknown, theme: unknown, context: any) => renderResult(result, options, theme, { ...context, tool: definition.name }) } : {}),
  });
  // 唯一模型注册面：14 个每操作独立工具（无 gate inspect/clear，它们仍 blocked）。
  // start/roster/run_* 全部委托 tool.execute 同一闭包：factory 已剥除 action 并注入固定
  // action，因此 coding/generic 路由、owner/CAS、gate 与 isError 失败语义全部沿用。
  const subagentOperationTools = createSubagentOperationTools({
    executeStart: (toolCallId, input, signal, onUpdate, ctx) => tool.execute(toolCallId, input, signal, onUpdate, ctx),
    executeControl: (toolCallId, input, signal, onUpdate, ctx) => tool.execute(toolCallId, input, signal, onUpdate, ctx),
  }).map((definition) => withToolRendererHint(definition, renderSubagentCall, renderSubagentResult));
  const workspaceOperationTools = createWorkspaceOperationTools(workspaceToolOptions)
    .map((definition) => withToolRendererHint(definition, renderWorkspaceCall, renderWorkspaceResult));
  const registrationFailures = new Map<string, string>();
  const controlledSupervisorAdapter = supervisorAdapter ? createControlledSupervisorAdapter(supervisorAdapter, supervisorControlPlane, registrationFailures, resolveRootSessionId, diagnosticSink) : undefined;
  const supervisorTool = controlledSupervisorAdapter ? createSupervisorTool(controlledSupervisorAdapter, {
    renderCall: renderSupervisorCall,
    renderResult: renderSupervisorResult,
  }) : undefined;
  const supervisorOperationTools = controlledSupervisorAdapter
    ? createSupervisorOperationTools(controlledSupervisorAdapter)
      .map((definition) => withToolRendererHint(definition, renderSupervisorCall, renderSupervisorResult))
    : [];
  const supervisorOperationToolNames = Object.freeze(supervisorOperationTools.map((definition) => definition.name));
  let requiredChildExtensionsRegistration;
  let ready;
  try {
    for (const definition of subagentOperationTools) pi.registerTool(definition);
    for (const definition of workspaceOperationTools) pi.registerTool(definition);

    if (typeof onSupervisorRequest === "function" || supervisorControlPlane) {
      pi.on("message_end", async (event, ctx) => {
        if (disposed || registry.get(pi)?.token !== token) return;
        const message = event?.message;
        if (message?.customType !== "subagent_supervisor_request") return;
        if (supervisorControlPlane && supervisorControlPlane.enabled?.() !== false) {
          let result;
          try {
            let hostRootSessionId;
            try { hostRootSessionId = resolveRootSessionId?.(ctx?.sessionManager); } catch { /* non-workspace registration fails closed without Host identity. */ }
            result = await supervisorControlPlane.registerSupervisorRequest(message.details, hostRootSessionId);
          } catch (error) {
            result = { status: "blocked", code: "SUPERVISOR_REQUEST_REGISTRATION_FAILED" };
            result.error = error;
          }
          const requestId = message.details?.id;
          if (result?.status !== "registered") {
            const errorCode = result?.code ?? "SUPERVISOR_REQUEST_REGISTRATION_FAILED";
            if (typeof requestId === "string") registrationFailures.set(requestId, errorCode);
            const details = { code: errorCode, requestId, runId: message.details?.runId };
            reportSupervisorDiagnostic(diagnosticSink, { version: 1, phase: "supervisor-registration-failed", errorCode, ...details, ...(result?.error ? { error: result.error, cause: result.error?.cause } : {}) });
            pi.sendMessage({ customType: "subagent_supervisor_registration_failed", content: `Supervisor request ${requestId ?? "(missing id)"} was not registered (${errorCode}). Reply is unavailable; interrupt the run and resume it to recover.`, details });
          } else if (typeof requestId === "string") {
            registrationFailures.delete(requestId);
          }
        }
        if (typeof onSupervisorRequest === "function") await onSupervisorRequest(message, ctx);
      });
    }

    for (const definition of supervisorOperationTools) pi.registerTool(definition);

    shutdownDebt = { attempted: false, completed: false, inFlight: undefined, run: undefined, event: undefined, ctx: undefined };
    shutdownDebt.run = async (event, ctx, force = false) => {
      if (shutdownDebt.completed || (!force && registry.get(pi)?.token !== token)) return;
      if (!shutdownDebt.attempted) {
        bindSessionDebtLane(ctx);
        shutdownDebt.event = event;
        shutdownDebt.ctx = ctx;
      }
      shutdownDebt.attempted = true;
      if (shutdownDebt.inFlight) return shutdownDebt.inFlight;
      // Pi invalidates the old ExtensionContext after reload, so retries use the new live context.
      const cleanupCtx = force && ctx !== undefined ? ctx : shutdownDebt.ctx;
      shutdownDebt.inFlight = (async () => {
        await repayDebts(debtLane, shutdownDebt, cleanupCtx);
        await beforeDispose(shutdownDebt.event, cleanupCtx);
        await afterBeforeDispose(shutdownDebt.event, cleanupCtx);
        await dispose();
        if (registry.get(pi)?.token === token) registry.delete(pi);
        shutdownDebt.completed = true;
        releaseCompletedDebts(debtLane);
      })();
      try {
        return await shutdownDebt.inFlight;
      } finally {
        if (!shutdownDebt.completed) shutdownDebt.inFlight = undefined;
      }
    };
    debtLane.debts.push(shutdownDebt);
    registry.set(pi, { token, dispose, debt: shutdownDebt, lane: debtLane });
    let startFlight;
    let started = false;
    ready = async (event, ctx) => {
      if (started) return;
      if (startFlight) return startFlight;
      startFlight = (async () => {
        bindSessionDebtLane(ctx);
        if (shutdownDebt.attempted && !shutdownDebt.completed) {
          await shutdownDebt.run(event, ctx, true);
          return;
        }
        await repayDebts(debtLane, shutdownDebt, ctx);
        // required-child 注册键必须等于上游全部查找点使用的 Pi session ID（getSessionId）；
        // 持久会话下 sessionFile ≠ sessionId，沿用文件路径键会令 required 查找精确匹配落空。
        const sessionId = ctx?.sessionManager?.getSessionId();
        if (sessionId && !requiredChildExtensionsRegistration) {
          // 同一现有 required-child 注册数组追加共享注入项，不得另起 register 造成
          // same-session duplicate。requireForAllRunners 是 registration 顶层 flag
          // （注册快照逐条只收 id/path，per-entry 形状会被拒绝），置位会把既有
          // root-session-owner/integration-queue 义务一并改写，因此保持缺省。
          requiredChildExtensionsRegistration = registerRequiredChildExtensions({
            sessionId,
            extensions: [
              { id: "root-session-owner", path: ROOT_SESSION_OWNER_EXTENSION },
              { id: "integration-queue", path: INTEGRATION_QUEUE_EXTENSION },
              ...(requiredSharedChildExtension
                ? [{ id: requiredSharedChildExtension.id, path: requiredSharedChildExtension.path }]
                : []),
            ],
          });
        }
        await beforeSessionStart(event, ctx);
        started = true;
      })();
      try {
        return await startFlight;
      } finally {
        if (!started) startFlight = undefined;
      }
    };
    pi.on("session_start", async (event, ctx) => {
      if (registry.get(pi)?.token !== token) return;
      await ready(event, ctx);
    });
    pi.on("session_shutdown", shutdownDebt.run);
    if (supervisorOperationTools.length > 0) {
      pi.on("session_start", async (event, ctx) => {
        if (registry.get(pi)?.token !== token) return;
        await ready(event, ctx);
        if (registry.get(pi)?.token !== token || supervisorAdapter.isBound()) return;
        deactivateSupervisorTool(pi, supervisorOperationToolNames);
        const error = new Error("SUPERVISOR_TARGET_UNAVAILABLE");
        error.code = "SUPERVISOR_TARGET_UNAVAILABLE";
        throw error;
      });
    }
  } catch (error) {
    if (shutdownDebt) {
      const debtIndex = debtLane.debts.indexOf(shutdownDebt);
      if (debtIndex >= 0) debtLane.debts.splice(debtIndex, 1);
    }
    if (registry.get(pi)?.token === token) registry.delete(pi);
    void Promise.resolve(dispose()).catch(() => undefined);
    throw error;
  }

  const executeSupervisor = async (params, ctx) => controlledSupervisorAdapter.execute(randomUUID(), params, undefined, undefined, ctx);
  return Object.freeze({ tool, workspaceTool, supervisorTool, executeSupervisor, dispose, ready });
}

export function installHeadlessTypedSubagentRuntime(pi, {
  bootstrap,
  afterBootstrap,
  completionNotifierFactory,
  resolveSessionId,
  beforeRuntimeDispose,
  workspaceCompletionReminderFactory,
    beforeUpstreamSessionStart = async (_event: unknown, _context: unknown) => {},
  ...options
}: TypedSubagentExtensionOptions & {
  bootstrap?: (api: unknown) => void;
  afterBootstrap?: (api: unknown) => void;
  completionNotifierFactory?: (api: unknown, state: { currentSessionId: string | null; completionOwnerId?: string }) => { dispose(): unknown };
  workspaceCompletionReminderFactory?: (api: unknown, state: { currentSessionId: string | null }) => { dispose(): unknown };
  resolveSessionId?: (sessionManager: unknown) => string;
  beforeRuntimeDispose?: (...args: unknown[]) => Promise<void>;
  beforeUpstreamSessionStart?: (event: unknown, ctx: { sessionManager: unknown }) => Promise<void>;
} = {}) {
  if (typeof bootstrap !== "function") {
    throw new TypeError("typed subagent runtime requires an upstream bootstrap function");
  }
  const supervisorAdapter = createSupervisorAdapter();
  const titleRegistry = options.titleRegistry ?? getTitleRegistry(options.cleanupStore ?? globalThis);
  titleRegistry.resetCompleted?.();
  const upstreamShutdownHandlers = [];
  const upstreamSessionStartHandlers = [];
  const deferredEventSubscriptions = [];
  const workingStateTrace = typeof options.workingStateTrace === "function" ? options.workingStateTrace : undefined;
  let notificationState;
  const traceWorkingState = (event, payload = {}) => {
    if (!workingStateTrace || typeof notificationState?.currentSessionId !== "string" || typeof notificationState?.completionOwnerId !== "string") return;
    try {
      workingStateTrace({
        version: 1,
        hostSessionId: notificationState.currentSessionId,
        completionOwnerId: notificationState.completionOwnerId,
        event,
        monotonicMs: Math.floor(Number(process.hrtime.bigint() / 1_000_000n)),
        ...payload,
      });
    } catch { /* 诊断输出不得影响 Pi 生命周期。 */ }
  };
  const cleanupStore = options.cleanupStore ?? globalThis;
  const debtManager = shutdownDebtManager(cleanupStore);
  const debtLane = shutdownDebtLane(debtManager, pi);
  const globalStore = globalThis;
  const globalCleanupKeys = ["__piSubagentRuntimeCleanup", "__piSubagentEventUnsubscribes"];
  const globalOwnership = globalCleanupKeys.map((key) => ({ key, present: Object.hasOwn(globalStore, key), value: globalStore[key] }));
  const hiddenOwnership = debtLane.debts.some((debt) => !debt.completed) || hasPendingSessionDebt(debtManager);
  if (hiddenOwnership) {
    // Upstream performs best-effort global cleanup synchronously during bootstrap.
    // Hide the old generation until its ordered shutdown debt has been repaid.
    for (const { key } of globalOwnership) delete globalStore[key];
  }
  let generationOwnership;
  const rollbackOwnership = new Map();
  const snapshotOwnership = (key) => ({ present: Object.hasOwn(globalStore, key), value: globalStore[key] });
  const matchesOwnership = (key, ownership) => ownership
    && Object.hasOwn(globalStore, key) === ownership.present
    && (!ownership.present || globalStore[key] === ownership.value);
  const cleanupGenerationOwnership = () => {
    if (!generationOwnership) return;
    for (const { key } of globalOwnership) {
      const owned = generationOwnership.get(key);
      if (!matchesOwnership(key, owned)) continue;
      try {
        if (key === "__piSubagentRuntimeCleanup" && typeof owned.value === "function") owned.value();
        if (key === "__piSubagentEventUnsubscribes" && Array.isArray(owned.value)) {
          for (const unsubscribe of owned.value) if (typeof unsubscribe === "function") unsubscribe();
        }
      } catch {
        // Preserve the installation error while continuing best-effort rollback.
      }
      const released = snapshotOwnership(key);
      if (!released.present || matchesOwnership(key, owned)) rollbackOwnership.set(key, released);
    }
  };
  const restoreOwnership = () => {
    if (!hiddenOwnership) return;
    for (const { key, present, value } of globalOwnership) {
      const expected = rollbackOwnership.get(key) ?? generationOwnership?.get(key);
      if (generationOwnership && !matchesOwnership(key, expected)) continue;
      if (present) globalStore[key] = value;
      else delete globalStore[key];
    }
  };
  const captureEventSubscription = (type, handler) => {
    if (typeof handler !== "function") throw new TypeError("upstream event handler must be a function");
    const entry = { type, handler, active: false, cancelled: false, unsubscribe: undefined };
    deferredEventSubscriptions.push(entry);
    return () => {
      if (entry.cancelled) return;
      entry.cancelled = true;
      entry.unsubscribe?.();
      entry.unsubscribe = undefined;
    };
  };
  const activateEventSubscriptions = () => {
    for (const entry of deferredEventSubscriptions) {
      if (entry.cancelled || entry.active) continue;
      entry.unsubscribe = pi.events.on(entry.type, entry.handler);
      entry.active = true;
    }
  };
  try {
  bootstrap(createHeadlessSubagentApi(pi, {
    supervisorAdapter,
    titleRegistry,
    suppressCompletionNotifications: typeof completionNotifierFactory === "function",
    captureSessionStart(handler) {
      if (typeof handler !== "function") throw new TypeError("upstream session_start handler must be a function");
      upstreamSessionStartHandlers.push(handler);
      return () => {
        const index = upstreamSessionStartHandlers.indexOf(handler);
        if (index >= 0) upstreamSessionStartHandlers.splice(index, 1);
      };
    },
    captureSessionShutdown(handler) {
      if (typeof handler !== "function") throw new TypeError("upstream session_shutdown handler must be a function");
      upstreamShutdownHandlers.push({ handler, completed: false });
      return () => {
        const index = upstreamShutdownHandlers.findIndex((entry) => entry.handler === handler);
        if (index >= 0) upstreamShutdownHandlers.splice(index, 1);
      };
    },
    captureEventSubscription,
  }));
  } catch (error) {
    generationOwnership = new Map(globalCleanupKeys.map((key) => [key, snapshotOwnership(key)]));
    cleanupGenerationOwnership();
    restoreOwnership();
    throw error;
  }
  generationOwnership = new Map(globalCleanupKeys.map((key) => [key, snapshotOwnership(key)]));
  // Bootstrap callbacks may use a public event registration API immediately
  // after installing the upstream runtime; registration requires the captured
  // upstream event listeners to be active, otherwise a valid production
  // registration is indistinguishable from an unavailable pi-subagents host
  // and admission fails closed.  When an old generation's shutdown debt is
  // still pending, defer both activation and registration to the repayment
  // point (beforeSessionStart) so the new RPC bridge stays silent during the
  // old drain and admission stays unavailable until the debt is repaid.
  let pendingAfterBootstrap;
  if (hiddenOwnership) {
    pendingAfterBootstrap = () => afterBootstrap?.(createHeadlessSubagentApi(pi, {
      titleRegistry,
      captureEventSubscription,
      workingStateTrace,
    }));
  } else {
    activateEventSubscriptions();
    afterBootstrap?.(createHeadlessSubagentApi(pi, {
      titleRegistry,
      captureEventSubscription,
      workingStateTrace,
    }));
  }

  let completionNotifier;
  let workspaceCompletionReminder;
  try {
    if (typeof completionNotifierFactory === "function" || typeof workspaceCompletionReminderFactory === "function") {
      if (typeof resolveSessionId !== "function") {
        throw new TypeError("completion listener requires a session identity resolver");
      }
      notificationState = { currentSessionId: null };
      const completionApi = createHeadlessSubagentApi(pi, {
        titleRegistry,
        forceCompletionDisplay: true,
        suppressSuccessfulCompletion(event) { return titleRegistry.isFacadeWorkflowSuccess?.(event) === true; },
        captureEventSubscription,
        workingStateTrace,
        getHostIdentity() {
          return { hostSessionId: notificationState.currentSessionId, completionOwnerId: notificationState.completionOwnerId };
        },
      });
      // Register this before the notifier so its follow-up is queued in the notifier's turn.
      if (typeof workspaceCompletionReminderFactory === "function") {
        workspaceCompletionReminder = workspaceCompletionReminderFactory(completionApi, notificationState);
        if (!workspaceCompletionReminder || typeof workspaceCompletionReminder.dispose !== "function") {
          throw new TypeError("workspace completion reminder factory must return a disposable reminder");
        }
      }
      if (typeof completionNotifierFactory === "function") {
        completionNotifier = completionNotifierFactory(completionApi, notificationState);
        if (!completionNotifier || typeof completionNotifier.dispose !== "function") {
          throw new TypeError("completion notifier factory must return a disposable notifier");
        }
      }
      pi.on("session_start", (_event, ctx) => {
        notificationState.currentSessionId = resolveSessionId(ctx.sessionManager);
      });
      const lifecycleEvents = new Map([
        ["agent_start", "agent-start"], ["agent_end", "agent-end"],
        ["agent_settled", "agent-settled"], ["ui_prompt_start", "ui-prompt-start"], ["ui_prompt_end", "ui-prompt-end"],
      ]);
      for (const [type, event] of lifecycleEvents) {
        pi.on(type, (payload) => {
          traceWorkingState(event, {
            ...(typeof payload?.runId === "string" ? { runId: payload.runId } : {}),
            ...(typeof payload?.sessionId === "string" ? { eventSessionId: payload.sessionId } : {}),
          });
          if (event === "agent-settled") traceWorkingState("host-idle");
        });
      }
    }

    return createTypedSubagentExtension(pi, {
    ...options,
    supervisorAdapter,
    titleRegistry,
    extraDisposables: [
      ...(Array.isArray(options.extraDisposables) ? options.extraDisposables : []),
      ...(workspaceCompletionReminder ? [workspaceCompletionReminder] : []),
      ...(completionNotifier ? [completionNotifier] : []),
      ...(notificationState ? [{ dispose() { notificationState.currentSessionId = null; } }] : []),
      { dispose() { for (const entry of deferredEventSubscriptions) { entry.cancelled = true; entry.unsubscribe?.(); entry.unsubscribe = undefined; } } },
    ],
    beforeDispose: beforeRuntimeDispose,
    async beforeSessionStart(event, ctx) {
      await beforeUpstreamSessionStart(event, ctx as { sessionManager: unknown });
      for (const handler of upstreamSessionStartHandlers) await handler(event, ctx);
      activateEventSubscriptions();
      if (pendingAfterBootstrap) {
        const run = pendingAfterBootstrap;
        pendingAfterBootstrap = undefined;
        run();
      }
    },
    async afterBeforeDispose(event, ctx) {
      for (const entry of upstreamShutdownHandlers) {
        if (!Object.hasOwn(entry, "event")) {
          entry.event = event;
          entry.ctx = ctx;
        }
      }
      for (const entry of upstreamShutdownHandlers) {
        if (entry.completed) continue;
        await entry.handler(entry.event, entry.ctx);
        entry.completed = true;
      }
    },
    });
  } catch (error) {
    workspaceCompletionReminder?.dispose?.();
    completionNotifier?.dispose?.();
    for (const entry of deferredEventSubscriptions) {
      entry.cancelled = true;
      entry.unsubscribe?.();
    }
    cleanupGenerationOwnership();
    restoreOwnership();
    throw error;
  }
}
