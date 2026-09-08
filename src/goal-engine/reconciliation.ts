import { createHash, randomUUID } from "node:crypto";

type UnknownRecord = Record<string, unknown>;
type ChangeIntent = "add" | "change" | "remove";
type TaskExpected = { condition?: string; writePolicy?: { allowedPaths: string[] }; budget?: Budget; dependsOn?: string[]; applicable?: boolean };
type ConditionExpected = { statement?: string; observable?: string; expected?: string; dependsOn?: string[]; applicable?: boolean };
type Budget = Partial<Record<"max_observations" | "max_repairs" | "max_elapsed_minutes" | "max_no_progress", number>>;
type TaskChange = { id: string; intent: "remove"; expected: "removed" } | { id: string; intent: "add" | "change"; expected: TaskExpected };
type ConditionChange = { id: string; intent: "remove"; expected: "removed" } | { id: string; intent: "add" | "change"; expected: ConditionExpected };
type ExecutionChanges = { tasks?: TaskChange[]; conditions?: ConditionChange[]; writePolicy?: { allowedPaths: string[] }; budget?: Budget };
type ReconciliationTask = { status: string; conditionIds?: unknown; writePaths?: unknown; budgetKeys?: unknown; workspace?: { state?: string; active?: boolean }; runBinding?: { state?: string; active?: boolean } };
type ExecutionProjection = { goalId: unknown; executionRevision: number; executionContractHash: unknown; baseHead: unknown; sessionId: unknown; tasks?: ReadonlyMap<string, ReconciliationTask>; conditions?: ReadonlyMap<string, unknown>; consumedCapabilityNonceDigests?: ReadonlySet<string> };
type AmendmentProposal = { goalId: unknown; revision: number; baseHead: unknown; contractHash: unknown; changesHash: string; reason: string; proposalId: string; sessionId: unknown; changes: ExecutionChanges; proposalHash: string };
type AmendmentCapability = { prefix: string; singleUse: boolean; goalId: unknown; executionRevision: number; proposalId: string; proposalHash: string; sessionId: unknown; userEntryId: string; nonce: string };
type ResourceFinding = { taskId: string; state?: string; quarantined?: boolean; released?: boolean };
type ReconciliationInventories = { activeRuns?: ResourceFinding[]; workspaces?: ResourceFinding[]; resources?: ResourceFinding[] };
type TaskImpact = { kind: "unaffected" } | { kind: "affected"; remove: boolean; reason: "task_add" | "task_change" | "task_remove" | "condition_changed" | "write_policy_changed" | "budget_changed" } | { kind: "unknown"; reason: "condition_relation_unknown" | "write_scope_unknown" | "budget_relation_unknown" };
type ReconciliationAction = "keep" | "block_until_terminal" | "supersede" | "reverify" | "add";
type ReconciliationActionEntry = { entityId: string; action: ReconciliationAction };
type ApplicabilityFact = { taskId: string; state: "superseded" | "reverify_required"; revision: number; reason: string };
type ConditionFact = { conditionId: string; fact: "applicability_reverify_required" | "reverify_required"; reason: string };
type ReconciliationResult = { proposalId: string; nonceDigest: string; actions: ReconciliationActionEntry[]; applicabilityFacts: ApplicabilityFact[]; conditionFacts: ConditionFact[]; attention: { entityId: string; reason: string }[]; events: readonly unknown[]; applyAllowed: boolean };

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as UnknownRecord)[key])])) : value;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const taskExpectedFields = new Set(["condition", "writePolicy", "budget", "dependsOn", "applicable"]);
const conditionExpectedFields = new Set(["statement", "observable", "expected", "dependsOn", "applicable"]);
const budgetFields = new Set(["max_observations", "max_repairs", "max_elapsed_minutes", "max_no_progress"]);
const isObject = (value: unknown): value is UnknownRecord => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const exactObject = (value: unknown, fields: ReadonlySet<string>): value is UnknownRecord => isObject(value) && Object.keys(value).every((key) => fields.has(key));

function validateExpected(expected: unknown, expectedFields: ReadonlySet<string>) {
  if (!exactObject(expected, expectedFields) || Object.keys(expected).length === 0) return false;
  if ("condition" in expected && typeof expected.condition !== "string") return false;
  if ("statement" in expected && typeof expected.statement !== "string") return false;
  if ("observable" in expected && typeof expected.observable !== "string") return false;
  if ("expected" in expected && typeof expected.expected !== "string") return false;
  if ("applicable" in expected && typeof expected.applicable !== "boolean") return false;
  if ("dependsOn" in expected && (!Array.isArray(expected.dependsOn) || expected.dependsOn.some((id) => typeof id !== "string" || !id))) return false;
  if ("writePolicy" in expected && (!exactObject(expected.writePolicy, new Set(["allowedPaths"])) || !Array.isArray(expected.writePolicy.allowedPaths) || expected.writePolicy.allowedPaths.some((path) => typeof path !== "string" || !path))) return false;
  return !("budget" in expected && (!exactObject(expected.budget, budgetFields) || Object.keys(expected.budget).length === 0 || Object.values(expected.budget).some((value) => !Number.isInteger(value) || typeof value !== "number" || value < 0)));
}
function normalizeTaskExpected(expected: unknown): TaskExpected {
  if (!validateExpected(expected, taskExpectedFields) || !isObject(expected)) throw new Error("changes contain empty or invalid expected change");
  const result: TaskExpected = {};
  if (typeof expected.condition === "string") result.condition = expected.condition;
  if (Array.isArray(expected.dependsOn)) result.dependsOn = expected.dependsOn as string[];
  if (typeof expected.applicable === "boolean") result.applicable = expected.applicable;
  if (exactObject(expected.writePolicy, new Set(["allowedPaths"])) && Array.isArray(expected.writePolicy.allowedPaths)) result.writePolicy = { allowedPaths: expected.writePolicy.allowedPaths as string[] };
  if (exactObject(expected.budget, budgetFields)) result.budget = expected.budget as Budget;
  return result;
}
function normalizeConditionExpected(expected: unknown): ConditionExpected {
  if (!validateExpected(expected, conditionExpectedFields) || !isObject(expected)) throw new Error("changes contain empty or invalid expected change");
  const result: ConditionExpected = {};
  if (typeof expected.statement === "string") result.statement = expected.statement;
  if (typeof expected.observable === "string") result.observable = expected.observable;
  if (typeof expected.expected === "string") result.expected = expected.expected;
  if (Array.isArray(expected.dependsOn)) result.dependsOn = expected.dependsOn as string[];
  if (typeof expected.applicable === "boolean") result.applicable = expected.applicable;
  return result;
}
function normalizeEntry(entry: unknown, expectedFields: ReadonlySet<string>): { id: string; intent: ChangeIntent; expected: unknown } {
  if (!isObject(entry) || Object.keys(entry).some((key) => !new Set(["id", "intent", "expected"]).has(key)) || typeof entry.id !== "string" || !entry.id || (entry.intent !== "add" && entry.intent !== "change" && entry.intent !== "remove") || !("expected" in entry)) throw new Error("changes contain invalid nested fields");
  if (entry.intent === "remove") {
    if (entry.expected !== "removed") throw new Error("changes contain invalid remove intent");
  } else if (!validateExpected(entry.expected, expectedFields)) throw new Error("changes contain empty or invalid expected change");
  return { id: entry.id, intent: entry.intent, expected: entry.expected };
}
function normalizeTaskEntry(entry: unknown): TaskChange {
  const normalized = normalizeEntry(entry, taskExpectedFields);
  if (normalized.intent === "remove") return { id: normalized.id, intent: "remove", expected: "removed" };
  return { id: normalized.id, intent: normalized.intent, expected: normalizeTaskExpected(normalized.expected) };
}
function normalizeConditionEntry(entry: unknown): ConditionChange {
  const normalized = normalizeEntry(entry, conditionExpectedFields);
  if (normalized.intent === "remove") return { id: normalized.id, intent: "remove", expected: "removed" };
  return { id: normalized.id, intent: normalized.intent, expected: normalizeConditionExpected(normalized.expected) };
}
function exactChanges(changes: unknown): ExecutionChanges {
  if (!exactObject(changes, new Set(["tasks", "conditions", "writePolicy", "budget"])) || Object.keys(changes).length === 0) throw new Error("changes contain non-permitted fields");
  const normalized: ExecutionChanges = {};
  if ("tasks" in changes) {
    if (!Array.isArray(changes.tasks) || changes.tasks.length === 0) throw new Error("changes contain empty tasks");
    normalized.tasks = changes.tasks.map(normalizeTaskEntry);
    if (new Set(normalized.tasks.map((entry) => entry.id)).size !== normalized.tasks.length) throw new Error("changes contain duplicate task id");
  }
  if ("conditions" in changes) {
    if (!Array.isArray(changes.conditions) || changes.conditions.length === 0) throw new Error("changes contain empty conditions");
    normalized.conditions = changes.conditions.map(normalizeConditionEntry);
    if (new Set(normalized.conditions.map((entry) => entry.id)).size !== normalized.conditions.length) throw new Error("changes contain duplicate condition id");
  }
  if ("writePolicy" in changes) {
    if (!exactObject(changes.writePolicy, new Set(["allowedPaths"])) || !Array.isArray(changes.writePolicy.allowedPaths) || changes.writePolicy.allowedPaths.some((path) => typeof path !== "string" || !path)) throw new Error("changes contain invalid write policy");
    normalized.writePolicy = { allowedPaths: changes.writePolicy.allowedPaths as string[] };
  }
  if ("budget" in changes) {
    if (!exactObject(changes.budget, budgetFields) || Object.keys(changes.budget).length === 0 || Object.values(changes.budget).some((value) => !Number.isInteger(value) || typeof value !== "number" || value < 0)) throw new Error("changes contain invalid budget");
    normalized.budget = changes.budget as Budget;
  }
  return canonical({ ...normalized, tasks: normalized.tasks?.slice().sort((a, b) => a.id.localeCompare(b.id)), conditions: normalized.conditions?.slice().sort((a, b) => a.id.localeCompare(b.id)) }) as ExecutionChanges;
}
function requireProjection(projection: ExecutionProjection | undefined) { for (const key of ["goalId", "executionRevision", "executionContractHash", "baseHead", "sessionId"] as const) if (projection?.[key] === undefined || projection[key] === null) throw new Error(`projection.${key} is required`); }
function validateEntityExistence(projection: ExecutionProjection, changes: ExecutionChanges) {
  for (const [kind, entities] of [["task", projection.tasks], ["condition", projection.conditions]] as const) for (const entry of changes[`${kind}s`] || []) {
    const exists = entities?.has(entry.id) === true;
    if ((entry.intent === "add" && exists) || (entry.intent !== "add" && !exists)) throw new Error(`${kind} intent does not match projection existence`);
  }
}
export function buildExecutionAmendmentProposal({ projection, changes, reason }: { projection?: ExecutionProjection; changes?: unknown; reason?: unknown } = {}): AmendmentProposal {
  requireProjection(projection); if (typeof reason !== "string" || !reason.trim()) throw new Error("reason is required");
  const normalized = exactChanges(changes); validateEntityExistence(projection, normalized); const proposalId = randomUUID(); const changesHash = hash(normalized);
  const unsigned = { goalId: projection.goalId, revision: projection.executionRevision, baseHead: projection.baseHead, contractHash: projection.executionContractHash, changesHash, reason: reason.trim(), proposalId, sessionId: projection.sessionId };
  return Object.freeze({ ...unsigned, changes: normalized, proposalHash: hash(unsigned) });
}
const relation = (values: unknown, affected: ReadonlySet<string>): boolean | null => Array.isArray(values) ? values.some((value) => typeof value === "string" && affected.has(value)) : null;
function taskImpact(task: ReconciliationTask, changes: ExecutionChanges, taskChange: TaskChange | undefined): TaskImpact {
  if (taskChange) return { kind: "affected", remove: taskChange.intent === "remove", reason: `task_${taskChange.intent}` };
  const conditionIds = new Set((changes.conditions || []).map((entry) => entry.id));
  if (conditionIds.size) { const result = relation(task.conditionIds, conditionIds); if (result === null) return { kind: "unknown", reason: "condition_relation_unknown" }; if (result) return { kind: "affected", remove: false, reason: "condition_changed" }; }
  if (changes.writePolicy) {
    if (!Array.isArray(task.writePaths) || task.writePaths.some((path) => typeof path !== "string")) return { kind: "unknown", reason: "write_scope_unknown" };
    if (task.writePaths.some((path) => !changes.writePolicy!.allowedPaths.includes(path))) return { kind: "affected", remove: false, reason: "write_policy_changed" };
  }
  if (changes.budget) { const result = relation(task.budgetKeys, new Set(Object.keys(changes.budget))); if (result === null) return { kind: "unknown", reason: "budget_relation_unknown" }; if (result) return { kind: "affected", remove: false, reason: "budget_changed" }; }
  return { kind: "unaffected" };
}
function activeDebt(taskId: string, task: ReconciliationTask, inventories: ReconciliationInventories) {
  const projectionActive = ["dispatched", "running", "settling", "disposing"].includes(task.status)
    || task.workspace?.state === "active" || task.workspace?.active === true
    || task.runBinding?.state === "active" || task.runBinding?.active === true;
  const active = (inventories.activeRuns || []).some((item) => item.taskId === taskId && !["terminal", "released", "cancelled"].includes(item.state || ""));
  const workspace = (inventories.workspaces || []).some((item) => item.taskId === taskId && !item.quarantined && !item.released);
  const resource = (inventories.resources || []).some((item) => item.taskId === taskId && !item.quarantined && !item.released);
  return projectionActive || active || workspace || resource;
}
function conditionFactsFor(task: ReconciliationTask, changes: ExecutionChanges, fact: ConditionFact["fact"], reason: string): ConditionFact[] {
  const conditionIds = new Set(Array.isArray(task.conditionIds) && task.conditionIds.every((id) => typeof id === "string") ? task.conditionIds : []);
  const changed = (changes.conditions || []).map((entry) => entry.id).filter((id) => conditionIds.has(id));
  const ids = changed.length ? changed : conditionIds;
  return [...ids].sort().map((conditionId) => ({ conditionId, fact, reason }));
}
export function reconcileExecutionChange({ projection, proposal, capability, inventories = {} }: { projection?: ExecutionProjection; proposal?: AmendmentProposal; capability?: AmendmentCapability; inventories?: ReconciliationInventories } = {}): ReconciliationResult {
  requireProjection(projection);
  if (!proposal || proposal.goalId !== projection.goalId || proposal.revision !== projection.executionRevision || proposal.sessionId !== projection.sessionId || proposal.contractHash !== projection.executionContractHash) throw new Error("stale amendment proposal");
  validateEntityExistence(projection, proposal.changes);
  if (!capability || capability.prefix !== "goal-user-capability.v1" || capability.singleUse !== true || capability.goalId !== proposal.goalId || capability.executionRevision !== proposal.revision || capability.proposalId !== proposal.proposalId || capability.proposalHash !== proposal.proposalHash || capability.sessionId !== proposal.sessionId || typeof capability.userEntryId !== "string" || !capability.userEntryId || typeof capability.nonce !== "string" || !capability.nonce) throw new Error("invalid amendment capability");
  const nonceDigest = hash(capability.nonce);
  if (projection.consumedCapabilityNonceDigests?.has(nonceDigest)) throw new Error("capability already consumed");
  const taskChanges = new Map((proposal.changes.tasks || []).map((entry) => [entry.id, entry]));
  const actions: ReconciliationActionEntry[] = []; const applicabilityFacts: ApplicabilityFact[] = []; const conditionFacts: ConditionFact[] = []; const attention: { entityId: string; reason: string }[] = [];
  for (const [entityId, task] of projection.tasks || []) {
    const impact = taskImpact(task, proposal.changes, taskChanges.get(entityId));
    let action: ReconciliationAction = "keep";
    if (task.status === "accepted") {
      if (impact.kind === "unknown" || (impact.kind === "affected" && activeDebt(entityId, task, inventories))) { action = "block_until_terminal"; attention.push({ entityId, reason: impact.kind === "unknown" ? impact.reason : "owned_resource_not_terminal" }); }
      else if (impact.kind === "affected" && impact.remove) applicabilityFacts.push({ taskId: entityId, state: "superseded", revision: proposal.revision + 1, reason: impact.reason });
      else if (impact.kind === "affected") {
        applicabilityFacts.push({ taskId: entityId, state: "reverify_required", revision: proposal.revision + 1, reason: impact.reason });
        conditionFacts.push(...conditionFactsFor(task, proposal.changes, "applicability_reverify_required", impact.reason));
      }
    } else if (impact.kind === "unknown" || (impact.kind === "affected" && activeDebt(entityId, task, inventories))) { action = "block_until_terminal"; attention.push({ entityId, reason: impact.kind === "unknown" ? impact.reason : "owned_resource_not_terminal" }); }
    else if (impact.kind === "affected" && impact.remove) action = "supersede";
    else if (impact.kind === "affected") { action = "reverify"; conditionFacts.push(...conditionFactsFor(task, proposal.changes, "reverify_required", impact.reason)); }
    actions.push({ entityId, action });
  }
  for (const entry of taskChanges.values()) if (!projection.tasks?.has(entry.id) && entry.intent === "add") actions.push({ entityId: entry.id, action: "add" });
  const reconciliation = actions.sort((a, b) => a.entityId.localeCompare(b.entityId));
  const blocked = reconciliation.some((entry) => entry.action === "block_until_terminal");
  if (blocked) return Object.freeze({ proposalId: proposal.proposalId, nonceDigest, actions: reconciliation, applicabilityFacts: applicabilityFacts.sort((a, b) => a.taskId.localeCompare(b.taskId)), conditionFacts: conditionFacts.sort((a, b) => a.conditionId.localeCompare(b.conditionId)), attention, events: Object.freeze([]), applyAllowed: false });
  const events = Object.freeze([{ type: "execution.amendment_capability_consumed", data: { proposalId: proposal.proposalId, nonceDigest } }, { type: "execution.amendment_applied", data: { proposalId: proposal.proposalId, oldRevision: proposal.revision, newRevision: proposal.revision + 1, contractHash: proposal.contractHash, reconciliation } }]);
  return Object.freeze({ proposalId: proposal.proposalId, nonceDigest, actions: reconciliation, applicabilityFacts: applicabilityFacts.sort((a, b) => a.taskId.localeCompare(b.taskId)), conditionFacts: conditionFacts.sort((a, b) => a.conditionId.localeCompare(b.conditionId)), attention: [], events, applyAllowed: true });
}
