/**
 * D0：RPC 与 supervisor 白名单诊断投影（package 内部实现，不进入 package.json 的 export 面）。
 *
 * 边界（计划 §5 D0）：
 * - 纯投影：不读文件、不 fetch、不 emit、不访问 Host/RPC/存储，也不改变任何准入判定。
 * - 严格白名单：只输出枚举、布尔、有限整数与符合 control plane ID 规则的 ID 字符串。
 *   正文、session/工作区路径、Error/cause/secondaryError/compensation 对象、payload digest、
 *   idempotencyKey 一律不透传；未知字段一律丢弃，绝不回显原值。
 * - 畸形输入 fail closed：无法安全投影时返回 undefined（RPC 投影则全量布尔为 false）。
 */

/** 与 supervisor-control-plane.ts 的 ID 规则保持一致：首字符字母数字，总长 <=160，禁 `..`。 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
/** 诊断 errorCode 只接受标识符形态（SUPERVISOR_REQUEST_EXPIRED / authority_store_unavailable），排除路径、正文、空格与标点。 */
const SAFE_ERROR_CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** 与 extension.ts 的 nonempty 判定一致：非空字符串即具备，不做 trim 猜测。 */
const nonemptyText = (value: unknown): boolean => typeof value === "string" && value.length > 0;

/** 只接受 safe ID 形态；路径、正文、oversize 或含 `..` 的值一律丢弃。 */
const safeIdValue = (value: unknown): string | undefined =>
  typeof value === "string" && SAFE_ID.test(value) && !value.includes("..") ? value : undefined;

/** 只接受有界非负安全整数（时钟类）；NaN/Infinity/小数/负数丢弃。 */
const boundedInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** generation 沿 control plane 的 positive 规则：必须是从 1 开始的安全整数，0 不是合法世代。 */
const positiveInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;

const safeErrorCode = (value: unknown): string | undefined =>
  typeof value === "string" && SAFE_ERROR_CODE.test(value) ? value : undefined;

/* ------------------------------------------------------------------ *
 * 1. RPC negotiation 投影（计划 D0：RPC 字段）
 * ------------------------------------------------------------------ */

/** 既有 4 个安全 capability 名（与 rpc-client.ts SECURITY_CAPABILITIES 同集合）。 */
const SECURITY_CAPABILITIES: readonly string[] = Object.freeze([
  "asyncSpawn",
  "processTerminalProof",
  "launchResolvedExtensions",
  "runtimeAcknowledgedExtensions",
]);
/** 既有复合身份标签；投影只回显该固定字面量，不回显任何能力值。 */
const RPC_SESSION_CAPABILITY = "rpc:v1/session";

export type RpcNegotiationDispatchPath = "coding" | "generic";
/** dispatchPath 的 fail-closed 哨兵值：调用方传入合同外取值时使用，绝不回显原值。 */
export type RpcNegotiationDispatchPathProjection = RpcNegotiationDispatchPath | "unknown";

export type RpcNegotiationDiagnosticV1 = {
  schemaVersion: "rpc-negotiation-diagnostic.v1";
  /** 固定为断言阶段，避免与旧的 workflow-spawn stage 标签混淆。 */
  stage: "spawn-capability-assertion";
  dispatchPath: RpcNegotiationDispatchPathProjection;
  capabilitiesEnvelopePresent: boolean;
  versionOk: boolean;
  spawnMethodOk: boolean;
  sessionIdPresent: boolean;
  lifecycleIdentityPresent: boolean;
  sessionCwdPresent: boolean;
  cwdEqual: boolean;
  /** 只可能包含 4 个安全 capability 名与 `rpc:v1/session`。 */
  missingCapabilities: readonly string[];
};

/** 镜像 lifecycleSessionIdentity 的判定语义，只返回是否具备，绝不返回身份值。 */
function hasLifecycleSessionIdentity(session: Record<string, unknown> | undefined): boolean {
  if (!session) return false;
  const sessionFile = session.sessionFile;
  if (sessionFile !== null && sessionFile !== undefined && !nonemptyText(sessionFile)) return false;
  return nonemptyText(sessionFile ?? session.sessionId);
}

/**
 * 把一次 ping 结果投影为布尔级诊断。原判定函数 assertSpawnCapabilities 仍是准入权威，
 * 本投影不接管准入，也不改变任何默认值。
 */
export function projectRpcNegotiation(
  result: unknown,
  expectedCwd: string,
  dispatchPath: RpcNegotiationDispatchPath,
): RpcNegotiationDiagnosticV1 {
  const value: Record<string, unknown> = isRecord(result) ? result : {};
  const session: Record<string, unknown> | undefined = isRecord(value.session) ? value.session : undefined;
  // 与断言函数同样的 envelope 判定：truthy 且 typeof object（数组同样成立），保持一致。
  const capabilitiesEnvelopePresent = Boolean(value.capabilities) && typeof value.capabilities === "object";
  const capabilities = capabilitiesEnvelopePresent ? (value.capabilities as Record<string, unknown>) : undefined;

  const methodNames = Array.isArray(value.methods) ? value.methods.filter(nonemptyText) : [];
  const methods = new Set<string>(methodNames as string[]);

  const versionOk = value.version === 1;
  const spawnMethodOk = methods.has("spawn");
  const sessionIdPresent = session ? nonemptyText(session.sessionId) : false;
  const lifecycleIdentityPresent = hasLifecycleSessionIdentity(session);
  const sessionCwdPresent = session ? nonemptyText(session.cwd) : false;
  // 只有双方都是非空字符串且严格相等才声称相等；空-空不声称相等。
  const cwdEqual = Boolean(session && sessionCwdPresent && nonemptyText(expectedCwd) && session.cwd === expectedCwd);

  const missing: string[] = [];
  if (capabilities) {
    // 0.71 契约形态：capability 可为布尔或对象；undefined/null/false 视为不具备。
    for (const capability of SECURITY_CAPABILITIES) {
      const capabilityValue = capabilities[capability];
      if (capabilityValue === undefined || capabilityValue === null || capabilityValue === false) {
        missing.push(capability);
      }
    }
  }
  if (!versionOk || !spawnMethodOk || !sessionIdPresent || !lifecycleIdentityPresent || !sessionCwdPresent || !cwdEqual) {
    missing.push(RPC_SESSION_CAPABILITY);
  }
  // 白名单终筛：投影只可能输出上述固定字面量，任何来自输入的能力名都不回显。
  const missingCapabilities = Object.freeze(missing.filter((name) =>
    SECURITY_CAPABILITIES.includes(name) || name === RPC_SESSION_CAPABILITY));

  const projectedDispatchPath: RpcNegotiationDispatchPathProjection =
    dispatchPath === "coding" || dispatchPath === "generic" ? dispatchPath : "unknown";

  return Object.freeze({
    schemaVersion: "rpc-negotiation-diagnostic.v1" as const,
    stage: "spawn-capability-assertion" as const,
    dispatchPath: projectedDispatchPath,
    capabilitiesEnvelopePresent,
    versionOk,
    spawnMethodOk,
    sessionIdPresent,
    lifecycleIdentityPresent,
    sessionCwdPresent,
    cwdEqual,
    missingCapabilities,
  });
}

/* ------------------------------------------------------------------ *
 * 2. supervisor trace 投影（计划 D0：Supervisor trace 字段）
 * ------------------------------------------------------------------ */

/** 9 类诊断的权威值集合；producer 现状全部带完整 `supervisor-` 前缀（phase 或 type 字段）。 */
const SUPERVISOR_TRACE_PHASES: readonly string[] = Object.freeze([
  "supervisor-registration-failed",
  "supervisor-delivery-compensation-failed",
  "supervisor-owner-read-failed",
  "supervisor-runtime-read-failed",
  "supervisor-consumption-rejected",
  "supervisor-consumption-failed",
  "supervisor-persistence-corrupt",
  "supervisor-persistence-rejected",
  "supervisor-replay-failed",
]);

/** 输出统一为带完整 `supervisor-` 前缀的 9 类枚举。 */
export type SupervisorTracePhase =
  | "supervisor-registration-failed"
  | "supervisor-delivery-compensation-failed"
  | "supervisor-owner-read-failed"
  | "supervisor-runtime-read-failed"
  | "supervisor-consumption-rejected"
  | "supervisor-consumption-failed"
  | "supervisor-persistence-corrupt"
  | "supervisor-persistence-rejected"
  | "supervisor-replay-failed";

/** 精确匹配白名单；不加前缀省略、大小写折叠等宽容分支。 */
function normalizeTracePhase(value: unknown): SupervisorTracePhase | undefined {
  return typeof value === "string" && SUPERVISOR_TRACE_PHASES.includes(value)
    ? (value as SupervisorTracePhase)
    : undefined;
}

export type SupervisorReceiptStatus = "queued" | "delivered" | "failed";

const RECEIPT_STATUSES: readonly SupervisorReceiptStatus[] = Object.freeze(["queued", "delivered", "failed"]);
const receiptStatusOf = (value: unknown): SupervisorReceiptStatus | undefined =>
  typeof value === "string" ? RECEIPT_STATUSES.find((status) => status === value) : undefined;

export type SafeSupervisorTraceV1 = {
  version: 1;
  eventKind: "supervisor-diagnostic";
  phase: SupervisorTracePhase;
  monotonicMs: number;
  runId?: string;
  requestId?: string;
  receiptId?: string;
  rootSessionId?: string;
  errorCode?: string;
  receiptStatus?: SupervisorReceiptStatus;
  consumed?: boolean;
  requestGeneration?: number;
  ownerGeneration?: number;
};

/**
 * 兼容 `phase` 与 `type` 两种既有 producer 形状，输出统一为 `phase` 枚举。
 * 缺 version/monotonicMs 时只在诊断包络层补齐版本与调用方提供的单调时钟；
 * 不补业务身份、不补消费事实。时钟两个来源都不可用时 fail closed 返回 undefined。
 */
export function projectSupervisorTrace(entry: unknown, monotonicMs: number): SafeSupervisorTraceV1 | undefined {
  if (!isRecord(entry)) return undefined;

  // phase 优先，其次 type；两者都必须在白名单内，未知 phase/type 一律不放行。
  const phase = normalizeTracePhase(entry.phase) ?? normalizeTracePhase(entry.type);
  if (!phase) return undefined;

  const clock = boundedInteger(entry.monotonicMs) ?? boundedInteger(monotonicMs);
  if (clock === undefined) return undefined;

  // 扁平字段-only：不遍历 error/cause/secondaryError/compensation 等对象，避免任何正文或路径外泄。
  const runId = safeIdValue(entry.runId);
  const requestId = safeIdValue(entry.requestId);
  const receiptId = safeIdValue(entry.receiptId);
  const rootSessionId = safeIdValue(entry.rootSessionId);
  const errorCode = safeErrorCode(entry.errorCode ?? entry.code);
  const receiptStatus = receiptStatusOf(entry.receiptStatus) ?? receiptStatusOf(entry.status);
  const consumed = typeof entry.consumed === "boolean" ? entry.consumed : undefined;
  const requestGeneration = positiveInteger(entry.requestGeneration);
  const ownerGeneration = positiveInteger(entry.ownerGeneration);

  return Object.freeze({
    version: 1 as const,
    eventKind: "supervisor-diagnostic" as const,
    phase,
    monotonicMs: clock,
    ...(runId === undefined ? {} : { runId }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(receiptId === undefined ? {} : { receiptId }),
    ...(rootSessionId === undefined ? {} : { rootSessionId }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(receiptStatus === undefined ? {} : { receiptStatus }),
    ...(consumed === undefined ? {} : { consumed }),
    ...(requestGeneration === undefined ? {} : { requestGeneration }),
    ...(ownerGeneration === undefined ? {} : { ownerGeneration }),
  });
}

/* ------------------------------------------------------------------ *
 * 3. supervisor receipt 投影（计划 D0：Receipt 字段）
 * ------------------------------------------------------------------ */

export type SupervisorReceiptDiagnosticV1 = {
  schemaVersion: "supervisor-receipt-diagnostic.v1";
  receiptId: string;
  runId: string;
  requestId?: string;
  status: SupervisorReceiptStatus;
  consumed: boolean;
  requestGeneration?: number;
  ownerGeneration?: number;
};

/**
 * 只投影提交/消费的可枚举事实；`kind`、`code`、`idempotencyKey`、`payloadDigest`、
 * `rootSessionId` 与任何路径字段都不在输出集合内。
 * queued 与 consumed 是两个独立事实：绝不由 status 推断 consumed。
 */
export function projectSupervisorReceipt(receipt: unknown): SupervisorReceiptDiagnosticV1 | undefined {
  if (!isRecord(receipt)) return undefined;

  const receiptId = safeIdValue(receipt.receiptId);
  const runId = safeIdValue(receipt.runId);
  const status = receiptStatusOf(receipt.status);
  const consumed = typeof receipt.consumed === "boolean" ? receipt.consumed : undefined;
  // 核心身份或核心状态不合法时无法安全归因，fail closed。
  if (receiptId === undefined || runId === undefined || status === undefined || consumed === undefined) {
    return undefined;
  }

  const requestId = safeIdValue(receipt.requestId);
  const requestGeneration = positiveInteger(receipt.requestGeneration);
  const ownerGeneration = positiveInteger(receipt.ownerGeneration);

  return Object.freeze({
    schemaVersion: "supervisor-receipt-diagnostic.v1" as const,
    receiptId,
    runId,
    ...(requestId === undefined ? {} : { requestId }),
    status,
    consumed,
    ...(requestGeneration === undefined ? {} : { requestGeneration }),
    ...(ownerGeneration === undefined ? {} : { ownerGeneration }),
  });
}
