import { createHash } from "node:crypto";

export type SupervisorRequestState = "pending" | "replying" | "replied" | "expired" | "failed";
export type SupervisorRequestV1 = {
  schemaVersion: "supervisor-request.v1"; requestId: string; runId: string; rootSessionId: string;
  ownerGeneration: number; requestGeneration: number; requestDigest: string;
  createdAt: number; expiresAt: number; state: SupervisorRequestState;
};
export type SupervisorControlIntentV1 = {
  schemaVersion: "supervisor-control-intent.v1"; intentId: string; runId: string;
  rootSessionId: string; ownerGeneration: number; kind: "reply" | "steer"; payloadDigest: string;
  requestId?: string; requestGeneration?: number; liveRunEpoch?: number;
};
export type SupervisorDeliveryReceipt = {
  receiptId: string; idempotencyKey: string; kind: "reply" | "steer"; status: "queued" | "delivered" | "failed"; consumed: boolean;
  runId: string; requestId?: string; code?: string;
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const safeId = (v: unknown, name: string) => { if (typeof v !== "string" || !ID.test(v) || v.includes("..")) throw new Error(`${name} invalid`); return v; };
const positive = (v: unknown, name: string) => { if (!Number.isSafeInteger(v) || (v as number) <= 0) throw new Error(`${name} invalid`); return v as number; };
const digestRef = (v: unknown, name: string) => { if (typeof v !== "string" || !DIGEST.test(v)) throw new Error(`${name} invalid`); return v; };
const stable = (v: any): string => Array.isArray(v) ? `[${v.map(stable).join(",")}]` : isObject(v) ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}` : JSON.stringify(v);
export function supervisorCanonicalDigest(value: unknown): string { return `sha256:${createHash("sha256").update(stable(value)).digest("hex")}`; }
function exact(o: Record<string, any>, keys: string[], name: string) { if (Object.keys(o).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(o, k))) throw new Error(`${name} fields invalid`); }

export function parseSupervisorRequestV1(value: unknown): SupervisorRequestV1 {
  if (!isObject(value)) throw new Error("request must be object");
  exact(value, ["schemaVersion","requestId","runId","rootSessionId","ownerGeneration","requestGeneration","requestDigest","createdAt","expiresAt","state"], "request");
  if (value.schemaVersion !== "supervisor-request.v1") throw new Error("request schema unsupported");
  safeId(value.requestId,"requestId"); safeId(value.runId,"runId"); safeId(value.rootSessionId,"rootSessionId");
  positive(value.ownerGeneration,"ownerGeneration"); positive(value.requestGeneration,"requestGeneration"); digestRef(value.requestDigest,"requestDigest");
  if (!["pending","replying","replied","expired","failed"].includes(value.state) || typeof value.createdAt !== "number" || typeof value.expiresAt !== "number" || value.expiresAt < value.createdAt) throw new Error("request timing/state invalid");
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

export type SupervisorControlPlaneOptions = {
  readOwnerReceipt?: (runId: string) => unknown | Promise<unknown>;
  readRuntime?: (runId: string) => { runId?: string; ownerGeneration?: number; liveRunEpoch?: number; running?: boolean; steerable?: boolean } | Promise<any>;
  now?: () => number; randomId?: () => string;
};
export function createSupervisorControlPlane(options: SupervisorControlPlaneOptions = {}) {
  const requests = new Map<string, SupervisorRequestV1>();
  const receipts = new Map<string, SupervisorDeliveryReceipt>();
  const replyPayloads = new Set<string>();
  const now = options.now ?? (() => Date.now());
  const id = options.randomId ?? (() => `${now()}-${Math.random().toString(36).slice(2)}`);
  const blocked = (code: string, extra: Record<string, unknown> = {}) => ({ status: "blocked" as const, code, ...extra });
  async function registerSupervisorRequest(native: any) {
    if (!isObject(native) || typeof native.id !== "string" || typeof native.runId !== "string" || typeof native.reason !== "string") return blocked("SUPERVISOR_REQUEST_IDENTITY_UNAVAILABLE");
    const owner: any = await options.readOwnerReceipt?.(native.runId);
    if (!owner || owner.runId !== native.runId || typeof owner.rootSessionId !== "string" || !Number.isSafeInteger(owner.ownerGeneration)) return blocked("SUPERVISOR_OWNER_UNAVAILABLE");
    const requestId = native.id; const requestDigest = supervisorCanonicalDigest({ id: native.id, runId: native.runId, agent: native.agent, reason: native.reason, expectsReply: native.expectsReply, replyTo: native.replyTo });
    const key = `${owner.rootSessionId}:${native.runId}:${owner.ownerGeneration}:${requestId}:${requestDigest}`;
    const existing = requests.get(key); if (existing) return { status: "registered" as const, request: existing };
    const t = now();
    const request = parseSupervisorRequestV1({ schemaVersion: "supervisor-request.v1", requestId, runId: native.runId, rootSessionId: owner.rootSessionId, ownerGeneration: owner.ownerGeneration, requestGeneration: Number.isSafeInteger(native.requestGeneration) ? native.requestGeneration : 1, requestDigest, createdAt: t, expiresAt: t + 20 * 60 * 1000, state: "pending" });
    requests.set(key, request); return { status: "registered" as const, request };
  }
  function findPending(intent: SupervisorControlIntentV1) { return [...requests.values()].find(r => r.state === "pending" && r.runId === intent.runId && r.rootSessionId === intent.rootSessionId && r.ownerGeneration === intent.ownerGeneration && r.requestId === intent.requestId && r.requestGeneration === intent.requestGeneration); }
  async function resolveSupervisorControl(intentInput: unknown) {
    let intent: SupervisorControlIntentV1; try { intent = parseSupervisorControlIntentV1(intentInput); } catch { return blocked("SUPERVISOR_INTENT_INVALID"); }
    const runtime: any = await options.readRuntime?.(intent.runId);
    const owner: any = await options.readOwnerReceipt?.(intent.runId);
    if (!owner || owner.rootSessionId !== intent.rootSessionId || owner.ownerGeneration !== intent.ownerGeneration || runtime?.ownerGeneration !== intent.ownerGeneration) return blocked("SUPERVISOR_STALE_OWNER");
    const pending = intent.kind === "steer"
      ? [...requests.values()].find(r => r.state === "pending" && r.runId === intent.runId && r.rootSessionId === intent.rootSessionId && r.ownerGeneration === intent.ownerGeneration)
      : findPending(intent);
    const key = intent.kind === "reply" ? `${intent.requestId}:${intent.requestGeneration}:${intent.payloadDigest}` : `${intent.runId}:${intent.ownerGeneration}:${intent.payloadDigest}:${intent.liveRunEpoch}`;
    const prior = receipts.get(key); if (prior) return { status: "idempotent" as const, receipt: prior };
    if (pending && intent.kind === "steer") return blocked("SUPERVISOR_REPLY_REQUIRED");
    if (!pending && intent.kind === "reply") return blocked("SUPERVISOR_REQUEST_NOT_PENDING");
    if (pending && now() >= pending.expiresAt) { pending.state = "expired"; return blocked("SUPERVISOR_REQUEST_EXPIRED"); }
    if (intent.kind === "steer" && (!runtime?.running || runtime?.steerable !== true || (intent.liveRunEpoch !== undefined && runtime.liveRunEpoch !== intent.liveRunEpoch))) return blocked("SUPERVISOR_STEER_NOT_ALLOWED");
    if (intent.kind === "steer" && replyPayloads.has(`${intent.runId}:${intent.ownerGeneration}:${intent.payloadDigest}`)) return blocked("STEER_DUPLICATES_REPLY");
    return { status: "allowed" as const, intent, idempotencyKey: key, request: pending };
  }
  async function commitDelivery(input: { intent: unknown; success?: boolean; code?: string; consumed?: boolean }) {
    const intent = parseSupervisorControlIntentV1(input.intent); const decision: any = await resolveSupervisorControl(intent);
    if (decision.status === "idempotent") {
      // A queued follow-up is not terminally delivered yet. The child may
      // later consume the same correlated payload, so allow that observation
      // to advance the existing durable receipt exactly once.
      if (input.consumed === true && decision.receipt.status === "queued") {
        decision.receipt.status = "delivered";
        decision.receipt.consumed = true;
        const request = intent.kind === "reply" ? findPending(intent) : undefined;
        if (request) request.state = "replied";
        if (intent.kind === "reply") replyPayloads.add(`${intent.runId}:${intent.ownerGeneration}:${intent.payloadDigest}`);
        return { status: "committed" as const, receipt: decision.receipt };
      }
      return decision;
    }
    if (decision.status !== "allowed") return decision;
    const consumed = input.consumed === true;
    const receipt: SupervisorDeliveryReceipt = { receiptId: `receipt-${id()}`, idempotencyKey: decision.idempotencyKey, kind: intent.kind, status: input.success === false ? "failed" : consumed ? "delivered" : "queued", consumed, runId: intent.runId, ...(intent.requestId ? { requestId: intent.requestId } : {}), ...(input.code ? { code: input.code } : {}) };
    receipts.set(decision.idempotencyKey, receipt);
    if (intent.kind === "reply" && decision.request) {
      decision.request.state = receipt.status === "delivered" ? "replied" : receipt.status === "failed" ? "failed" : "pending";
      if (receipt.status === "delivered") replyPayloads.add(`${intent.runId}:${intent.ownerGeneration}:${intent.payloadDigest}`);
    }
    return { status: "committed" as const, receipt };
  }
  async function markDeliveryConsumed(intent: unknown) {
    return commitDelivery({ intent, consumed: true });
  }
  return Object.freeze({ registerSupervisorRequest, resolveSupervisorControl, commitDelivery, markDeliveryConsumed,
    identityForRun: async (runId: string) => ({ owner: await options.readOwnerReceipt?.(runId), runtime: await options.readRuntime?.(runId) }),
    listPending: () => [...requests.values()].filter(r => r.state === "pending"), findRequest: (requestId: string) => [...requests.values()].find(r => r.requestId === requestId), markProgressStalled: (runId: string) => ({ status: "stalled-suspected", runId }), snapshot: () => ({ requests: [...requests.values()] }) });
}
