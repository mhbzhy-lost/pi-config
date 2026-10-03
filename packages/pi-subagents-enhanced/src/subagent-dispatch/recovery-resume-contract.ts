import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

export const INTEGRATION_RESUME_INTENT_VERSION = "integration-resume-intent.v1";
export const RECOVERY_RESUME_ACTIVATION_VERSION = "recovery-resume-activation.v1";

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const INTENT_QUEUE_STATES = new Set(["queued", "admitted", "resolving-conflict", "prepared"]);
const QUEUE_FINGERPRINT_STATES = new Set(["queued", "admitted", "rebasing", "resolving-conflict", "prepared", "completed", "cancelled", "preserved", "blocked"]);
const INTENT_STATES = new Set(["waiting-head", "pending", "starting", "activated", "completed", "failed", "preserved"]);
const DELIVERY_STATES = new Set(["pending", "delivered", "debt"]);
const OWNER_KINDS = new Set(["standalone-subagent"]);

const INTENT_KEYS = ["version", "resumeIntentId", "queueItemId", "workspaceId", "leaseId", "ownerScope", "sourceRunId", "sourceAsyncDir", "sourceProofId",
  "attempt", "generation", "queueRevision", "queueState", "conflictDigest", "progressFingerprint", "noProgressCount", "requiredAction", "state",
  "resumedRun", "delivery", "createdAt", "updatedAt"];
const RESUMED_RUN_KEYS = ["runId", "asyncDir", "sessionId", "pid", "agentProfile"];
const ACTIVATION_KEYS = ["version", "resumeIntentId", "queueItemId", "workspaceId", "leaseId", "sourceRunId", "resumedRun", "ownerScope", "generation", "authorization"];
const DELIVERY_REQUIRED_KEYS = ["state", "attempts"];
const DELIVERY_OPTIONAL_KEYS = ["reason"];
const OWNER_SCOPE_KEYS = ["kind", "rootSessionId"];

export interface ResumeOwnerScope { kind: "standalone-subagent"; rootSessionId: string }
export interface ResumedRunIdentity { runId: string; asyncDir: string; sessionId: string; pid: number; agentProfile: string }
export type ResumeDeliveryState = "pending" | "delivered" | "debt";
export interface ResumeDelivery { state: ResumeDeliveryState; attempts: number; reason?: string }
export type ResumableQueueState = "queued" | "admitted" | "resolving-conflict" | "prepared";
export type ResumeIntentState = "waiting-head" | "pending" | "starting" | "activated" | "completed" | "failed" | "preserved";

export interface IntegrationResumeIntentV1 {
  version: "integration-resume-intent.v1";
  resumeIntentId: string;
  queueItemId: string;
  workspaceId: string;
  leaseId: string;
  ownerScope: ResumeOwnerScope;
  sourceRunId: string;
  sourceAsyncDir: string;
  sourceProofId: string;
  attempt: number;
  generation: number;
  queueRevision: number;
  queueState: ResumableQueueState;
  conflictDigest: string | null;
  progressFingerprint: string;
  noProgressCount: number;
  requiredAction: "resume-child";
  state: ResumeIntentState;
  resumedRun: ResumedRunIdentity | null;
  delivery: ResumeDelivery;
  createdAt: string;
  updatedAt: string;
}

export function createManualIntegrationHandoff(input: { resumeIntentId: string; sourceRunId: string; workspaceId: string; queueItemId: string }) {
  for (const [key, value] of Object.entries(input)) if (typeof value !== "string" || value.length === 0) throw new TypeError(`${key} must be a non-empty string`);
  return Object.freeze({
    customType: "subagent-integration-handoff",
    content: `子 Agent 生命周期已结束，但 merge queue 项尚未完成。系统不会自动恢复该 child。请主 Agent 接管 worktree ${input.workspaceId}，检查未提交修改并完成提交，然后继续将其送入 merge queue。`,
    details: Object.freeze({ ...input }),
  });
}

export interface RecoveryResumeActivationV1 {
  version: "recovery-resume-activation.v1";
  resumeIntentId: string;
  queueItemId: string;
  workspaceId: string;
  leaseId: string;
  sourceRunId: string;
  resumedRun: ResumedRunIdentity;
  ownerScope: ResumeOwnerScope;
  generation: number;
  authorization: "root";
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown, label: string): string => { if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string`); return value; };
const digest = (value: unknown, label: string): string => { if (typeof value !== "string" || !SHA256.test(value)) throw new TypeError(`${label} must be sha256`); return value; };
const commit = (value: unknown, label: string): string => { if (typeof value !== "string" || !COMMIT.test(value)) throw new TypeError(`${label} must be a commit id`); return value; };
const int = (value: unknown, label: string, min: number): number => { if (!Number.isSafeInteger(value) || (value as number) < min) throw new TypeError(`${label} must be an integer >= ${min}`); return value as number; };
const timestamp = (value: unknown, label: string): string => { if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new TypeError(`${label} must be an ISO timestamp`); return value; };
const absolutePath = (value: unknown, label: string): string => {
  const raw = str(value, label);
  if (!path.isAbsolute(raw)) throw new TypeError(`${label} must be an absolute path`);
  return path.normalize(raw);
};

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || !keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))) {
    throw new TypeError(`${label} must have exactly the expected fields`);
  }
}

function parseOwnerScope(value: unknown): ResumeOwnerScope {
  if (!isObject(value)) throw new TypeError("ownerScope must be an object");
  exactKeys(value, OWNER_SCOPE_KEYS, "ownerScope");
  if (value.kind !== "standalone-subagent" || !OWNER_KINDS.has(String(value.kind))) throw new TypeError("ownerScope.kind must be standalone-subagent");
  return { kind: "standalone-subagent", rootSessionId: str(value.rootSessionId, "ownerScope.rootSessionId") };
}

function parseResumedRun(value: unknown): ResumedRunIdentity {
  if (!isObject(value)) throw new TypeError("resumedRun must be an object");
  exactKeys(value, RESUMED_RUN_KEYS, "resumedRun");
  return { runId: str(value.runId, "resumedRun.runId"), asyncDir: absolutePath(value.asyncDir, "resumedRun.asyncDir"),
    sessionId: str(value.sessionId, "resumedRun.sessionId"), pid: int(value.pid, "resumedRun.pid", 1),
    agentProfile: str(value.agentProfile, "resumedRun.agentProfile") };
}

function parseDelivery(value: unknown): ResumeDelivery {
  if (!isObject(value)) throw new TypeError("delivery must be an object");
  const keys = Object.keys(value);
  if (!keys.every((key) => DELIVERY_REQUIRED_KEYS.includes(key) || DELIVERY_OPTIONAL_KEYS.includes(key)) || !DELIVERY_REQUIRED_KEYS.every((key) => Object.prototype.hasOwnProperty.call(value, key))) {
    throw new TypeError("delivery must have exactly the expected fields");
  }
  if (typeof value.state !== "string" || !DELIVERY_STATES.has(value.state)) throw new TypeError("delivery.state is invalid");
  const reason = value.reason;
  if (reason !== undefined && typeof reason !== "string") throw new TypeError("delivery.reason must be a string");
  const delivery: ResumeDelivery = { state: value.state as ResumeDeliveryState, attempts: int(value.attempts, "delivery.attempts", 0) };
  if (typeof reason === "string") delivery.reason = reason;
  return delivery;
}

function deepFreeze<T>(value: T): T {
  if (isObject(value) || Array.isArray(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** 队列项进展指纹：对 state/revision/admissionGeneration/conflictDigest/candidateHead 敏感，其余字段不参与。 */
export function progressFingerprint(queueItem: unknown): string {
  if (!isObject(queueItem)) throw new TypeError("queueItem must be an object");
  const state = queueItem.state;
  if (typeof state !== "string" || !QUEUE_FINGERPRINT_STATES.has(state)) throw new TypeError("queueItem.state is invalid");
  int(queueItem.revision, "queueItem.revision", 0);
  int(queueItem.admissionGeneration, "queueItem.admissionGeneration", 0);
  const conflictDigest = queueItem.conflictDigest ?? null;
  if (conflictDigest !== null) digest(conflictDigest, "queueItem.conflictDigest");
  const candidateHead = queueItem.candidateHead ?? null;
  if (candidateHead !== null) commit(candidateHead, "queueItem.candidateHead");
  return createHash("sha256").update(JSON.stringify({ state, revision: queueItem.revision, admissionGeneration: queueItem.admissionGeneration, conflictDigest, candidateHead })).digest("hex");
}

export function createIntegrationResumeIntentV1(input: {
  queueItem: unknown;
  sourceAsyncDir: string;
  sourceProofId: string;
  attempt?: number;
}): IntegrationResumeIntentV1 {
  if (!isObject(input)) throw new TypeError("intent input must be an object");
  const queueItem = input.queueItem;
  if (!isObject(queueItem)) throw new TypeError("queueItem must be an object");
  const state = queueItem.state;
  if (typeof state !== "string" || !INTENT_QUEUE_STATES.has(state)) throw new TypeError("queueItem.state is not resumable");
  const rawConflict = queueItem.conflictDigest;
  const conflictDigest = rawConflict === null || rawConflict === undefined ? null : digest(rawConflict, "queueItem.conflictDigest");
  const now = new Date().toISOString();
  const intent: IntegrationResumeIntentV1 = {
    version: INTEGRATION_RESUME_INTENT_VERSION,
    resumeIntentId: randomUUID(),
    queueItemId: str(queueItem.queueItemId, "queueItem.queueItemId"),
    workspaceId: str(queueItem.workspaceId, "queueItem.workspaceId"),
    leaseId: digest(queueItem.leaseId, "queueItem.leaseId"),
    ownerScope: parseOwnerScope(queueItem.ownerScope),
    sourceRunId: str(queueItem.childRunId, "queueItem.childRunId"),
    sourceAsyncDir: absolutePath(input.sourceAsyncDir, "sourceAsyncDir"),
    sourceProofId: str(input.sourceProofId, "sourceProofId"),
    attempt: int(input.attempt ?? 1, "attempt", 1),
    generation: int(queueItem.admissionGeneration, "queueItem.admissionGeneration", 0),
    queueRevision: int(queueItem.revision, "queueItem.revision", 0),
    queueState: state as ResumableQueueState,
    conflictDigest,
    progressFingerprint: progressFingerprint(queueItem),
    noProgressCount: 0,
    requiredAction: "resume-child",
    state: "waiting-head",
    resumedRun: null,
    delivery: { state: "pending", attempts: 0 },
    createdAt: now,
    updatedAt: now,
  };
  return deepFreeze(intent);
}

export function parseIntegrationResumeIntentV1(value: unknown, expected?: { rootSessionId?: string }): IntegrationResumeIntentV1 {
  if (!isObject(value)) throw new TypeError("resume intent must be an object");
  exactKeys(value, INTENT_KEYS, "resume intent");
  if (value.version !== INTEGRATION_RESUME_INTENT_VERSION) throw new TypeError("resume intent version is invalid");
  if (value.requiredAction !== "resume-child") throw new TypeError("resume intent requiredAction is invalid");
  if (typeof value.state !== "string" || !INTENT_STATES.has(value.state)) throw new TypeError("resume intent state is invalid");
  if (typeof value.queueState !== "string" || !INTENT_QUEUE_STATES.has(value.queueState)) throw new TypeError("resume intent queueState is invalid");
  const conflictDigest = value.conflictDigest === null ? null : digest(value.conflictDigest, "conflictDigest");
  const intent: IntegrationResumeIntentV1 = {
    version: INTEGRATION_RESUME_INTENT_VERSION,
    resumeIntentId: str(value.resumeIntentId, "resumeIntentId"),
    queueItemId: str(value.queueItemId, "queueItemId"),
    workspaceId: str(value.workspaceId, "workspaceId"),
    leaseId: digest(value.leaseId, "leaseId"),
    ownerScope: parseOwnerScope(value.ownerScope),
    sourceRunId: str(value.sourceRunId, "sourceRunId"),
    sourceAsyncDir: absolutePath(value.sourceAsyncDir, "sourceAsyncDir"),
    sourceProofId: str(value.sourceProofId, "sourceProofId"),
    attempt: int(value.attempt, "attempt", 1),
    generation: int(value.generation, "generation", 0),
    queueRevision: int(value.queueRevision, "queueRevision", 0),
    queueState: value.queueState as ResumableQueueState,
    conflictDigest,
    progressFingerprint: digest(value.progressFingerprint, "progressFingerprint"),
    noProgressCount: int(value.noProgressCount, "noProgressCount", 0),
    requiredAction: "resume-child",
    state: value.state as ResumeIntentState,
    resumedRun: value.resumedRun === null ? null : parseResumedRun(value.resumedRun),
    delivery: parseDelivery(value.delivery),
    createdAt: timestamp(value.createdAt, "createdAt"),
    updatedAt: timestamp(value.updatedAt, "updatedAt"),
  };
  if (expected?.rootSessionId !== undefined && intent.ownerScope.rootSessionId !== expected.rootSessionId) throw new TypeError("resume intent owner scope denied");
  return deepFreeze(intent);
}

export function parseRecoveryResumeActivationV1(value: unknown, intent: IntegrationResumeIntentV1): RecoveryResumeActivationV1 {
  if (!isObject(value)) throw new TypeError("recovery resume activation must be an object");
  exactKeys(value, ACTIVATION_KEYS, "recovery resume activation");
  if (value.version !== RECOVERY_RESUME_ACTIVATION_VERSION) throw new TypeError("recovery resume activation version is invalid");
  if (value.authorization !== "root") throw new TypeError("recovery resume activation requires root authorization");
  const activation: RecoveryResumeActivationV1 = {
    version: RECOVERY_RESUME_ACTIVATION_VERSION,
    resumeIntentId: str(value.resumeIntentId, "resumeIntentId"),
    queueItemId: str(value.queueItemId, "queueItemId"),
    workspaceId: str(value.workspaceId, "workspaceId"),
    leaseId: digest(value.leaseId, "leaseId"),
    sourceRunId: str(value.sourceRunId, "sourceRunId"),
    resumedRun: parseResumedRun(value.resumedRun),
    ownerScope: parseOwnerScope(value.ownerScope),
    generation: int(value.generation, "generation", 0),
    authorization: "root",
  };
  if (activation.resumeIntentId !== intent.resumeIntentId) throw new TypeError("activation resumeIntentId does not match the intent");
  if (activation.queueItemId !== intent.queueItemId) throw new TypeError("activation queueItemId does not match the intent");
  if (activation.workspaceId !== intent.workspaceId) throw new TypeError("activation workspaceId does not match the intent");
  if (activation.leaseId !== intent.leaseId) throw new TypeError("activation leaseId does not match the intent");
  if (activation.sourceRunId !== intent.sourceRunId) throw new TypeError("activation sourceRunId does not match the intent");
  if (activation.ownerScope.rootSessionId !== intent.ownerScope.rootSessionId) throw new TypeError("activation owner scope denied");
  if (activation.generation !== intent.generation) throw new TypeError("activation generation does not match the intent");
  if (activation.resumedRun.runId === activation.sourceRunId) throw new TypeError("activation resumedRun must differ from the source run");
  return deepFreeze(activation);
}
