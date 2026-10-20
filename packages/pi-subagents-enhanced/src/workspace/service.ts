import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

import { createManagedWorkspaceRequestV2 } from "./contract.ts";
import { DISPOSITION_PREPARE_VERSION, isPreparedWorkspaceDisposition, dispositionBindingMatches, type PreparedWorkspaceDispositionV1 } from "./disposition-contract.ts";
import {
  ensureManagedGitWorkspace,
  inspectManagedGitWorkspace,
  managedGitRebase,
  managedWorkspaceSnapshotHash,
  releaseManagedGitWorkspace,
  assertManagedWorkspaceWritePaths,
  publishWorkspaceSnapshot,
  applyPublishedArtifact,
  fastForwardManagedGitWorkspace,
  inspectManagedIntegrationAdmission,
  inspectManagedNoPayload,
} from "./git-worktree.ts";
import {
  allowedActionsFor,
  createManagedWorkspaceLedger,
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

type TerminalProof = { state: "pending" } | { state: "observed"; conflict: boolean; runId: string; rootSessionId: string; asyncDir: string; processInstance: string; proofId: string };
type ServiceFault = (event: { operation: string; phase: string; workspaceId: string }) => void;
type ServiceOptions = { stateRoot?: string; storageRepositoryId?: string; terminalProofProvider?: (input: { workspaceId: string; run: unknown }) => unknown; fault?: ServiceFault; admissionProbe?: () => void; diagnosticSink?: (entry: unknown) => void };
export type WorkspaceOwnerScope = Readonly<{ kind: "standalone-subagent"; rootSessionId: string }>;
type StatusInput = { workspaceId?: string; terminalProof?: unknown; expectedHead?: string };
type DisposeInput = StatusInput & { disposition?: "integrate" | "discard" | "preserve"; strategy?: "cherry-pick" | "merge"; reason?: string; actionToken?: string };
type ReleaseInput = { workspaceId?: string; terminalProof?: unknown; actionToken?: string };
type ReconcileInput = { originRoot?: string };

function failure(code: string, message: string, cause?: unknown): ManagedWorkspaceError {
  return new ManagedWorkspaceError(code, message, cause);
}

const STATE_NEXT_ACTION: Record<string, string> = {
  reserved: "稍后重试 status；若长期停留说明 allocation 未完成。",
  allocating: "稍后重试 status；若长期停留说明 allocation 未完成。",
  active: "先调用 status，再用 dispose。",
  disposing: "重放同一 dispose 调用以完成 pendingAction。",
  preserved: "调用 release 回收。",
  "cleanup-debt": "调用 release 重试回收；持续失败需人工处理。",
  released: "终态，无可调用动作。",
};

export function managedWorkspaceStateFailure(state: string, message: string) {
  const allowedActions = [...allowedActionsFor(state)];
  const nextAction = STATE_NEXT_ACTION[state] ?? "状态未知，请人工检查 ledger 记录。";
  const detail = Object.freeze({ state, allowedActions: Object.freeze(allowedActions), nextAction });
  return Object.assign(failure("MANAGED_WORKSPACE_STATE", `${message}; state=${state}; allowed actions: ${allowedActions.join(", ") || "(none)"}; next: ${nextAction}`), { detail });
}

function cleanupDebtStateFailure(state: string, message: string) {
  const allowedActions = [...allowedActionsFor(state)];
  const nextAction = STATE_NEXT_ACTION[state] ?? "状态未知，请人工检查 ledger 记录。";
  const detail = Object.freeze({ state, allowedActions: Object.freeze(allowedActions), nextAction });
  return Object.assign(failure("MANAGED_WORKSPACE_CLEANUP_DEBT", `${message}; state=${state}; allowed actions: ${allowedActions.join(", ") || "(none)"}; next: ${nextAction}`), { detail });
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
  if (value === undefined || value === null) return { state: "pending" };
  if (value.state === "pending") {
    if (!exactKeys(value, ["state"])) throw failure("MANAGED_WORKSPACE_TERMINAL", "pending terminal proof has unknown fields");
    return { state: "pending" };
  }
  if (!exactKeys(value, ["state", "conflict", "runId", "rootSessionId", "asyncDir", "processInstance", "proofId"]) || value.state !== "observed" || typeof value.conflict !== "boolean") {
    throw failure("MANAGED_WORKSPACE_TERMINAL", "terminal proof is invalid");
  }
  for (const key of ["runId", "rootSessionId", "asyncDir", "processInstance", "proofId"]) if (typeof value[key] !== "string" || !value[key].trim()) throw failure("MANAGED_WORKSPACE_TERMINAL", "terminal proof identity is invalid");
  if (!/^[a-f0-9]{64}$/.test(value.proofId)) throw failure("MANAGED_WORKSPACE_TERMINAL", "terminal proof id is invalid");
  return structuredClone(value);
}

function observed(proof) { return proof?.state === "observed" && proof.conflict === false; }
function v2Receipt(record) { return { schemaVersion: "managed-workspace.v2", workspaceId: record.workspaceId, leaseId: record.leaseId, owner: record.request.owner, originRoot: record.request.originRoot, requestedCwd: record.request.requestedCwd, originRef: record.request.originRef, baseCommit: record.request.baseCommit, path: record.path, dispatchCwd: record.dispatchCwd, branchRef: record.branchRef, state: record.state, run: record.run, cleanupDebt: record.cleanupDebt ?? null, policy: record.request.policy, publishedArtifact: record.publishedArtifact ?? null, application: record.application ?? null, terminalProof: record.terminalProof ?? null }; }

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

const SERVICE_REGISTRY_KEY = Symbol.for("pi.managed-workspace-service.by-state-root.v1");

function serviceRegistry(): Map<string, any> {
  const current = (process as any)[SERVICE_REGISTRY_KEY];
  if (current instanceof Map) return current;
  const created = new Map<string, any>();
  Object.defineProperty(process, SERVICE_REGISTRY_KEY, { value: created, enumerable: false, configurable: false, writable: false });
  return created;
}

function createManagedWorkspaceServiceInternal({ stateRoot = process.env.PI_CODING_WORKSPACE_DIR, storageRepositoryId, terminalProofProvider, fault, admissionProbe, diagnosticSink }: ServiceOptions = {}) {
  const ledger = createManagedWorkspaceLedger({ stateRoot, storageRepositoryId });
  const diagnose = (entry: unknown) => { try { diagnosticSink?.(entry); } catch (diagnosticError) { console.error("[managed-workspace-service] diagnostic sink failed", { entry, diagnosticError }); } };
  let activeTerminalProofProvider = terminalProofProvider;
  let activeFault = fault;
  let activeAdmissionProbe = admissionProbe;

  function receipt(record) { return v2Receipt(record); }

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

  function loadIntegrationBinding(binding: any) {
    const lease = loadOwned(binding?.workspaceId, binding?.ownerScope);
    if (lease.record.leaseId !== binding?.leaseId || lease.record.run?.runId !== binding?.runId) {
      throw failure("MANAGED_WORKSPACE_BINDING", "workspace lease and trusted run binding do not match");
    }
    if (lease.record.state !== "active") throw managedWorkspaceStateFailure(lease.record.state, "integration requires an active workspace");
    return lease;
  }

  function mutate(lease, change) {
    return ledger.mutate(lease.workspaceId, change, { leaseId: lease.leaseId });
  }

  function reserve(input) {
    const request = createManagedWorkspaceRequestV2(input);
    return receipt(ledger.reserve(request).record);
  }

  function markDebt(lease, error, phase) {
    return mutate(lease, (record) => {
      record.state = "cleanup-debt";
      record.cleanupDebt = cleanupDebt(error, phase);
      return record;
    });
  }

  function ensureAllocated(input) {
    const request = createManagedWorkspaceRequestV2(input);
    let lease = ledger.reserve(request);
    if (lease.record.state === "active") return receipt(lease.record);
    if (lease.record.state === "released") throw managedWorkspaceStateFailure(lease.record.state, "released workspace cannot be allocated again");
    if (lease.record.state === "cleanup-debt") throw cleanupDebtStateFailure(lease.record.state, "workspace allocation requires manual recovery");
    if (!new Set(["reserved", "allocating"]).has(lease.record.state)) throw managedWorkspaceStateFailure(lease.record.state, `workspace cannot allocate from ${lease.record.state}`);
    if (lease.record.state === "reserved") {
      lease = mutate(lease, (record) => { record.state = "allocating"; return record; });
    }
    try {
      ensureManagedGitWorkspace(lease.record);
      activeFault?.({ operation: "allocate", phase: "after-git", workspaceId: lease.workspaceId });
      lease = mutate(lease, (record) => { record.state = "active"; return record; });
      return receipt(lease.record);
    } catch (error) {
      if (error?.code === "TEST_FAULT") throw error;
      if (error?.code === "MANAGED_WORKSPACE_IDENTITY") {
        try { markDebt(lease, error, "allocation"); } catch (secondaryError) { diagnose({ version: 1, phase: "workspace-allocation-debt-write-failed", error, cause: error?.cause, secondaryError, secondaryCause: secondaryError?.cause, workspaceId: lease.workspaceId }); }
      }
      throw error;
    }
  }

  function bindRun({ workspaceId, run }) {
    if (!exactKeys(run, ["runId", "asyncDir"])) throw failure("MANAGED_WORKSPACE_RUN", "run binding is invalid");
    let lease = load(workspaceId);
    if (lease.record.state !== "active") throw managedWorkspaceStateFailure(lease.record.state, "run can bind only to an active workspace");
    if (lease.record.run) {
      if (!same(lease.record.run, run)) throw failure("MANAGED_WORKSPACE_RUN_CONFLICT", "workspace is already bound to another run");
      return receipt(lease.record);
    }
    lease = mutate(lease, (record) => { record.run = structuredClone(run); return record; });
    return receipt(lease.record);
  }

  // Root 授权的 recovery 重绑：upstream resume 产生新 runId，同一 workspace/lease
  // 从 source run 显式换绑到 resumed run。普通 bindRun 的不可变绑定不放宽；
  // 「已授权 active resume intent」由调用方注入 validator 校验，service 不持有
  // integration queue 句柄，保持分层。幂等重放返回同 receipt。
  function rebindRunForRecovery(input: any, options: { authorizeResumeIntent?: (input: any) => unknown } = {}) {
    const { workspaceId, ownerScope, leaseId, sourceRunId, resumedRun, resumeIntentId } = input ?? {};
    if (typeof options?.authorizeResumeIntent !== "function") throw failure("MANAGED_WORKSPACE_RUN", "recovery rebind requires a resume intent authorizer");
    if (!resumeIntentId || typeof resumeIntentId !== "string") throw failure("MANAGED_WORKSPACE_RUN", "recovery rebind requires a resume intent");
    if (!resumedRun || !exactKeys(resumedRun, ["runId", "asyncDir", "sessionId", "pid", "agentProfile"])
        || typeof resumedRun.runId !== "string" || !resumedRun.runId
        || typeof resumedRun.asyncDir !== "string" || !path.isAbsolute(resumedRun.asyncDir)
        || typeof resumedRun.sessionId !== "string" || !resumedRun.sessionId
        || !Number.isSafeInteger(resumedRun.pid) || resumedRun.pid < 1
        || typeof resumedRun.agentProfile !== "string" || !resumedRun.agentProfile
        || sourceRunId === resumedRun.runId) throw failure("MANAGED_WORKSPACE_RUN", "resumed run binding is invalid");
    let lease = loadOwned(workspaceId, ownerScope);
    if (lease.record.state !== "active") throw managedWorkspaceStateFailure(lease.record.state, "run can bind only to an active workspace");
    if (lease.record.leaseId !== leaseId) throw failure("MANAGED_WORKSPACE_BINDING", "workspace lease and recovery rebind do not match");
    options.authorizeResumeIntent(input);
    if (!lease.record.run) throw failure("MANAGED_WORKSPACE_RUN_CONFLICT", "workspace is not bound to the source run");
    if (same(lease.record.run, resumedRun)) return receipt(lease.record);
    if (lease.record.run.runId !== sourceRunId) throw failure("MANAGED_WORKSPACE_RUN_CONFLICT", "workspace is already bound to another run");
    lease = mutate(lease, (record) => { record.run = structuredClone(resumedRun); return record; });
    return receipt(lease.record);
  }

  function recordTerminalProof({ workspaceId, ownerScope, proof }: any = {}) {
    let lease = loadOwned(workspaceId, ownerScope);
    const accepted = resolveProof(lease.record, proof);
    if (lease.record.state === "cleanup-debt") {
      if (!observed(accepted)) throw failure("MANAGED_WORKSPACE_TERMINAL", "authoritative terminal proof is required to settle proof debt");
      lease = mutate(lease, (record) => { record.state = "active"; record.cleanupDebt = null; record.terminalProof = structuredClone(accepted); return record; });
    } else if (observed(accepted)) {
      lease = mutate(lease, (record) => { record.terminalProof = structuredClone(accepted); return record; });
    }
    return receipt(lease.record);
  }

  function noPayloadFacts(binding: any) {
    const lease = loadIntegrationBinding(binding);
    return inspectManagedNoPayload(lease.record);
  }

  function integrationAdmissionFacts(input: any, binding: any) {
    activeAdmissionProbe?.();
    const lease = loadIntegrationBinding(binding);
    if (lease.workspaceId !== input.workspaceId || lease.record.leaseId !== input.leaseId) throw failure("MANAGED_WORKSPACE_BINDING", "queue item does not match workspace binding");
    const facts = inspectManagedIntegrationAdmission(lease.record, input.targetRef);
    if (facts.inspection.headCommit !== input.authorizedWorkspaceHead || !facts.inspection.clean || !facts.inspection.descendant || !facts.inspection.hasCommits) {
      throw failure("MANAGED_WORKSPACE_INTEGRATE", "workspace admission requires the authorized clean committed HEAD");
    }
    assertManagedWorkspaceWritePaths(facts.inspection.changedFiles, lease.record.request.policy.writePaths);
    return { targetHead: facts.targetHead };
  }
  // claim 路径的 admission facts 入口：与 integrationAdmissionFacts 共用同一 inspection+probe，
  // 由 claimNext 的 ledger 锁串行化并发，避免 enqueue 阶段重复重 Git inspection（T3）。
  function admissionFactsForClaim(input: any, binding: any) {
    return integrationAdmissionFacts(input, binding);
  }

  function prepareIntegrationIntent(input: any, binding: any) {
    let lease = loadIntegrationBinding(binding);
    const intent = {
      integrationIntentId: input.integrationIntentId ?? randomUUID(), queueItemId: input.queueItemId, queueLeaseId: input.queueLeaseId,
      admissionGeneration: input.admissionGeneration, targetRef: input.targetRef, targetHead: input.targetHead, candidateHead: input.candidateHead,
      ownerScope: structuredClone(binding.ownerScope), workspaceLeaseId: binding.leaseId, createdAt: new Date().toISOString(),
    };
    const existing = lease.record.integrationIntent;
    if (existing) {
      const comparable = { ...existing, createdAt: intent.createdAt };
      if (!same(comparable, intent)) throw failure("MANAGED_WORKSPACE_INTEGRATE", "workspace already has a different integration intent");
      return structuredClone(existing);
    }
    const facts = inspectManagedIntegrationAdmission(lease.record, input.targetRef);
    if (facts.targetHead !== input.targetHead) throw failure("MANAGED_WORKSPACE_ORIGIN_DRIFT", "target HEAD advanced outside the admission CAS");
    if (facts.inspection.headCommit !== input.candidateHead || !facts.inspection.clean) throw failure("MANAGED_WORKSPACE_INTEGRATE", "candidate HEAD drifted or workspace is dirty");
    lease = mutate(lease, record => { record.integrationIntent = intent; return record; });
    activeFault?.({ operation: "integration", phase: "after-intent", workspaceId: lease.workspaceId });
    return structuredClone(lease.record.integrationIntent);
  }

  function completeIntegrationIntent(input: any, binding: any) {
    let lease = loadIntegrationBinding(binding);
    const intent = lease.record.integrationIntent;
    if (!intent || intent.integrationIntentId !== input.integrationIntentId || intent.queueItemId !== input.queueItemId
        || intent.queueLeaseId !== input.queueLeaseId || intent.candidateHead !== input.candidateHead) {
      throw failure("MANAGED_WORKSPACE_INTEGRATE", "integration intent identity does not match");
    }
    if (lease.record.integrationReceipt) {
      if (lease.record.integrationReceipt.integrationIntentId !== intent.integrationIntentId || lease.record.integrationReceipt.candidateHead !== intent.candidateHead) {
        throw failure("MANAGED_WORKSPACE_INTEGRATE", "integration receipt identity does not match intent");
      }
      return structuredClone(lease.record.integrationReceipt);
    }
    fastForwardManagedGitWorkspace({ record: lease.record, targetRef: intent.targetRef, targetHead: intent.targetHead, candidateHead: intent.candidateHead,
      fault: phase => activeFault?.({ operation: "integration", phase, workspaceId: lease.workspaceId }) });
    const integrationReceipt = { receiptId: randomUUID(), integrationIntentId: intent.integrationIntentId, queueItemId: intent.queueItemId,
      candidateHead: intent.candidateHead, targetRef: intent.targetRef, completedAt: new Date().toISOString() };
    lease = mutate(lease, record => { record.integrationReceipt = integrationReceipt; return record; });
    activeFault?.({ operation: "integration", phase: "after-receipt", workspaceId: lease.workspaceId });
    return structuredClone(lease.record.integrationReceipt);
  }

  function managedRebase(input: any, binding: any) {
    const lease = loadIntegrationBinding(binding);
    return managedGitRebase(lease.record, input.targetHead, {
      continue: input.continue === true,
      admission: { admissionGeneration: input.admissionGeneration, queueLeaseId: input.queueLeaseId,
        validate: () => { const current = loadIntegrationBinding(binding); return { admissionGeneration: input.admissionGeneration, queueLeaseId: input.queueLeaseId, head: current.record.run?.runId }; } },
    });
  }

  function integrationState(input: any, binding: any) {
    const lease = loadIntegrationBinding(binding);
    return { intent: structuredClone(lease.record.integrationIntent), integrationReceipt: structuredClone(lease.record.integrationReceipt) };
  }

  function inspectIntegrationCompletion(binding: any) {
    const lease = loadOwned(binding?.workspaceId, binding?.ownerScope);
    if (lease.record.leaseId !== binding?.leaseId || lease.record.run?.runId !== binding?.runId) {
      throw failure("MANAGED_WORKSPACE_BINDING", "workspace lease and trusted run binding do not match");
    }
    return {
      workspaceState: lease.record.state,
      integrationReceipt: structuredClone(lease.record.integrationReceipt ?? null),
      proofState: lease.record.state === "released" ? "accepted" : lease.record.state === "preserved" || lease.record.cleanupDebt ? "debt" : "absent",
    };
  }

  function preserveIntegrationDebt(binding: any) {
    let lease = loadOwned(binding?.workspaceId, binding?.ownerScope);
    if (lease.record.leaseId !== binding?.leaseId || lease.record.run?.runId !== binding?.runId) {
      throw failure("MANAGED_WORKSPACE_BINDING", "workspace lease and trusted run binding do not match");
    }
    if (lease.record.state === "preserved") return receipt(lease.record);
    if (lease.record.state !== "active") throw managedWorkspaceStateFailure(lease.record.state, "integration debt can preserve only an active workspace");
    lease = mutate(lease, record => {
      record.state = "preserved";
      record.disposition = { action: "preserve", reason: "managed child settled without a terminal integration receipt" };
      record.cleanupDebt = null;
      return record;
    });
    return receipt(lease.record);
  }

  function abandonIntegrationIntent(input: any, binding: any) {
    let lease = loadIntegrationBinding(binding);
    const intent = lease.record.integrationIntent;
    if (!intent) return null;
    if (lease.record.integrationReceipt || intent.queueItemId !== input.queueItemId || intent.queueLeaseId !== input.queueLeaseId) {
      throw failure("MANAGED_WORKSPACE_INTEGRATE", "integration intent cannot be abandoned by this queue lease");
    }
    lease = mutate(lease, record => {
      record.integrationHistory.push({ intent: record.integrationIntent, disposition: "preserved", closedAt: new Date().toISOString() });
      record.integrationIntent = null;
      return record;
    });
    return structuredClone(lease.record.integrationHistory.at(-1));
  }

  function resolveProof(record, supplied) {
    let value = supplied;
    if (value === undefined && record.terminalProof?.state === "observed") value = record.terminalProof;
    if (value === undefined && activeTerminalProofProvider) {
      value = activeTerminalProofProvider({ workspaceId: record.workspaceId, run: structuredClone(record.run) });
      if (value && typeof value.then === "function") throw failure("MANAGED_WORKSPACE_TERMINAL", "terminalProofProvider must be synchronous");
    }
    const result = proofValue(value);
    if (result.state === "observed") {
      const owner = record.request.owner;
      if (result.runId !== record.run?.runId || result.asyncDir !== record.run?.asyncDir || result.rootSessionId !== owner.rootSessionId) throw failure("MANAGED_WORKSPACE_TERMINAL", "terminal proof identity does not match workspace run");
    }
    return result;
  }

  function statusForLease(lease, { terminalProof, expectedHead }: Omit<StatusInput, "workspaceId"> = {}) {
    if (lease.record.state !== "active") throw managedWorkspaceStateFailure(lease.record.state, `workspace status is unavailable in ${lease.record.state}`);
    const proof = resolveProof(lease.record, terminalProof);
    const inspection = inspectManagedGitWorkspace(lease.record);
    const blockedReasons = [];
    if (!observed(proof)) blockedReasons.push("terminal-unobserved");
    if (!inspection.originClean) blockedReasons.push("origin-dirty");
    if (inspection.clean === false) blockedReasons.push("workspace-dirty");
    const allowedActions = [];
    const policy = lease.record.request.policy;
    if (observed(proof) && policy.publication === "allowed") allowedActions.push("publish");
    if (observed(proof) && policy.application === "allowed" && lease.record.publishedArtifact) allowedActions.push("apply");
    if (observed(proof)) { allowedActions.push("discard"); if (!inspection.clean) blockedReasons.push("workspace-dirty"); }
    allowedActions.push("preserve", "release");
    const snapshotHash = managedWorkspaceSnapshotHash(inspection, proof);
    assertExpectedHead(inspection, expectedHead);
    return { receipt: receipt(lease.record), inspection, terminalProof: proof, allowedActions, allowedDispositions: allowedActions, blockedReasons: [...new Set(blockedReasons)], snapshotHash };
  }

  function issueActionForLease(lease, { action, terminalProof, expectedHead, snapshotHash }: any = {}) {
    if (!["publish", "apply", "discard", "preserve", "release"].includes(action)) throw failure("MANAGED_WORKSPACE_ACTION", "unsupported workspace action");
    const status = statusForLease(lease, { terminalProof, expectedHead });
    if (snapshotHash !== undefined && snapshotHash !== status.snapshotHash) throw failure("MANAGED_WORKSPACE_ACTION", "snapshot is stale");
    if (!status.allowedActions.includes(action) && !(action === "release" && lease.record.publishedArtifact)) throw failure("MANAGED_WORKSPACE_ACTION", "action is not allowed");
    const token = actionToken();
    const next = mutate(lease, record => { record.v2Action = { tokenHash: tokenHash(token), action, snapshotHash: status.snapshotHash, proofId: status.terminalProof.proofId, used: false }; return record; });
    return { ...status, receipt: receipt(next.record), actionToken: token };
  }

  function issueAction({ workspaceId, ownerScope, action, terminalProof, expectedHead, snapshotHash }: any = {}) { return issueActionForLease(loadOwned(workspaceId, ownerScope), { action, terminalProof, expectedHead, snapshotHash }); }

  function consumeV2Action(lease, token, action, terminalProof) {
    const challenge = lease.record.v2Action;
    if (!challenge || challenge.used || challenge.action !== action || tokenHash(token) !== challenge.tokenHash) throw failure("MANAGED_WORKSPACE_ACTION", "action token is stale or replayed");
    const proof = resolveProof(lease.record, terminalProof);
    if (!observed(proof) || proof.proofId !== challenge.proofId) throw failure("MANAGED_WORKSPACE_TERMINAL", "terminal proof is not the issued proof");
    return mutate(lease, record => { record.v2Action.used = true; return record; });
  }

  function publishForLease(lease, { terminalProof, actionToken: suppliedToken }: any = {}) {
    if (lease.record.request.policy.publication !== "allowed") throw failure("MANAGED_WORKSPACE_POLICY", "publish requires an allowed publication policy");
    lease = consumeV2Action(lease, suppliedToken, "publish", terminalProof);
    const artifact = publishWorkspaceSnapshot({ record: lease.record, policy: lease.record.request.policy, proofId: terminalProof.proofId });
    lease = mutate(lease, record => { record.v2Action.effectComplete = true; record.v2Action.effect = artifact; return record; });
    activeFault?.({ operation: "publish", phase: "after-effect", workspaceId: lease.workspaceId });
    const next = mutate(lease, record => { record.publishedArtifact = artifact; record.v2Action = null; return record; });
    return { ...artifact, receipt: receipt(next.record) };
  }
  function publishOwned(input: any = {}) { return publishForLease(loadOwned(input.workspaceId, input.ownerScope), input); }

  function applyForLease(lease, { terminalProof, actionToken: suppliedToken }: any = {}) {
    if (!lease.record.publishedArtifact) throw failure("MANAGED_WORKSPACE_POLICY", "apply requires a published artifact");
    lease = consumeV2Action(lease, suppliedToken, "apply", terminalProof);
    let result;
    try { result = applyPublishedArtifact({ record: lease.record, artifact: lease.record.publishedArtifact }); }
    catch (error) {
      if (error?.code === "MANAGED_WORKSPACE_ORIGIN_DIRTY") return { applied: false, blocked: "origin-dirty", receipt: receipt(lease.record) };
      throw error;
    }
    const next = mutate(lease, record => { record.application = result; record.v2Action = null; return record; });
    return { ...result, applied: true, receipt: receipt(next.record) };
  }
  function applyOwned(input: any = {}) { return applyForLease(loadOwned(input.workspaceId, input.ownerScope), input); }

  function discardForLease(lease, { terminalProof, actionToken: suppliedToken }: any = {}) {
    lease = consumeV2Action(lease, suppliedToken, "discard", terminalProof);
    try {
      const inspection = inspectManagedGitWorkspace(lease.record);
      releaseManagedGitWorkspace(lease.record, { expectedHead: inspection.headCommit });
      return receipt(mutate(lease, record => {
        record.state = "released";
        record.disposition = { action: "discard" };
        record.v2Action = null;
        // released 的证明链随 ledger 持久化：durable audit 的 proof 证据不得依赖
        // 已删除的 worktree 或动态 provider（R12g）。
        record.terminalProof = proofValue(terminalProof);
        return record;
      }).record);
    } catch (error) {
      if (error?.code === "TEST_FAULT") throw error;
      try { markDebt(lease, error, "discard"); } catch (secondaryError) { diagnose({ version: 1, phase: "workspace-discard-debt-write-failed", error, cause: error?.cause, secondaryError, secondaryCause: secondaryError?.cause, workspaceId: lease.workspaceId }); }
      throw error;
    }
  }

  function discardOwned(input: any = {}) { return discardForLease(loadOwned(input.workspaceId, input.ownerScope), input); }

  function status({ workspaceId, terminalProof, expectedHead }: StatusInput = {}) {
    return statusForLease(load(workspaceId), { terminalProof, expectedHead });
  }

  function statusOwned({ workspaceId, ownerScope, terminalProof, expectedHead }: StatusInput & { ownerScope: WorkspaceOwnerScope }) {
    return statusForLease(loadOwned(workspaceId, ownerScope), { terminalProof, expectedHead });
  }

  function issueDispositionForLease(lease, { terminalProof, expectedHead }: Omit<StatusInput, "workspaceId"> = {}) {
    if (lease.record.state !== "active") throw managedWorkspaceStateFailure(lease.record.state, "disposition can be issued only for an active workspace");
    const snapshot = statusForLease(lease, { terminalProof, expectedHead });
    assertExpectedHead(snapshot.inspection, expectedHead);
    const token = actionToken();
    const challenge = {
      tokenHash: tokenHash(token),
      snapshotHash: snapshot.snapshotHash,
      allowed: snapshot.allowedDispositions,
      proofHash: observed(snapshot.terminalProof) ? snapshot.terminalProof.proofId : null,
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

  function recoverDisposition(lease, settledProof = undefined) {
    const pending = lease.record.pendingAction;
    if (isPreparedWorkspaceDisposition(pending)) throw failure("MANAGED_WORKSPACE_RECOVERY", "coordinator must settle the prepared workspace disposition");
    if (lease.record.state !== "disposing" || !pending) throw managedWorkspaceStateFailure(lease.record.state, "workspace has no disposition to recover");
    try {
      if (pending.disposition === "preserve") {
        return mutate(lease, (record) => { record.state = "preserved"; return record; });
      }
      releaseManagedGitWorkspace(lease.record, { expectedHead: pending.executorHead });
      activeFault?.({ operation: "dispose", phase: "after-git", workspaceId: lease.workspaceId });
      return mutate(lease, (record) => {
        record.state = "released";
        // released 的证明链随 ledger 持久化：durable audit 的 proof 证据不得依赖
        // 已删除的 worktree 或动态 provider（R12g）。
        if (settledProof !== undefined) record.terminalProof = settledProof;
        return record;
      });
    } catch (error) {
      if (error?.code === "TEST_FAULT") throw error;
      try { markDebt(lease, error, "disposition"); } catch (secondaryError) { diagnose({ version: 1, phase: "workspace-disposition-debt-write-failed", error, cause: error?.cause, secondaryError, secondaryCause: secondaryError?.cause, workspaceId: lease.workspaceId }); }
      throw error;
    }
  }

  function disposeForLease(lease, { terminalProof, expectedHead, disposition, strategy = "cherry-pick", reason, actionToken: suppliedToken }: Omit<DisposeInput, "workspaceId"> = {}) {
    if (disposition === "integrate" && lease.record.request.policy.publication === "allowed") {
      throw failure("CHILD_OWNS_INTEGRATION", "integration is owned by the child integration queue");
    }
    if (lease.record.state === "disposing") {
      if (tokenHash(suppliedToken) !== lease.record.actionChallenge?.tokenHash) throw failure("MANAGED_WORKSPACE_ACTION", "action token does not own pending disposition");
      return receipt(recoverDisposition(lease).record);
    }
    if (lease.record.state !== "active") throw managedWorkspaceStateFailure(lease.record.state, "workspace disposition token was replayed or state is closed");
    const snapshot = statusForLease(lease, { terminalProof, expectedHead });
    // This check happens in the service disposition authority immediately
    // before its durable intent; callers cannot substitute a stale snapshot.
    assertExpectedHead(snapshot.inspection, expectedHead);
    const challenge = lease.record.actionChallenge;
    if (!challenge || challenge.used || tokenHash(suppliedToken) !== challenge.tokenHash
        || challenge.snapshotHash !== snapshot.snapshotHash || challenge.proofHash !== (observed(snapshot.terminalProof) ? snapshot.terminalProof.proofId : null)) {
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
      if (observed(snapshot.terminalProof)) record.terminalProof = structuredClone(snapshot.terminalProof);
      record.pendingAction = {
        disposition,
        strategy: disposition === "integrate" ? strategy : null,
        reason: disposition === "preserve" ? normalizedDisposition.reason : null,
        snapshotHash: snapshot.snapshotHash,
        proofHash: observed(snapshot.terminalProof) ? snapshot.terminalProof.proofId : null,
        executorHead: snapshot.inspection.headCommit,
      };
      return record;
    });
    activeFault?.({ operation: "dispose", phase: "after-intent", workspaceId: lease.workspaceId });
    return receipt(recoverDisposition(lease, proofValue(terminalProof)).record);
  }

  function dispose({ workspaceId, terminalProof, expectedHead, disposition, strategy, reason, actionToken: suppliedToken }: DisposeInput = {}) {
    return disposeForLease(load(workspaceId), { terminalProof, expectedHead, disposition, strategy, reason, actionToken: suppliedToken });
  }

  function disposeOwned({ workspaceId, ownerScope, terminalProof, expectedHead, disposition, strategy, reason, actionToken: suppliedToken }: DisposeInput & { ownerScope: WorkspaceOwnerScope }) {
    return disposeForLease(loadOwned(workspaceId, ownerScope), { terminalProof, expectedHead, disposition, strategy, reason, actionToken: suppliedToken });
  }

  function issueReleaseForLease(lease, { terminalProof }: { terminalProof?: unknown } = {}) {
    if (lease.record.state !== "preserved" && lease.record.state !== "cleanup-debt") throw managedWorkspaceStateFailure(lease.record.state, "release authorization requires a preserved workspace");
    const proof = lease.record.run ? resolveProof(lease.record, terminalProof) : proofValue(terminalProof);
    if (lease.record.run && !observed(proof)) throw failure("MANAGED_WORKSPACE_TERMINAL", "release requires an observed terminal proof");
    const token = actionToken();
    const next = mutate(lease, record => { record.actionChallenge = { tokenHash: tokenHash(token), snapshotHash: null, allowed: ["release"], proofHash: observed(proof) ? proof.proofId : null, used: false }; return record; });
    return { receipt: receipt(next.record), actionToken: token, terminalProof: proof };
  }

  function issueRelease({ workspaceId, ownerScope, terminalProof }: any = {}) { return issueReleaseForLease(ownerScope ? loadOwned(workspaceId, ownerScope) : load(workspaceId), { terminalProof }); }

  function releaseForLease(lease, { terminalProof, actionToken: suppliedToken }: ReleaseInput = {}) {
    if (lease.record.state !== "preserved" && lease.record.state !== "cleanup-debt") {
      throw managedWorkspaceStateFailure(lease.record.state, "only a preserved or cleanup-debt workspace can be released");
    }
    const proof = lease.record.run ? resolveProof(lease.record, terminalProof) : proofValue(terminalProof);
    if (lease.record.run && !observed(proof)) throw failure("MANAGED_WORKSPACE_TERMINAL", "release requires an observed terminal proof");
    // 无显式 token 的公开回收也必须经过同一证明校验和内部一次性授权。
    if (suppliedToken === undefined) {
      const authorization = issueReleaseForLease(lease, { terminalProof: proof });
      suppliedToken = authorization.actionToken;
      lease = load(lease.workspaceId);
    }
    const challenge = lease.record.actionChallenge;
    if (!challenge || challenge.used || !challenge.allowed?.includes("release") || tokenHash(suppliedToken) !== challenge.tokenHash
        || challenge.proofHash !== (observed(proof) ? proof.proofId : null)) {
      throw failure("MANAGED_WORKSPACE_ACTION", "release action token or terminal proof is stale, replayed, or invalid");
    }
    try {
      const inspection = inspectManagedGitWorkspace(lease.record);
      releaseManagedGitWorkspace(lease.record, { expectedHead: inspection.headCommit });
      lease = mutate(lease, (record) => {
        if (record.actionChallenge) record.actionChallenge.used = true;
        if (observed(proof)) record.terminalProof = structuredClone(proof);
        record.state = "released";
        record.cleanupDebt = null;
        record.disposition ??= { action: "discard" };
        return record;
      });
      return receipt(lease.record);
    } catch (error) {
      try { markDebt(lease, error, "release"); } catch (secondaryError) { diagnose({ version: 1, phase: "workspace-release-debt-write-failed", error, cause: error?.cause, secondaryError, secondaryCause: secondaryError?.cause, workspaceId: lease.workspaceId }); }
      throw error;
    }
  }

  function release({ workspaceId, terminalProof, actionToken: suppliedToken }: ReleaseInput = {}) {
    return releaseForLease(load(workspaceId), { terminalProof, actionToken: suppliedToken });
  }

  function releaseOwned({ workspaceId, ownerScope, terminalProof, actionToken: suppliedToken }: ReleaseInput & { ownerScope: WorkspaceOwnerScope }) {
    return releaseForLease(loadOwned(workspaceId, ownerScope), { terminalProof, actionToken: suppliedToken });
  }

  /** 授权消费和准备记录在 workspace ledger 同一次 CAS 中完成。 */
  function prepareOwnedDisposition(input: any, context: { settlementId: string; queueItem?: any }) {
    let lease = loadOwned(input.workspaceId, input.ownerScope);
    if (storageRepositoryId !== undefined) ledger.load(lease.workspaceId, { originRoot: lease.record.request.originRoot });
    const operation = input.operation ?? input.disposition;
    if (!["preserve", "discard", "release"].includes(operation)) throw failure("MANAGED_WORKSPACE_DISPOSITION", "coordinator disposition operation is invalid");
    if (isPreparedWorkspaceDisposition(lease.record.pendingAction) && lease.record.pendingAction.phase !== "settled") {
      throw failure("MANAGED_WORKSPACE_RECOVERY", "workspace disposition must finish recovery before accepting another action");
    }
    let proof: any;
    let snapshotHash: string | null;
    let suppliedToken = input.actionToken;
    let inspection: any;
    const legacy = lease.record.state === "disposing" && lease.record.pendingAction
      && !isPreparedWorkspaceDisposition(lease.record.pendingAction) ? lease.record.pendingAction : null;
    if (legacy) {
      // 旧合法 writer 已消费的同一授权可升级；缺原 token 或完整匹配 proof 时保留现场。
      proof = resolveProof(lease.record, input.terminalProof);
      if (legacy.disposition !== operation || legacy.executorHead === null || legacy.proofHash !== (observed(proof) ? proof.proofId : null)
          || (operation !== "preserve" && !observed(proof)) || (operation === "preserve" && legacy.reason !== input.reason)) {
        throw failure("MANAGED_WORKSPACE_RECOVERY", "legacy disposition lacks its original action and matching proof");
      }
      inspection = { headCommit: legacy.executorHead };
      snapshotHash = legacy.snapshotHash;
    } else if (operation === "release") {
      if (!["preserved", "cleanup-debt"].includes(lease.record.state)) throw managedWorkspaceStateFailure(lease.record.state, "release requires preserved or cleanup-debt state");
      proof = lease.record.run ? resolveProof(lease.record, input.terminalProof) : proofValue(input.terminalProof);
      if (lease.record.run && !observed(proof)) throw failure("MANAGED_WORKSPACE_TERMINAL", "release requires an observed terminal proof");
      if (suppliedToken === undefined) {
        suppliedToken = issueReleaseForLease(lease, { terminalProof: proof }).actionToken;
        lease = loadOwned(input.workspaceId, input.ownerScope);
      }
      inspection = inspectManagedGitWorkspace(lease.record);
      snapshotHash = null;
    } else {
      const snapshot = statusForLease(lease, input);
      proof = snapshot.terminalProof;
      inspection = snapshot.inspection;
      snapshotHash = snapshot.snapshotHash;
      if (!snapshot.allowedDispositions.includes(operation)) throw failure("MANAGED_WORKSPACE_TERMINAL", "disposition is not allowed by the current terminal proof");
      assertExpectedHead(inspection, input.expectedHead);
    }
    const challenge = lease.record.actionChallenge;
    if (!challenge || challenge.used !== Boolean(legacy) || !challenge.allowed.includes(operation)
        || challenge.tokenHash !== tokenHash(suppliedToken) || challenge.snapshotHash !== snapshotHash
        || challenge.proofHash !== (observed(proof) ? proof.proofId : null)) {
      throw failure("MANAGED_WORKSPACE_ACTION", "workspace disposition authorization is stale or invalid");
    }
    const q = context.queueItem;
    const binding = {
      workspaceId: lease.workspaceId, leaseId: lease.leaseId, rootSessionId: lease.record.request.owner.rootSessionId,
      runId: lease.record.run?.runId ?? null, asyncDir: lease.record.run?.asyncDir ?? null,
      queueItemId: q?.queueItemId ?? null, queueLeaseId: q?.queueLeaseId ?? null,
      queueRevision: q?.revision ?? null, admissionGeneration: q?.admissionGeneration ?? null,
    };
    if (q && (q.workspaceId !== binding.workspaceId || q.leaseId !== binding.leaseId || q.childRunId !== binding.runId
        || q.ownerScope?.kind !== "standalone-subagent" || q.ownerScope?.rootSessionId !== binding.rootSessionId)) {
      throw failure("MANAGED_WORKSPACE_BINDING", "queue item does not match workspace disposition binding");
    }
    const prepared: PreparedWorkspaceDispositionV1 = {
      schemaVersion: DISPOSITION_PREPARE_VERSION, settlementId: context.settlementId, operation,
      reason: operation === "preserve" ? input.reason : null, binding, authorizedRevision: lease.revision,
      snapshotHash, proofHash: observed(proof) ? proof.proofId : null, executorHead: inspection.headCommit,
      phase: "prepared", workspaceReceiptRef: null, queueReceiptRef: null,
    };
    if (!isPreparedWorkspaceDisposition(prepared)) throw failure("MANAGED_WORKSPACE_SCHEMA", "workspace disposition prepare is invalid");
    lease = mutate(lease, record => {
      if (record.revision !== prepared.authorizedRevision || record.actionChallenge?.used !== Boolean(legacy)
          || record.actionChallenge?.tokenHash !== challenge.tokenHash) throw failure("MANAGED_WORKSPACE_CAS", "workspace changed before disposition prepare");
      record.actionChallenge.used = true;
      if (observed(proof)) record.terminalProof = structuredClone(proof);
      record.state = "disposing";
      record.pendingAction = structuredClone(prepared);
      record.disposition = operation === "preserve" ? { action: "preserve", reason: prepared.reason } : { action: "discard" };
      return record;
    });
    activeFault?.({ operation: "settlement", phase: "after-workspace-prepare", workspaceId: lease.workspaceId });
    return structuredClone(lease.record.pendingAction) as PreparedWorkspaceDispositionV1;
  }

  function preparedLease(input: any) {
    const lease = loadOwned(input.workspaceId, input.ownerScope);
    if (storageRepositoryId !== undefined) ledger.load(lease.workspaceId, { originRoot: lease.record.request.originRoot });
    const prepared = lease.record.pendingAction;
    if (!isPreparedWorkspaceDisposition(prepared) || prepared.settlementId !== input.settlementId || !dispositionBindingMatches(lease.record, prepared)) {
      throw failure("MANAGED_WORKSPACE_BINDING", "prepared workspace disposition identity changed");
    }
    return { lease, prepared };
  }

  function applyPreparedDisposition(input: any) {
    const { lease, prepared } = preparedLease(input);
    if (prepared.phase !== "prepared") return receipt(lease.record);
    if (prepared.operation !== "preserve") releaseManagedGitWorkspace(lease.record, { expectedHead: prepared.executorHead });
    else assertExpectedHead(inspectManagedGitWorkspace(lease.record), prepared.executorHead);
    activeFault?.({ operation: "settlement", phase: "after-workspace-git-before-commit", workspaceId: lease.workspaceId });
    const next = mutate(lease, record => {
      if (!same(record.pendingAction, prepared)) throw failure("MANAGED_WORKSPACE_CAS", "prepared workspace changed before effect commit");
      record.state = prepared.operation === "preserve" ? "preserved" : "released";
      record.cleanupDebt = null;
      record.pendingAction.phase = "effect-committed";
      record.pendingAction.workspaceReceiptRef = `wsr-${prepared.settlementId}`;
      return record;
    });
    activeFault?.({ operation: "settlement", phase: "after-workspace-effect", workspaceId: lease.workspaceId });
    return receipt(next.record);
  }

  function readPreparedDisposition(input: any): PreparedWorkspaceDispositionV1 {
    return structuredClone(preparedLease(input).prepared);
  }

  function listPreparedDispositions(): readonly PreparedWorkspaceDispositionV1[] {
    return ledger.list({ storagePartitionOnly: storageRepositoryId !== undefined }).filter(record => isPreparedWorkspaceDisposition(record.pendingAction)
      && record.pendingAction.phase !== "settled").map(record => structuredClone(record.pendingAction));
  }

  function markDispositionSettled(input: any) {
    const { lease, prepared } = preparedLease(input);
    if (prepared.phase === "settled") {
      if (prepared.queueReceiptRef !== input.queueReceiptRef) throw failure("MANAGED_WORKSPACE_BINDING", "settlement receipt identity changed");
      return receipt(lease.record);
    }
    if (prepared.phase !== "effect-committed" || input.queueReceiptRef !== `qsr-${prepared.settlementId}`) throw failure("MANAGED_WORKSPACE_RECOVERY", "workspace effect or queue receipt is incomplete");
    return receipt(mutate(lease, record => {
      if (!same(record.pendingAction, prepared)) throw failure("MANAGED_WORKSPACE_CAS", "workspace changed before settlement receipt");
      record.pendingAction.phase = "settled";
      record.pendingAction.queueReceiptRef = input.queueReceiptRef;
      return record;
    }).record);
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
        if (current.record.v2Action?.effectComplete && current.record.v2Action.effect) {
          current = mutate(current, record => { record.publishedArtifact = record.v2Action.effect; record.v2Action = null; return record; });
          results.push(receipt(current.record));
        } else if (current.record.state === "reserved" || current.record.state === "allocating") {
          results.push(ensureAllocated(current.record.request));
        } else if (current.record.state === "disposing") {
          results.push(receipt(recoverDisposition(current).record));
        } else {
          if (current.record.state === "active" || current.record.state === "preserved") inspectManagedGitWorkspace(current.record);
          if (current.record.state === "active" && current.record.run && existsSync(current.record.run.asyncDir)
              && !existsSync(`${current.record.run.asyncDir}/process-terminal.json`)) {
            current = markDebt(current, Object.assign(new Error("terminal proof was not produced before Root termination"), { code: "MANAGED_WORKSPACE_TERMINAL" }), "terminal-proof");
          }
          results.push(receipt(current.record));
        }
      } catch (error) {
        if (error?.code === "TEST_FAULT") throw error;
        current = ledger.load(record.workspaceId, { originRoot: record.request.originRoot });
        if (current.record.state !== "cleanup-debt") {
          try { current = markDebt(current, error, "reconcile"); } catch (secondaryError) { diagnose({ version: 1, phase: "workspace-reconcile-debt-write-failed", error, cause: error?.cause, secondaryError, secondaryCause: secondaryError?.cause, workspaceId: current.workspaceId }); }
        }
        results.push(receipt(current.record));
      }
    }
    return results.sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
  }

  return Object.freeze({
    stateRoot: ledger.stateRoot,
    configure(options: ServiceOptions = {}) {
      activeTerminalProofProvider = options.terminalProofProvider;
      activeFault = options.fault;
      activeAdmissionProbe = options.admissionProbe;
    },
    reserve, ensureAllocated, bindRun, rebindRunForRecovery, recordTerminalProof, listOwned, status, statusOwned, issueDisposition, issueOwnedDisposition, issueAction,
    prepareOwnedDisposition, readPreparedDisposition, applyPreparedDisposition, listPreparedDispositions, markDispositionSettled,
    publishOwned, applyOwned, discardOwned, dispose, disposeOwned, issueRelease, release, releaseOwned, reconcile,
    integrationAdmissionFacts, admissionFactsForClaim, noPayloadFacts, prepareIntegrationIntent, completeIntegrationIntent, managedRebase, integrationState, inspectIntegrationCompletion, preserveIntegrationDebt, abandonIntegrationIntent,
  });
}

export function createManagedWorkspaceService(options: ServiceOptions = {}) {
  const candidate = createManagedWorkspaceServiceInternal(options);
  const services = serviceRegistry();
  const key = `${candidate.stateRoot}:${options.storageRepositoryId ?? "legacy"}`;
  const existing = services.get(key);
  if (existing) {
    existing.configure(options);
    return existing;
  }
  services.set(key, candidate);
  return candidate;
}
