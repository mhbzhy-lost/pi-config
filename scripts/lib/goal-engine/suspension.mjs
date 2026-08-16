import { randomUUID } from "node:crypto";

const REASONS = new Set(["interactive_steer", "follow_up", "abort", "execution_amendment", "host_pause"]);
const BLOCKED = Object.freeze(["dispatch", "integrate", "finalize"]);
const string = (value, name) => { if (typeof value !== "string" || !value) throw new Error(`${name} is required`); return value; };

export function buildSuspensionPlan({ projection, reason, affectedIds = {}, inventories = {} } = {}) {
  if (!projection?.goalId) throw new Error("runtime projection is required");
  if (!REASONS.has(reason)) throw new Error("invalid suspension reason");
  const taskIds = [...new Set(affectedIds.taskIds || [])]; const runIds = [...new Set(affectedIds.runIds || [])];
  const strategies = (inventories.workspaces || []).map((workspace) => ({ taskId: workspace.taskId, runId: workspace.runId ?? null, action: workspace.affected ? "quarantine" : workspace.policy === "keep" ? "preserve" : "quarantine", execute: false }));
  return Object.freeze({ suspensionId: randomUUID(), blocked: BLOCKED, workspaceStrategies: strategies, events: [
    { type: "goal.runtime_suspended", data: { suspensionId: randomUUID(), reason, affectedTaskIds: taskIds, affectedRunIds: runIds, requestedAt: new Date().toISOString(), resourcesQuarantined: false } },
    { type: "goal.action_offer_revoked", data: { offerId: projection.actionOffer?.id ?? null, reason: "runtime_suspended" } },
  ] });
}

export async function requestOwnedRunStop(pi, request = {}) {
  const { projection, goalId, taskId, attempt, runId, leaseId } = request;
  if (!pi || typeof pi.stopOwnedRun !== "function") throw new Error("Root Broker owned stop facade is unavailable");
  if (!projection || goalId !== projection.goalId) throw new Error("owned stop identity mismatch");
  const task = projection.tasks?.get?.(taskId); const binding = task?.executorBinding;
  if (!task || binding?.runId !== runId || task.attempts !== attempt || binding.workspaceLeaseId !== leaseId) throw new Error("owned stop identity mismatch");
  try {
    const response = await pi.stopOwnedRun({ goalId: string(goalId, "goalId"), taskId: string(taskId, "taskId"), attempt, runId: string(runId, "runId"), leaseId: string(leaseId, "leaseId") });
    if (response?.state !== "observed" || !response.proof) return Object.freeze({ terminal: false, attention: true, reason: "official_terminal_proof_missing" });
    return Object.freeze({ terminal: true, attention: false, proof: response.proof });
  } catch (error) { return Object.freeze({ terminal: false, attention: true, reason: `stop_failed:${error.message}` }); }
}

export function inspectSuspensionCompletion({ projection, stopProofs = [], workspaceInventories = [] } = {}) {
  const affected = projection?.tasks ? [...projection.tasks.entries()].filter(([, task]) => task.executorBinding).map(([taskId, task]) => ({ taskId, runId: task.executorBinding.runId })) : [];
  const missingProof = affected.some(({ runId }) => !stopProofs.some((proof) => proof.runId === runId && proof.state === "observed" && !proof.conflict));
  const missingWorkspace = affected.some(({ taskId }) => !workspaceInventories.some((workspace) => workspace.taskId === taskId && ["preserve", "quarantine", "discard"].includes(workspace.action) && workspace.proof && workspace.resourcesReleased === true));
  return Object.freeze({ complete: !missingProof && !missingWorkspace, attention: missingProof || missingWorkspace, missingProof, missingWorkspace });
}
