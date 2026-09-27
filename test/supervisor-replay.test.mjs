import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJiti } from "../packages/pi-subagents-enhanced/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { DurableStorage } = await jiti.import("../packages/pi-subagents-enhanced/src/subagent-dispatch/durable-storage.ts");
const { DurableEventOutbox } = await jiti.import("../packages/pi-subagents-enhanced/src/subagent-dispatch/durable-event-outbox.ts");
const { ReplayBarrier } = await jiti.import("../packages/pi-subagents-enhanced/src/subagent-dispatch/replay-barrier.ts");
const { createSupervisorReplay } = await jiti.import("../packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-replay.ts");
const { createOwnerReceipt } = await jiti.import("../packages/pi-subagents-enhanced/src/subagent-dispatch/authority-contract.ts");

const cursor = (overrides = {}) => ({ rootSessionId: "root-1", runId: "run-1", ownerGeneration: 2, epoch: 3, sequence: 0, ...overrides });
const event = (sequence, payload = { message: `event-${sequence}` }, metadata = { kind: "notice" }) => ({ cursor: cursor({ sequence }), envelope: { version: "durable-envelope.v1", eventId: `event-${sequence}`, payload, metadata } });
const receipt = (overrides = {}) => createOwnerReceipt({ receiptId: "owner-1", rootSessionId: "root-1", runId: "run-1", ownerGeneration: 2, processBirth: "birth-1", revision: 1, authorizationReference: `sha256:${"a".repeat(64)}`, ...overrides });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "supervisor-replay-")); const storage = new DurableStorage({ root }); const outbox = new DurableEventOutbox({ storage });
  const delivered = []; const sink = { async hasDelivered(key) { return delivered.some(entry => entry.idempotencyKey === key); }, async deliver(input) { delivered.push(input); return { idempotencyKey: input.idempotencyKey, receiptId: input.receiptId }; } };
  const adapter = createSupervisorReplay({ outbox, barrier: new ReplayBarrier({ storage, outbox }), consumerId: "supervisor-1", ownerValidator: async value => value.receiptId === "owner-1" && value.ownerGeneration === 2, cursorValidator: async value => value.epoch === 3, terminalReceiptValidator: async (_event, terminalReceiptId) => terminalReceiptId === "terminal-1", deliverySink: sink });
  return { outbox, storage, sink, delivered, adapter };
}

test("offline replay batches, survives restart and ACK loss without duplicate consumer effects", async () => {
  const { outbox, storage, delivered, adapter } = await fixture(); await outbox.appendEvent(event(1)); await outbox.appendEvent(event(2)); await outbox.appendEvent(event(3));
  const first = await adapter.replaySupervisor({ rootSessionId: "root-1", runId: "run-1", ownerReceipt: receipt(), after: cursor(), batchSize: 2 });
  assert.equal(first.status, "replayed"); assert.equal(first.events.length, 2); assert.equal(delivered.length, 2);
  const restarted = createSupervisorReplay({ outbox: new DurableEventOutbox({ storage }), barrier: new ReplayBarrier({ storage, outbox: new DurableEventOutbox({ storage }) }), consumerId: "supervisor-1", ownerValidator: async () => true, cursorValidator: async value => value.epoch === 3, terminalReceiptValidator: async (_event, terminalReceiptId) => terminalReceiptId === "terminal-1", deliverySink: { async hasDelivered(key) { return delivered.some(item => item.idempotencyKey === key); }, async deliver(input) { delivered.push(input); } } });
  const second = await restarted.replaySupervisor({ rootSessionId: "root-1", runId: "run-1", ownerReceipt: receipt(), after: cursor({ sequence: 2 }), batchSize: 2 });
  assert.equal(second.events.length, 1); assert.equal(delivered.length, 3);
  const replayedAfterLostAck = await restarted.replaySupervisor({ rootSessionId: "root-1", runId: "run-1", ownerReceipt: receipt(), after: cursor(), batchSize: 3 });
  assert.equal(replayedAfterLostAck.events.length, 3); assert.equal(delivered.length, 3);
});

test("terminal completion uses authority terminal receipt stable key across the sink crash gap", async () => {
  const { outbox, adapter, delivered } = await fixture();
  await outbox.appendEvent(event(1, { terminalReceiptId: "terminal-1" }, { kind: "terminal-completion", terminalReceiptId: "terminal-1" }));
  const key = "run-1:terminal-1"; delivered.push({ idempotencyKey: key, receiptId: "crashed-after-sink" });
  const result = await adapter.replaySupervisor({ rootSessionId: "root-1", runId: "run-1", ownerReceipt: receipt(), after: cursor(), batchSize: 1 });
  assert.equal(result.userVisibleCompletionReceipt.kind, "user-visible-completion"); assert.equal(delivered.filter(item => item.idempotencyKey === key).length, 1);
  const restart = await adapter.replaySupervisor({ rootSessionId: "root-1", runId: "run-1", ownerReceipt: receipt(), after: cursor(), batchSize: 1 });
  assert.equal(restart.userVisibleCompletionReceipt.receiptId, result.userVisibleCompletionReceipt.receiptId);
});

test("invalid authority/cursor, stale generation and missing idempotency lookup fail closed", async () => {
  const { outbox, adapter, delivered } = await fixture(); await outbox.appendEvent(event(1));
  for (const input of [
    { rootSessionId: "root-1", runId: "run-1", ownerReceipt: receipt({ ownerGeneration: 1 }), after: cursor(), batchSize: 1 },
    { rootSessionId: "root-1", runId: "run-1", ownerReceipt: receipt(), after: cursor({ epoch: 4 }), batchSize: 1 },
    { rootSessionId: "root-x", runId: "run-1", ownerReceipt: receipt(), after: cursor(), batchSize: 1 },
  ]) assert.equal((await adapter.replaySupervisor(input)).status, "blocked-unknown");
  assert.equal(delivered.length, 0);
  const unsafe = createSupervisorReplay({ outbox, barrier: { beginReplayBarrier() {} }, consumerId: "x", ownerValidator: async () => true, deliverySink: { async deliver() {} } });
  assert.equal((await unsafe.replaySupervisor({ rootSessionId: "root-1", runId: "run-1", ownerReceipt: receipt(), after: cursor(), batchSize: 1 })).status, "blocked-unknown");
});
