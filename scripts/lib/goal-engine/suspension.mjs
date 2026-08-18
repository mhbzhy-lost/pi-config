import { randomUUID } from "node:crypto";
import { ownerSessionId, suspensionClosureHash } from "./events.mjs";

export { suspensionClosureHash };

const REASONS = new Set(["interactive_steer", "follow_up", "abort", "execution_amendment", "host_pause"]);
const BLOCKED = Object.freeze(["dispatch", "integrate", "finalize"]);
const string = (value, name) => { if (typeof value !== "string" || !value) throw new Error(`${name} is required`); return value; };

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
  if (typeof taskId !== "string" || !taskId || !task || !["dispatched", "running", "settling"].includes(task.status) || !Number.isSafeInteger(task.attempts) || task.attempts < 1 || !binding || typeof binding.runId !== "string" || !binding.runId || typeof binding.asyncDir !== "string" || !binding.asyncDir.startsWith("/") || typeof binding.workspaceLeaseId !== "string" || !binding.workspaceLeaseId) throw new Error("durable executor binding is invalid");
  return Object.freeze({ goalId: projection.goalId, taskId, attempt: task.attempts, runId: binding.runId, asyncDir: binding.asyncDir, leaseId: binding.workspaceLeaseId, sessionId, baseHead: projection.runtimeBaseHead, executionRevision: projection.executionRevision, contractHash: projection.executionContractHash });
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
  const { projection, goalId, taskId, attempt, runId, leaseId } = request;
  if (!pi || typeof pi.stopOwnedRun !== "function") throw new Error("Root Broker owned stop facade is unavailable");
  const owned = deriveOwnedExecutorStopRequest({ projection, taskId });
  if (goalId !== owned.goalId || attempt !== owned.attempt || runId !== owned.runId || leaseId !== owned.leaseId) throw new Error("owned stop identity mismatch");
  try {
    const response = await pi.stopOwnedRun({ runId: string(owned.runId, "runId"), asyncDir: owned.asyncDir, sessionId: owned.sessionId });
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
