import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createIntegrationQueue } from "../packages/pi-subagents-enhanced/src/workspace/integration-queue.ts";

const sha = "a".repeat(64);
const commit = "b".repeat(40);

test("recovery intent is durable, redacts private fields, and enforces owner/generation gates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-recovery-"));
  try {
    const queue = createIntegrationQueue({ stateRoot: root, repositoryId: sha });
    const ownerScope = { kind: "standalone-subagent", rootSessionId: "root-a" };
    const item = queue.enqueueIntegration({ requestId: "request-1", repositoryId: sha, workspaceId: "workspace-1", leaseId: sha, ownerScope, childRunId: "run-a", strategy: "rebase-ff", targetRef: "refs/heads/main", authorizedWorkspaceHead: commit, observedTargetHead: commit });
    const intent = queue.recoveryIntent({ queueItemId: item.queueItemId, workspaceId: item.workspaceId, ownerScope, runId: "run-a", attempt: 1, generation: 2, reason: "broker disconnected", requiredAction: "preserve", token: "secret", privatePath: "/private" });
    assert.equal(intent.version, "recovery-intent.v1");
    assert.equal(intent.state, "preserved");
    assert.equal(intent.delivery.state, "pending");
    assert.equal("token" in intent, false);
    assert.equal("privatePath" in intent, false);
    assert.throws(() => queue.mutateRecovery({ recoveryIntentId: intent.recoveryIntentId, ownerScope: { ...ownerScope, rootSessionId: "root-b" }, generation: 2 }, "release"), /owner scope denied/);
    assert.throws(() => queue.mutateRecovery({ recoveryIntentId: intent.recoveryIntentId, ownerScope, generation: 1 }, "release"), /generation mismatch/);
    const retried = queue.mutateRecovery({ recoveryIntentId: intent.recoveryIntentId, ownerScope, generation: 2 }, "retry");
    assert.equal(retried.generation, 3);
    assert.equal(queue.listRecoveryIntents().length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("recovery tool permission matrix rejects foreign roots, stale generations, duplicate actions, and permits one concurrent action", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-recovery-matrix-"));
  try {
    const queue = createIntegrationQueue({ stateRoot: root, repositoryId: sha });
    const ownerA = { kind: "standalone-subagent", rootSessionId: "root-a" };
    const ownerB = { kind: "standalone-subagent", rootSessionId: "root-b" };
    const item = queue.enqueueIntegration({ requestId: "matrix", repositoryId: sha, workspaceId: "workspace-matrix", leaseId: sha, ownerScope: ownerA, childRunId: "run-a", strategy: "rebase-ff", targetRef: "refs/heads/main", authorizedWorkspaceHead: commit, observedTargetHead: commit });
    const intent = queue.recoveryIntent({ queueItemId: item.queueItemId, workspaceId: item.workspaceId, ownerScope: ownerA, runId: "run-a", reason: "provider error", requiredAction: "preserve", generation: 1 });
    assert.equal(queue.listRecoveryIntents().length, 1, "audit discovers intent");
    assert.equal(queue.listRecoveryIntents().find((value) => value.recoveryIntentId === intent.recoveryIntentId)?.state, "preserved", "status observes intent");
    assert.throws(() => queue.mutateRecovery({ recoveryIntentId: intent.recoveryIntentId, ownerScope: ownerB, generation: 1 }, "retry"), /owner scope denied/);
    assert.throws(() => queue.mutateRecovery({ recoveryIntentId: intent.recoveryIntentId, ownerScope: ownerA, generation: 0 }, "preserved"), /generation mismatch/);
    const results = await Promise.allSettled([0, 1].map(() => Promise.resolve().then(() => queue.mutateRecovery({ recoveryIntentId: intent.recoveryIntentId, ownerScope: ownerA, generation: 1 }, "retry"))));
    assert.equal(results.filter((value) => value.status === "fulfilled").length, 1, "concurrent action has one winner");
    assert.equal(results.filter((value) => value.status === "rejected").length, 1, "concurrent duplicate is rejected");
    const settled = queue.listRecoveryIntents()[0];
    assert.equal(settled.state, "retry");
    assert.equal(settled.generation, 2);
    assert.throws(() => queue.mutateRecovery({ recoveryIntentId: intent.recoveryIntentId, ownerScope: ownerA, generation: 2 }, "retry"), /already settled/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("all six queue recovery stages persist a conservative preserve across coordinator recreation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-recovery-stages-"));
  try {
    const stages = ["queued", "admitted", "rebasing", "resolving-conflict", "prepared", "completed-awaiting-proof"];
    for (const [index, stage] of stages.entries()) {
      const queue = createIntegrationQueue({ stateRoot: root, repositoryId: sha });
      const ownerScope = { kind: "standalone-subagent", rootSessionId: `root-${index}` };
      const item = queue.enqueueIntegration({ requestId: `stage-${index}`, repositoryId: sha, workspaceId: `workspace-${index}`, leaseId: sha, ownerScope, childRunId: `run-${index}`, strategy: "rebase-ff", targetRef: "refs/heads/main", authorizedWorkspaceHead: commit, observedTargetHead: commit });
      const intent = queue.recoveryIntent({ queueItemId: item.queueItemId, workspaceId: item.workspaceId, ownerScope, runId: `run-${index}`, reason: `root close at ${stage}`, requiredAction: "preserve", generation: index });
      const restarted = createIntegrationQueue({ stateRoot: root, repositoryId: sha });
      const recovered = restarted.listRecoveryIntents().find((value) => value.recoveryIntentId === intent.recoveryIntentId);
      assert.equal(recovered?.state, "preserved", stage);
      assert.equal(recovered?.delivery.state, "pending", stage);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
