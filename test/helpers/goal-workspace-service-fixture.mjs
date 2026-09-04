import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { createManagedWorkspaceService } from "../../packages/pi-subagents-enhanced/src/workspace/service.ts";

const services = new Map();
const leases = new Map();
const sha = (value) => createHash("sha256").update(value).digest("hex");

function serviceFor(stateRoot) {
  if (!services.has(stateRoot)) services.set(stateRoot, createManagedWorkspaceService({ stateRoot }));
  return services.get(stateRoot);
}

export function allocateGoalWorkspaceFixture({ goalId, taskId, attempt, originRoot, stateRoot, baseCommit, contractHash = sha(`${goalId}:${taskId}:${attempt}`) }) {
  const workspaceId = `goal-${sha(`${goalId}:${taskId}:${attempt}:${baseCommit}`).slice(0, 48)}`;
  const receipt = serviceFor(stateRoot).ensureAllocated({
    workspaceId,
    owner: { kind: "goal-task", rootSessionId: "fixture-root", goalId, taskId, attempt, executionRevision: 1 },
    originRoot,
    requestedCwd: originRoot,
    originRef: `refs/heads/${execFileSync("git", ["branch", "--show-current"], { cwd: originRoot, encoding: "utf8" }).trim()}`,
    baseCommit,
    contractHash,
    mode: "coding",
    writePaths: ["src/**"],
  });
  const lease = { ...receipt, goalId, taskId, attempt, stateRoot, baseCommit, branch: receipt.branchRef };
  leases.set(`${stateRoot}:${goalId}:${taskId}:${attempt}`, lease);
  return lease;
}

export function loadGoalWorkspaceFixture({ goalId, taskId, attempt, stateRoot }) {
  return leases.get(`${stateRoot}:${goalId}:${taskId}:${attempt}`);
}

export function inspectGoalWorkspaceFixture(lease) {
  return serviceFor(lease.stateRoot).status({ workspaceId: lease.workspaceId }).inspection;
}

export function releaseGoalWorkspaceFixture(lease, { disposition = "discarded-cleanup" } = {}) {
  const service = serviceFor(lease.stateRoot);
  const issued = service.issueDisposition({ workspaceId: lease.workspaceId, terminalProof: { state: "observed", conflict: false, proofHash: sha("fixture-terminal") } });
  return service.dispose({ workspaceId: lease.workspaceId, terminalProof: { state: "observed", conflict: false, proofHash: sha("fixture-terminal") }, disposition: disposition === "preserved" ? "preserve" : "discard", reason: "fixture cleanup", actionToken: issued.actionToken });
}
