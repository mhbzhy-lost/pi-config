import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createIntegrationQueue, INTEGRATION_QUEUE_RECORD_VERSION } from "../packages/pi-subagents-enhanced/src/workspace/integration-queue.ts";

const item = (workspaceId, requestId = workspaceId) => ({
  requestId, repositoryId: "a".repeat(64), workspaceId, leaseId: `workspace-${workspaceId}`,
  ownerScope: { kind: "standalone-subagent", rootSessionId: "root-1" }, strategy: "rebase-ff",
  targetRef: "refs/heads/main", authorizedWorkspaceHead: "b".repeat(64), observedTargetHead: "c".repeat(64), attempt: 1,
});

test("durable queue assigns FIFO sequence and idempotently enqueues", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "integration-queue-"));
  try {
    const queue = createIntegrationQueue({ stateRoot: root, repositoryId: "a".repeat(64) });
    const first = queue.enqueueIntegration(item("ws-1"));
    const replay = queue.enqueueIntegration(item("ws-1"));
    const second = queue.enqueueIntegration(item("ws-2"));
    assert.equal(first.queueItemId, replay.queueItemId); assert.equal(first.sequence, 1); assert.equal(second.sequence, 2);
    assert.deepEqual(queue.listQueue().map((entry) => entry.workspaceId), ["ws-1", "ws-2"]);
    assert.equal(first.version, INTEGRATION_QUEUE_RECORD_VERSION);
    assert.match(await readFile(path.join(root, "repositories", "a".repeat(64), "integration-queue", `${first.queueItemId}.json`), "utf8"), /workspace-integration-queue-item.v1/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("claim is single-admission and completion immediately advances queue", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "integration-queue-"));
  try {
    const queue = createIntegrationQueue({ stateRoot: root, repositoryId: "a".repeat(64) });
    queue.enqueueIntegration(item("ws-1")); queue.enqueueIntegration(item("ws-2"));
    const daemon = { instanceId: "daemon-1", pid: process.pid, birthIdentity: "d".repeat(64) };
    const first = queue.claimNext(daemon); assert.equal(queue.claimNext(daemon), null);
    assert.notEqual(first.childAdmissionLeaseId, first.leaseId);
    queue.completeItem({ queueItemId: first.queueItemId, queueLeaseId: first.queueLeaseId, revision: first.revision });
    assert.equal(queue.listQueue()[0].state, "completed"); assert.equal(queue.claimNext(daemon).workspaceId, "ws-2");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("live daemon claim is not recovered by wall-clock and dead claim is recoverable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "integration-queue-"));
  try {
    const queue = createIntegrationQueue({ stateRoot: root, repositoryId: "a".repeat(64) }); queue.enqueueIntegration(item("ws-1"));
    const birthIdentity = createHash("sha256").update(execFileSync("/bin/ps", ["-ww", "-p", String(process.pid), "-o", "lstart=", "-o", "command="], { encoding: "buffer" })).digest("hex");
    const claim = queue.claimNext({ instanceId: "daemon-1", pid: process.pid, birthIdentity });
    assert.deepEqual(queue.recoverClaims({ instanceId: "daemon-1", pid: process.pid, birthIdentity }), []);
    assert.equal(queue.recoverClaims({ instanceId: "daemon-1", pid: 999999, birthIdentity: "e".repeat(64) }).length, 1);
    assert.equal(queue.listQueue()[0].state, "queued");
    assert.throws(() => queue.completeItem({ queueItemId: claim.queueItemId, queueLeaseId: claim.queueLeaseId, revision: claim.revision }), /lease|state/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("authorized cancel releases admission and retry is a new tail attempt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "integration-queue-"));
  try {
    const queue = createIntegrationQueue({ stateRoot: root, repositoryId: "a".repeat(64) });
    queue.enqueueIntegration(item("ws-1")); queue.enqueueIntegration(item("ws-2"));
    const daemon = { instanceId: "daemon-1", pid: process.pid, birthIdentity: "d".repeat(64) };
    const claim = queue.claimNext(daemon); assert.throws(() => queue.cancelItem(claim), /authorized/);
    const cancelled = queue.cancelItem(claim, { authorized: true }); assert.equal(cancelled.state, "cancelled");
    const next = queue.claimNext(daemon); const retried = queue.retryItem({ ...next, state: "preserved" });
    assert.equal(retried.attempt, 2); assert.equal(retried.sequence, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});
