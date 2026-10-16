/**
 * supervisor-gate-policy.ts —— supervisor child 级门禁的纯策略层（计划 G1）。
 *
 * 依据：
 * - `docs/plans/2026-10-15-supervisor-gate-recovery.md` §2.1/§2.2、G1 任务合同、「G0 后父层执行裁决」；
 * - `docs/plans/records/2026-10-15-supervisor-gate/contract.md` §2.2/§2.3/§3.6（fixed codes）。
 *   其中「稀疏 child 目录」相关接口以父层 G0 后裁决为准：显式非负安全整数 index 直接交原上游投递核
 *   membership，不得要求该 child 在 request 历史里出现过；缺 index 不猜 0、不广播，完整目录不可公开
 *   证明时固定返回歧义码。
 *
 * 硬边界（G1 合同）：
 * - 纯计算：无 IO、无 async、不自取系统时钟（时间由调用方显式传入 `now`）、不读上游/私有 Map/目录、
 *   不修改任何入参（request/receipts/directory/intent 全部按只读消费）。
 * - 零依赖：本文件不 import control-plane / diagnostics / 上游模块，全部使用 feature-owned 结构类型，
 *   避免 G2 接线时形成 control-plane ↔ policy 循环依赖。
 * - fail closed：任何不可证明的分支返回固定 code，绝不猜 0、不广播、不以空集合当「无 pending」、
 *   不为非法数据新增兼容分支。
 */

/** 策略层版本标识，供 G2 接线与诊断投影引用。 */
export const SUPERVISOR_GATE_POLICY_VERSION = "supervisor-gate-policy.v1" as const;

/* ------------------------------------------------------------------ *
 * 1. fixed codes（G0 合同 §3.6；不得复用他人 code）
 * ------------------------------------------------------------------ */

/** 目标 child 确有 needs-reply 事实。既有 code，唯一产生点仍在 control-plane。 */
export const SUPERVISOR_REPLY_REQUIRED = "SUPERVISOR_REPLY_REQUIRED";
/** 缺显式 index 且无法公开证明唯一可 steer child（与 runId 前缀歧义 code 严格分离）。 */
export const SUPERVISOR_STEER_CHILD_AMBIGUOUS = "SUPERVISOR_STEER_CHILD_AMBIGUOUS";
/** request 缺可信 child 关联：不默认 0、不阻断所有 child，单列并由 inspect 逃生口上报。 */
export const SUPERVISOR_REQUEST_SCOPE_UNVERIFIED = "SUPERVISOR_REQUEST_SCOPE_UNVERIFIED";
/** child 目录本身不可读/不可信（含 identity 读失败）。 */
export const SUPERVISOR_TARGET_DIRECTORY_UNAVAILABLE = "SUPERVISOR_TARGET_DIRECTORY_UNAVAILABLE";
/** 显式 index 形态非法（非数字、非安全整数、负数）。既有 code，不新增别名。 */
export const SUPERVISOR_STEER_TARGET_INVALID = "SUPERVISOR_STEER_TARGET_INVALID";
/** intent 字段非法。既有 code。 */
export const SUPERVISOR_INTENT_INVALID = "SUPERVISOR_INTENT_INVALID";
/** request 形状非法（策略层自身校验，形态权威仍是 parseSupervisorRequestV1）。 */
export const SUPERVISOR_REQUEST_INVALID = "SUPERVISOR_REQUEST_INVALID";
/** receipts 参数非法（非数组或含非对象条目）。 */
export const SUPERVISOR_RECEIPT_INVALID = "SUPERVISOR_RECEIPT_INVALID";
/** `now` 缺失或非法：TTL 判断必须由调用方显式给时间。 */
export const SUPERVISOR_CLASSIFICATION_TIME_INVALID = "SUPERVISOR_CLASSIFICATION_TIME_INVALID";
/** 行政清理标记 code（C2 写入 administrativeResolution.code；本层只读识别）。 */
export const SUPERVISOR_ORPHAN_CLEARED = "SUPERVISOR_ORPHAN_CLEARED";

/* ------------------------------------------------------------------ *
 * 2. feature-owned 结构类型（不 import control-plane 类型，避免 cycle）
 * ------------------------------------------------------------------ */

export type SupervisorRequestStateValue = "pending" | "replying" | "replied" | "expired" | "failed";

/**
 * 只读 request 视图：字段全部按 unknown 接收，由本层自行校验。
 * 结构与 `SupervisorRequestV1`（+ v2 的 optional `administrativeResolution`）兼容，
 * 但不建立类型依赖，G2 可直接把已 parse 的 request 传进来。
 */
export type SupervisorGateRequest = Readonly<{
  requestId?: unknown;
  runId?: unknown;
  rootSessionId?: unknown;
  ownerGeneration?: unknown;
  requestGeneration?: unknown;
  requestDigest?: unknown;
  createdAt?: unknown;
  expiresAt?: unknown;
  state?: unknown;
  correlation?: unknown;
  administrativeResolution?: unknown;
}>;

/** 只读 receipt 视图；`childIndex` 为 v2 可选字段，出现即参与精确匹配。 */
export type SupervisorGateReceipt = Readonly<{
  receiptId?: unknown;
  idempotencyKey?: unknown;
  kind?: unknown;
  status?: unknown;
  consumed?: unknown;
  runId?: unknown;
  requestId?: unknown;
  rootSessionId?: unknown;
  ownerGeneration?: unknown;
  requestGeneration?: unknown;
  requestDigest?: unknown;
  childIndex?: unknown;
  code?: unknown;
}>;

export type SupervisorChildScope =
  | Readonly<{ status: "verified"; childIndex: number; agent: string | undefined }>
  | Readonly<{ status: "unverified"; code: typeof SUPERVISOR_REQUEST_SCOPE_UNVERIFIED }>;

export type SupervisorRequestClassification =
  | "needs-reply"
  | "reply-submitted"
  | "consumed"
  | "cleared"
  | "terminal"
  | "scope-unverified";

/** reply 事实投影：queued 与 consumed 是两个独立事实，failed 不解 gate 但允许显式重试。 */
export type SupervisorReplyFacts = Readonly<{
  /** 是否存在通过精确匹配的 reply receipt。 */
  matched: boolean;
  receiptId: string | undefined;
  /** status === "queued" 且 consumed === false：回复已提交，尚未消费。 */
  queued: boolean;
  /** status === "delivered" 或 consumed === true：消费事实存在。 */
  consumed: boolean;
  /** status === "failed"：提交失败，不构成回复已提交。 */
  failed: boolean;
  /** failed 或无匹配时允许同目标显式重试；不得被幂等短路永久锁死。 */
  retryable: boolean;
}>;

export type SupervisorClassifiedRequest = Readonly<{
  status: "classified";
  policyVersion: typeof SUPERVISOR_GATE_POLICY_VERSION;
  classification: SupervisorRequestClassification;
  requestId: string;
  runId: string;
  rootSessionId: string;
  ownerGeneration: number;
  requestGeneration: number;
  requestDigest: string;
  /** 原始 state 原样回显；本层不改写任何持久化状态。 */
  state: SupervisorRequestStateValue;
  scope: SupervisorChildScope;
  createdAt: number;
  expiresAt: number;
  /** 纯时间判断 `now >= expiresAt`，与既有 loadRoot/resolveSupervisorControl 口径一致。 */
  expired: boolean;
  /** pending/replying 且已到期：分类不再作为待回复；是否写回 expired 只由既有持久化事务决定。 */
  expiredByTime: boolean;
  reply: SupervisorReplyFacts;
  /** needs-reply 对应既有 code；scope-unverified 对应独立 code；其余为 undefined。 */
  blockingCode: string | undefined;
  terminalReason: "expired" | "failed" | "replied" | "administratively-cleared" | undefined;
  administrativeCode: string | undefined;
  /** 未通过精确匹配的 receipt 条数（含 steer receipt 与其他 request 的 receipt），仅供诊断。 */
  unmatchedReceipts: number;
}>;

export type SupervisorClassificationRejected = Readonly<{
  status: "rejected";
  policyVersion: typeof SUPERVISOR_GATE_POLICY_VERSION;
  code:
    | typeof SUPERVISOR_REQUEST_INVALID
    | typeof SUPERVISOR_RECEIPT_INVALID
    | typeof SUPERVISOR_CLASSIFICATION_TIME_INVALID;
}>;

export type SupervisorRequestClassificationResult = SupervisorClassifiedRequest | SupervisorClassificationRejected;

/** 目录中的单个 child。`agent`/`steerable` 都是可选提示，不是 membership 证明。 */
export type SupervisorTargetChild = Readonly<{
  childIndex: number;
  agent: string | undefined;
  steerable: boolean | undefined;
}>;

/**
 * child 目录。`complete` 表示「能公开证明这是该 run 的完整 child 集合」；
 * G0 结论：当前没有任何 public 来源可证明完整性（durable correlation 只是稀疏请求历史，
 * asyncSnapshot/fleet 是带 omitted 的有界投影），因此生产调用方必须传 `complete: false`。
 */
export type SupervisorTargetDirectory =
  | Readonly<{
      availability: "available";
      runId: string;
      ownerGeneration: number | undefined;
      complete: boolean;
      children: readonly SupervisorTargetChild[];
    }>
  | Readonly<{ availability: "unavailable"; code: typeof SUPERVISOR_TARGET_DIRECTORY_UNAVAILABLE }>;

export type SupervisorTargetBlockedCode =
  | typeof SUPERVISOR_TARGET_DIRECTORY_UNAVAILABLE
  | typeof SUPERVISOR_STEER_TARGET_INVALID
  | typeof SUPERVISOR_STEER_CHILD_AMBIGUOUS;

export type SupervisorTargetResolution =
  | Readonly<{
      status: "exact";
      target: SupervisorTargetChild;
      /**
       * `directory-confirmed`：目录中存在该 index（附带已证 agent）。
       * `delegated-upstream`：目录稀疏/不可读，membership 交原上游投递校验；
       * 上游返回 isError 即本次投递失败，不得写 queued receipt（G2-wire 责任）。
       */
      membership: "directory-confirmed" | "delegated-upstream";
      /** 是否为「缺 index 时从已证完整目录推断」的结果。 */
      inferred: boolean;
    }>
  | Readonly<{ status: "blocked"; code: SupervisorTargetBlockedCode }>;

/** 带 child 的 steer intent（v2 严格形态）只读视图。 */
export type SupervisorSteerReceiptIntent = Readonly<{
  kind?: unknown;
  rootSessionId?: unknown;
  runId?: unknown;
  ownerGeneration?: unknown;
  childIndex?: unknown;
  payloadDigest?: unknown;
  liveRunEpoch?: unknown;
}>;

/** reply 正文重复保护（STEER_DUPLICATES_REPLY）所需的 child-scoped 作用域。 */
export type SupervisorReplyGuardScope = Readonly<{
  rootSessionId?: unknown;
  runId?: unknown;
  ownerGeneration?: unknown;
  childIndex?: unknown;
  payloadDigest?: unknown;
}>;

export type SupervisorReceiptKeyBlockedCode =
  | typeof SUPERVISOR_INTENT_INVALID
  | typeof SUPERVISOR_STEER_TARGET_INVALID
  | typeof SUPERVISOR_STEER_CHILD_AMBIGUOUS
  | typeof SUPERVISOR_REQUEST_SCOPE_UNVERIFIED;

export type SupervisorReceiptKeyResult =
  | Readonly<{ status: "ok"; key: string; childIndex: number }>
  | Readonly<{ status: "blocked"; code: SupervisorReceiptKeyBlockedCode }>;

/* ------------------------------------------------------------------ *
 * 3. 内部校验工具（全部纯函数）
 * ------------------------------------------------------------------ */

const REQUEST_STATES: readonly string[] = ["pending", "replying", "replied", "expired", "failed"];
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
/** 幂等 key 命名空间：与 v1 receipt key（`requestId:requestGeneration:payloadDigest`）不重叠。 */
const STEER_RECEIPT_KEY_PREFIX = "supervisor-receipt.v2:steer";
/** reply 正文重复保护 key 命名空间，必须与 steer receipt key 不同，避免跨语义碰撞。 */
const REPLY_GUARD_KEY_PREFIX = "supervisor-reply-guard.v2";
/** `liveRunEpoch` 缺失时的显式段值，避免出现字面量 "undefined" 尾段。 */
const EPOCH_ABSENT_SEGMENT = "none";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function digestValue(value: unknown): string | undefined {
  return typeof value === "string" && DIGEST_PATTERN.test(value) ? value : undefined;
}

/**
 * childIndex 规范化：只接受非负安全整数；`-0` 归一为 `0`。
 * 返回 undefined 表示「不可用」，由调用方决定是拒绝还是视为缺失（两者都不得猜 0）。
 */
function childIndexValue(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
  return value === 0 ? 0 : value;
}

type ParsedRequest = Readonly<{
  requestId: string;
  runId: string;
  rootSessionId: string;
  ownerGeneration: number;
  requestGeneration: number;
  requestDigest: string;
  createdAt: number;
  expiresAt: number;
  state: SupervisorRequestStateValue;
  correlation: unknown;
  administrativeResolution: unknown;
}>;

function readRequest(request: SupervisorGateRequest): ParsedRequest | undefined {
  const raw: unknown = request;
  if (!isRecord(raw)) return undefined;
  const requestId = nonEmptyString(raw.requestId);
  const runId = nonEmptyString(raw.runId);
  const rootSessionId = nonEmptyString(raw.rootSessionId);
  const ownerGeneration = positiveSafeInteger(raw.ownerGeneration);
  const requestGeneration = positiveSafeInteger(raw.requestGeneration);
  const requestDigest = digestValue(raw.requestDigest);
  const createdAt = finiteNumber(raw.createdAt);
  const expiresAt = finiteNumber(raw.expiresAt);
  const state = typeof raw.state === "string" && REQUEST_STATES.includes(raw.state)
    ? (raw.state as SupervisorRequestStateValue)
    : undefined;
  if (
    requestId === undefined || runId === undefined || rootSessionId === undefined ||
    ownerGeneration === undefined || requestGeneration === undefined || requestDigest === undefined ||
    createdAt === undefined || expiresAt === undefined || state === undefined
  ) return undefined;
  // 与 parseSupervisorRequestV1 同口径：到期时刻不得早于创建时刻，倒退时间视为非法数据。
  if (expiresAt < createdAt) return undefined;
  return Object.freeze({
    requestId, runId, rootSessionId, ownerGeneration, requestGeneration, requestDigest,
    createdAt, expiresAt, state,
    correlation: raw.correlation,
    administrativeResolution: raw.administrativeResolution,
  });
}

/**
 * child 归属只认已证 correlation.childIndex；缺关联/非法关联一律 unverified，
 * 绝不默认 0，也绝不用它阻断所有 child。agent 仅作展示与交叉校验，不参与归属判断。
 */
function readChildScope(correlation: unknown): SupervisorChildScope {
  const unverified = Object.freeze({ status: "unverified" as const, code: SUPERVISOR_REQUEST_SCOPE_UNVERIFIED });
  if (!isRecord(correlation)) return unverified;
  const childIndex = childIndexValue(correlation.childIndex);
  if (childIndex === undefined) return unverified;
  return Object.freeze({ status: "verified" as const, childIndex, agent: nonEmptyString(correlation.agent) });
}

/**
 * 精确匹配：root/run/ownerGeneration/requestId/requestGeneration 五元组必须逐项全等；
 * receipt 若带 requestDigest 或 childIndex（v2），也必须与 request 已证事实全等。
 * 缺字段（undefined）不视为通配，一律不匹配 —— 这是「跨 scope 旧 receipt 不污染」的核心。
 */
function receiptMatchesRequest(receipt: SupervisorGateReceipt, request: ParsedRequest, scope: SupervisorChildScope): boolean {
  if (receipt.kind !== "reply") return false;
  if (receipt.rootSessionId !== request.rootSessionId) return false;
  if (receipt.runId !== request.runId) return false;
  if (receipt.ownerGeneration !== request.ownerGeneration) return false;
  if (receipt.requestId !== request.requestId) return false;
  if (receipt.requestGeneration !== request.requestGeneration) return false;
  if (receipt.requestDigest !== undefined && receipt.requestDigest !== request.requestDigest) return false;
  if (receipt.childIndex !== undefined) {
    const receiptChild = childIndexValue(receipt.childIndex);
    if (scope.status !== "verified" || receiptChild === undefined || receiptChild !== scope.childIndex) return false;
  }
  return true;
}

/**
 * receipt 事实强度（kind 无关，只读 status/consumed）：
 * 3 = 已消费，2 = 已提交未消费（queued），1 = 失败，0 = 无可枚举事实。
 * queued 必须显式 `consumed === false`；缺 consumed 字段不构成「已提交」事实（fail closed）。
 */
function receiptFactRank(receipt: SupervisorGateReceipt): number {
  const status = nonEmptyString(receipt.status);
  if (status === "delivered" || receipt.consumed === true) return 3;
  if (status === "queued" && receipt.consumed === false) return 2;
  if (status === "failed") return 1;
  return 0;
}

/** 只有带行政清理记录的 failed 才算 cleared；普通业务失败/消费成功都不算。 */
function readAdministrativeCode(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const code = nonEmptyString(value.code);
  if (code === undefined) return undefined;
  // clearedAt 缺失说明这不是一条完整的行政清理记录，按普通 failed 处理。
  if (finiteNumber(value.clearedAt) === undefined) return undefined;
  return code;
}

/* ------------------------------------------------------------------ *
 * 4. classifyRequest：待回复 / 已提交 / 已消费 / 已清理 / 终局 / 归属不可证
 * ------------------------------------------------------------------ */

/**
 * 纯分类：不改 request.state、不写任何过期转换、不消费 receipt。
 * `now` 必须由调用方显式传入（内存与持久化模式共用同一 TTL 口径）。
 */
export function classifyRequest(
  request: SupervisorGateRequest,
  receipts: readonly SupervisorGateReceipt[],
  now: number,
): SupervisorRequestClassificationResult {
  const reject = (code: SupervisorClassificationRejected["code"]): SupervisorClassificationRejected =>
    Object.freeze({ status: "rejected" as const, policyVersion: SUPERVISOR_GATE_POLICY_VERSION, code });

  const parsed = readRequest(request);
  if (parsed === undefined) return reject(SUPERVISOR_REQUEST_INVALID);
  if (typeof now !== "number" || !Number.isFinite(now)) return reject(SUPERVISOR_CLASSIFICATION_TIME_INVALID);
  if (!Array.isArray(receipts)) return reject(SUPERVISOR_RECEIPT_INVALID);

  const scope = readChildScope(parsed.correlation);

  let matched: SupervisorGateReceipt | undefined;
  let matchedRank = 0;
  let unmatchedReceipts = 0;
  for (const entry of receipts as readonly unknown[]) {
    if (!isRecord(entry)) return reject(SUPERVISOR_RECEIPT_INVALID);
    if (!receiptMatchesRequest(entry, parsed, scope)) { unmatchedReceipts++; continue; }
    const rank = receiptFactRank(entry);
    if (rank > matchedRank) { matchedRank = rank; matched = entry; }
  }

  // TTL 口径与既有 loadRoot / resolveSupervisorControl 一致：now >= expiresAt 即视为到期。
  const expired = now >= parsed.expiresAt;
  const replyObligationOpen = parsed.state === "pending" || parsed.state === "replying";
  const administrativeCode = parsed.state === "failed" ? readAdministrativeCode(parsed.administrativeResolution) : undefined;

  let classification: SupervisorRequestClassification;
  let terminalReason: SupervisorClassifiedRequest["terminalReason"];
  let blockingCode: string | undefined;

  if (administrativeCode !== undefined) {
    // 行政清理不是业务失败也不是消费成功；late consumption 不得把它复活成 replied。
    classification = "cleared";
    terminalReason = "administratively-cleared";
  } else if (parsed.state === "expired") {
    classification = "terminal";
    terminalReason = "expired";
  } else if (parsed.state === "failed") {
    classification = "terminal";
    terminalReason = "failed";
  } else if (parsed.state === "replied") {
    if (matchedRank === 3) { classification = "consumed"; }
    else { classification = "terminal"; terminalReason = "replied"; }
  } else if (expired) {
    // 到期的 pending 不得继续作为 needs-reply 阻断 steer；状态写回留给既有事务。
    classification = "terminal";
    terminalReason = "expired";
  } else if (matchedRank === 3) {
    // state 滞后于消费事实时以消费事实为准，不复活 needs-reply。
    classification = "consumed";
  } else if (scope.status === "unverified") {
    // 缺可信 child 关联：不默认 0、不阻断所有 child，单列并由 inspect 上报。
    classification = "scope-unverified";
    blockingCode = SUPERVISOR_REQUEST_SCOPE_UNVERIFIED;
  } else if (matchedRank === 2) {
    // 回复已提交（queued）但未消费：允许新的 steer 排队，queued/consumed 原样保持。
    classification = "reply-submitted";
  } else {
    // 无成功 reply receipt（含只有 failed receipt 的情况）：仍待回复。
    classification = "needs-reply";
    blockingCode = SUPERVISOR_REPLY_REQUIRED;
  }

  const reply: SupervisorReplyFacts = Object.freeze({
    matched: matchedRank > 0,
    receiptId: matched !== undefined ? nonEmptyString(matched.receiptId) : undefined,
    queued: matchedRank === 2,
    consumed: matchedRank === 3,
    failed: matchedRank === 1,
    // failed 或尚无匹配 receipt 时，同目标显式重试必须被允许（不被幂等短路永久锁死）。
    retryable: matchedRank !== 2 && matchedRank !== 3,
  });

  return Object.freeze({
    status: "classified" as const,
    policyVersion: SUPERVISOR_GATE_POLICY_VERSION,
    classification,
    requestId: parsed.requestId,
    runId: parsed.runId,
    rootSessionId: parsed.rootSessionId,
    ownerGeneration: parsed.ownerGeneration,
    requestGeneration: parsed.requestGeneration,
    requestDigest: parsed.requestDigest,
    state: parsed.state,
    scope,
    createdAt: parsed.createdAt,
    expiresAt: parsed.expiresAt,
    expired,
    expiredByTime: replyObligationOpen && expired,
    reply,
    blockingCode,
    terminalReason,
    administrativeCode,
    unmatchedReceipts,
  });
}

/**
 * 该分类结果是否阻断「指定 child」的 steer。
 * 只有已证归属到同一 childIndex 的 needs-reply 才阻断；scope-unverified 不可归属，
 * 既不默认 0 也不阻断所有 child（由 blockingCode 走 inspect 逃生口）。
 * `rejected` 返回 false 只表示「本谓词不回答归属」，调用方必须自行 fail closed，不得当成放行授权。
 */
export function gateBlocksChildSteer(classification: SupervisorRequestClassificationResult, targetChildIndex: unknown): boolean {
  const result: unknown = classification;
  if (!isRecord(result) || result.status !== "classified") return false;
  if (result.classification !== "needs-reply") return false;
  const target = childIndexValue(targetChildIndex);
  if (target === undefined) return false;
  const scope: unknown = result.scope;
  return isRecord(scope) && scope.status === "verified" && scope.childIndex === target;
}

/**
 * 幂等参与策略：只有成功（queued/delivered）receipt 才参与相同 payload/epoch 幂等判定。
 * failed receipt 不得阻止同一目标的显式重试；不可读状态一律不参与（不被短路锁死）。
 */
export function participatesInIdempotency(receipt: SupervisorGateReceipt): boolean {
  if (!isRecord(receipt)) return false;
  return receiptFactRank(receipt) >= 2;
}

/* ------------------------------------------------------------------ *
 * 5. resolveTargetChild：显式 index 精确、缺 index 不猜不广播
 * ------------------------------------------------------------------ */

type ReadableDirectory =
  | { availability: "available"; complete: boolean; children: readonly SupervisorTargetChild[] }
  | { availability: "unavailable" };

/**
 * 目录只按「已证来源」消费：形状非法、children 非数组、条目缺合法 childIndex、
 * 同一 childIndex 重复、缺 runId → 整个目录不可信（unavailable），不做部分采信。
 */
function readDirectory(directory: SupervisorTargetDirectory): ReadableDirectory {
  // 先降级成 unknown 再收窄，避开交叉类型上的判别式收窄差异；目录不可信时不做部分采信。
  const raw: unknown = directory;
  if (!isRecord(raw)) return { availability: "unavailable" };
  if (raw.availability !== "available") return { availability: "unavailable" };
  if (nonEmptyString(raw.runId) === undefined) return { availability: "unavailable" };
  if (raw.ownerGeneration !== undefined && positiveSafeInteger(raw.ownerGeneration) === undefined) {
    return { availability: "unavailable" };
  }
  if (!Array.isArray(raw.children)) return { availability: "unavailable" };
  const children: SupervisorTargetChild[] = [];
  const seen = new Set<number>();
  for (const entry of raw.children as readonly unknown[]) {
    if (!isRecord(entry)) return { availability: "unavailable" };
    const childIndex = childIndexValue(entry.childIndex);
    if (childIndex === undefined) return { availability: "unavailable" };
    if (seen.has(childIndex)) return { availability: "unavailable" };
    seen.add(childIndex);
    children.push(Object.freeze({
      childIndex,
      agent: nonEmptyString(entry.agent),
      steerable: typeof entry.steerable === "boolean" ? entry.steerable : undefined,
    }));
  }
  return { availability: "available", complete: raw.complete === true, children: Object.freeze(children) };
}

/**
 * 目标 child 解析。
 * - 显式合法 index：直接返回 exact target，membership 交原上游投递校验（isError 即失败），
 *   绝不因该 child 未出现在稀疏 request 历史里而判其不存在；
 * - index 非法：SUPERVISOR_STEER_TARGET_INVALID；
 * - 缺 index（undefined/null）：目录不可读 → SUPERVISOR_TARGET_DIRECTORY_UNAVAILABLE；
 *   目录可读但未证明完整（今天恒成立）→ SUPERVISOR_STEER_CHILD_AMBIGUOUS；
 *   只有 complete === true 且恰好一个 steerable child 时才推断，否则同样 ambiguous。
 *   任何分支都不默认 0、不广播。
 */
export function resolveTargetChild(directory: SupervisorTargetDirectory, index?: unknown): SupervisorTargetResolution {
  const blocked = (code: SupervisorTargetBlockedCode) => Object.freeze({ status: "blocked" as const, code });
  const readable = readDirectory(directory);

  // undefined / null 都按「调用方没给 index」处理：走歧义分支，不猜 0。
  if (index === undefined || index === null) {
    if (readable.availability !== "available") return blocked(SUPERVISOR_TARGET_DIRECTORY_UNAVAILABLE);
    if (!readable.complete) return blocked(SUPERVISOR_STEER_CHILD_AMBIGUOUS);
    const steerable = readable.children.filter(child => child.steerable === true);
    if (steerable.length !== 1) return blocked(SUPERVISOR_STEER_CHILD_AMBIGUOUS);
    return Object.freeze({
      status: "exact" as const,
      target: steerable[0],
      membership: "directory-confirmed" as const,
      inferred: true,
    });
  }

  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) {
    return blocked(SUPERVISOR_STEER_TARGET_INVALID);
  }
  const childIndex = index === 0 ? 0 : index;

  if (readable.availability === "available") {
    const confirmed = readable.children.find(child => child.childIndex === childIndex);
    if (confirmed !== undefined) {
      // 返回目录内的只读副本，避免调用方拿到内部引用后改写。
      return Object.freeze({
        status: "exact" as const,
        target: Object.freeze({ childIndex: confirmed.childIndex, agent: confirmed.agent, steerable: confirmed.steerable }),
        membership: "directory-confirmed" as const,
        inferred: false,
      });
    }
  }

  // 稀疏目录不能证明「该 child 不存在」：显式 index 一律交上游投递核 membership。
  return Object.freeze({
    status: "exact" as const,
    target: Object.freeze({ childIndex, agent: undefined, steerable: undefined }),
    membership: "delegated-upstream" as const,
    inferred: false,
  });
}

/* ------------------------------------------------------------------ *
 * 6. child-scoped 幂等 key 与 reply 正文重复保护 key
 * ------------------------------------------------------------------ */

type ScopeKeyParts =
  | { status: "ok"; rootSessionId: string; runId: string; ownerGeneration: number; childIndex: number; payloadDigest: string }
  | { status: "invalid" }
  | { status: "missing-child"; childIndexProvided: boolean };

function readScopeKeyParts(scope: SupervisorReplyGuardScope): ScopeKeyParts {
  const raw: unknown = scope;
  if (!isRecord(raw)) return { status: "invalid" };
  const rootSessionId = nonEmptyString(raw.rootSessionId);
  const runId = nonEmptyString(raw.runId);
  const ownerGeneration = positiveSafeInteger(raw.ownerGeneration);
  const payloadDigest = digestValue(raw.payloadDigest);
  if (rootSessionId === undefined || runId === undefined || ownerGeneration === undefined || payloadDigest === undefined) {
    return { status: "invalid" };
  }
  if (raw.childIndex === undefined || raw.childIndex === null) return { status: "missing-child", childIndexProvided: false };
  const childIndex = childIndexValue(raw.childIndex);
  if (childIndex === undefined) return { status: "missing-child", childIndexProvided: true };
  return { status: "ok", rootSessionId, runId, ownerGeneration, childIndex, payloadDigest };
}

/**
 * steer receipt 幂等 key（v2）：必须含 childIndex，使「同文本发不同 child」不再互相误判幂等。
 * `liveRunEpoch` 缺失时写入显式 `none` 段，避免 v1 的字面量 "undefined" 尾段歧义。
 */
export function steerReceiptKey(intent: SupervisorSteerReceiptIntent): SupervisorReceiptKeyResult {
  if (isRecord(intent) && intent.kind !== undefined && intent.kind !== "steer") {
    return Object.freeze({ status: "blocked" as const, code: SUPERVISOR_INTENT_INVALID });
  }
  const parts = readScopeKeyParts(intent);
  if (parts.status === "invalid") return Object.freeze({ status: "blocked" as const, code: SUPERVISOR_INTENT_INVALID });
  if (parts.status === "missing-child") {
    // 调用方没给 index → 歧义（不猜 0）；给了非法 index → 目标非法。
    return Object.freeze({
      status: "blocked" as const,
      code: parts.childIndexProvided ? SUPERVISOR_STEER_TARGET_INVALID : SUPERVISOR_STEER_CHILD_AMBIGUOUS,
    });
  }
  let epochSegment = EPOCH_ABSENT_SEGMENT;
  if (isRecord(intent) && intent.liveRunEpoch !== undefined && intent.liveRunEpoch !== null) {
    const epoch = positiveSafeInteger(intent.liveRunEpoch);
    if (epoch === undefined) return Object.freeze({ status: "blocked" as const, code: SUPERVISOR_INTENT_INVALID });
    epochSegment = String(epoch);
  }
  const key = `${STEER_RECEIPT_KEY_PREFIX}:${parts.rootSessionId}:${parts.runId}:${parts.ownerGeneration}:child:${parts.childIndex}:${parts.payloadDigest}:epoch:${epochSegment}`;
  return Object.freeze({ status: "ok" as const, key, childIndex: parts.childIndex });
}

/**
 * reply 正文重复保护（STEER_DUPLICATES_REPLY）key：同样收紧到 child 级。
 * childIndex 不可证时返回 SUPERVISOR_REQUEST_SCOPE_UNVERIFIED —— 不得默认 0，
 * 也不得让一个 child 的 reply 正文替另一个 child 制造重复判定。
 */
export function replyPayloadGuardKey(scope: SupervisorReplyGuardScope): SupervisorReceiptKeyResult {
  const parts = readScopeKeyParts(scope);
  if (parts.status === "invalid") return Object.freeze({ status: "blocked" as const, code: SUPERVISOR_INTENT_INVALID });
  if (parts.status === "missing-child") {
    return Object.freeze({
      status: "blocked" as const,
      code: parts.childIndexProvided ? SUPERVISOR_STEER_TARGET_INVALID : SUPERVISOR_REQUEST_SCOPE_UNVERIFIED,
    });
  }
  const key = `${REPLY_GUARD_KEY_PREFIX}:${parts.rootSessionId}:${parts.runId}:${parts.ownerGeneration}:child:${parts.childIndex}:${parts.payloadDigest}`;
  return Object.freeze({ status: "ok" as const, key, childIndex: parts.childIndex });
}
