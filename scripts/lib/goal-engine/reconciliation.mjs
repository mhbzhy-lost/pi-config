import { createHash, randomUUID } from "node:crypto";
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const hash = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const allowed = new Set(["tasks", "conditions", "writePolicy", "budget"]);
function exactChanges(changes) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes) || Object.keys(changes).length === 0 || Object.keys(changes).some((key) => !allowed.has(key))) throw new Error("changes contain non-permitted fields");
  for (const [key, value] of Object.entries(changes)) if (!value || typeof value !== "object" || (key === "tasks" && (!Array.isArray(value) || value.some((task) => !task || typeof task !== "object" || Array.isArray(task) || Object.keys(task).some((field) => !new Set(["id", "condition", "writePolicy", "budget"]).has(field)))))) throw new Error("changes contain invalid nested fields");
  return canonical(changes);
}
function requireProjection(projection) { for (const key of ["goalId", "executionRevision", "executionContractHash", "baseHead", "sessionId"]) if (projection?.[key] === undefined || projection[key] === null) throw new Error(`projection.${key} is required`); }
export function buildExecutionAmendmentProposal({ projection, changes, reason } = {}) {
  requireProjection(projection); if (typeof reason !== "string" || !reason.trim()) throw new Error("reason is required");
  const normalized = exactChanges(changes); const proposalId = randomUUID(); const changesHash = hash(normalized);
  const unsigned = { goalId: projection.goalId, revision: projection.executionRevision, baseHead: projection.baseHead, contractHash: projection.executionContractHash, changesHash, reason: reason.trim(), proposalId, sessionId: projection.sessionId };
  return Object.freeze({ ...unsigned, changes: normalized, proposalHash: hash(unsigned) });
}
export function reconcileExecutionChange({ projection, proposal, capability, inventories = {} } = {}) {
  requireProjection(projection);
  if (!proposal || proposal.goalId !== projection.goalId || proposal.revision !== projection.executionRevision || proposal.sessionId !== projection.sessionId || proposal.contractHash !== projection.executionContractHash) throw new Error("stale amendment proposal");
  if (!capability || capability.prefix !== "goal-user-capability.v1" || capability.singleUse !== true || capability.goalId !== proposal.goalId || capability.executionRevision !== proposal.revision || capability.proposalId !== proposal.proposalId || capability.proposalHash !== proposal.proposalHash || capability.sessionId !== proposal.sessionId) throw new Error("invalid amendment capability");
  const nonceDigest = hash(capability.nonce);
  if (projection.consumedCapabilityNonceDigests?.has?.(nonceDigest)) throw new Error("capability already consumed");
  const blocked = (inventories.activeRuns || []).length || (inventories.workspaces || []).some((item) => !item.quarantined && !item.released) || (inventories.resources || []).some((item) => !item.released);
  if (blocked) throw new Error("resources must be terminal, quarantined, or released before apply");
  const changed = new Set((proposal.changes.tasks || []).map((task) => task.id)); const actions = [];
  for (const [taskId, task] of projection.tasks || []) actions.push({ taskId, action: task.status === "accepted" ? "keep" : changed.has(taskId) ? "reverify" : "keep" });
  for (const task of proposal.changes.tasks || []) if (!projection.tasks?.has(task.id)) actions.push({ taskId: task.id, action: "add" });
  const reconciliation = canonical(actions);
  const events = Object.freeze([{ type: "execution.amendment_capability_consumed", data: { proposalId: proposal.proposalId, nonceDigest } }, { type: "execution.amendment_applied", data: { proposalId: proposal.proposalId, oldRevision: proposal.revision, newRevision: proposal.revision + 1, contractHash: proposal.contractHash, reconciliation } }]);
  return Object.freeze({ proposalId: proposal.proposalId, nonceDigest, actions: reconciliation, events, applyAllowed: true });
}
