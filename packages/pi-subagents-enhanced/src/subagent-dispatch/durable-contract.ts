import { createHash } from "node:crypto";

export const DURABLE_ENVELOPE_VERSION = "durable-envelope.v1" as const;
export type DurableErrorCode = "DURABLE_JSON_ONLY" | "DURABLE_SENSITIVE_KEY" | "DURABLE_UNKNOWN_FIELD" | "DURABLE_PAYLOAD_TOO_LARGE" | "DURABLE_FRAME_TOO_LARGE" | "DURABLE_REFERENCE_FIELDS" | "DURABLE_CURSOR" | "DURABLE_PROVENANCE";
export class DurableContractError extends TypeError { constructor(readonly code: DurableErrorCode, message = code) { super(message); } }
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectValue = Record<string, unknown>;
const sensitive = /token|secret|password|credential|authorization|cookie|private.?key|api.?key/i;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
function exact(value: unknown, keys: readonly string[], code: DurableErrorCode): asserts value is ObjectValue {
  if (!object(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) throw new DurableContractError(code);
}
function json(value: unknown): asserts value is Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new DurableContractError("DURABLE_JSON_ONLY"); return; }
  if (Array.isArray(value)) { for (const entry of value) json(entry); return; }
  if (!object(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new DurableContractError("DURABLE_JSON_ONLY");
  for (const [key, entry] of Object.entries(value)) { if (sensitive.test(key)) throw new DurableContractError("DURABLE_SENSITIVE_KEY"); json(entry); }
}
const nonEmpty = (value: unknown, code: DurableErrorCode) => { if (typeof value !== "string" || !value) throw new DurableContractError(code); return value; };
const integer = (value: unknown, code: DurableErrorCode) => { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new DurableContractError(code); return value as number; };
export interface DurableEnvelopeV1 { version: typeof DURABLE_ENVELOPE_VERSION; eventId: string; payload: Json; metadata: Json; }
export function parseDurableEnvelopeV1(value: unknown): DurableEnvelopeV1 {
  exact(value, ["version", "eventId", "payload", "metadata"], "DURABLE_UNKNOWN_FIELD");
  if (value.version !== DURABLE_ENVELOPE_VERSION) throw new DurableContractError("DURABLE_UNKNOWN_FIELD");
  const eventId = nonEmpty(value.eventId, "DURABLE_JSON_ONLY"); json(value.payload); json(value.metadata);
  if (Buffer.byteLength(JSON.stringify(value.payload), "utf8") > 32 * 1024) throw new DurableContractError("DURABLE_PAYLOAD_TOO_LARGE");
  const result = { version: DURABLE_ENVELOPE_VERSION, eventId, payload: value.payload, metadata: value.metadata } as DurableEnvelopeV1;
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 64 * 1024) throw new DurableContractError("DURABLE_FRAME_TOO_LARGE");
  return Object.freeze(result);
}
export interface InventoryReferenceV1 { id: string; digest: string; revision: number; reference: string; }
export function parseInventoryReferenceV1(value: unknown): InventoryReferenceV1 {
  exact(value, ["id", "digest", "revision", "reference"], "DURABLE_REFERENCE_FIELDS");
  const id = nonEmpty(value.id, "DURABLE_REFERENCE_FIELDS"), digest = nonEmpty(value.digest, "DURABLE_REFERENCE_FIELDS"), reference = nonEmpty(value.reference, "DURABLE_REFERENCE_FIELDS");
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new DurableContractError("DURABLE_REFERENCE_FIELDS");
  return Object.freeze({ id, digest, revision: integer(value.revision, "DURABLE_REFERENCE_FIELDS"), reference });
}
export interface ReplayCursorV1 { rootSessionId: string; runId: string; ownerGeneration: number; epoch: number; sequence: number; }
export function parseReplayCursorV1(value: unknown): ReplayCursorV1 { exact(value, ["rootSessionId", "runId", "ownerGeneration", "epoch", "sequence"], "DURABLE_CURSOR"); return Object.freeze({ rootSessionId: nonEmpty(value.rootSessionId, "DURABLE_CURSOR"), runId: nonEmpty(value.runId, "DURABLE_CURSOR"), ownerGeneration: integer(value.ownerGeneration, "DURABLE_CURSOR"), epoch: integer(value.epoch, "DURABLE_CURSOR"), sequence: integer(value.sequence, "DURABLE_CURSOR") }); }
export type ProvenanceClassification = "production" | "test-manufactured" | "unconfirmed";
export interface ProvenanceV1 { classification: ProvenanceClassification; observedAt: string; quarantineReference?: InventoryReferenceV1; status?: "blocked-unknown"; }
export function parseProvenanceV1(value: unknown): ProvenanceV1 {
  if (!object(value) || !["production", "test-manufactured", "unconfirmed"].includes(String(value.classification)) || typeof value.observedAt !== "string" || Number.isNaN(Date.parse(value.observedAt))) throw new DurableContractError("DURABLE_PROVENANCE");
  const unconfirmed = value.classification === "unconfirmed";
  if (unconfirmed && !Object.hasOwn(value, "quarantineReference")) throw new DurableContractError("DURABLE_PROVENANCE");
  if (Object.keys(value).length !== (unconfirmed ? 3 : 2) || (!unconfirmed && Object.hasOwn(value, "quarantineReference"))) throw new DurableContractError("DURABLE_PROVENANCE");
  return Object.freeze(unconfirmed ? { classification: "unconfirmed", observedAt: value.observedAt, quarantineReference: parseInventoryReferenceV1(value.quarantineReference), status: "blocked-unknown" } : { classification: value.classification as Exclude<ProvenanceClassification, "unconfirmed">, observedAt: value.observedAt });
}
export const durableDigest = (value: Json) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
