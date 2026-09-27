import { DurableContractError, durableDigest, parseDurableEnvelopeV1, parseReplayCursorV1, type DurableEnvelopeV1, type ReplayCursorV1 } from "./durable-contract.ts";
import { DurableStorage } from "./durable-storage.ts";

export class DurableOutboxError extends Error { constructor(readonly code: string, message = code) { super(message); } }
export type ReceiptKindV1 = "transport-durable" | "consumer-processing" | "user-visible-completion";
export interface DurableReceiptV1 { receiptId: string; kind: ReceiptKindV1; eventId?: string; payloadDigest?: string; acknowledged?: boolean; }
export interface OutboxEventV1 { cursor: ReplayCursorV1; envelope: DurableEnvelopeV1; payloadDigest: string; transportReceipt: DurableReceiptV1; }
type Partition = { events: OutboxEventV1[] };
const partitionId = (cursor: ReplayCursorV1) => `outbox-${durableDigest({ rootSessionId: cursor.rootSessionId, runId: cursor.runId, ownerGeneration: cursor.ownerGeneration, epoch: cursor.epoch })}`;
const receiptId = (kind: ReceiptKindV1, value: Parameters<typeof durableDigest>[0]) => `${kind}-${durableDigest(value)}`;
const samePartition = (a: ReplayCursorV1, b: ReplayCursorV1) => a.rootSessionId === b.rootSessionId && a.runId === b.runId && a.ownerGeneration === b.ownerGeneration && a.epoch === b.epoch;
const cursorDigestInput = (cursor: ReplayCursorV1) => ({ rootSessionId: cursor.rootSessionId, runId: cursor.runId, ownerGeneration: cursor.ownerGeneration, epoch: cursor.epoch, sequence: cursor.sequence });

export class DurableEventOutbox {
  constructor(private readonly options: { storage: DurableStorage }) {}
  private async mutate<T>(key: string, initial: unknown, update: (value: any) => T | { value: any; result: T }): Promise<T> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const prior = await this.options.storage.read<any>(key); const changed = update(prior?.value ?? initial);
      if (!changed || typeof changed !== "object" || !("value" in changed) || !("result" in changed)) return changed as T;
      try { await this.options.storage.write(key, changed.value, prior?.revision ?? 0); return changed.result; }
      catch (error) { if (!(error instanceof Error) || !((error as any).code === "DURABLE_REVISION_CONFLICT")) throw error; }
    }
    throw new DurableOutboxError("OUTBOX_CAS_CONFLICT");
  }
  async appendEvent(input: unknown): Promise<DurableReceiptV1> {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new DurableOutboxError("OUTBOX_EVENT_FIELDS");
    const item = input as Record<string, unknown>; if (Object.keys(item).length !== 2 || !Object.hasOwn(item, "cursor") || !Object.hasOwn(item, "envelope")) throw new DurableOutboxError("OUTBOX_EVENT_FIELDS");
    const cursor = parseReplayCursorV1(item.cursor), envelope = parseDurableEnvelopeV1(item.envelope), payloadDigest = durableDigest(envelope.payload), key = partitionId(cursor);
    if (Buffer.byteLength(JSON.stringify({ cursor: cursorDigestInput(cursor), envelope }), "utf8") > 64 * 1024) throw new DurableContractError("DURABLE_FRAME_TOO_LARGE");
    return this.mutate(key, { events: [] } as Partition, value => {
      const state = value as Partition; const existing = state.events.find(event => event.cursor.sequence === cursor.sequence);
      if (existing) {
        if (existing.payloadDigest !== payloadDigest || existing.envelope.eventId !== envelope.eventId || durableDigest(existing.envelope.metadata) !== durableDigest(envelope.metadata)) throw new DurableOutboxError("OUTBOX_DIGEST_CONFLICT");
        return existing.transportReceipt;
      }
      const high = state.events.length ? state.events[state.events.length - 1].cursor.sequence : 0;
      if (cursor.sequence !== high + 1) throw new DurableOutboxError(cursor.sequence <= high ? "OUTBOX_SEQUENCE_REWIND" : "OUTBOX_SEQUENCE_GAP");
      const transportReceipt: DurableReceiptV1 = Object.freeze({ receiptId: receiptId("transport-durable", { cursor: cursorDigestInput(cursor), eventId: envelope.eventId, payloadDigest }), kind: "transport-durable", eventId: envelope.eventId, payloadDigest });
      const entry: OutboxEventV1 = Object.freeze({ cursor, envelope, payloadDigest, transportReceipt });
      return { value: { events: [...state.events, entry] }, result: transportReceipt };
    });
  }
  async readReplayBatch(input: unknown): Promise<{ events: OutboxEventV1[] }> {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new DurableOutboxError("OUTBOX_BATCH_FIELDS"); const item = input as Record<string, unknown>;
    if (Object.keys(item).length !== 2 || !Object.hasOwn(item, "after") || !Number.isSafeInteger(item.limit) || (item.limit as number) < 1) throw new DurableOutboxError("OUTBOX_BATCH_FIELDS");
    const after = parseReplayCursorV1(item.after); const saved = await this.options.storage.read<Partition>(partitionId(after)); const events = saved?.value.events ?? [];
    return { events: events.filter(event => samePartition(event.cursor, after) && event.cursor.sequence > after.sequence).slice(0, item.limit as number) };
  }
  async highWater(cursorInput: unknown): Promise<ReplayCursorV1> { const cursor = parseReplayCursorV1(cursorInput); const saved = await this.options.storage.read<Partition>(partitionId(cursor)); return saved?.value.events.at(-1)?.cursor ?? cursor; }
  async recordConsumerProcessingReceipt(input: unknown): Promise<DurableReceiptV1> {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new DurableOutboxError("OUTBOX_PROCESSING_FIELDS"); const item = input as Record<string, unknown>;
    if (Object.keys(item).length !== 3 || !["consumerId", "eventId", "payloadDigest"].every(key => typeof item[key] === "string" && item[key])) throw new DurableOutboxError("OUTBOX_PROCESSING_FIELDS");
    const consumerId = item.consumerId as string, eventId = item.eventId as string, payloadDigest = item.payloadDigest as string;
    const processingInput = { consumerId, eventId, payloadDigest }, id = receiptId("consumer-processing", processingInput), key = `outbox-receipt-${durableDigest({ consumerId, eventId })}`;
    return this.mutate(key, null, existing => { if (existing) { if (existing.payloadDigest !== payloadDigest) throw new DurableOutboxError("OUTBOX_DIGEST_CONFLICT"); return existing as DurableReceiptV1; } const result = Object.freeze({ receiptId: id, kind: "consumer-processing" as const, eventId, payloadDigest, acknowledged: false }); return { value: result, result }; });
  }
  async ackReceipt(input: unknown): Promise<{ acknowledged: true }> {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 || typeof (input as any).receiptId !== "string") throw new DurableOutboxError("OUTBOX_ACK_FIELDS");
    const receiptIdValue = (input as any).receiptId as string; const key = `outbox-ack-${durableDigest(receiptIdValue)}`;
    return this.mutate(key, null, existing => existing ? { acknowledged: true as const } : { value: { receiptId: receiptIdValue, acknowledged: true }, result: { acknowledged: true as const } });
  }
  async isReceiptAcknowledged(input: unknown): Promise<boolean> {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 || typeof (input as any).receiptId !== "string") throw new DurableOutboxError("OUTBOX_ACK_FIELDS");
    return !!await this.options.storage.read(`outbox-ack-${durableDigest((input as any).receiptId)}`);
  }
  async recordCompletionReceipt(input: unknown): Promise<DurableReceiptV1> {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 2 || typeof (input as any).runId !== "string" || typeof (input as any).terminalReceiptId !== "string") throw new DurableOutboxError("OUTBOX_COMPLETION_FIELDS");
    const item = input as { runId: string; terminalReceiptId: string }; const key = `outbox-completion-${durableDigest(item)}`;
    return this.mutate(key, null, existing => existing ?? { value: Object.freeze({ receiptId: receiptId("user-visible-completion", item), kind: "user-visible-completion" as const, eventId: item.terminalReceiptId, acknowledged: false }), result: Object.freeze({ receiptId: receiptId("user-visible-completion", item), kind: "user-visible-completion" as const, eventId: item.terminalReceiptId, acknowledged: false }) });
  }
  async completeCompletionReceipt(input: unknown): Promise<{ completed: true }> {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 || typeof (input as any).receiptId !== "string") throw new DurableOutboxError("OUTBOX_COMPLETION_FIELDS");
    return this.ackReceipt(input).then(() => ({ completed: true as const }));
  }
}
