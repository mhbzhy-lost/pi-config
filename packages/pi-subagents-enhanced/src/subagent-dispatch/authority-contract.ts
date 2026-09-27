import { createHash } from "node:crypto";

export const RECOVERY_RPC_DEADLINE_MS = 5_000;
export const HEARTBEAT_LEASE_MS = 60_000;
export const HEARTBEAT_RENEW_MS = 15_000;

export const AUTHORITY_ERROR_CODES = Object.freeze({
  INVALID_RECEIPT: "invalid_receipt",
  INVALID_LEASE: "invalid_lease",
  STALE_GENERATION: "stale_generation",
  CAS_CONFLICT: "cas_conflict",
  PROCESS_BIRTH_MISMATCH: "process_birth_mismatch",
  PID_REUSE: "pid_reuse",
  BLOCKED_UNKNOWN: "blocked_unknown",
  LEASE_EXPIRED: "lease_expired",
  UNKNOWN_RUN: "unknown_run",
} as const);

type Dict = Record<string, any>;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
function object(v: unknown, name: string, keys: string[]): Dict {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${name} must be an object`);
  const o = v as Dict;
  if (Object.keys(o).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(o, k))) throw new Error(`${name} contains unknown or missing fields`);
  return o;
}
function id(v: unknown, name: string): string { if (typeof v !== "string" || !ID.test(v) || v.includes("..")) throw new Error(`${name} must be a safe identity`); return v; }
function positive(v: unknown, name: string): number { if (!Number.isSafeInteger(v) || (v as number) <= 0) throw new Error(`${name} must be a positive safe integer`); return v as number; }
function finite(v: unknown, name: string): number { if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${name} must be finite`); return v; }
function hash(v: unknown, name: string): string { if (typeof v !== "string" || !HASH.test(v)) throw new Error(`${name} must be a sha256 reference`); return v; }
function birth(v: unknown, name = "processBirth"): string { if (typeof v !== "string" || !v || v.length > 4096 || /[\0\r\n]/.test(v)) throw new Error(`${name} must be an OS birth identity`); return v; }
function stable(v: any): string { if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`; if (v && typeof v === "object") return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`; return JSON.stringify(v); }
function digest(v: unknown): string { return createHash("sha256").update(stable(v), "utf8").digest("hex"); }

export type OwnerReceiptV1 = { receiptId: string; rootSessionId: string; runId: string; ownerGeneration: number; processBirth: string; revision: number; digest: string; authorizationReference: string };
export type ExecutionLeaseV1 = { schemaVersion: "execution-lease.v1"; leaseId: string; rootSessionId: string; runId: string; ownerGeneration: number; processBirth: string; issuedAt: number; lastRenewedAt: number; expiresAt: number; renewalSequence: number; revision: number };

export function digestOwnerReceipt(value: Omit<OwnerReceiptV1, "digest"> | OwnerReceiptV1): string { const { digest: _ignored, ...rest } = value as any; return `sha256:${digest(rest)}`; }
export function createOwnerReceipt(input: Omit<OwnerReceiptV1, "digest">): OwnerReceiptV1 { const parsed = parseOwnerReceipt({ ...input, digest: digestOwnerReceipt(input) }); return Object.freeze(parsed); }
export function parseOwnerReceipt(value: unknown): OwnerReceiptV1 { const o = object(value, "owner receipt", ["receiptId", "rootSessionId", "runId", "ownerGeneration", "processBirth", "revision", "digest", "authorizationReference"]); id(o.receiptId, "receiptId"); id(o.rootSessionId, "rootSessionId"); id(o.runId, "runId"); positive(o.ownerGeneration, "ownerGeneration"); birth(o.processBirth); positive(o.revision, "revision"); hash(o.authorizationReference, "authorizationReference"); hash(o.digest, "digest"); if (o.digest !== digestOwnerReceipt(o as OwnerReceiptV1)) throw new Error("owner receipt digest mismatch"); return o as OwnerReceiptV1; }

export function parseExecutionLease(value: unknown): ExecutionLeaseV1 { const o = object(value, "execution lease", ["schemaVersion", "leaseId", "rootSessionId", "runId", "ownerGeneration", "processBirth", "issuedAt", "lastRenewedAt", "expiresAt", "renewalSequence", "revision"]); if (o.schemaVersion !== "execution-lease.v1") throw new Error("lease schemaVersion unsupported"); id(o.leaseId, "leaseId"); id(o.rootSessionId, "rootSessionId"); id(o.runId, "runId"); positive(o.ownerGeneration, "ownerGeneration"); birth(o.processBirth); finite(o.issuedAt, "issuedAt"); finite(o.lastRenewedAt, "lastRenewedAt"); finite(o.expiresAt, "expiresAt"); if (o.expiresAt < o.lastRenewedAt) throw new Error("expiresAt precedes lastRenewedAt"); if (!Number.isSafeInteger(o.renewalSequence) || o.renewalSequence < 0) throw new Error("renewalSequence invalid"); positive(o.revision, "revision"); return o as ExecutionLeaseV1; }

export function parseRebindRequest(v: unknown) { const o = object(v, "rebind request", ["sourceRunId", "expectedGeneration", "expectedProcessBirth", "resumedRunId", "expectedRevision", "expectedResumedRevision"]); id(o.sourceRunId, "sourceRunId"); positive(o.expectedGeneration, "expectedGeneration"); birth(o.expectedProcessBirth, "expectedProcessBirth"); id(o.resumedRunId, "resumedRunId"); if (o.sourceRunId === o.resumedRunId) throw new Error("sourceRunId and resumedRunId must be different"); positive(o.expectedRevision, "expectedRevision"); positive(o.expectedResumedRevision, "expectedResumedRevision"); return o; }
export function parseRevokeRequest(v: unknown) { const o = object(v, "revoke request", ["runId", "ownerGeneration", "processBirth", "expectedRevision"]); id(o.runId, "runId"); positive(o.ownerGeneration, "ownerGeneration"); birth(o.processBirth); positive(o.expectedRevision, "expectedRevision"); return o; }
export function parseIssueLeaseRequest(v: unknown) { const o = object(v, "issue lease request", ["runId", "ownerGeneration", "processBirth", "expectedRevision"]); id(o.runId, "runId"); positive(o.ownerGeneration, "ownerGeneration"); birth(o.processBirth); positive(o.expectedRevision, "expectedRevision"); return o; }
export function parseRenewLeaseRequest(v: unknown) { const o = object(v, "renew lease request", ["runId", "leaseId", "ownerGeneration", "expectedRevision", "expectedRenewalSequence", "processBirth"]); id(o.runId, "runId"); id(o.leaseId, "leaseId"); positive(o.ownerGeneration, "ownerGeneration"); positive(o.expectedRevision, "expectedRevision"); if (!Number.isSafeInteger(o.expectedRenewalSequence) || o.expectedRenewalSequence < 0) throw new Error("expectedRenewalSequence invalid"); birth(o.processBirth); return o; }
export function parseReleaseLeaseRequest(v: unknown) { const o = object(v, "release lease request", ["runId", "leaseId", "ownerGeneration", "processBirth", "expectedRevision"]); id(o.runId, "runId"); id(o.leaseId, "leaseId"); positive(o.ownerGeneration, "ownerGeneration"); birth(o.processBirth); positive(o.expectedRevision, "expectedRevision"); return o; }
export function parseRenewLeaseResponse(v: unknown) { const o = object(v, "renew lease response", ["leaseId", "lastRenewedAt", "expiresAt", "renewalSequence"]); id(o.leaseId, "leaseId"); finite(o.lastRenewedAt, "lastRenewedAt"); finite(o.expiresAt, "expiresAt"); if (o.expiresAt < o.lastRenewedAt || !Number.isSafeInteger(o.renewalSequence) || o.renewalSequence < 0) throw new Error("renewal response invalid"); return o; }
export function parseWorkspaceReference(v: unknown) { const o = object(v, "workspace reference", ["schemaVersion", "workspaceId", "leaseId", "revision", "digest", "reference"]); if (o.schemaVersion !== "managed-workspace.v2") throw new Error("workspace schemaVersion unsupported"); id(o.workspaceId, "workspaceId"); id(o.leaseId, "leaseId"); positive(o.revision, "revision"); hash(o.digest, "digest"); hash(o.reference, "reference"); return o; }

export const RECOVERY_RPC_METHODS = Object.freeze(["owner.create", "owner.rebind", "owner.revoke", "lease.issue", "lease.renew", "lease.release"] as const);
