import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { createManagedWorkspaceService } from "../../packages/pi-subagents-enhanced/src/workspace/service.ts";
import { inventoryManagedWorkspaces } from "../../packages/pi-subagents-enhanced/src/workspace/administration.ts";

const services = new Map();
const sha = (value) => createHash("sha256").update(value).digest("hex");

export function goalWorkspaceService({ stateRoot }) {
  if (!services.has(stateRoot)) services.set(stateRoot, createManagedWorkspaceService({ stateRoot }));
  return services.get(stateRoot);
}

export function allocateGoalWorkspaceFixture({ goalId, taskId, attempt, originRoot, stateRoot, baseCommit, contractHash = sha(`${goalId}:${taskId}:${attempt}`) }) {
  const workspaceId = `goal-${sha(`${goalId}:${taskId}:${attempt}:${baseCommit}`).slice(0, 48)}`;
  const receipt = goalWorkspaceService({ stateRoot }).ensureAllocated({
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
  return receipt;
}

export function loadGoalWorkspaceFixture({ goalId, taskId, attempt, stateRoot }) {
  const matches = inventoryManagedWorkspaces({ stateRoot }).workspaces
    .map(({ receipt }) => receipt)
    .filter((receipt) => receipt.owner.kind === "goal-task"
      && receipt.owner.goalId === goalId
      && receipt.owner.taskId === taskId
      && receipt.owner.attempt === attempt);
  if (matches.length === 0) return undefined;
  if (matches.length !== 1) {
    const error = new Error(`managed workspace receipt is ambiguous for ${goalId}/${taskId}/${attempt}`);
    error.code = "MANAGED_WORKSPACE_RECEIPT_AMBIGUOUS";
    throw error;
  }
  const receipt = matches[0];
  return receipt;
}

export function inspectGoalWorkspaceFixture(lease) {
  return serviceForCanonicalReceipt(lease).status({ workspaceId: lease.workspaceId }).inspection;
}

export function releaseGoalWorkspaceFixture(lease, { disposition = "discarded-cleanup" } = {}) {
  const service = serviceForCanonicalReceipt(lease);
  // Cleanup only touches a receipt that is still present in the canonical
  // service inventory.  A released/no-op fixture has no record to dispose.
  let current;
  try {
    current = service.status({ workspaceId: lease.workspaceId }).receipt;
  } catch (error) {
    if (error.code === "MANAGED_WORKSPACE_NOT_FOUND") return undefined;
    throw error;
  }
  if (current.state === "released") return current;
  const issued = service.issueDisposition({ workspaceId: lease.workspaceId, terminalProof: { state: "observed", conflict: false, proofHash: sha("fixture-terminal") } });
  return service.dispose({ workspaceId: lease.workspaceId, terminalProof: { state: "observed", conflict: false, proofHash: sha("fixture-terminal") }, disposition: disposition === "preserved" ? "preserve" : "discard", reason: "fixture cleanup", actionToken: issued.actionToken });
}

function serviceForCanonicalReceipt(receipt) {
  if (receipt.stateRoot) return goalWorkspaceService({ stateRoot: receipt.stateRoot });
  for (const service of services.values()) {
    try {
      if (service.status({ workspaceId: receipt.workspaceId }).receipt.leaseId === receipt.leaseId) return service;
    } catch (error) {
      if (error.code !== "MANAGED_WORKSPACE_NOT_FOUND") throw error;
    }
  }
  const error = new Error(`managed workspace receipt is missing for ${receipt.workspaceId}`);
  error.code = "MANAGED_WORKSPACE_NOT_FOUND";
  throw error;
}
