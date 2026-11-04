import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createIntegrationQueue, INTEGRATION_RECEIPT_EVENT_VERSION } from "../packages/pi-subagents-enhanced/src/workspace/integration-queue.ts";
import { createCoordinatorServer } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts";
import { connectRepositoryCoordinator } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-client.ts";
import { resolveReceiptEventPumpPlan } from "../packages/pi-subagents-enhanced/extensions/subagent-runtime.ts";

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

  // 受控中断：真实 public queue 已写入终态后丢失 event/index；重开读取从权威 queue item 补齐。
  await rm(path.join(queueDir(root), `receipt-event-${event.eventId}.json`), { force: true });
  await rm(path.join(queueDir(root), "queue-receipt-events.json"), { force: true });
  const reopened = createIntegrationQueue({ stateRoot: root, repositoryId });
  const recovered = reopened.listReceiptEvents();
  assert.equal(recovered.length, 1);
  assert.deepEqual(recovered[0], event);

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

test("preserveByBinding 落 preserved 回执事件，重复终态写入不产生第二事件", async () => withQueue(async ({ root, queue }) => {
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

  // 受控中断：保留真实终态 event 文件但丢失索引；重开读取补索引并保留 delivery。
  queue.markReceiptEventDelivery({ eventIds: [event.eventId], state: "delivered", reason: "host execution facts notified" });
  await rm(path.join(queueDir(root), "queue-receipt-events.json"), { force: true });
  const reopened = createIntegrationQueue({ stateRoot: root, repositoryId });
  const recovered = reopened.listReceiptEvents();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].delivery.state, "delivered");
  assert.equal(recovered[0].delivery.attempts, 1);
  assert.deepEqual(JSON.parse(await readFile(path.join(queueDir(root), "queue-receipt-events.json"), "utf8")), [`receipt-event-${event.eventId}.json`]);

  // 幂等：重复 preserveByBinding 是既有幂等 no-op，不产生第二事件，也不改队列项。
  const replay = queue.preserveByBinding(binding, "child exited before integration");
  assert.equal(replay.revision, preserved.revision);
  assert.equal(queue.listReceiptEvents().length, 1);
  assert.deepEqual(queue.getItem(enqueued.queueItemId), preserved);
}));

test("cancelItem/completeItem/failItem（transition）各落回执事件；未绑定 child 的 cancelled 事件 childRunId 为 null", async () => withQueue(async ({ root, queue }) => {
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
  await rm(path.join(queueDir(root), `receipt-event-${events[0].eventId}.json`), { force: true });
  await rm(path.join(queueDir(root), "queue-receipt-events.json"), { force: true });
  const reopened = createIntegrationQueue({ stateRoot: root, repositoryId });
  events = reopened.listReceiptEvents();
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

// ———— 计划 T4 步骤 4：queue.receipt-events / queue.receipt-event-delivered RPC 与 D7 泵判定 ————

test("queue.receipt-events 按 owner 过滤且只返回 pending；回写后不再返回；recovery.status 保持扁平数组形状", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "receipt-events-rpc-"));
  const stateRoot = path.join(root, "state");
  // 免认证 mock：与 managed-workspace-resume-intent 集成测试同形态。
  const challengeBroker = async (registry) => ({ nonce: "n", repositoryId: registry.repositoryId, coordinatorInstanceId: "i", rootSessionId: registry.rootSessionId, brokerProcessIdentity: "b".repeat(64) });
  const coordinator = createCoordinatorServer({ endpoint: path.join(root, "coordinator.sock"), repositoryId, stateRoot, idleGraceMs: 10_000, challengeBroker });
  t.after(async () => { await coordinator.close(); await rm(root, { recursive: true, force: true }); });
  await coordinator.listen();
  const client = await connectRepositoryCoordinator({ repositoryId }, { protocol: "pi-root-subagent-broker-registry.v1", rootSessionId: "root-a", endpoint: "broker.sock", pid: process.pid, processBirthIdentity: "b".repeat(64) }, {
    metadata: { protocol: "repository-workspace-coordinator.v1", repositoryId, storageRepositoryId: repositoryId, endpoint: path.join(root, "coordinator.sock"), instanceId: coordinator.instanceId, pid: process.pid, birthIdentity: "c".repeat(64), canonicalStateRoot: stateRoot },
  });
  t.after(() => client.close());
  const queue = coordinator.internal.integrationQueue;

  const seedCancelled = (workspaceId, owner, childRunId) => {
    queue.enqueueIntegration({
      requestId: `req-${workspaceId}`, repositoryId, workspaceId, leaseId: sha(`lease-${workspaceId}`),
      ownerScope: { kind: "standalone-subagent", rootSessionId: owner }, ...(childRunId === undefined ? {} : { childRunId }),
      strategy: "rebase-ff", targetRef: "refs/heads/main", authorizedWorkspaceHead: "b".repeat(64), observedTargetHead: null,
    });
    const claim = queue.claimNext(daemon);
    assert.equal(claim.workspaceId, workspaceId);
    return queue.cancelItem(claim, { authorized: true });
  };

  // root-a 两个 pending（childRunId=null 与有 child 各一）；root-b 一个 pending；
  // root-a/root-b 各预置一个已回写终态（delivered/debt），验证只返回 pending。
  const aNull = seedCancelled("ws-a-null", "root-a");
  const aRun = seedCancelled("ws-a-run", "root-a", "run-a-2");
  const bNull = seedCancelled("ws-b-null", "root-b");
  const aSettled = seedCancelled("ws-a-settled", "root-a", "run-a-3");
  const bSettled = seedCancelled("ws-b-settled", "root-b", "run-b-3");
  queue.markReceiptEventDelivery({ eventIds: [`${aSettled.queueItemId}:cancelled`], state: "delivered", reason: "host execution facts notified" });
  queue.markReceiptEventDelivery({ eventIds: [`${bSettled.queueItemId}:cancelled`], state: "debt", reason: "child-run-unavailable" });
  const aNullEventId = `${aNull.queueItemId}:cancelled`;
  const aRunEventId = `${aRun.queueItemId}:cancelled`;
  const bNullEventId = `${bNull.queueItemId}:cancelled`;

  // 按 owner 过滤且只含 pending：root-a 的拉取不含 root-b 事件与 delivered/debt。
  let pending = await client.receiptEvents();
  assert.deepEqual(pending.map((event) => event.eventId).sort(), [aNullEventId, aRunEventId].sort());
  for (const event of pending) {
    assert.equal(event.delivery.state, "pending");
    assert.equal(event.ownerScope.rootSessionId, "root-a");
  }

  // recovery.status 形状不变：扁平数组（recovery intents + resume intents），回执事件不出现在其中。
  queue.enqueueIntegration({
    requestId: "req-ws-a-resume", repositoryId, workspaceId: "ws-a-resume", leaseId: sha("lease-ws-a-resume"),
    ownerScope: { kind: "standalone-subagent", rootSessionId: "root-a" }, childRunId: "run-a-9", strategy: "rebase-ff",
    targetRef: "refs/heads/main", authorizedWorkspaceHead: "b".repeat(64), observedTargetHead: null,
  });
  const resumable = queue.listQueue().find((entry) => entry.workspaceId === "ws-a-resume");
  queue.requestChildResume({ queueItemId: resumable.queueItemId, sourceRunId: "run-a-9", sourceAsyncDir: "/var/tmp/async-a9", sourceProofId: "p".repeat(64) });
  const status = await client.recoveryStatus();
  assert.ok(Array.isArray(status), "recovery.status 仍为扁平数组");
  assert.ok(status.length > 0, "recovery intents（resume intent）仍在扁平数组中返回");
  assert.ok(status.some((entry) => entry.version === "integration-resume-intent.v1"));
  assert.ok(status.every((entry) => entry.version !== INTEGRATION_RECEIPT_EVENT_VERSION), "回执事件不得进入 recovery.status");

  // 回写授权与未知/越权 eventId fail-closed；失败后事件保持 pending（下轮重试语义）。
  const rootScope = { kind: "standalone-subagent", rootSessionId: "root-a" };
  await assert.rejects(() => client.receiptEventDelivered({ eventIds: ["missing-event-id:cancelled"], state: "delivered", authorization: "root", ownerScope: rootScope }), /receipt event not found/);
  await assert.rejects(() => client.receiptEventDelivered({ eventIds: [bNullEventId], state: "delivered", authorization: "root", ownerScope: rootScope }), /owner scope denied/);
  await assert.rejects(() => client.receiptEventDelivered({ eventIds: [aRunEventId], state: "delivered", ownerScope: rootScope }), /root authorization required/);
  assert.deepEqual((await client.receiptEvents()).map((event) => event.eventId).sort(), [aNullEventId, aRunEventId].sort(), "回写失败保持 pending");

  // 回写 delivered 后不再返回；attempts 递增且重放幂等收敛。
  const delivered = await client.receiptEventDelivered({ eventIds: [aRunEventId], state: "delivered", authorization: "root", ownerScope: rootScope, reason: "host execution facts notified" });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].delivery.state, "delivered");
  assert.equal(delivered[0].delivery.attempts, 1);
  assert.equal(delivered[0].delivery.reason, "host execution facts notified");
  assert.deepEqual((await client.receiptEvents()).map((event) => event.eventId), [aNullEventId], "delivered 事件不再返回");
  const replay = await client.receiptEventDelivered({ eventIds: [aRunEventId], state: "delivered", authorization: "root", ownerScope: rootScope, reason: "host execution facts notified" });
  assert.equal(replay[0].delivery.state, "delivered");
  assert.equal(replay[0].delivery.attempts, 2, "重放只递增 attempts，状态幂等收敛");

  // childRunId=null 置 debt 终态后不再返回。
  const debt = await client.receiptEventDelivered({ eventIds: [aNullEventId], state: "debt", reason: "child-run-unavailable", authorization: "root", ownerScope: rootScope });
  assert.equal(debt[0].delivery.state, "debt");
  assert.equal(debt[0].delivery.reason, "child-run-unavailable");
  assert.deepEqual(await client.receiptEvents(), [], "root-a 无剩余 pending");

  // queue.audit 聚合返回全部回执事件（含 delivered/debt 与其它 owner）。
  const audit = await client.audit();
  assert.ok(Array.isArray(audit.receiptEvents));
  assert.deepEqual(audit.receiptEvents.map((event) => event.eventId).sort(),
    [aNullEventId, aRunEventId, `${aSettled.queueItemId}:cancelled`, bNullEventId, `${bSettled.queueItemId}:cancelled`].sort());
  const audited = new Map(audit.receiptEvents.map((event) => [event.eventId, event]));
  assert.equal(audited.get(aRunEventId).delivery.state, "delivered");
  assert.equal(audited.get(aNullEventId).delivery.state, "debt");
  assert.equal(audited.get(bNullEventId).delivery.state, "pending");
});

test("泵判定纯函数 resolveReceiptEventPumpPlan：childRunId=null 归入 toDebt，有效 childRunId 归入 toNotify 且 deliveredIds 含之", () => {
  const base = {
    version: INTEGRATION_RECEIPT_EVENT_VERSION, queueItemId: "q-1", workspaceId: "ws-1", leaseId: "lease-1",
    ownerScope: { kind: "standalone-subagent", rootSessionId: "root-a" }, repositoryId,
    state: "cancelled", attempt: 1, revision: 1, delivery: { state: "pending", attempts: 0 },
  };
  const events = [
    { ...base, eventId: "q-1:cancelled", childRunId: null },
    { ...base, eventId: "q-2:completed", childRunId: "run-2" },
    { ...base, eventId: "q-3:preserved" },
    { ...base, eventId: "q-4:cancelled", childRunId: "run-4", ownerScope: { kind: "other", rootSessionId: "root-x" } },
    { ...base, eventId: "", childRunId: "run-5" },
  ];
  const plan = resolveReceiptEventPumpPlan(events);
  assert.deepEqual(plan.toDebt.map((entry) => [entry.eventId, entry.reason]), [["q-1:cancelled", "child-run-unavailable"]]);
  assert.deepEqual(plan.toDebt[0].ownerScope, { kind: "standalone-subagent", rootSessionId: "root-a" });
  assert.deepEqual(plan.toNotify.map((entry) => [entry.eventId, entry.childRunId]), [["q-2:completed", "run-2"]]);
  assert.deepEqual(plan.toNotify[0].ownerScope, { kind: "standalone-subagent", rootSessionId: "root-a" });
  // notify 成功后回写 delivered 的目标集合：恰为 toNotify 的 eventId。
  assert.deepEqual(plan.deliveredIds, ["q-2:completed"]);
  // 非数组输入不抛错，返回空分组。
  assert.deepEqual(resolveReceiptEventPumpPlan(undefined), { toNotify: [], toDebt: [], deliveredIds: [] });
  assert.deepEqual(resolveReceiptEventPumpPlan("not-an-array"), { toNotify: [], toDebt: [], deliveredIds: [] });
});
