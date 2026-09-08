import { realpathSync } from "node:fs";
import { inventoryManagedWorkspaces } from "../../packages/pi-subagents-enhanced/src/workspace/administration.ts";
import { publicManagedWorkspaceReceipt } from "../../packages/pi-subagents-enhanced/src/workspace/contract.ts";

/** The sole Goal-side reader for the public managed-workspace.v1 receipt. */
export function canonicalManagedWorkspaceReceipt(value) {
  return publicManagedWorkspaceReceipt(value);
}

export function isCanonicalManagedWorkspaceReceipt(value) {
  try { return canonicalManagedWorkspaceReceipt(value).schemaVersion === "managed-workspace.v1"; }
  catch { return false; }
}

export function managedWorkspaceState(value) {
  return canonicalManagedWorkspaceReceipt(value).state;
}

export function managedWorkspaceDisposition(value) {
  return canonicalManagedWorkspaceReceipt(value).disposition;
}

export function managedWorkspaceOwner(value) {
  return canonicalManagedWorkspaceReceipt(value).owner;
}

/**
 * The sole Goal-to-service terminal adapter.  Its input is the durable,
 * already verified official executor proof saved by task settlement; it never
 * reads runner status, logs, or caller-supplied evidence.
 */
export function goalWorkspaceTerminalProof(proof) {
  if (proof === null || proof === undefined) return { state: "pending" };
  const fields = ["runId", "proofId", "rootSessionId", "observedAt", "outcome"];
  if (!proof || typeof proof !== "object" || Array.isArray(proof)
      || Object.keys(proof).length !== fields.length || fields.some((field) => !Object.hasOwn(proof, field))
      || typeof proof.runId !== "string" || !proof.runId
      || !/^[a-f0-9]{64}$/.test(proof.proofId)
      || typeof proof.rootSessionId !== "string" || !proof.rootSessionId
      || !Number.isFinite(proof.observedAt)
      || !["succeeded", "failed"].includes(proof.outcome)) {
    throw new Error("Goal workspace terminal adapter requires an official executor proof");
  }
  return {
    state: "observed",
    // A persisted proof was already identity-verified at settlement. Its task
    // outcome is not a proof conflict: failed/blocked tasks may still discard.
    conflict: false,
    proofHash: proof.proofId,
  };
}

// Public snapshot identity deliberately excludes service-private implementation
// data and mutable service state (including owner tokens and inspection output).
export function sameManagedWorkspaceSnapshot(left, right) {
  try {
    const identity = (value) => {
      const receipt = canonicalManagedWorkspaceReceipt(value);
      return { schemaVersion: receipt.schemaVersion, workspaceId: receipt.workspaceId, leaseId: receipt.leaseId,
        owner: receipt.owner, originRoot: receipt.originRoot, requestedCwd: receipt.requestedCwd,
        originRef: receipt.originRef, baseCommit: receipt.baseCommit, path: receipt.path,
        dispatchCwd: receipt.dispatchCwd, branchRef: receipt.branchRef };
    };
    return JSON.stringify(identity(left)) === JSON.stringify(identity(right));
  } catch { return false; }
}

type WorkspaceResources = { workspaceExists: boolean | null; branchExists: boolean | null; leaseExists?: boolean; recordExists?: boolean };
type UnverifiedInventory = { kind: "unverified"; resources: WorkspaceResources; observed?: string; error?: string };
const emptyResources: WorkspaceResources = { workspaceExists: null, branchExists: null, leaseExists: null };

function resourcesFor(receipt, identity) {
  const present = ["active", "disposing", "preserved"].includes(receipt.state);
  return { workspaceExists: present && identity === true, branchExists: present && identity === true, leaseExists: receipt.state !== "released" };
}

function unverified(resources: WorkspaceResources, observed?: string, error?: string): UnverifiedInventory {
  const result: UnverifiedInventory = { kind: "unverified", resources };
  if (observed) result.observed = observed;
  if (error) result.error = error;
  return result;
}

/**
 * Read-only Goal adapter for the public managed-workspace ledger inventory.
 * It deliberately never calls reconcile: status may observe, but never repair.
 */
export function createGoalManagedWorkspaceInspector({ workspaceService }) {
  return ({ goalId, taskId, attempt, originRoot, expectedWorkspaceId, expectedExecutionRevision, expectedRootSessionId }) => {
    const ledgerStateRoot = workspaceService?.stateRoot;
    if (typeof ledgerStateRoot !== "string" || !ledgerStateRoot) {
      return unverified(emptyResources, "authoritative managed workspace service is unavailable");
    }
    let canonicalOrigin;
    try { canonicalOrigin = realpathSync(originRoot); }
    catch (error) { return unverified(emptyResources, "Goal origin is unavailable", error?.code || "origin unavailable"); }
    let inventory;
    try {
      inventory = inventoryManagedWorkspaces({ stateRoot: ledgerStateRoot, originRoot: canonicalOrigin });
    } catch (error) {
      return unverified(emptyResources, undefined, error?.code || "managed workspace ledger inventory failed");
    }
    const relevant = inventory.workspaces.filter(({ receipt }) => receipt.owner.kind === "goal-task"
      && receipt.owner.goalId === goalId && receipt.owner.taskId === taskId && receipt.owner.attempt === attempt);
    if (relevant.length === 0) {
      // A missing record can still leave the service's Git registration.  It
      // identifies only the deterministic requested workspace, never an
      // arbitrary external worktree, and is deliberately unverified.
      const registration = typeof expectedWorkspaceId === "string"
        && inventory.orphanRegistrations.find((entry) => entry.branchRef === `refs/heads/pi-managed/${expectedWorkspaceId}`);
      if (registration) {
        return unverified({ workspaceExists: true, branchExists: true, recordExists: false }, "managed workspace ledger record is missing");
      }
      if (inventory.legacy.length > 0) return unverified(emptyResources, "legacy workspace artifacts require manual recovery");
      return { kind: "none", resources: { workspaceExists: false, branchExists: false, leaseExists: false } };
    }
    if (relevant.length !== 1) return unverified(emptyResources, "ambiguous managed workspace ledger records");
    const entry = relevant[0];
    const receipt = canonicalManagedWorkspaceReceipt(entry.receipt);
    const resources = resourcesFor(receipt, entry.identity);
    // A service record is recovery authority only when the Goal's durable
    // dispatch identity can bind every owner dimension.  Matching a human
    // readable goal/task/attempt alone must never authorize an orphan action.
    if (typeof expectedWorkspaceId !== "string" || !expectedWorkspaceId
        || !Number.isSafeInteger(expectedExecutionRevision) || expectedExecutionRevision < 1
        || typeof expectedRootSessionId !== "string" || !expectedRootSessionId
        || receipt.workspaceId !== expectedWorkspaceId
        || receipt.owner.executionRevision !== expectedExecutionRevision
        || receipt.owner.rootSessionId !== expectedRootSessionId) {
      return unverified(resources, "managed workspace owner identity does not match the Goal dispatch request");
    }
    if (receipt.originRoot !== canonicalOrigin) return unverified(resources, "foreign managed workspace origin");
    if (receipt.state === "released") return { kind: "none", resources };
    let snapshot;
    try {
      snapshot = workspaceService.status({ workspaceId: receipt.workspaceId });
    } catch (error) {
      return unverified(resources, "managed workspace status is unavailable", error?.code || "managed workspace status failed");
    }
    if (!sameManagedWorkspaceSnapshot(receipt, snapshot.receipt)
        || receipt.originRoot !== canonicalOrigin || receipt.owner.kind !== "goal-task"
        || receipt.owner.goalId !== goalId || receipt.owner.taskId !== taskId
        || receipt.owner.attempt !== attempt || !snapshot.inspection) {
      return unverified(resources, "managed workspace receipt facts changed during inspection");
    }
    return {
      kind: "verified",
      lease: { ...snapshot.receipt, attempt: snapshot.receipt.owner.attempt, branch: snapshot.receipt.branchRef },
      executorHead: snapshot.inspection.headCommit,
      resources,
    };
  };
}
