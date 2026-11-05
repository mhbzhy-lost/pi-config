import { createHash } from "node:crypto";
import { DurableStorage } from "./durable-storage.ts";
import { projectSupervisorReceipt, type SupervisorReceiptDiagnosticV1 } from "./diagnostics.ts";
import { classifyRequest, gateBlocksChildSteer, steerReceiptKey, replyPayloadGuardKey } from "./supervisor-gate-policy.ts";

export type SupervisorRequestState = "pending" | "replying" | "replied" | "expired" | "failed";
export type SupervisorRequestV1 = {
  schemaVersion: "supervisor-request.v1"; requestId: string; runId: string; rootSessionId: string;
  ownerGeneration: number; requestGeneration: number; requestDigest: string;
  createdAt: number; expiresAt: number; state: SupervisorRequestState;
  correlation?: { asyncDir: string; pid: number; lifecycleSessionId: string; processBirth: string; sessionFile: string; childSessionId: string; toolCallId: string; agent: string; childIndex: number; reason: string; requestBodyDigest: string };
};
export type SupervisorRequestV2 = Omit<SupervisorRequestV1, "schemaVersion"> & {
  schemaVersion: "supervisor-request.v2"; childIndex?: number;
};
type SupervisorRequest = SupervisorRequestV1 | SupervisorRequestV2;
export type SupervisorControlIntentV1 = {
  schemaVersion: "supervisor-control-intent.v1"; intentId: string; runId: string;
  rootSessionId: string; ownerGeneration: number; kind: "reply" | "steer"; payloadDigest: string;
  requestId?: string; requestGeneration?: number; liveRunEpoch?: number;
};
export type SupervisorControlIntentV2 = Omit<SupervisorControlIntentV1, "schemaVersion"> & { schemaVersion: "supervisor-control-intent.v2"; childIndex?: number };
export type SupervisorControlIntent = SupervisorControlIntentV1 | SupervisorControlIntentV2;
export type SupervisorDeliveryReceipt = {
  receiptId: string; idempotencyKey: string; kind: "reply" | "steer"; status: "queued" | "delivered" | "failed"; consumed: boolean;
  runId: string; requestId?: string; code?: string; rootSessionId?: string; ownerGeneration?: number; requestGeneration?: number; childIndex?: number; requestDigest?: string;
};

// A non-workspace run has no broker owner generation; only Host session authority can fence its requests.
const UNOWNED_OWNER_GENERATION = 1;
/** D2：每组（requests/receipts）最多返回 50 条，超出截断并置 complete=false。 */
const DIAGNOSTICS_GROUP_LIMIT = 50;
/** D2：读取失败唯一固定错误码；不携带任何底层错误细节。 */
const SUPERVISOR_DIAGNOSTICS_UNAVAILABLE = "SUPERVISOR_DIAGNOSTICS_UNAVAILABLE";

/** readDiagnostics 的 request 投影行：白名单字段，绝不含 correlation/requestDigest 等敏感载荷。 */
export type SupervisorDiagnosticsRequestV1 = {
  requestId: string; runId: string; state: SupervisorRequestState;
  ownerGeneration: number; requestGeneration: number; createdAt: number; expiresAt: number;
  childIndex?: number; classification?: string;
};

/** D2：supervisor 自身 root 有界只读诊断快照。unavailable 时为固定 code 的 fail closed，绝不解释成空 pending。 */
export type SupervisorDiagnosticsV1 = {
  schemaVersion: "supervisor-diagnostics.v1";
  availability: "available" | "unavailable";
  /** 仅 availability === "unavailable" 时存在，固定值，不含任何底层错误文本/cause。 */
  code?: typeof SUPERVISOR_DIAGNOSTICS_UNAVAILABLE;
  requests: readonly SupervisorDiagnosticsRequestV1[];
  receipts: readonly SupervisorReceiptDiagnosticV1[];
  /** 任一组超过 50 条被截断时为 false。 */
  complete: boolean;
};
/**
 * INV-EXIT（审计 §五、矩阵 #16）：每个 supervisor 拒绝码都必须能被调用方归因并
 * 找到下一步，格式对齐 `MANAGED_WORKSPACE_STATE` 范本（service.ts：
 * `<message>; state=...; allowed actions: ...; next: ...`）——本域没有状态机状态，
 * 因此回执为 `<code> … <触发条件/观测事实>; next: <可执行指引>`。
 *
 * 该表是「拒绝码 → next 指引」的唯一权威：`blocked()` 与扩展侧 controlFailure 都
 * 从这里取值，新增拒绝码必须同变更补一条，不得留下无 next 的拒绝码。表内容只影响
 * 回执文案，不参与任何判定。
 */
export const SUPERVISOR_CONTROL_NEXT: Readonly<Record<string, string>> = Object.freeze({
  SUPERVISOR_INTENT_INVALID: "用当前控制面版本重新构造 intent（schemaVersion 与 kind 一致，steer 必须带 childIndex），不要复用上一次的 intent 片段。",
  SUPERVISOR_PERSISTENCE_CORRUPT: "控制面 durable state 校验失败：不要重试同一动作；先用 subagent_run_status 取只读诊断快照（availability=unavailable 即同一损坏），需要修 state 文件时按阻断上报并保留现场。",
  SUPERVISOR_PERSISTENCE_CONFLICT: "控制面 state 写入持续冲突：稍后重试一次；仍冲突按阻断上报并保留 state 文件现场，不要绕过控制面投递。",
  SUPERVISOR_STALE_OWNER: "owner 已换代或 root session 不一致：先用 subagent_run_status 取当前 run 身份，再按当前 owner/root session 重新发起；workspace 场景以 workspace 记录里的 owner run 为准，不要沿用旧 ownerGeneration。",
  SUPERVISOR_OWNER_UNAVAILABLE: "owner receipt 当前不可读（broker 未就绪或存储不可用），这不等于非受管：稍后重试一次；仍不可用时按阻断上报，不要绕过控制面直接投递。",
  SUPERVISOR_REQUEST_IDENTITY_UNAVAILABLE: "上游 native request 缺 id/runId/reason 之一：属上游回执缺陷，按阻断上报并保留现场，不要补造身份字段后重试。",
  SUPERVISOR_REQUEST_NOT_PENDING: "该 request 已不在待回复集合（已回复/已过期/身份不符）：用 subagent_run_status 取 pending 列表核对；仍需干预时改用 subagent_run_steer，需要继续工作则 fresh 派发。",
  SUPERVISOR_REQUEST_EXPIRED: "request 已超时（TTL 20 分钟）：不要重放同一 reply；用 subagent_run_status 确认 run 状态，需要继续对话改用 subagent_run_steer，已终态则 fresh 派发。",
  SUPERVISOR_REQUEST_SCOPE_UNVERIFIED: "request 与 child 的关联不可证：先用 subagent_run_status 核对 pending 项与 child 目录，再按已证实的 child 重新发起，不要猜测 childIndex。",
  SUPERVISOR_RECEIPT_IDENTITY_MISMATCH: "同一幂等键的既有 receipt 属于别的 root/run/owner：不要复用该 payload；核对 run 身份后重新发起。",
  SUPERVISOR_CONSUMPTION_MISMATCH: "消费观察与已提交 receipt 不匹配：保持现场，用 subagent_run_status 取诊断快照，不要重复 reply 或 steer。",
  SUPERVISOR_STEER_CHILD_AMBIGUOUS: "显式提供 `$.index`（0 基 child 下标）后重试；本层不推断 child、不默认 0、不广播。",
  SUPERVISOR_REPLY_REQUIRED: "该 child 仍有未回复的 supervisor request：先用 supervisor_request_reply 回复该 requestId/child，再 steer。",
  STEER_DUPLICATES_REPLY: "该 child 已收到正文相同的 reply：改用语意不同的指导内容重发，不要重复同一 payload。",
  SUPERVISOR_DELIVERY_IDEMPOTENT: "同一控制动作已投递过相同 payload（幂等命中）：不要重试；按既有 receipt 继续，需要新指导请改正文。",
  SUPERVISOR_DELIVERY_COMPENSATION_BLOCKED: "投递失败后的补偿也失败：用 subagent_run_status 取诊断快照定位，按阻断上报并保留现场，不要重复投递同一 payload。",
  SUPERVISOR_REQUEST_INVALID: "request 记录形状非法：保持现场并按阻断上报，不要改写记录后重试。",
  SUPERVISOR_CLASSIFICATION_TIME_INVALID: "控制面未取得合法时钟：属内部缺陷，按阻断上报，不要用重试规避。",
  SUPERVISOR_RECEIPT_INVALID: "receipt 集合含非法条目：按阻断上报并用 subagent_run_status 保留快照现场。",
});

/** 拒绝码 → next 指引的只读查询（未登记的码返回 undefined，不做任何推断）。 */
export function supervisorControlNext(code: unknown): string | undefined {
  return typeof code === "string" ? SUPERVISOR_CONTROL_NEXT[code] : undefined;
}

/**
 * steer 门拒绝的归因事实（矩阵 #16）：三条件坍缩曾导致「运行中 run 被拒且无法
 * 归因」。这里只把判定结果与观测到的 runtime 事实暴露出去，条件表达式与阈值
 * 逐条保持原样（见 resolveSupervisorControl 的调用点）。
 */
export type SupervisorSteerGateRejectionV1 = {
  trigger: "non_running" | "not_steerable" | "live_run_epoch_mismatch";
  running: boolean | null; steerable: boolean | null;
  liveRunEpoch: number | null; expectedLiveRunEpoch: number | null;
  /** 主判定源的显式 state；null = 主源没有显式 state（缺源）而非「已终态」。 */
  explicitState: string | null; childIndex: number;
};

const STEER_GATE_NEXT: Readonly<Record<SupervisorSteerGateRejectionV1["trigger"], string>> = Object.freeze({
  non_running: "刚确认过 running 的瞬时判定失败可原样重试一次；重试仍拒时用 subagent_run_status 核对 run 是否已进入终态，需要继续对话改用 supervisor_request_reply，已终态则 fresh 派发。",
  not_steerable: "run 在跑但上游 steerable=false：用 subagent_run_status 确认状态；不要重复 steer，先 supervisor_request_reply 回复待回复请求，run 结束后处理回执或 fresh 派发。",
  live_run_epoch_mismatch: "调用方携带的 liveRunEpoch 已过期（run 重启或换代）：用 subagent_run_status 重新取得当前 liveRunEpoch 后重试一次；不要手工构造或沿用旧 epoch。",
});

const numeric = (v: unknown): number | null => (Number.isSafeInteger(v) ? (v as number) : null);
const flag = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const text = (v: unknown): string => (v === null ? "null" : String(v));

/**
 * 生成 steer 门拒绝的回执载荷：触发条件 + 观测到的 runtime 事实 + next 指引。
 * 允许 steer 时返回 undefined（调用方继续走原有判定，本函数不改变任何条件）。
 */
function steerGateRejection(
  intent: SupervisorControlIntent, runtime: SupervisorRunIdentity["runtime"] | undefined, childIndex: number,
): { trigger: SupervisorSteerGateRejectionV1["trigger"]; observations: SupervisorSteerGateRejectionV1; facts: string; hint: string } | undefined {
  let trigger: SupervisorSteerGateRejectionV1["trigger"];
  if (!runtime?.running) trigger = "non_running";
  else if (runtime?.steerable !== true) trigger = "not_steerable";
  else if (intent.liveRunEpoch !== undefined && runtime.liveRunEpoch !== intent.liveRunEpoch) trigger = "live_run_epoch_mismatch";
  else return undefined;
  const observations: SupervisorSteerGateRejectionV1 = {
    trigger,
    running: flag(runtime?.running),
    steerable: flag(runtime?.steerable),
    liveRunEpoch: numeric(runtime?.liveRunEpoch),
    expectedLiveRunEpoch: numeric(intent.liveRunEpoch),
    explicitState: typeof runtime?.explicitState === "string" ? runtime.explicitState : null,
    childIndex,
  };
  const facts = `trigger=${trigger}; observed running=${text(observations.running)}, steerable=${text(observations.steerable)}, liveRunEpoch=${text(observations.liveRunEpoch)}${trigger === "live_run_epoch_mismatch" ? ` (expected ${text(observations.expectedLiveRunEpoch)})` : ""}, explicitState=${text(observations.explicitState)}, childIndex=${observations.childIndex}`;
  return { trigger, observations, facts, hint: STEER_GATE_NEXT[trigger] };
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const safeId = (v: unknown, name: string) => { if (typeof v !== "string" || !ID.test(v) || v.includes("..")) throw new Error(`${name} invalid`); return v; };
const positive = (v: unknown, name: string) => { if (!Number.isSafeInteger(v) || (v as number) <= 0) throw new Error(`${name} invalid`); return v as number; };
const nonnegative = (v: unknown, name: string) => { if (!Number.isSafeInteger(v) || (v as number) < 0) throw new Error(`${name} invalid`); return v as number; };
const digestRef = (v: unknown, name: string) => { if (typeof v !== "string" || !DIGEST.test(v)) throw new Error(`${name} invalid`); return v; };
const stable = (v: any): string => Array.isArray(v) ? `[${v.map(stable).join(",")}]` : isObject(v) ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}` : JSON.stringify(v);
export function supervisorCanonicalDigest(value: unknown): string { return `sha256:${createHash("sha256").update(stable(value)).digest("hex")}`; }
function exact(o: Record<string, any>, keys: string[], name: string) { if (Object.keys(o).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(o, k))) throw new Error(`${name} fields invalid`); }

export function parseSupervisorRequestV1(value: unknown): SupervisorRequestV1 {
  if (!isObject(value)) throw new Error("request must be object");
  exact(value, ["schemaVersion","requestId","runId","rootSessionId","ownerGeneration","requestGeneration","requestDigest","createdAt","expiresAt","state", ...(Object.hasOwn(value,"correlation") ? ["correlation"] : [])], "request");
  if (value.schemaVersion !== "supervisor-request.v1") throw new Error("request schema unsupported");
  safeId(value.requestId,"requestId"); safeId(value.runId,"runId"); safeId(value.rootSessionId,"rootSessionId");
  positive(value.ownerGeneration,"ownerGeneration"); positive(value.requestGeneration,"requestGeneration"); digestRef(value.requestDigest,"requestDigest");
  if (!["pending","replying","replied","expired","failed"].includes(value.state) || typeof value.createdAt !== "number" || typeof value.expiresAt !== "number" || value.expiresAt < value.createdAt) throw new Error("request timing/state invalid");
  if (value.correlation !== undefined) {
    const c = value.correlation;
    if (!isObject(c)) throw new Error('request correlation invalid');
    exact(c, ['asyncDir','pid','lifecycleSessionId','processBirth','sessionFile','childSessionId','toolCallId','agent','childIndex','reason','requestBodyDigest'], 'request correlation');
    for (const field of ['asyncDir','lifecycleSessionId','processBirth','sessionFile','childSessionId','toolCallId','agent','reason']) if (typeof c[field] !== 'string' || !c[field]) throw new Error('request correlation invalid');
    if (!Number.isSafeInteger(c.pid) || c.pid <= 0) throw new Error('request pid invalid');
    if (!Number.isSafeInteger(c.childIndex) || c.childIndex < 0) throw new Error('request childIndex invalid');
    digestRef(c.requestBodyDigest,'requestBodyDigest');
  }
  return value as SupervisorRequestV1;
}
export function parseSupervisorControlIntentV1(value: unknown): SupervisorControlIntentV1 {
  if (!isObject(value)) throw new Error("intent must be object");
  const keys = ["schemaVersion","intentId","runId","rootSessionId","ownerGeneration","kind","payloadDigest","requestId","requestGeneration","liveRunEpoch"];
  if (Object.keys(value).some(k => !keys.includes(k))) throw new Error("intent fields invalid");
  if (value.schemaVersion !== "supervisor-control-intent.v1" || !["reply","steer"].includes(value.kind)) throw new Error("intent invalid");
  safeId(value.intentId,"intentId"); safeId(value.runId,"runId"); safeId(value.rootSessionId,"rootSessionId"); positive(value.ownerGeneration,"ownerGeneration"); digestRef(value.payloadDigest,"payloadDigest");
  if (value.kind === "reply") { safeId(value.requestId,"requestId"); positive(value.requestGeneration,"requestGeneration"); }
  if (value.liveRunEpoch !== undefined) positive(value.liveRunEpoch,"liveRunEpoch");
  return value as SupervisorControlIntentV1;
}

export function parseSupervisorControlIntent(value: unknown): SupervisorControlIntent {
  if (!isObject(value) || value.schemaVersion === "supervisor-control-intent.v1") return parseSupervisorControlIntentV1(value);
  if (value.schemaVersion !== "supervisor-control-intent.v2") throw new Error("intent schema unsupported");
  const { childIndex, ...body } = value;
  parseSupervisorControlIntentV1({ ...body, schemaVersion: "supervisor-control-intent.v1" });
  if (value.kind === "steer" || Object.hasOwn(value, "childIndex")) nonnegative(childIndex, "childIndex");
  return value as SupervisorControlIntentV2;
}

function requestChild(request: SupervisorRequest): number | undefined {
  return request.correlation?.childIndex;
}

function parseStoredRequest(value: unknown): SupervisorRequest {
  if (!isObject(value) || value.schemaVersion === "supervisor-request.v1") return parseSupervisorRequestV1(value);
  if (value.schemaVersion !== "supervisor-request.v2") throw new Error("request schema unsupported");
  const { childIndex, ...body } = value;
  const legacy = parseSupervisorRequestV1({ ...body, schemaVersion: "supervisor-request.v1" });
  if (Object.hasOwn(value, "childIndex")) {
    nonnegative(childIndex, "childIndex");
    if (childIndex !== legacy.correlation?.childIndex) throw new Error("request child scope mismatch");
  } else if (legacy.correlation) throw new Error("request child scope missing");
  return value as SupervisorRequestV2;
}

function migrateRequest(request: SupervisorRequest): SupervisorRequestV2 {
  const childIndex = requestChild(request);
  return { ...request, schemaVersion: "supervisor-request.v2", ...(childIndex === undefined ? {} : { childIndex }) };
}

function replyKey(intent: SupervisorControlIntent): string {
  // 原v1键保持可读；v2键精确绑定root/run/owner，避免跨scope幂等碰撞。
  return intent.schemaVersion === "supervisor-control-intent.v1"
    ? `${intent.requestId}:${intent.requestGeneration}:${intent.payloadDigest}`
    : `${intent.rootSessionId}:${intent.runId}:${intent.ownerGeneration}:${intent.requestId}:${intent.requestGeneration}:${intent.childIndex ?? "unverified"}:${intent.payloadDigest}`;
}

function parseStoredState(value: unknown, root: string) {
  if (!isObject(value)) throw new Error("state must be object");
  exact(value, ["schemaVersion", "rootSessionId", "requests", "receipts", "replyPayloads", "stateDigest"], "state");
  if (!["supervisor-state.v1", "supervisor-state.v2"].includes(value.schemaVersion) || value.rootSessionId !== root
    || !Array.isArray(value.requests) || !Array.isArray(value.receipts) || !Array.isArray(value.replyPayloads)) throw new Error("state schema invalid");
  const { stateDigest, ...body } = value;
  if (stateDigest !== supervisorCanonicalDigest(body)) throw new Error("state digest mismatch");
  const parsedRequests = value.requests.map(raw => {
    if (value.schemaVersion === "supervisor-state.v1" && raw?.schemaVersion !== "supervisor-request.v1") throw new Error("legacy request schema invalid");
    const request = parseStoredRequest(raw);
    if (request.rootSessionId !== root) throw new Error("request root mismatch");
    return request;
 });
  const parsedReceipts = value.receipts.map(raw => {
    const keys = ["receiptId", "idempotencyKey", "kind", "status", "consumed", "runId", "requestId", "code", "rootSessionId", "ownerGeneration", "requestGeneration", "requestDigest",
      ...(value.schemaVersion === "supervisor-state.v2" ? ["childIndex"] : [])];
    if (!isObject(raw) || Object.keys(raw).some(key => !keys.includes(key)) || raw.rootSessionId !== root
      || typeof raw.idempotencyKey !== "string" || !["reply", "steer"].includes(raw.kind)
      || !["queued", "delivered", "failed"].includes(raw.status) || typeof raw.consumed !== "boolean"
      || (raw.status === "delivered") !== raw.consumed) throw new Error("receipt schema invalid");
    safeId(raw.receiptId, "receiptId"); safeId(raw.runId, "runId"); positive(raw.ownerGeneration, "ownerGeneration");
    if (raw.requestId !== undefined) safeId(raw.requestId, "requestId");
    if (raw.requestGeneration !== undefined) positive(raw.requestGeneration, "requestGeneration");
    if (raw.requestDigest !== undefined) digestRef(raw.requestDigest, "requestDigest");
    if (raw.childIndex !== undefined) nonnegative(raw.childIndex, "childIndex");
    return raw as SupervisorDeliveryReceipt;
  });
  for (const key of value.replyPayloads) {
    if (typeof key !== "string" || !(key.startsWith(`${root}:`) || key.startsWith(`supervisor-reply-guard.v2:${root}:`))
      || !/:sha256:[a-f0-9]{64}$/.test(key)) throw new Error("reply payload schema invalid");
  }
  return { requests: parsedRequests, receipts: parsedReceipts, replyPayloads: value.replyPayloads as string[] };
}

export type SupervisorOwnerState = "owned" | "unowned" | "unavailable";
export type SupervisorRunIdentity = {
  owner: unknown;
  ownerState: SupervisorOwnerState;
  /** explicitState 只用于拒绝归因，不参与任何判定。 */
  runtime: { runId?: string; ownerGeneration?: number; liveRunEpoch?: number; running?: boolean; steerable?: boolean; explicitState?: string } | undefined;
};

export type SupervisorControlPlaneOptions = {
  readOwnerReceipt?: (runId: string) => unknown | Promise<unknown>;
  readRuntime?: (runId: string) => { runId?: string; ownerGeneration?: number; liveRunEpoch?: number; running?: boolean; steerable?: boolean; explicitState?: string } | Promise<any>;
  now?: () => number; randomId?: () => string; persistenceRoot?: string; diagnosticSink?: (entry: unknown) => void;
};
export function createSupervisorControlPlane(options: SupervisorControlPlaneOptions = {}) {
  const requests = new Map<string, SupervisorRequest>();
  const receipts = new Map<string, SupervisorDeliveryReceipt>();
  const replyPayloads = new Set<string>();
  const now = options.now ?? (() => Date.now());
  const id = options.randomId ?? (() => `${now()}-${Math.random().toString(36).slice(2)}`);
  const storage = options.persistenceRoot ? new DurableStorage({ root: options.persistenceRoot }) : undefined;
  const lockedRoots = new Set<string>();
  const loadedRoots = new Set<string>();
  const corruptRoots = new Set<string>();
  const stateKey = (root: string) => `supervisor-${createHash("sha256").update(root).digest("hex")}`;
  const report = (entry: unknown) => {
    try { options.diagnosticSink?.(entry); } catch (diagnosticError) {
      console.error("[supervisor-control-plane] diagnostic sink failed", diagnosticError);
    }
  };
  const persistenceError = (root: string, error: unknown) => {
    corruptRoots.add(root);
    report({ type: "supervisor-persistence-corrupt", rootSessionId: root, code: (error as any)?.code ?? "SUPERVISOR_PERSISTENCE_CORRUPT", error, cause: (error as any)?.cause });
  };
  const stateDigest = (value: unknown) => supervisorCanonicalDigest(value);
  async function loadRoot(root: string): Promise<boolean> {
    if (!storage || loadedRoots.has(root)) return !corruptRoots.has(root);
    try {
      const saved: any = await storage.read(stateKey(root));
      const value: any = saved?.value ?? { schemaVersion: "supervisor-state.v1", rootSessionId: root, requests: [], receipts: [], replyPayloads: [], stateDigest: stateDigest({ schemaVersion: "supervisor-state.v1", rootSessionId: root, requests: [], receipts: [], replyPayloads: [] }) };
      const parsed = parseStoredState(value, root);
      for (const request of parsed.requests) {
        const migrated = migrateRequest(request);
        if (migrated.state === 'pending' && now() >= migrated.expiresAt) {
          migrated.state = 'expired'; report({ type: 'supervisor-persistence-rejected', rootSessionId: root, requestId: migrated.requestId, code: 'SUPERVISOR_REQUEST_EXPIRED' });
        }
        requests.set(`${root}:${migrated.runId}:${migrated.ownerGeneration}:${migrated.requestId}:${migrated.requestDigest}`, migrated);
      }
      for (const receipt of parsed.receipts) receipts.set(receipt.idempotencyKey, receipt);
      for (const payload of parsed.replyPayloads) replyPayloads.add(payload);
      loadedRoots.add(root);
      return true;
    } catch (error) { persistenceError(root, error); return false; }
  }
  async function saveRoot(root: string) {
    if (!storage || corruptRoots.has(root)) return;
    const stateBody = { schemaVersion: "supervisor-state.v2", rootSessionId: root,
      requests: [...requests.values()].filter(request => request.rootSessionId === root).map(migrateRequest),
      receipts: [...receipts.values()].filter(receipt => receipt.rootSessionId === root),
      replyPayloads: [...replyPayloads].filter(payload => payload.startsWith(`${root}:`) || payload.startsWith(`supervisor-reply-guard.v2:${root}:`)) };
    const value = { ...stateBody, stateDigest: stateDigest(stateBody) };
    for (let attempt = 0; attempt < 8; attempt++) {
      const prior = await storage.read(stateKey(root));
      try { if (lockedRoots.has(root)) await storage.writeLocked(stateKey(root), value, prior?.revision ?? 0); else await storage.write(stateKey(root), value, prior?.revision ?? 0); return; }
      catch (error) { if ((error as any)?.code !== "DURABLE_REVISION_CONFLICT") throw error; }
    }
    throw new Error("SUPERVISOR_PERSISTENCE_CONFLICT");
  }
  // 所有公开durable操作在同一root锁内重载最新状态，禁止对陈旧snapshot只重试写。
  const memoryLanes = new Map<string, Promise<unknown>>();
  async function transaction<T>(root: string, operation: () => Promise<T>): Promise<T> {
    if (!storage) {
      const flight = (memoryLanes.get(root) ?? Promise.resolve()).catch(() => undefined).then(operation);
      memoryLanes.set(root, flight);
      try { return await flight; } finally { if (memoryLanes.get(root) === flight) memoryLanes.delete(root); }
    }
    let release: (() => Promise<void>) | undefined;
    const deadline = Date.now() + 5000;
    for (;;) {
      try { release = await storage.acquireLock(stateKey(root)); break; }
      catch (error) { if (error?.code !== 'DURABLE_LOCK_HELD' || Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    try {
      for (const [key, r] of requests) if (r.rootSessionId === root) requests.delete(key);
      for (const [key, r] of receipts) if (r.rootSessionId === root) receipts.delete(key);
      for (const payload of replyPayloads) if (payload.startsWith(`${root}:`) || payload.startsWith(`supervisor-reply-guard.v2:${root}:`)) replyPayloads.delete(payload);
      loadedRoots.delete(root); lockedRoots.add(root);
      return await operation();
    } finally { lockedRoots.delete(root); await release(); }
  }
  // INV-EXIT：拒绝回执统一携带 hint（next 指引）与可选 diagnostic（触发条件/观测事实）。
  // extra 可覆盖 hint；未显式给出时取 SUPERVISOR_CONTROL_NEXT 的登记值。
  const blocked = (code: string, extra: Record<string, unknown> = {}, next?: string) => ({
    status: "blocked" as const, code,
    ...(next !== undefined || supervisorControlNext(code) !== undefined ? { hint: next ?? supervisorControlNext(code) } : {}),
    ...extra,
  });
  // owner 读取三态：依赖缺失或抛异常一律 unavailable（无法证明非受管），
  // 只有成功查询且确认无 receipt 才是 unowned。“读不到”绝不等同于“不受管”。
  async function readOwnerState(runId: string): Promise<{ state: SupervisorOwnerState; receipt: any }> {
    if (typeof options.readOwnerReceipt !== "function") return { state: "unavailable", receipt: undefined };
    try {
      const receipt = await options.readOwnerReceipt(runId);
      return receipt ? { state: "owned", receipt } : { state: "unowned", receipt: undefined };
    } catch (error) {
      // broker 对「无当前 owner receipt」的权威回答是抛 code=unknown_run
      // （root-broker-server.ts readOwnerReceipt / authority-store.ts read），
      // 这是唯一可用来「确认非受管」的信号；其余任何失败（存储不可用、锁竞争、
      // CAS 冲突、revoked、布局不支持、无 code 的未知错误）均为「无法确认」，
      // 必须 fail-closed，绝不得当成非受管而放行。
      if ((error as any)?.code === "unknown_run") return { state: "unowned", receipt: undefined };
      report({ phase: "supervisor-owner-read-failed", runId, error, cause: (error as any)?.cause, errorCode: (error as any)?.code ?? "SUPERVISOR_OWNER_UNAVAILABLE" });
      return { state: "unavailable", receipt: undefined };
    }
  }
  async function registerSupervisorRequest(native: any, hostRootSessionId?: string) {
    if (!isObject(native) || typeof native.id !== "string" || typeof native.runId !== "string" || typeof native.reason !== "string") return blocked("SUPERVISOR_REQUEST_IDENTITY_UNAVAILABLE");
    const { state, receipt } = await readOwnerState(native.runId);
    if (state === "unavailable") return blocked("SUPERVISOR_OWNER_UNAVAILABLE");
    const owner: any = state === "owned" ? receipt : { runId: native.runId, rootSessionId: hostRootSessionId, ownerGeneration: UNOWNED_OWNER_GENERATION };
    if (!owner || owner.runId !== native.runId || typeof owner.rootSessionId !== "string" || !Number.isSafeInteger(owner.ownerGeneration)) return blocked("SUPERVISOR_OWNER_UNAVAILABLE");
    if (!(await loadRoot(owner.rootSessionId))) return blocked("SUPERVISOR_PERSISTENCE_CORRUPT");
    const requestId = native.id; const requestDigest = supervisorCanonicalDigest({ id: native.id, runId: native.runId, agent: native.agent, reason: native.reason, expectsReply: native.expectsReply, replyTo: native.replyTo });
    const key = `${owner.rootSessionId}:${native.runId}:${owner.ownerGeneration}:${requestId}:${requestDigest}`;
    const existing = requests.get(key); if (existing) return { status: "registered" as const, request: existing };
    const t = now();
    const request = parseSupervisorRequestV1({ ...(native.correlation ? { correlation: native.correlation } : {}), schemaVersion: "supervisor-request.v1", requestId, runId: native.runId, rootSessionId: owner.rootSessionId, ownerGeneration: owner.ownerGeneration, requestGeneration: Number.isSafeInteger(native.requestGeneration) ? native.requestGeneration : 1, requestDigest, createdAt: t, expiresAt: t + 20 * 60 * 1000, state: "pending" });
    const migrated = migrateRequest(request);
    requests.set(key, migrated); await saveRoot(owner.rootSessionId); return { status: "registered" as const, request: migrated };
  }
  function findPending(intent: SupervisorControlIntent) { return [...requests.values()].find(r => r.state === "pending" && r.runId === intent.runId && r.rootSessionId === intent.rootSessionId && r.ownerGeneration === intent.ownerGeneration && r.requestId === intent.requestId && r.requestGeneration === intent.requestGeneration); }
  async function resolveSupervisorControl(intentInput: unknown, hostRootSessionId?: string) {
    let intent: SupervisorControlIntent; try { intent = parseSupervisorControlIntent(intentInput); } catch { return blocked("SUPERVISOR_INTENT_INVALID"); }
    if (!(await loadRoot(intent.rootSessionId))) return blocked("SUPERVISOR_PERSISTENCE_CORRUPT");
    const runtime: any = await options.readRuntime?.(intent.runId);
    const { state, receipt: owner } = await readOwnerState(intent.runId);
    if (state === "owned") {
      if (!owner || owner.rootSessionId !== intent.rootSessionId || owner.ownerGeneration !== intent.ownerGeneration || runtime?.ownerGeneration !== intent.ownerGeneration) return blocked("SUPERVISOR_STALE_OWNER");
    } else if (state !== "unowned" || typeof hostRootSessionId !== "string" || hostRootSessionId !== intent.rootSessionId || intent.ownerGeneration !== UNOWNED_OWNER_GENERATION) return blocked("SUPERVISOR_STALE_OWNER");
    const allReceipts = [...receipts.values()];
    const childIndex = intent.schemaVersion === "supervisor-control-intent.v2" ? intent.childIndex : undefined;
    // child身份仅用于steer隔离；reply旧合同和终局消费继续按精确request身份处理。
    if (intent.kind === "steer") {
      if (childIndex === undefined) return blocked("SUPERVISOR_STEER_CHILD_AMBIGUOUS");
      const steerRejection = steerGateRejection(intent, runtime, childIndex);
      if (steerRejection) return blocked("SUPERVISOR_STEER_NOT_ALLOWED", {
        diagnostic: { reason: steerRejection.trigger, facts: steerRejection.facts, observations: steerRejection.observations, fields: ["runtime.running", "runtime.steerable", "runtime.liveRunEpoch", "runtime.explicitState"] },
      }, steerRejection.hint);
    }
    const pending = intent.kind === "reply" ? findPending(intent) : undefined;
    if (pending && childIndex !== undefined && requestChild(pending) !== childIndex) return blocked("SUPERVISOR_REQUEST_SCOPE_UNVERIFIED");
    const steerKey = intent.kind === "steer" ? steerReceiptKey({ ...intent, childIndex }) : undefined;
    if (steerKey?.status === "blocked") return blocked(steerKey.code);
    const key = intent.kind === "reply" ? replyKey(intent) : steerKey?.status === "ok" ? steerKey.key : "";
    const prior = receipts.get(key);
    if (prior && (prior.rootSessionId !== intent.rootSessionId || prior.runId !== intent.runId || prior.ownerGeneration !== intent.ownerGeneration)) return blocked('SUPERVISOR_RECEIPT_IDENTITY_MISMATCH');
    if (prior && prior.status !== "failed") return { status: "idempotent" as const, receipt: prior };
    if (!pending && intent.kind === "reply") return blocked("SUPERVISOR_REQUEST_NOT_PENDING");
    if (pending && now() >= pending.expiresAt) { pending.state = "expired"; return blocked("SUPERVISOR_REQUEST_EXPIRED"); }
    if (intent.kind === "steer") {
      const relevant = [...requests.values()].filter(r => ["pending", "replying"].includes(r.state)
        && r.runId === intent.runId && r.rootSessionId === intent.rootSessionId && r.ownerGeneration === intent.ownerGeneration);
      for (const request of relevant) {
        const classification = classifyRequest(request, allReceipts, now());
        if (classification.status === "rejected") return blocked(classification.code);
        if (classification.classification === "scope-unverified") return blocked("SUPERVISOR_REQUEST_SCOPE_UNVERIFIED");
        if (gateBlocksChildSteer(classification, childIndex)) return blocked("SUPERVISOR_REPLY_REQUIRED", { requestId: request.requestId, childIndex });
      }
      // 重复reply正文保护按child核对；queued不是consumed，但已提交正文仍不能重复steer。
      const duplicate = [...requests.values()].some(request => request.rootSessionId === intent.rootSessionId
        && request.runId === intent.runId && request.ownerGeneration === intent.ownerGeneration && requestChild(request) === childIndex
        && allReceipts.some(receipt => receipt.kind === "reply" && receipt.status !== "failed"
          && receipt.rootSessionId === request.rootSessionId && receipt.runId === request.runId
          && receipt.ownerGeneration === request.ownerGeneration && receipt.requestId === request.requestId
          && receipt.requestGeneration === request.requestGeneration && receipt.idempotencyKey.endsWith(`:${intent.payloadDigest}`)));
      const guard = replyPayloadGuardKey({ ...intent, childIndex });
      if (duplicate || (guard.status === "ok" && replyPayloads.has(guard.key))) return blocked("STEER_DUPLICATES_REPLY");
    }
    return { status: "allowed" as const, intent, idempotencyKey: key, request: pending };
  }
  async function commitDelivery(input: { intent: unknown; success?: boolean; code?: string; consumed?: boolean }, hostRootSessionId?: string) {
    const intent = parseSupervisorControlIntent(input.intent); const decision: any = await resolveSupervisorControl(intent, hostRootSessionId);
    if (decision.status === "idempotent") {
      // A queued follow-up is not terminally delivered yet. The child may
      // later consume the same correlated payload, so allow that observation
      // to advance the existing durable receipt exactly once.
      if (input.consumed === true && decision.receipt.status === "queued") {
        decision.receipt.status = "delivered";
        decision.receipt.consumed = true;
        const request = intent.kind === 'reply' ? [...requests.values()].find(r=>r.state!=='failed' && r.runId===intent.runId && r.rootSessionId===intent.rootSessionId && r.ownerGeneration===intent.ownerGeneration && r.requestId===intent.requestId && r.requestGeneration===intent.requestGeneration) : undefined;
        if (request) request.state = "replied";
        if (intent.kind === "reply" && request?.correlation) {
          const guard = replyPayloadGuardKey({ ...intent, childIndex: requestChild(request) });
          if (guard.status === "ok") replyPayloads.add(guard.key);
        }
        await saveRoot(intent.rootSessionId);
        return { status: "committed" as const, receipt: decision.receipt };
      }
      return decision;
    }
    if (decision.status !== "allowed") return decision;
    const consumed = input.consumed === true;
    const receipt: SupervisorDeliveryReceipt = { receiptId: `receipt-${id()}`, idempotencyKey: decision.idempotencyKey, kind: intent.kind, status: input.success === false ? "failed" : consumed ? "delivered" : "queued", consumed, runId: intent.runId, rootSessionId: intent.rootSessionId, ownerGeneration: intent.ownerGeneration, ...(("childIndex" in intent && intent.childIndex !== undefined) ? { childIndex: intent.childIndex } : {}), ...(decision.request ? { requestDigest: decision.request.requestDigest } : {}), ...(intent.requestGeneration ? { requestGeneration: intent.requestGeneration } : {}), ...(intent.requestId ? { requestId: intent.requestId } : {}), ...(input.code ? { code: input.code } : {}) };
    receipts.set(decision.idempotencyKey, receipt);
    if (intent.kind === "reply" && decision.request) {
      // 投递失败不终结待回复义务；同一请求允许显式重试。
      decision.request.state = receipt.status === "delivered" ? "replied" : "pending";
      if (receipt.status === "delivered" && decision.request.correlation) {
        const guard = replyPayloadGuardKey({ ...intent, childIndex: requestChild(decision.request) });
        if (guard.status === "ok") replyPayloads.add(guard.key);
      }
    }
    await saveRoot(intent.rootSessionId);
    return { status: "committed" as const, receipt };
  }
  async function markDeliveryConsumed(intent: unknown, hostRootSessionId?: string) {
    return commitDelivery({ intent, consumed: true }, hostRootSessionId);
  }
  async function closeRootRequests(root: string) {
    if (!(await loadRoot(root))) return blocked('SUPERVISOR_PERSISTENCE_CORRUPT');
    for (const request of requests.values()) if (request.rootSessionId === root && ['pending','replying'].includes(request.state)) request.state = 'failed';
    for (const receipt of receipts.values()) if (receipt.rootSessionId === root && receipt.status === 'queued') { receipt.status = 'failed'; receipt.code = 'SUPERVISOR_PARENT_CLOSED'; }
    await saveRoot(root);
    return { status: 'committed' as const };
  }
  async function expireTerminalRequests(runId: string, hostRootSessionId: string, terminalState: "expired" | "failed" = "expired") {
    if (!(await loadRoot(hostRootSessionId))) return blocked('SUPERVISOR_PERSISTENCE_CORRUPT');
    const identity = await readOwnerState(runId);
    if (identity.state === 'unavailable' || (identity.state === 'owned' && identity.receipt.rootSessionId !== hostRootSessionId)) return blocked('SUPERVISOR_STALE_OWNER');
    let expired = 0;
    for (const request of requests.values()) {
      if (request.runId !== runId || request.rootSessionId !== hostRootSessionId || request.state !== 'pending') continue;
      if (identity.state === 'owned' && identity.receipt.ownerGeneration !== request.ownerGeneration) continue;
      request.state = terminalState; expired++;
    }
    await saveRoot(hostRootSessionId);
    return { status: 'committed' as const, expired };
  }
  async function observeReplyConsumption(observation: { runId: string; requestId: string; payloadDigest: string }, hostRootSessionId: string) {
    if (!(await loadRoot(hostRootSessionId))) return blocked('SUPERVISOR_PERSISTENCE_CORRUPT');
    const request = [...requests.values()].find(r => r.rootSessionId === hostRootSessionId && r.runId === observation.runId && r.requestId === observation.requestId);
    if (!request) return blocked('SUPERVISOR_REQUEST_NOT_PENDING');
    // 以完整请求身份定位原receipt；旧v1键原样读取，不为缺child事实猜0。
    const base = { intentId: "consumption", rootSessionId: request.rootSessionId, runId: request.runId, ownerGeneration: request.ownerGeneration,
      kind: "reply" as const, requestId: request.requestId, requestGeneration: request.requestGeneration, payloadDigest: observation.payloadDigest };
    const legacy = { ...base, schemaVersion: "supervisor-control-intent.v1" as const };
    const current = { ...base, schemaVersion: "supervisor-control-intent.v2" as const,
      ...(requestChild(request) === undefined ? {} : { childIndex: requestChild(request) }) };
    const receipt = receipts.get(replyKey(current)) ?? receipts.get(replyKey(legacy));
    if (!receipt || receipt.kind !== 'reply' || receipt.rootSessionId !== hostRootSessionId || receipt.runId !== request.runId
      || receipt.ownerGeneration !== request.ownerGeneration || receipt.requestGeneration !== request.requestGeneration || receipt.status === 'failed') return blocked('SUPERVISOR_CONSUMPTION_MISMATCH');
    const intent = receipt.idempotencyKey === replyKey(current) ? current : legacy;
    return markDeliveryConsumed(intent, hostRootSessionId);
  }
  // D2：持久化模式下按既有 schema/stateDigest 语义只读重读自身 root 已存 state。
  // 不做 TTL 过期改写、不写 corruptRoots、不触发诊断 sink、不改任何 Map/Set；
  // 任何校验失败直接抛出，由 readDiagnostics 统一 fail closed，绝不新增宽容分支。
  async function readPersistedRootStateForDiagnostics(root: string): Promise<{ requests: SupervisorRequest[]; receipts: SupervisorDeliveryReceipt[] }> {
    if (!storage) throw new Error("diagnostics storage unavailable");
    const saved: any = await storage.read(stateKey(root));
    if (!saved) return { requests: [], receipts: [] };
    const value: any = saved.value;
    const parsed = parseStoredState(value, root);
    return { requests: parsed.requests, receipts: parsed.receipts };
  }

  // D2：supervisor 自身 root 的有界只读 provenance 投影（只读安全副本）。
  // 唯一允许的文件系统副作用是 DurableStorage.read 首次为自身 persistenceRoot 执行的 0700
  // ensureRoot mkdir；已有 state 文件字节/mtime 不变。不调用 loadRoot/ready/transaction
  // （避免 TTL 过期改写与 Map 重载），不改任何 Map/Set，不铸造 token，不启动 broker，
  // 不扫描其它 root；requests 保持存储观察值，不额外计算 expired/gate-open。
  async function readDiagnostics(rootSessionId: string, filter?: { requestId?: string }): Promise<SupervisorDiagnosticsV1> {
    try {
      // root 身份由调用方 Host resolver 提供；形状不合法时 fail closed，不发起任何读取。
      safeId(rootSessionId, "rootSessionId");
      let requestIdFilter: string | undefined;
      if (filter !== undefined) {
        if (!isObject(filter) || Object.keys(filter).some(key => key !== "requestId")) throw new Error("diagnostics filter invalid");
        if (filter.requestId !== undefined && (typeof filter.requestId !== "string" || !ID.test(filter.requestId) || filter.requestId.includes(".."))) throw new Error("diagnostics filter invalid");
        requestIdFilter = filter.requestId;
      }
      let storedRequests: SupervisorRequest[];
      let storedReceipts: SupervisorDeliveryReceipt[];
      if (storage) {
        // 持久化模式：直接 read 唯一 DurableStorage 对应 root 的已存 state 并验证既有 schema/digest。
        const persisted = await readPersistedRootStateForDiagnostics(rootSessionId);
        storedRequests = persisted.requests; storedReceipts = persisted.receipts;
      } else {
        // 无持久化：从既有内存 Map 过滤出本 root 的安全副本（不引用原对象，不修改 Map）。
        storedRequests = [...requests.values()].filter(request => request.rootSessionId === rootSessionId);
        storedReceipts = [...receipts.values()].filter(receipt => receipt.rootSessionId === rootSessionId);
      }
      if (requestIdFilter !== undefined) {
        // requestId 只能收窄本 root 的投影（request 与其对应 receipt 同步收窄），绝不扩大 scope。
        storedRequests = storedRequests.filter(request => request.requestId === requestIdFilter);
        storedReceipts = storedReceipts.filter(receipt => receipt.requestId === requestIdFilter);
      }
      // 按 ID 升序稳定排序（相等时保持存储顺序），每组最多 50 条。
      storedRequests.sort((a, b) => (a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0));
      storedReceipts.sort((a, b) => (a.receiptId < b.receiptId ? -1 : a.receiptId > b.receiptId ? 1 : 0));
      const complete = storedRequests.length <= DIAGNOSTICS_GROUP_LIMIT && storedReceipts.length <= DIAGNOSTICS_GROUP_LIMIT;
      const projectedRequests = storedRequests.slice(0, DIAGNOSTICS_GROUP_LIMIT).map(request => Object.freeze({
        requestId: request.requestId, runId: request.runId, state: request.state,
        ownerGeneration: request.ownerGeneration, requestGeneration: request.requestGeneration,
        createdAt: request.createdAt, expiresAt: request.expiresAt,
        ...(requestChild(request) === undefined ? {} : { childIndex: requestChild(request) }),
        classification: (() => { const value = classifyRequest(request, storedReceipts, now()); return value.status === "classified" ? value.classification : "scope-unverified"; })(),
      }));
      const projectedReceipts: SupervisorReceiptDiagnosticV1[] = [];
      for (const receipt of storedReceipts.slice(0, DIAGNOSTICS_GROUP_LIMIT)) {
        const projected = projectSupervisorReceipt(receipt);
        if (!projected) throw new Error("receipt diagnostic projection failed");
        projectedReceipts.push(projected);
      }
      return Object.freeze({
        schemaVersion: "supervisor-diagnostics.v1" as const,
        availability: "available" as const,
        requests: Object.freeze(projectedRequests),
        receipts: Object.freeze(projectedReceipts),
        complete,
      });
    } catch {
      // 读取失败 fail closed：固定 code 的 unavailable，绝不解释成「空 pending」，不外泄任何错误细节。
      return Object.freeze({
        schemaVersion: "supervisor-diagnostics.v1" as const,
        availability: "unavailable" as const,
        code: SUPERVISOR_DIAGNOSTICS_UNAVAILABLE,
        requests: Object.freeze([]),
        receipts: Object.freeze([]),
        complete: false,
      });
    }
  }
  return Object.freeze({
    registerSupervisorRequest: async (native: any, hostRootSessionId?: string) => {
      const identity = await readOwnerState(native?.runId);
      const root = identity.state === 'owned' ? identity.receipt.rootSessionId : hostRootSessionId;
      return typeof root === 'string' ? transaction(root, () => registerSupervisorRequest(native, hostRootSessionId)) : registerSupervisorRequest(native, hostRootSessionId);
    },
    resolveSupervisorControl: (intent: any, root?: string) => transaction(intent.rootSessionId, () => resolveSupervisorControl(intent, root)),
    commitDelivery: (input: any, root?: string) => transaction(input.intent.rootSessionId, () => commitDelivery(input, root)),
    markDeliveryConsumed: (intent: any, root?: string) => transaction(intent.rootSessionId, () => markDeliveryConsumed(intent, root)),
    observeReplyConsumption: (value: any, root: string) => transaction(root, () => observeReplyConsumption(value, root)),
    readDiagnostics: (rootSessionId: string, filter?: { requestId?: string }) => readDiagnostics(rootSessionId, filter),
    closeRootRequests: (root: string) => transaction(root, () => closeRootRequests(root)),
    expireTerminalRequests: (runId: string, root: string, state?: 'expired' | 'failed') => transaction(root, () => expireTerminalRequests(runId, root, state)),
    ready: async (rootSessionId: string) => transaction(rootSessionId, () => loadRoot(rootSessionId)),
    findRequestAsync: async (requestId: string, rootSessionId?: string) => {
      if (storage && typeof rootSessionId !== 'string') return undefined;
      const find = async () => { if (rootSessionId && !(await loadRoot(rootSessionId))) return undefined; return [...requests.values()].find(r => r.requestId === requestId && (!rootSessionId || r.rootSessionId === rootSessionId)); };
      return rootSessionId ? transaction(rootSessionId, find) : find();
    },
    identityForRun: async (runId: string): Promise<SupervisorRunIdentity> => {
      const { state, receipt } = await readOwnerState(runId);
      let runtime: SupervisorRunIdentity["runtime"];
      try { runtime = await options.readRuntime?.(runId); } catch (error) {
        report({ phase: "supervisor-runtime-read-failed", runId, error, cause: (error as any)?.cause, errorCode: (error as any)?.code ?? "SUPERVISOR_RUNTIME_UNAVAILABLE" });
        runtime = undefined;
      }
      return { owner: receipt, ownerState: state, runtime };
    },
    listPending: () => [...requests.values()].filter(r => r.state === "pending"), findRequest: (requestId: string) => [...requests.values()].find(r => r.requestId === requestId), markProgressStalled: (runId: string) => ({ status: "stalled-suspected", runId }), snapshot: () => ({ requests: [...requests.values()] }) });
}
