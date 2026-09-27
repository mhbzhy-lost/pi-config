import { parseOwnerReceipt, type OwnerReceiptV1 } from "./authority-contract.ts";
import { parseReplayCursorV1, type ReplayCursorV1 } from "./durable-contract.ts";
import type { DurableEventOutbox, DurableReceiptV1, OutboxEventV1 } from "./durable-event-outbox.ts";
import type { ReplayBarrier } from "./replay-barrier.ts";

type OwnerValidator = (receipt: OwnerReceiptV1) => Promise<boolean> | boolean;
type DeliverySink = {
  hasDelivered: (idempotencyKey: string) => Promise<boolean> | boolean;
  deliver: (input: { eventId: string; payloadDigest: string; payload: unknown; idempotencyKey: string; receiptId: string; kind: "event" | "completion" }) => Promise<unknown> | unknown;
};
type Options = { outbox: DurableEventOutbox; barrier: ReplayBarrier; consumerId: string; ownerValidator: OwnerValidator; cursorValidator: (cursor: ReplayCursorV1, receipt: OwnerReceiptV1) => Promise<boolean> | boolean; terminalReceiptValidator?: (event: OutboxEventV1, terminalReceiptId: string) => Promise<boolean> | boolean; deliverySink: DeliverySink };
const sameIdentity = (a: ReplayCursorV1, b: { rootSessionId: string; runId: string; ownerGeneration: number }) => a.rootSessionId === b.rootSessionId && a.runId === b.runId && a.ownerGeneration === b.ownerGeneration;
const blocked = () => ({ status: "blocked-unknown" as const, events: [] as OutboxEventV1[], transportReceipts: [] as DurableReceiptV1[], processingReceipts: [] as DurableReceiptV1[] });

/** Durable, injected-only replay adapter. It never reads storage or runtime state directly. */
export function createSupervisorReplay(options: Options) {
  async function replaySupervisor(input: unknown) {
    try {
      if (!input || typeof input !== "object" || Array.isArray(input)) return blocked();
      const value = input as Record<string, unknown>;
      if (!Object.hasOwn(value, "rootSessionId") || !Object.hasOwn(value, "runId") || !Object.hasOwn(value, "ownerReceipt") || !Object.hasOwn(value, "after") || typeof value.rootSessionId !== "string" || typeof value.runId !== "string" || !Number.isSafeInteger(value.batchSize) || (value.batchSize as number) < 1) return blocked();
      const ownerReceipt = parseOwnerReceipt(value.ownerReceipt), after = parseReplayCursorV1(value.after);
      if (ownerReceipt.rootSessionId !== value.rootSessionId || ownerReceipt.runId !== value.runId || !sameIdentity(after, ownerReceipt) || !await options.ownerValidator(ownerReceipt) || !await options.cursorValidator(after, ownerReceipt)) return blocked();
      if (!options.deliverySink || typeof options.deliverySink.hasDelivered !== "function" || typeof options.deliverySink.deliver !== "function") return blocked();
      const begun = await options.barrier.beginReplayBarrier({ cursor: after });
      const batch = await options.barrier.replayBatch({ cursor: after, limit: value.batchSize });
      const processingReceipts: DurableReceiptV1[] = [], transportReceipts: DurableReceiptV1[] = [];
      let completion: DurableReceiptV1 | undefined;
      for (const event of batch.events) {
        if (!sameIdentity(event.cursor, ownerReceipt) || event.cursor.epoch !== after.epoch) return blocked();
        transportReceipts.push(event.transportReceipt);
        const processing = await options.outbox.recordConsumerProcessingReceipt({ consumerId: options.consumerId, eventId: event.envelope.eventId, payloadDigest: event.payloadDigest });
        processingReceipts.push(processing);
        const terminalReceiptId = event.envelope.metadata && typeof event.envelope.metadata === "object" && !Array.isArray(event.envelope.metadata) && (event.envelope.metadata as Record<string, unknown>).kind === "terminal-completion" && typeof (event.envelope.metadata as Record<string, unknown>).terminalReceiptId === "string" ? (event.envelope.metadata as Record<string, unknown>).terminalReceiptId as string : undefined;
        const isCompletion = !!terminalReceiptId && !!options.terminalReceiptValidator && await options.terminalReceiptValidator(event, terminalReceiptId);
        const idempotencyKey = isCompletion ? `${ownerReceipt.runId}:${terminalReceiptId}` : `${event.envelope.eventId}:${event.payloadDigest}`;
        const durableReceipt = isCompletion ? await options.outbox.recordCompletionReceipt({ runId: ownerReceipt.runId, terminalReceiptId }) : processing;
        if (!await options.deliverySink.hasDelivered(idempotencyKey)) await options.deliverySink.deliver({ eventId: event.envelope.eventId, payloadDigest: event.payloadDigest, payload: event.envelope.payload, idempotencyKey, receiptId: durableReceipt.receiptId, kind: isCompletion ? "completion" : "event" });
        // Durable ACK follows the effect. A crash before it deliberately replays transport.
        if (isCompletion) { await options.outbox.completeCompletionReceipt({ receiptId: durableReceipt.receiptId }); completion = durableReceipt; }
        await options.outbox.ackReceipt({ receiptId: processing.receiptId });
      }
      if (batch.events.length > 0 && batch.events.at(-1)!.cursor.sequence >= begun.highWater.sequence) await options.barrier.switchLiveAfterBarrier({ cursor: after });
      return { status: "replayed" as const, events: batch.events, transportReceipts, processingReceipts, ...(completion ? { userVisibleCompletionReceipt: completion } : {}) };
    } catch { return blocked(); }
  }
  return { replaySupervisor };
}
