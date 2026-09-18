import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCoordinatorServer } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts";
import { createIntegrationQueue } from "../packages/pi-subagents-enhanced/src/workspace/integration-queue.ts";

test("coordinator clean idle shutdown is delayed and active connection prevents it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coordinator-"));
  const endpoint = path.join(root, "coordinator.sock");
  const server = createCoordinatorServer({ endpoint, repositoryId: "a".repeat(64), idleGraceMs: 20 });
  await server.listen();
  assert.equal(server.server.listening, true);
  await server.close();
  assert.equal(server.server.listening, false);
});

test("retained queue or git activity fences idle shutdown until released", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coordinator-"));
  const server = createCoordinatorServer({ endpoint: path.join(root, "coordinator.sock"), repositoryId: "a".repeat(64), idleGraceMs: 10 });
  await server.listen();
  const release = server.beginActivity();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(server.server.listening, true);
  release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(server.server.listening, false);
});

test("stale UNIX socket is reclaimed while a live socket is preserved", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coordinator-"));
  const endpoint = path.join(root, "coordinator.sock");
  await writeFile(endpoint, "stale");
  const server = createCoordinatorServer({ endpoint, repositoryId: "a".repeat(64), idleGraceMs: 1000 });
  await server.listen();
  assert.equal(server.server.listening, true);
  await server.close();
});

test("an admission abandoned by a dead daemon is reissued with a new generation and rejects the old lease", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "coordinator-admission-recovery-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  const repositoryId = "a".repeat(64);
  const queue = createIntegrationQueue({ stateRoot: root, repositoryId });
  queue.enqueueIntegration({ requestId: "request", repositoryId, workspaceId: "workspace", leaseId: "lease", ownerScope: { kind: "standalone-subagent", rootSessionId: "root" }, strategy: "rebase-ff", targetRef: "refs/heads/main", authorizedWorkspaceHead: "b".repeat(40), observedTargetHead: "c".repeat(40) });
  const abandoned = queue.claimNext({ instanceId: "dead-daemon", pid: 999999, birthIdentity: "d".repeat(64) });
  assert.equal(abandoned.admissionGeneration, 1);
  assert.equal(queue.recoverClaims({ instanceId: "dead-daemon", pid: 999999, birthIdentity: "d".repeat(64) }).length, 1);
  const replacement = queue.claimNext({ instanceId: "replacement", pid: process.pid, birthIdentity: "e".repeat(64) });
  assert.equal(replacement.admissionGeneration, 2);
  assert.notEqual(replacement.queueLeaseId, abandoned.queueLeaseId);
  assert.throws(() => queue.completeItem({ queueItemId: abandoned.queueItemId, queueLeaseId: abandoned.queueLeaseId, revision: abandoned.revision }), /lease|revision/i);
});
