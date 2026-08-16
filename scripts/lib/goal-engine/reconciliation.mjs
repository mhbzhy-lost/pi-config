import { createHash, randomUUID } from "node:crypto";

const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const hash = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const taskExpectedFields = new Set(["condition", "writePolicy", "budget", "dependsOn", "applicable"]);
const conditionExpectedFields = new Set(["statement", "observable", "expected", "dependsOn", "applicable"]);
const budgetFields = new Set(["max_observations", "max_repairs", "max_elapsed_minutes", "max_no_progress"]);
const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
const exactObject = (value, fields) => isObject(value) && Object.keys(value).every((key) => fields.has(key));

function validateExpected(expected, expectedFields) {
  if (!exactObject(expected, expectedFields) || Object.keys(expected).length === 0) return false;
  if ("condition" in expected && typeof expected.condition !== "string") return false;
  if ("statement" in expected && typeof expected.statement !== "string") return false;
  if ("observable" in expected && typeof expected.observable !== "string") return false;
  if ("expected" in expected && typeof expected.expected !== "string") return false;
  if ("applicable" in expected && typeof expected.applicable !== "boolean") return false;
  if ("dependsOn" in expected && (!Array.isArray(expected.dependsOn) || expected.dependsOn.some((id) => typeof id !== "string" || !id))) return false;
  if ("writePolicy" in expected && (!exactObject(expected.writePolicy, new Set(["allowedPaths"])) || !Array.isArray(expected.writePolicy.allowedPaths) || expected.writePolicy.allowedPaths.some((path) => typeof path !== "string" || !path))) return false;
  return !("budget" in expected && (!exactObject(expected.budget, budgetFields) || Object.keys(expected.budget).length === 0 || Object.values(expected.budget).some((value) => !Number.isInteger(value) || value < 0)));
}
function validateEntry(entry, expectedFields) {
  if (!isObject(entry) || Object.keys(entry).some((key) => !new Set(["id", "intent", "expected"]).has(key)) || typeof entry.id !== "string" || !entry.id || !["add", "change", "remove"].includes(entry.intent) || !("expected" in entry)) throw new Error("changes contain invalid nested fields");
  if (entry.intent === "remove") {
    if (entry.expected !== "removed") throw new Error("changes contain invalid remove intent");
  } else if (!validateExpected(entry.expected, expectedFields)) throw new Error("changes contain empty or invalid expected change");
}
function exactChanges(changes) {
  if (!isObject(changes) || Object.keys(changes).length === 0 || Object.keys(changes).some((key) => !new Set(["tasks", "conditions", "writePolicy", "budget"]).has(key))) throw new Error("changes contain non-permitted fields");
  if ("tasks" in changes) {
    if (!Array.isArray(changes.tasks) || changes.tasks.length === 0) throw new Error("changes contain empty tasks");
    changes.tasks.forEach((entry) => validateEntry(entry, taskExpectedFields));
    if (new Set(changes.tasks.map((entry) => entry.id)).size !== changes.tasks.length) throw new Error("changes contain duplicate task id");
  }
  if ("conditions" in changes) {
    if (!Array.isArray(changes.conditions) || changes.conditions.length === 0) throw new Error("changes contain empty conditions");
    changes.conditions.forEach((entry) => validateEntry(entry, conditionExpectedFields));
    if (new Set(changes.conditions.map((entry) => entry.id)).size !== changes.conditions.length) throw new Error("changes contain duplicate condition id");
  }
  if ("writePolicy" in changes && (!exactObject(changes.writePolicy, new Set(["allowedPaths"])) || !Array.isArray(changes.writePolicy.allowedPaths) || changes.writePolicy.allowedPaths.some((path) => typeof path !== "string" || !path))) throw new Error("changes contain invalid write policy");
  if ("budget" in changes && (!exactObject(changes.budget, budgetFields) || Object.keys(changes.budget).length === 0 || Object.values(changes.budget).some((value) => !Number.isInteger(value) || value < 0))) throw new Error("changes contain invalid budget");
  return canonical({ ...changes, tasks: changes.tasks?.slice().sort((a, b) => a.id.localeCompare(b.id)), conditions: changes.conditions?.slice().sort((a, b) => a.id.localeCompare(b.id)) });
}
function requireProjection(projection) { for (const key of ["goalId", "executionRevision", "executionContractHash", "baseHead", "sessionId"]) if (projection?.[key] === undefined || projection[key] === null) throw new Error(`projection.${key} is required`); }
export function buildExecutionAmendmentProposal({ projection, changes, reason } = {}) {
  requireProjection(projection); if (typeof reason !== "string" || !reason.trim()) throw new Error("reason is required");
  const normalized = exactChanges(changes); const proposalId = randomUUID(); const changesHash = hash(normalized);
  const unsigned = { goalId: projection.goalId, revision: projection.executionRevision, baseHead: projection.baseHead, contractHash: projection.executionContractHash, changesHash, reason: reason.trim(), proposalId, sessionId: projection.sessionId };
  return Object.freeze({ ...unsigned, changes: normalized, proposalHash: hash(unsigned) });
}
const relation = (values, affected) => Array.isArray(values) ? values.some((value) => affected.has(value)) : null;
function taskImpact(task, changes, taskChange) {
  if (taskChange) return { affected: true, remove: taskChange.intent === "remove", reason: `task_${taskChange.intent}` };
  const conditionIds = new Set((changes.conditions || []).map((entry) => entry.id));
  if (conditionIds.size) { const result = relation(task.conditionIds, conditionIds); if (result === null) return { unknown: true, reason: "condition_relation_unknown" }; if (result) return { affected: true, reason: "condition_changed" }; }
  if (changes.writePolicy) {
    if (!Array.isArray(task.writePaths)) return { unknown: true, reason: "write_scope_unknown" };
    if (task.writePaths.some((path) => !changes.writePolicy.allowedPaths.includes(path))) return { affected: true, reason: "write_policy_changed" };
  }
  if (changes.budget) { const result = relation(task.budgetKeys, new Set(Object.keys(changes.budget))); if (result === null) return { unknown: true, reason: "budget_relation_unknown" }; if (result) return { affected: true, reason: "budget_changed" }; }
  return { affected: false };
}
function activeDebt(taskId, inventories) {
  const active = (inventories.activeRuns || []).some((item) => item.taskId === taskId && !["terminal", "released", "cancelled"].includes(item.state));
  const workspace = (inventories.workspaces || []).some((item) => item.taskId === taskId && !item.quarantined && !item.released);
  const resource = (inventories.resources || []).some((item) => item.taskId === taskId && !item.quarantined && !item.released);
  return active || workspace || resource;
}
export function reconcileExecutionChange({ projection, proposal, capability, inventories = {} } = {}) {
  requireProjection(projection);
  if (!proposal || proposal.goalId !== projection.goalId || proposal.revision !== projection.executionRevision || proposal.sessionId !== projection.sessionId || proposal.contractHash !== projection.executionContractHash) throw new Error("stale amendment proposal");
  if (!capability || capability.prefix !== "goal-user-capability.v1" || capability.singleUse !== true || capability.goalId !== proposal.goalId || capability.executionRevision !== proposal.revision || capability.proposalId !== proposal.proposalId || capability.proposalHash !== proposal.proposalHash || capability.sessionId !== proposal.sessionId || typeof capability.userEntryId !== "string" || !capability.userEntryId || typeof capability.nonce !== "string" || !capability.nonce) throw new Error("invalid amendment capability");
  const nonceDigest = hash(capability.nonce);
  if (projection.consumedCapabilityNonceDigests?.has?.(nonceDigest)) throw new Error("capability already consumed");
  const taskChanges = new Map((proposal.changes.tasks || []).map((entry) => [entry.id, entry]));
  const actions = []; const applicabilityFacts = []; const conditionFacts = []; const attention = [];
  for (const [entityId, task] of projection.tasks || []) {
    const impact = taskImpact(task, proposal.changes, taskChanges.get(entityId));
    let action = "keep";
    if (task.status === "accepted") {
      if (impact.affected || impact.unknown) { applicabilityFacts.push({ taskId: entityId, state: "reverify_required", reason: impact.reason }); conditionFacts.push({ conditionId: entityId, fact: "applicability_reverify_required" }); }
    } else if (impact.unknown || (impact.affected && activeDebt(entityId, inventories))) { action = "block_until_terminal"; attention.push({ entityId, reason: impact.unknown ? impact.reason : "owned_resource_not_terminal" }); }
    else if (impact.remove) action = "supersede";
    else if (impact.affected) { action = "reverify"; conditionFacts.push({ conditionId: entityId, fact: "reverify_required", reason: impact.reason }); }
    actions.push({ entityId, action });
  }
  for (const entry of taskChanges.values()) if (!projection.tasks?.has(entry.id) && entry.intent === "add") actions.push({ entityId: entry.id, action: "add" });
  const reconciliation = actions.sort((a, b) => a.entityId.localeCompare(b.entityId));
  const blocked = reconciliation.some((entry) => entry.action === "block_until_terminal");
  if (blocked) return Object.freeze({ proposalId: proposal.proposalId, nonceDigest, actions: reconciliation, applicabilityFacts: applicabilityFacts.sort((a, b) => a.taskId.localeCompare(b.taskId)), conditionFacts: conditionFacts.sort((a, b) => a.conditionId.localeCompare(b.conditionId)), attention, events: Object.freeze([]), applyAllowed: false });
  const events = Object.freeze([{ type: "execution.amendment_capability_consumed", data: { proposalId: proposal.proposalId, nonceDigest } }, { type: "execution.amendment_applied", data: { proposalId: proposal.proposalId, oldRevision: proposal.revision, newRevision: proposal.revision + 1, contractHash: proposal.contractHash, reconciliation } }]);
  return Object.freeze({ proposalId: proposal.proposalId, nonceDigest, actions: reconciliation, applicabilityFacts: applicabilityFacts.sort((a, b) => a.taskId.localeCompare(b.taskId)), conditionFacts: conditionFacts.sort((a, b) => a.conditionId.localeCompare(b.conditionId)), attention: [], events, applyAllowed: true });
}
