import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createIntegrationQueue, INTEGRATION_RECEIPT_EVENT_VERSION } from "../packages/pi-subagents-enhanced/src/workspace/integration-queue.ts";

const repositoryId = "a".repeat(64);
const sha = (tag) => createHash("sha256").update(tag).digest("hex");
const candidateHead = "b".repeat(40);
const daemon = { instanceId: "daemon-1", pid: process.pid, birthIdentity: "d".repeat(64) };

const item = (workspaceId, extra = {}) => ({
  requestId: workspaceId, repositoryId, workspaceId, leaseId: sha(`lease-${workspaceId}`),
  ownerScope: { kind: "standalone-subagent", rootSessionId: "root-1" }, strategy: "rebase-ff",
  targetRef: "refs/heads/main", authorizedWorkspaceHead: "b".repeat(64), observedTargetHead: "c".repeat(64), attempt: 1,
  ...extra,
});

const queueDir = (root) => path.join(root, "repositories", repositoryId, "integration-queue");

async function withQueue(run) {
  const root = await mkdtemp(path.join(tmpdir(), "integration-queue-receipt-"));
  try {
    return await run({ root, queue: createIntegrationQueue({ stateRoot: root, repositoryId }) });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("completePrepared 落 completed 回执事件：字段完备、索引与事件文件落盘、既有终态行为不变", async () => withQueue(async ({ root, queue }) => {
  queue.enqueueIntegration(item("ws-1", { childRunId: "run-ws-1" }));
  queue.enqueueIntegration(item("ws-2"));
  const claim = queue.claimNext(daemon);
  assert.equal(claim.state, "admitted");
  const intent = queue.requestChildResume({ queueItemId: claim.queueItemId, sourceRunId: "run-ws-1", sourceAsyncDir: "/var/tmp/async-ws-1", sourceProofId: "proof-ws-1" });
  assert.equal(intent.state, "waiting-head");
  const prepared = queue.prepareCandidate({ queueItemId: claim.queueItemId, queueLeaseId: claim.queueLeaseId, admissionGeneration: claim.admissionGeneration, candidateHead });
  assert.equal(prepared.state, "prepared");
  const completed = queue.completePrepared({ queueItemId: claim.queueItemId, queueLeaseId: claim.queueLeaseId, candidateHead, integrationIntentId: "intent-1", workspaceDispositionReceiptId: "wsr-1" });
  assert.equal(completed.state, "completed");
  assert.equal(completed.revision, prepared.revision + 1);
  assert.ok(completed.completedAt);

  const events = queue.listReceiptEvents();
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.version, INTEGRATION_RECEIPT_EVENT_VERSION);
  assert.equal(event.eventId, `${claim.queueItemId}:completed`);
  assert.equal(event.queueItemId, claim.queueItemId);
  assert.equal(event.workspaceId, "ws-1");
  assert.equal(event.leaseId, sha("lease-ws-1"));
  assert.equal(event.childRunId, "run-ws-1");
  assert.deepEqual(event.ownerScope, { kind: "standalone-subagent", rootSessionId: "root-1" });
  assert.equal(event.repositoryId, repositoryId);
  assert.equal(event.state, "completed");
  assert.equal(event.attempt, 1);
  assert.equal(event.revision, completed.revision);
  assert.equal(event.candidateHead, candidateHead);
  assert.equal(event.integrationIntentId, "intent-1");
  assert.equal(event.workspaceDispositionReceiptId, "wsr-1");
  assert.equal(event.completedAt, completed.completedAt);
  assert.ok(!("preservedAt" in event) && !("cancelledAt" in event));
  assert.deepEqual(event.delivery, { state: "pending", attempts: 0 });

  // durable 存储：queue-receipt-events.json 索引 + 每事件一文件，与 resume intents 形态并列。
  const index = JSON.parse(await readFile(path.join(queueDir(root), "queue-receipt-events.json"), "utf8"));
  assert.deepEqual(index, [`receipt-event-${event.eventId}.json`]);
  const persisted = JSON.parse(await readFile(path.join(queueDir(root), `receipt-event-${event.eventId}.json`), "utf8"));
  assert.deepEqual(persisted, event);

  // 既有行为不变：active resume intent 在同一锁内关闭；完成即推进 FIFO；
  // 队列项记录不含回执事件字段。
  assert.equal(queue.listResumeIntents()[0].state, "completed");
  assert.equal(queue.claimNext(daemon).workspaceId, "ws-2");
  assert.deepEqual(queue.getItem(claim.queueItemId), completed);
  const stored = JSON.parse(await readFile(path.join(queueDir(root), `${claim.queueItemId}.json`), "utf8"));
  assert.ok(!("delivery" in stored) && !("eventId" in stored), "回执事件字段不得泄漏进队列项记录");

  // 既有守卫不变：终态后的重复 completePrepared 仍被拒绝，且不追加第二事件。
  assert.throws(() => queue.completePrepared({ queueItemId: claim.queueItemId, queueLeaseId: claim.queueLeaseId, candidateHead, integrationIntentId: "intent-1", workspaceDispositionReceiptId: "wsr-1" }), /prepared queue lease or candidate mismatch/);
  assert.equal(queue.listReceiptEvents().length, 1);
}));

test("preserveByBinding 落 preserved 回执事件，重复终态写入不产生第二事件", async () => withQueue(async ({ queue }) => {
  const enqueued = queue.enqueueIntegration(item("ws-1", { childRunId: "run-ws-1" }));
  const binding = { workspaceId: "ws-1", leaseId: sha("lease-ws-1"), runId: "run-ws-1", ownerScope: { kind: "standalone-subagent", rootSessionId: "root-1" } };
  const preserved = queue.preserveByBinding(binding, "child exited before integration");
  assert.equal(preserved.state, "preserved");
  assert.equal(preserved.revision, enqueued.revision + 1);
  assert.ok(preserved.preservedAt);

  const events = queue.listReceiptEvents();
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.eventId, `${enqueued.queueItemId}:preserved`);
  assert.equal(event.queueItemId, enqueued.queueItemId);
  assert.equal(event.state, "preserved");
  assert.equal(event.childRunId, "run-ws-1");
  assert.equal(event.leaseId, sha("lease-ws-1"));
  assert.equal(event.attempt, 1);
  assert.equal(event.revision, preserved.revision);
  assert.equal(event.preservedAt, preserved.preservedAt);
  assert.ok(!("candidateHead" in event) && !("integrationIntentId" in event) && !("workspaceDispositionReceiptId" in event) && !("completedAt" in event) && !("cancelledAt" in event));
  assert.deepEqual(event.delivery, { state: "pending", attempts: 0 });

  // 幂等：重复 preserveByBinding 是既有幂等 no-op，不产生第二事件，也不改队列项。
  const replay = queue.preserveByBinding(binding, "child exited before integration");
  assert.equal(replay.revision, preserved.revision);
  assert.equal(queue.listReceiptEvents().length, 1);
  assert.deepEqual(queue.getItem(enqueued.queueItemId), preserved);
}));

test("cancelItem/completeItem/failItem（transition）各落回执事件；未绑定 child 的 cancelled 事件 childRunId 为 null", async () => withQueue(async ({ queue }) => {
  queue.enqueueIntegration(item("ws-1"));
  queue.enqueueIntegration(item("ws-2", { childRunId: "run-ws-2" }));
  queue.enqueueIntegration(item("ws-3", { childRunId: "run-ws-3" }));

  const first = queue.claimNext(daemon);
  const cancelled = queue.cancelItem(first, { authorized: true });
  assert.equal(cancelled.state, "cancelled");
  let events = queue.listReceiptEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, `${first.queueItemId}:cancelled`);
  assert.equal(events[0].state, "cancelled");
  assert.equal(events[0].childRunId, null);
  assert.equal(events[0].revision, cancelled.revision);
  assert.ok(events[0].cancelledAt);

  // 既有行为不变：cancel 释放 admission，下一项可被认领。
  const second = queue.claimNext(daemon);
  assert.equal(second.workspaceId, "ws-2");
  const completed = queue.completeItem({ queueItemId: second.queueItemId, queueLeaseId: second.queueLeaseId, revision: second.revision });
  assert.equal(completed.state, "completed");

  const third = queue.claimNext(daemon);
  assert.equal(third.workspaceId, "ws-3");
  const preserved = queue.failItem({ queueItemId: third.queueItemId, queueLeaseId: third.queueLeaseId, revision: third.revision });
  assert.equal(preserved.state, "preserved");

  events = queue.listReceiptEvents();
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((entry) => `${entry.queueItemId}:${entry.state}`),
    [`${first.queueItemId}:cancelled`, `${second.queueItemId}:completed`, `${third.queueItemId}:preserved`]);
  assert.equal(events[1].childRunId, "run-ws-2");
  assert.ok(events[1].completedAt);
  assert.equal(events[2].childRunId, "run-ws-3");
  assert.ok(events[2].preservedAt);
}));

const preparedDisposition = (claim, { operation, settlementId, reason = null }) => ({
  schemaVersion: "workspace-disposition-prepare.v1", settlementId, operation, reason,
  binding: { workspaceId: claim.workspaceId, leaseId: claim.leaseId, rootSessionId: "root-1",
    runId: claim.childRunId, asyncDir: "/var/tmp/async-disposition", queueItemId: claim.queueItemId,
    queueLeaseId: claim.queueLeaseId, queueRevision: claim.revision, admissionGeneration: claim.admissionGeneration },
  authorizedRevision: 0, snapshotHash: null, proofHash: null, executorHead: "e".repeat(40),
  phase: "prepared", workspaceReceiptRef: null, queueReceiptRef: null,
});

test("settleDispositionQueue 落终态回执事件，重放幂等不产生第二事件也不改队列项", async () => withQueue(async ({ queue }) => {
  queue.enqueueIntegration(item("ws-discard", { childRunId: "run-discard" }));
  const discardClaim = queue.claimNext(daemon);
  const discard = preparedDisposition(discardClaim, { operation: "discard", settlementId: "settle-discard" });
  const receipt = queue.settleDispositionQueue(discard);
  assert.equal(receipt.receiptRef, "qsr-settle-discard");
  const settled = queue.getItem(discardClaim.queueItemId);
  assert.equal(settled.state, "cancelled");
  assert.equal(settled.dispositionSettlementId, "settle-discard");
  assert.equal(settled.dispositionReceiptRef, "qsr-settle-discard");
  assert.equal(settled.revision, discardClaim.revision + 1);

  const events = queue.listReceiptEvents();
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.eventId, `${discardClaim.queueItemId}:cancelled`);
  assert.equal(event.state, "cancelled");
  assert.equal(event.childRunId, "run-discard");
  assert.equal(event.revision, settled.revision);
  assert.ok(event.cancelledAt);
  assert.deepEqual(event.delivery, { state: "pending", attempts: 0 });

  // 重放：幂等结算 + 幂等事件，不产生第二个事件也不改队列项。
  const replayReceipt = queue.settleDispositionQueue(discard);
  assert.equal(replayReceipt.receiptRef, "qsr-settle-discard");
  assert.deepEqual(queue.getItem(discardClaim.queueItemId), settled);
  assert.equal(queue.listReceiptEvents().length, 1);

  // preserve 结算落 preserved 事件。
  queue.enqueueIntegration(item("ws-keep", { childRunId: "run-keep" }));
  const keepClaim = queue.claimNext(daemon);
  queue.settleDispositionQueue(preparedDisposition(keepClaim, { operation: "preserve", settlementId: "settle-keep", reason: "manual preserve" }));
  const all = queue.listReceiptEvents();
  assert.equal(all.length, 2);
  assert.equal(all[1].eventId, `${keepClaim.queueItemId}:preserved`);
  assert.equal(all[1].state, "preserved");
  assert.ok(all[1].preservedAt);
}));
