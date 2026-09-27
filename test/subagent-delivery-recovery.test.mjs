import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJiti } from "../packages/pi-subagents-enhanced/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { DurableStorage } = await jiti.import("../packages/pi-subagents-enhanced/src/subagent-dispatch/durable-storage.ts");
const { DurableEventOutbox, DurableOutboxError } = await jiti.import("../packages/pi-subagents-enhanced/src/subagent-dispatch/durable-event-outbox.ts");
const { ReplayBarrier, ReplayBarrierError } = await jiti.import("../packages/pi-subagents-enhanced/src/subagent-dispatch/replay-barrier.ts");

const cursor = (overrides = {}) => ({ rootSessionId: "root-1", runId: "run-1", ownerGeneration: 2, epoch: 3, sequence: 0, ...overrides });
const event = (sequence, payload = { message: `event-${sequence}` }) => ({ cursor: cursor({ sequence }), envelope: { version: "durable-envelope.v1", eventId: `event-${sequence}`, payload, metadata: { kind: "notice" } } });
async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), "durable-outbox-")); const storage = new DurableStorage({ root }); return { storage, outbox: new DurableEventOutbox({ storage }), barrier: new ReplayBarrier({ storage, outbox: new DurableEventOutbox({ storage }) }) }; }

test("append commits transport receipt before return and retry after lost response is idempotent", async () => {
  const { outbox } = await fixture();
  const first = await outbox.appendEvent(event(1));
  assert.equal(first.kind, "transport-durable");
  assert.equal((await outbox.appendEvent(event(1))).receiptId, first.receiptId);
  assert.deepEqual((await outbox.readReplayBatch({ after: cursor(), limit: 10 })).events.map(item => item.cursor.sequence), [1]);
});

test("outbox retains delivery through processing and lost or repeated ACK", async () => {
  const { outbox } = await fixture(); await outbox.appendEvent(event(1));
  const processing = await outbox.recordConsumerProcessingReceipt({ consumerId: "supervisor-1", eventId: "event-1", payloadDigest: (await outbox.readReplayBatch({ after: cursor(), limit: 1 })).events[0].payloadDigest });
  assert.equal(processing.kind, "consumer-processing");
  assert.equal((await outbox.ackReceipt({ receiptId: processing.receiptId })).acknowledged, true);
  assert.equal((await outbox.ackReceipt({ receiptId: processing.receiptId })).acknowledged, true);
  assert.equal((await outbox.readReplayBatch({ after: cursor(), limit: 10 })).events.length, 1);
  const completion = await outbox.recordCompletionReceipt({ runId: "run-1", terminalReceiptId: "terminal-1" });
  assert.equal(completion.kind, "user-visible-completion");
  assert.equal(await outbox.isReceiptAcknowledged({ receiptId: completion.receiptId }), false);
  assert.equal((await outbox.completeCompletionReceipt({ receiptId: completion.receiptId })).completed, true);
  assert.equal(await outbox.isReceiptAcknowledged({ receiptId: completion.receiptId }), true);
});

test("outbox fences sequences, digest conflicts, roots, partial batches, and unsafe payloads", async () => {
  const { outbox } = await fixture();
  await outbox.appendEvent(event(1)); await outbox.appendEvent(event(2)); await outbox.appendEvent(event(3));
  assert.deepEqual((await outbox.readReplayBatch({ after: cursor(), limit: 2 })).events.map(item => item.cursor.sequence), [1, 2]);
  await assert.rejects(() => outbox.appendEvent(event(5)), error => error instanceof DurableOutboxError && error.code === "OUTBOX_SEQUENCE_GAP");
  await assert.rejects(() => outbox.appendEvent({ ...event(3), envelope: { ...event(3).envelope, payload: { changed: true } } }), error => error.code === "OUTBOX_DIGEST_CONFLICT");
  await assert.rejects(() => outbox.appendEvent(event(4, { deeply: [{ token: "no" }] })), /DURABLE_SENSITIVE_KEY/);
  await assert.rejects(() => outbox.appendEvent(event(4, "x".repeat(32 * 1024 + 1))), /DURABLE_PAYLOAD_TOO_LARGE/);
  const frameOverflow = event(4, { metadataBudget: "x".repeat(32 * 1024 - 500) });
  frameOverflow.cursor = cursor({ sequence: 1, rootSessionId: "r".repeat(40 * 1024) });
  await assert.rejects(() => outbox.appendEvent(frameOverflow), /DURABLE_FRAME_TOO_LARGE/);
  await outbox.appendEvent({ ...event(1), cursor: cursor({ rootSessionId: "root-2", sequence: 1 }), envelope: { ...event(1).envelope, eventId: "root-2-event" } });
  assert.equal((await outbox.readReplayBatch({ after: cursor({ rootSessionId: "root-2" }), limit: 10 })).events.length, 1);
});

test("replay barrier persists high-water over crash and atomically fences live frames", async () => {
  const { storage, outbox, barrier } = await fixture(); await outbox.appendEvent(event(1)); await outbox.appendEvent(event(2));
  const begun = await barrier.beginReplayBarrier({ cursor: cursor() });
  assert.equal(begun.highWater.sequence, 2);
  const afterRestart = new ReplayBarrier({ storage, outbox: new DurableEventOutbox({ storage }) });
  assert.deepEqual((await afterRestart.beginReplayBarrier({ cursor: cursor() })).highWater, begun.highWater);
  assert.deepEqual((await afterRestart.replayBatch({ cursor: cursor(), limit: 1 })).events.map(item => item.cursor.sequence), [1]);
  const live = await afterRestart.switchLiveAfterBarrier({ cursor: cursor() });
  assert.equal(live.liveBoundary.sequence, 2);
  assert.equal(await afterRestart.acceptLiveFrame({ cursor: cursor({ sequence: 3 }) }), true);
  assert.equal(await afterRestart.acceptLiveFrame({ cursor: cursor({ sequence: 2 }) }), false);
  assert.equal(await afterRestart.acceptLiveFrame({ cursor: cursor({ ownerGeneration: 1, sequence: 3 }) }), false);
  assert.equal(await afterRestart.acceptLiveFrame({ cursor: cursor({ epoch: 2, sequence: 3 }) }), false);
  await assert.rejects(() => afterRestart.switchLiveAfterBarrier({ cursor: cursor({ rootSessionId: "root-else" }) }), error => error instanceof ReplayBarrierError);
});
