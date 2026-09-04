import { randomUUID } from "node:crypto";
import { ownerSessionId, suspensionClosureHash } from "./events.ts";
import { executorCriteria } from "./task-definition.ts";

export { suspensionClosureHash };

export function suspensionClosureStatus(projection) {
  const suspension = projection?.suspension || {};
  const ids = (value) => [...new Set(Array.isArray(value) ? value.filter((id) => typeof id === "string") : [])].sort();
  const missing = (affected, refs, key) => {
    const proven = new Set((Array.isArray(refs) ? refs : []).map((ref) => ref?.[key]).filter((id) => typeof id === "string"));
    return affected.filter((id) => !proven.has(id));
  };
  const runIds = ids(suspension.affectedRunIds), taskIds = ids(suspension.affectedTaskIds);
  const missingTerminalRunIds = missing(runIds, suspension.terminalProofRefs, "runId");
  const missingWorkspaceTaskIds = missing(taskIds, suspension.workspaceClosureProofRefs, "taskId");
  const missingResourceOwnerIds = missing(runIds, suspension.resourceClosureProofRefs, "ownerId");
  return Object.freeze({
    complete: suspension.resourcesQuarantined === true && !missingTerminalRunIds.length && !missingWorkspaceTaskIds.length && !missingResourceOwnerIds.length,
    missingTerminalRunIds: Object.freeze(missingTerminalRunIds),
    missingWorkspaceTaskIds: Object.freeze(missingWorkspaceTaskIds),
    missingResourceOwnerIds: Object.freeze(missingResourceOwnerIds),
  });
}

const REASONS = new Set(["interactive_steer", "follow_up", "abort", "execution_amendment", "host_pause"]);
const BLOCKED = Object.freeze(["dispatch", "integrate", "finalize"]);
function durableOwnerSessionId(projection) {
  const owners = projection?.sessionBindings?.filter?.((binding) => binding?.state !== "transferred") || [];
  const sessionId = ownerSessionId(projection);
  if (owners.length !== 1 || sessionId !== owners[0]?.sessionId || typeof sessionId !== "string" || !sessionId) throw new Error("durable runtime identity is invalid");
  return sessionId;
}

export function deriveOwnedExecutorStopRequest({ projection, taskId } = {}) {
  if (!projection || projection.runtimeGeneration !== "goal-runtime.v1" || !Number.isSafeInteger(projection.executionRevision) || projection.executionRevision < 1 || typeof projection.executionContractHash !== "string" || !/^[a-f0-9]{64}$/.test(projection.executionContractHash) || typeof projection.goalId !== "string" || !projection.goalId || typeof projection.runtimeBaseHead !== "string" || !/^[a-f0-9]{40}$/.test(projection.runtimeBaseHead)) throw new Error("durable runtime identity is invalid");
  const sessionId = durableOwnerSessionId(projection);
  const task = projection.tasks?.get?.(taskId); const binding = task?.executorBinding;
  if (typeof taskId !== "string" || !taskId || !task || !["dispatched", "running", "settling"].includes(task.status) || !Number.isSafeInteger(task.attempts) || task.attempts < 1 || !binding || typeof binding.runId !== "string" || !binding.runId || typeof binding.asyncDir !== "string" || !binding.asyncDir.startsWith("/") || typeof binding.workspacePath !== "string" || !binding.workspacePath.startsWith("/") || typeof binding.workspaceLeaseId !== "string" || !/^[a-f0-9]{64}$/.test(binding.workspaceLeaseId) || typeof binding.headAtDispatch !== "string" || !/^[a-f0-9]{40}$/.test(binding.headAtDispatch)) throw new Error("durable executor binding is invalid");
  const expectedCriteria = executorCriteria(task.acceptance?.criteria ?? []).map((criterion) => criterion.id);
  if (!expectedCriteria.length) throw new Error("durable executor acceptance authority is invalid");
  return Object.freeze({ goalId: projection.goalId, taskId, attempt: task.attempts, runId: binding.runId, asyncDir: binding.asyncDir, workspacePath: binding.workspacePath, leaseId: binding.workspaceLeaseId, sessionId, baseHead: projection.runtimeBaseHead, headAtDispatch: binding.headAtDispatch, executionRevision: projection.executionRevision, contractHash: projection.executionContractHash, expectedCriteria, agent: "executor" });
}

export function suspensionGuard(projection, operation) {
  if (projection?.runtimeState === "suspended" || projection?.suspension) {
    if (BLOCKED.includes(operation)) throw new Error(`runtime is suspended: ${operation} is blocked`);
  }
  return true;
}

export function buildSuspensionPlan({ projection, reason, affectedIds = {}, inventories = {} } = {}) {
  if (!projection?.goalId) throw new Error("runtime projection is required");
  if (!REASONS.has(reason)) throw new Error("invalid suspension reason");
  const taskIds = [...new Set(affectedIds.taskIds || [])].sort(); const runIds = [...new Set(affectedIds.runIds || [])].sort();
  const suspensionId = randomUUID();
  const workspaceStrategies = (inventories.workspaces || []).map((workspace) => {
    const affected = workspace.affected === true || taskIds.includes(workspace.taskId) || runIds.includes(workspace.runId);
    return Object.freeze({ taskId: workspace.taskId, runId: workspace.runId ?? null, action: affected ? "quarantine" : workspace.policy === "keep" ? "preserve" : "quarantine", resultPolicy: affected ? "quarantine" : workspace.policy === "keep" ? "keep" : "quarantine", execute: false });
  });
  const events = [{ type: "goal.runtime_suspended", data: { suspensionId, reason, affectedTaskIds: taskIds, affectedRunIds: runIds, requestedAt: new Date().toISOString(), resourcesQuarantined: false } }];
  return Object.freeze({ suspensionId, blocked: BLOCKED, guard: (operation) => suspensionGuard({ runtimeState: "suspended" }, operation), workspaceStrategies, events: Object.freeze(events) });
}

export async function requestOwnedRunStop(pi, request = {}) {
  const { projection, ...claimed } = request;
  if (!pi || typeof pi.stopOwnedRun !== "function") throw new Error("Root Broker owned stop facade is unavailable");
  const owned = deriveOwnedExecutorStopRequest({ projection, taskId: claimed.taskId });
  if (JSON.stringify(claimed) !== JSON.stringify(owned)) throw new Error("owned stop identity mismatch");
  try {
    const response = await pi.stopOwnedRun(owned);
    if (response?.state !== "observed" || !response.proof) return Object.freeze({ terminal: false, attention: true, reason: "official_terminal_proof_missing" });
    return Object.freeze({ terminal: true, attention: false, proof: response.proof });
  } catch { return Object.freeze({ terminal: false, attention: true, reason: "owned_stop_unavailable" }); }
}

export function inspectSuspensionCompletion({ projection, stopProofs = [], workspaceInventories = [], resourceProofs = [] } = {}) {
  const suspension = projection?.suspension;
  const taskIds = Array.isArray(suspension?.affectedTaskIds) ? suspension.affectedTaskIds : [];
  const runIds = Array.isArray(suspension?.affectedRunIds) ? suspension.affectedRunIds : [];
  const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  const missingProof = runIds.some((runId) => {
    const matches = stopProofs.filter((proof) => proof?.runId === runId);
    return matches.length !== 1 || !exact(matches[0], ["runId", "proofHash", "state"]) || !hash(matches[0].proofHash) || matches[0].state !== "observed";
  });
  const missingWorkspace = taskIds.some((taskId) => {
    const matches = workspaceInventories.filter((proof) => proof?.taskId === taskId);
    const attempt = projection?.tasks?.get?.(taskId)?.attempts;
    return matches.length !== 1 || !exact(matches[0], ["taskId", "attempt", "proofHash", "state", "disposition"]) || !Number.isSafeInteger(attempt) || matches[0].attempt !== attempt || !hash(matches[0].proofHash) || matches[0].state !== "quarantined" || matches[0].disposition !== "preserved";
  });
  const missingResource = runIds.some((runId) => {
    const matches = resourceProofs.filter((proof) => proof?.ownerId === runId);
    return matches.length !== 1 || !exact(matches[0], ["ownerId", "proofHash", "state", "debt"]) || !hash(matches[0].proofHash) || matches[0].state !== "quarantined" || matches[0].debt !== true;
  });
  const attention = missingProof || missingWorkspace || missingResource;
  return Object.freeze({ complete: !attention, attention, missingProof, missingWorkspace, missingResource });
}
