import { createHash, randomBytes } from "node:crypto";

import { createManagedWorkspaceRequest } from "./contract.ts";
import {
  ensureManagedGitWorkspace,
  inspectManagedGitWorkspace,
  integrateManagedGitWorkspace,
  managedWorkspaceAlreadyIntegrated,
  managedWorkspaceSnapshotHash,
  releaseManagedGitWorkspace,
  assertManagedWorkspaceWritePaths,
} from "./git-worktree.ts";
import {
  createManagedWorkspaceLedger,
  managedWorkspaceReceiptFromRecord,
} from "./ledger.ts";

class ManagedWorkspaceError extends Error {
  code: string;
  cause?: unknown;
  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

type TerminalProof = { state: "pending" } | { state: "observed"; conflict: boolean; proofHash: string };
type ServiceFault = (event: { operation: string; phase: string; workspaceId: string }) => void;
type ServiceOptions = { stateRoot?: string; terminalProofProvider?: (input: { workspaceId: string; run: unknown }) => unknown; fault?: ServiceFault };
export type WorkspaceOwnerScope = Readonly<{ kind: "standalone-subagent"; rootSessionId: string }>;
type StatusInput = { workspaceId?: string; terminalProof?: unknown; expectedHead?: string };
type DisposeInput = StatusInput & { disposition?: "integrate" | "discard" | "preserve"; strategy?: "cherry-pick" | "merge"; reason?: string; actionToken?: string };
type ReleaseInput = { workspaceId?: string };
type ReconcileInput = { originRoot?: string };

function failure(code: string, message: string, cause?: unknown): ManagedWorkspaceError {
  return new ManagedWorkspaceError(code, message, cause);
}

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function ownerScopeValue(value: unknown): WorkspaceOwnerScope {
  const input = value as { kind?: unknown; rootSessionId?: unknown };
  if (!exactKeys(value, ["kind", "rootSessionId"]) || input.kind !== "standalone-subagent"
      || typeof input.rootSessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(input.rootSessionId) || input.rootSessionId.includes("..")) {
    throw failure("MANAGED_WORKSPACE_OWNER_SCOPE", "workspace owner scope is invalid");
  }
  return Object.freeze({ kind: input.kind, rootSessionId: input.rootSessionId });
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function proofValue(value) {
  if (value === undefined || value === null || value.state === "pending") return { state: "pending" };
  if (!exactKeys(value, ["state", "conflict", "proofHash"]) || value.state !== "observed"
      || typeof value.conflict !== "boolean" || !/^[a-f0-9]{64}$/.test(value.proofHash)) {
    throw failure("MANAGED_WORKSPACE_TERMINAL", "terminal proof is invalid");
  }
  return { state: value.state, conflict: value.conflict, proofHash: value.proofHash };
}

function observed(proof) {
  return proof?.state === "observed" && proof.conflict === false;
}

function assertExpectedHead(inspection, expectedHead) {
  if (expectedHead === undefined) return;
  if (typeof expectedHead !== "string" || !/^[a-f0-9]{40}$/.test(expectedHead)) {
    throw failure("MANAGED_WORKSPACE_EXPECTED_HEAD", "expected workspace HEAD is invalid");
  }
  if (inspection?.headCommit !== expectedHead) {
    throw failure("MANAGED_WORKSPACE_EXPECTED_HEAD", "workspace HEAD does not match the required settled HEAD");
  }
}

function actionToken() {
  return `managed-workspace-action.v1:${randomBytes(32).toString("hex")}`;
}

function tokenHash(value) {
  if (typeof value !== "string" || !/^managed-workspace-action\.v1:[a-f0-9]{64}$/.test(value)) {
    throw failure("MANAGED_WORKSPACE_ACTION", "action token is invalid");
  }
  return createHash("sha256").update(value).digest("hex");
}

function dispositionValue(disposition, { strategy, reason }) {
  if (disposition === "integrate") {
    if (strategy !== "cherry-pick" && strategy !== "merge") throw failure("MANAGED_WORKSPACE_DISPOSITION", "integration strategy is invalid");
    return { action: disposition, strategy };
  }
  if (disposition === "discard") return { action: disposition };
  if (disposition === "preserve") {
    if (typeof reason !== "string" || !reason.trim()) throw failure("MANAGED_WORKSPACE_DISPOSITION", "preserve reason is required");
    return { action: disposition, reason: reason.trim() };
  }
  throw failure("MANAGED_WORKSPACE_DISPOSITION", "disposition is invalid");
}

function cleanupDebt(error, phase) {
  const rawCode = typeof error?.code === "string" ? error.code : "MANAGED_WORKSPACE_ERROR";
  const code = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(rawCode) ? rawCode : "MANAGED_WORKSPACE_ERROR";
  return {
    phase,
    code,
    message: error instanceof Error && error.message ? error.message : "managed workspace operation did not complete",
  };
}

export function createManagedWorkspaceService({ stateRoot = process.env.PI_CODING_WORKSPACE_DIR, terminalProofProvider, fault }: ServiceOptions = {}) {
  const ledger = createManagedWorkspaceLedger({ stateRoot });

  function receipt(record) {
    return managedWorkspaceReceiptFromRecord(record);
  }

  function load(workspaceId) {
    return ledger.load(workspaceId);
  }

  function loadOwned(workspaceId, ownerScope: unknown) {
    const scope = ownerScopeValue(ownerScope);
    const lease = load(workspaceId);
    const owner = lease.record.request.owner;
    if (owner.kind !== scope.kind || owner.rootSessionId !== scope.rootSessionId) {
      throw failure("MANAGED_WORKSPACE_OWNER_SCOPE", "workspace does not belong to the current standalone session");
    }
    return lease;
  }

  function mutate(lease, change) {
    return ledger.mutate(lease.workspaceId, change, { leaseId: lease.leaseId });
  }

  function reserve(input) {
    return receipt(ledger.reserve(createManagedWorkspaceRequest(input)).record);
  }

  function markDebt(lease, error, phase) {
    return mutate(lease, (record) => {
      record.state = "cleanup-debt";
      record.cleanupDebt = cleanupDebt(error, phase);
      return record;
    });
  }

  function ensureAllocated(input) {
    const request = createManagedWorkspaceRequest(input);
    let lease = ledger.reserve(request);
    if (lease.record.state === "active") return receipt(lease.record);
    if (lease.record.state === "released") throw failure("MANAGED_WORKSPACE_STATE", "released workspace cannot be allocated again");
    if (lease.record.state === "cleanup-debt") throw failure("MANAGED_WORKSPACE_CLEANUP_DEBT", "workspace allocation requires manual recovery");
    if (!new Set(["reserved", "allocating"]).has(lease.record.state)) throw failure("MANAGED_WORKSPACE_STATE", `workspace cannot allocate from ${lease.record.state}`);
    if (lease.record.state === "reserved") {
      lease = mutate(lease, (record) => { record.state = "allocating"; return record; });
    }
    try {
      ensureManagedGitWorkspace(lease.record);
      fault?.({ operation: "allocate", phase: "after-git", workspaceId: lease.workspaceId });
      lease = mutate(lease, (record) => { record.state = "active"; return record; });
      return receipt(lease.record);
    } catch (error) {
      if (error?.code === "TEST_FAULT") throw error;
      if (error?.code === "MANAGED_WORKSPACE_IDENTITY") {
        try { markDebt(lease, error, "allocation"); } catch {}
      }
      throw error;
    }
  }

  function bindRun({ workspaceId, run }) {
    if (!exactKeys(run, ["runId", "asyncDir"])) throw failure("MANAGED_WORKSPACE_RUN", "run binding is invalid");
    let lease = load(workspaceId);
    if (lease.record.state !== "active") throw failure("MANAGED_WORKSPACE_STATE", "run can bind only to an active workspace");
    if (lease.record.run) {
      if (!same(lease.record.run, run)) throw failure("MANAGED_WORKSPACE_RUN_CONFLICT", "workspace is already bound to another run");
      return receipt(lease.record);
    }
    lease = mutate(lease, (record) => { record.run = structuredClone(run); return record; });
    return receipt(lease.record);
  }

  function resolveProof(record, supplied) {
    let value = supplied;
    if (value === undefined && terminalProofProvider) {
      value = terminalProofProvider({ workspaceId: record.workspaceId, run: structuredClone(record.run) });
      if (value && typeof value.then === "function") throw failure("MANAGED_WORKSPACE_TERMINAL", "terminalProofProvider must be synchronous");
    }
    return proofValue(value);
  }

  function inspectStatus(record, suppliedProof) {
    const unbound = record.run === null;
    const terminalProof = unbound ? null : resolveProof(record, suppliedProof);
    const inspection = inspectManagedGitWorkspace(record);
    if (unbound) {
      const snapshotHash = managedWorkspaceSnapshotHash(inspection, terminalProof);
      return { receipt: receipt(record), inspection, terminalProof, allowedDispositions: ["discard", "preserve"], blockedReasons: [], snapshotHash };
    }
    const allowedDispositions = ["preserve"];
    const blockedReasons = [];
    if (!observed(terminalProof)) blockedReasons.push("terminal-unobserved");
    if (record.request.mode !== "coding") blockedReasons.push("non-coding-workspace");
    if (!inspection.clean) blockedReasons.push("workspace-dirty");
    if (!inspection.hasCommits) blockedReasons.push("no-commits");
    if (!inspection.descendant) blockedReasons.push("not-descendant");
    if (!inspection.originClean) blockedReasons.push(inspection.originError === "MANAGED_WORKSPACE_ORIGIN_DIRTY" ? "origin-dirty" : "origin-drift");
    try { assertManagedWorkspaceWritePaths(inspection.changedFiles, record.request.writePaths); }
    catch { blockedReasons.push("writePaths-out-of-scope"); }
    if (observed(terminalProof) && inspection.clean) {
      allowedDispositions.push("discard");
      if (blockedReasons.length === 0) allowedDispositions.push("integrate");
    }
    const snapshotHash = managedWorkspaceSnapshotHash(inspection, terminalProof);
    return { receipt: receipt(record), inspection, terminalProof, allowedDispositions, blockedReasons: [...new Set(blockedReasons)], snapshotHash };
  }

  function statusForLease(lease, { terminalProof, expectedHead }: Omit<StatusInput, "workspaceId"> = {}) {
    if (lease.record.state === "released" || lease.record.state === "cleanup-debt") {
      return { receipt: receipt(lease.record), inspection: null, terminalProof: null, allowedDispositions: [], blockedReasons: [], snapshotHash: null };
    }
    if (lease.record.state === "preserved") {
      return { receipt: receipt(lease.record), inspection: inspectManagedGitWorkspace(lease.record), terminalProof: null, allowedDispositions: [], blockedReasons: [], snapshotHash: null };
    }
    if (lease.record.state !== "active") throw failure("MANAGED_WORKSPACE_STATE", `workspace status is unavailable in ${lease.record.state}`);
    const snapshot = inspectStatus(lease.record, terminalProof);
    // Test/runtime barriers run after canonical Git inspection; no caller
    // inspector participates in this authority boundary.
    fault?.({ operation: "status", phase: "after-inspection", workspaceId: lease.workspaceId });
    // An expected settled HEAD asks for a bounded post-barrier reinspection.
    // This closes the status-to-intent TOCTOU without accepting caller facts.
    const confirmed = expectedHead === undefined ? snapshot : inspectStatus(lease.record, terminalProof);
    assertExpectedHead(confirmed.inspection, expectedHead);
    return confirmed;
  }

  function status({ workspaceId, terminalProof, expectedHead }: StatusInput = {}) {
    return statusForLease(load(workspaceId), { terminalProof, expectedHead });
  }

  function statusOwned({ workspaceId, ownerScope, terminalProof, expectedHead }: StatusInput & { ownerScope: WorkspaceOwnerScope }) {
    return statusForLease(loadOwned(workspaceId, ownerScope), { terminalProof, expectedHead });
  }

  function issueDispositionForLease(lease, { terminalProof, expectedHead }: Omit<StatusInput, "workspaceId"> = {}) {
    if (lease.record.state !== "active") throw failure("MANAGED_WORKSPACE_STATE", "disposition can be issued only for an active workspace");
    const snapshot = inspectStatus(lease.record, terminalProof);
    assertExpectedHead(snapshot.inspection, expectedHead);
    const token = actionToken();
    const challenge = {
      tokenHash: tokenHash(token),
      snapshotHash: snapshot.snapshotHash,
      allowed: snapshot.allowedDispositions,
      proofHash: observed(snapshot.terminalProof) ? snapshot.terminalProof.proofHash : null,
      used: false,
    };
    lease = mutate(lease, (record) => { record.actionChallenge = challenge; return record; });
    return { ...snapshot, receipt: receipt(lease.record), actionToken: token };
  }

  function issueDisposition({ workspaceId, terminalProof, expectedHead }: StatusInput = {}) {
    return issueDispositionForLease(load(workspaceId), { terminalProof, expectedHead });
  }

  function issueOwnedDisposition({ workspaceId, ownerScope, terminalProof, expectedHead }: StatusInput & { ownerScope: WorkspaceOwnerScope }) {
    return issueDispositionForLease(loadOwned(workspaceId, ownerScope), { terminalProof, expectedHead });
  }

  function recoverDisposition(lease) {
    const pending = lease.record.pendingAction;
    if (lease.record.state !== "disposing" || !pending) throw failure("MANAGED_WORKSPACE_STATE", "workspace has no disposition to recover");
    try {
      if (pending.disposition === "preserve") {
        return mutate(lease, (record) => { record.state = "preserved"; return record; });
      }
      if (pending.disposition === "integrate") {
        if (!managedWorkspaceAlreadyIntegrated(lease.record, { strategy: pending.strategy, executorHead: pending.executorHead })) {
          integrateManagedGitWorkspace(lease.record, { strategy: pending.strategy, executorHead: pending.executorHead });
        }
        fault?.({ operation: "dispose", phase: "after-integrate", workspaceId: lease.workspaceId });
      }
      releaseManagedGitWorkspace(lease.record, { expectedHead: pending.executorHead });
      fault?.({ operation: "dispose", phase: "after-git", workspaceId: lease.workspaceId });
      return mutate(lease, (record) => { record.state = "released"; return record; });
    } catch (error) {
      if (error?.code === "TEST_FAULT") throw error;
      try { markDebt(lease, error, "disposition"); } catch {}
      throw error;
    }
  }

  function disposeForLease(lease, { terminalProof, expectedHead, disposition, strategy = "cherry-pick", reason, actionToken: suppliedToken }: Omit<DisposeInput, "workspaceId"> = {}) {
    if (lease.record.state === "disposing") {
      if (tokenHash(suppliedToken) !== lease.record.actionChallenge?.tokenHash) throw failure("MANAGED_WORKSPACE_ACTION", "action token does not own pending disposition");
      return receipt(recoverDisposition(lease).record);
    }
    if (lease.record.state !== "active") throw failure("MANAGED_WORKSPACE_STATE", "workspace disposition token was replayed or state is closed");
    const snapshot = inspectStatus(lease.record, terminalProof);
    // This check happens in the service disposition authority immediately
    // before its durable intent; callers cannot substitute a stale snapshot.
    assertExpectedHead(snapshot.inspection, expectedHead);
    const challenge = lease.record.actionChallenge;
    if (!challenge || challenge.used || tokenHash(suppliedToken) !== challenge.tokenHash
        || challenge.snapshotHash !== snapshot.snapshotHash || challenge.proofHash !== (observed(snapshot.terminalProof) ? snapshot.terminalProof.proofHash : null)) {
      throw failure("MANAGED_WORKSPACE_ACTION", "action token is stale, replayed, or does not match the workspace snapshot");
    }
    if (!challenge.allowed.includes(disposition) || !snapshot.allowedDispositions.includes(disposition)) {
      throw failure("MANAGED_WORKSPACE_TERMINAL", "disposition is not allowed by the terminal and workspace snapshot");
    }
    const normalizedDisposition = dispositionValue(disposition, { strategy, reason });
    lease = mutate(lease, (record) => {
      record.actionChallenge.used = true;
      record.state = "disposing";
      record.disposition = normalizedDisposition;
      record.pendingAction = {
        disposition,
        strategy: disposition === "integrate" ? strategy : null,
        reason: disposition === "preserve" ? normalizedDisposition.reason : null,
        snapshotHash: snapshot.snapshotHash,
        proofHash: observed(snapshot.terminalProof) ? snapshot.terminalProof.proofHash : null,
        executorHead: snapshot.inspection.headCommit,
      };
      return record;
    });
    fault?.({ operation: "dispose", phase: "after-intent", workspaceId: lease.workspaceId });
    return receipt(recoverDisposition(lease).record);
  }

  function dispose({ workspaceId, terminalProof, expectedHead, disposition, strategy, reason, actionToken: suppliedToken }: DisposeInput = {}) {
    return disposeForLease(load(workspaceId), { terminalProof, expectedHead, disposition, strategy, reason, actionToken: suppliedToken });
  }

  function disposeOwned({ workspaceId, ownerScope, terminalProof, expectedHead, disposition, strategy, reason, actionToken: suppliedToken }: DisposeInput & { ownerScope: WorkspaceOwnerScope }) {
    return disposeForLease(loadOwned(workspaceId, ownerScope), { terminalProof, expectedHead, disposition, strategy, reason, actionToken: suppliedToken });
  }

  function releaseForLease(lease) {
    if (lease.record.state !== "preserved") throw failure("MANAGED_WORKSPACE_STATE", "only a preserved workspace can be released");
    try {
      const inspection = inspectManagedGitWorkspace(lease.record);
      releaseManagedGitWorkspace(lease.record, { expectedHead: inspection.headCommit });
      lease = mutate(lease, (record) => { record.state = "released"; return record; });
      return receipt(lease.record);
    } catch (error) {
      try { markDebt(lease, error, "release"); } catch {}
      throw error;
    }
  }

  function release({ workspaceId }: ReleaseInput = {}) {
    return releaseForLease(load(workspaceId));
  }

  function releaseOwned({ workspaceId, ownerScope }: ReleaseInput & { ownerScope: WorkspaceOwnerScope }) {
    return releaseForLease(loadOwned(workspaceId, ownerScope));
  }

  function listOwned({ ownerScope, runId }: { ownerScope: WorkspaceOwnerScope; runId?: string }) {
    const scope = ownerScopeValue(ownerScope);
    if (runId !== undefined && (typeof runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(runId) || runId.includes(".."))) {
      throw failure("MANAGED_WORKSPACE_OWNER_SCOPE", "workspace run identity is invalid");
    }
    return ledger.listScoped({ owner: scope })
      .filter((record) => runId === undefined || record.run?.runId === runId)
      .map(receipt);
  }

  function reconcile({ originRoot }: ReconcileInput = {}) {
    const results = [];
    for (const record of ledger.list({ originRoot })) {
      let current = ledger.load(record.workspaceId, { originRoot: record.request.originRoot });
      try {
        if (current.record.state === "reserved" || current.record.state === "allocating") {
          results.push(ensureAllocated(current.record.request));
        } else if (current.record.state === "disposing") {
          results.push(receipt(recoverDisposition(current).record));
        } else {
          if (current.record.state === "active" || current.record.state === "preserved") inspectManagedGitWorkspace(current.record);
          results.push(receipt(current.record));
        }
      } catch (error) {
        if (error?.code === "TEST_FAULT") throw error;
        current = ledger.load(record.workspaceId, { originRoot: record.request.originRoot });
        if (current.record.state !== "cleanup-debt") {
          try { current = markDebt(current, error, "reconcile"); } catch {}
        }
        results.push(receipt(current.record));
      }
    }
    return results.sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
  }

  return Object.freeze({ stateRoot: ledger.stateRoot, reserve, ensureAllocated, bindRun, listOwned, status, statusOwned, issueDisposition, issueOwnedDisposition, dispose, disposeOwned, release, releaseOwned, reconcile });
}
