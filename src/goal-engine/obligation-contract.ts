import { createHash } from "node:crypto";
import { assertContractArray, assertContractString } from "./contract-limits.ts";
import { normalizeRepoRelativePosixPath } from "./repo-path.ts";
import { validateTaskDefinitions } from "./task-definition.ts";

const ID = /^[A-Za-z0-9._-]{1,160}$/;
const READINESS = new Set(["draft", "ready", "needs_clarification", "environment_blocked", "unsafe_to_run"]);
const FORBIDDEN = /^(?:command|executable|args|env(?:_value)?|.*(?:token|cookie|authorization|secret).*)$/i;

function fail(message) { throw new Error(`invalid runtime contract: ${message}`); }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function object(value, location, keys) {
  if (!plain(value)) fail(`${location} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key) || FORBIDDEN.test(key)) fail(`${location} contains forbidden or unknown field`);
  return value;
}
function string(value, location) { try { return assertContractString(value, location); } catch { fail(`${location} is required`); } }
function array(value, location) { try { return assertContractArray(value, location); } catch { fail(`${location} must be an array`); } }
function id(value, location) { const normalized = string(value, location); if (!ID.test(normalized)) fail(`${location} is invalid`); return normalized; }
function paths(value, location) {
  const seen = new Set();
  return array(value, location).map((entry, index) => {
    let normalized;
    try { normalized = normalizeRepoRelativePosixPath(string(entry, `${location}[${index}]`), `${location}[${index}]`); } catch { fail(`${location} contains an invalid path`); }
    if (seen.has(normalized)) fail(`${location} contains duplicate path`);
    seen.add(normalized); return normalized;
  });
}
function subset(path, allowed) { return allowed.some((base) => path === base || base.endsWith("/**") && path.startsWith(base.slice(0, -2))); }
function registry(registries, name) { return plain(registries?.[name]) ? registries[name] : {}; }
function known(registries, name, ref) { return Object.hasOwn(registry(registries, name), ref); }
function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; Object.values(value).forEach(freeze); return Object.freeze(value); }
function canonicalize(value) { if (Array.isArray(value)) return value.map(canonicalize); if (!plain(value)) return value; return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])); }

function normalizeTask(value, index) {
  object(value, `execution.tasks[${index}]`, ["id", "description", "deps", "writePaths", "acceptance", "workflow"]);
  const normalized = {
    id: id(value.id, `execution.tasks[${index}].id`),
    description: string(value.description, `execution.tasks[${index}].description`),
    ...(Object.hasOwn(value, "deps") ? { deps: array(value.deps, `execution.tasks[${index}].deps`).map((dep, item) => id(dep, `execution.tasks[${index}].deps[${item}]`)) } : {}),
    writePaths: paths(value.writePaths, `execution.tasks[${index}].writePaths`),
    acceptance: structuredClone(value.acceptance),
    ...(Object.hasOwn(value, "workflow") ? { workflow: string(value.workflow, `execution.tasks[${index}].workflow`) } : {}),
  };
  return normalized;
}
function normalizeCondition(value, index, allowedPaths, registries) {
  object(value, `execution.conditions[${index}]`, ["id", "role", "enforcement", "statement", "observable", "expected", "depends_on", "oracle_ref", "environment_ref", "fixture_refs", "invalidation", "remediation", "stability"]);
  const conditionId = id(value.id, `execution.conditions[${index}].id`);
  const role = string(value.role, "condition.role"); if (!["terminal", "invariant"].includes(role)) fail("condition.role is invalid");
  const enforcement = string(value.enforcement, "condition.enforcement"); if (!["pre_integrate", "continuous", "final"].includes(enforcement)) fail("condition.enforcement is invalid");
  const oracle_ref = string(value.oracle_ref, "condition.oracle_ref"); if (!known(registries, "adapters", oracle_ref)) fail("condition references unknown adapter");
  const environment_ref = string(value.environment_ref, "condition.environment_ref"); if (!known(registries, "environments", environment_ref)) fail("condition references unknown environment");
  const fixture_refs = array(value.fixture_refs, "condition.fixture_refs").map((ref, item) => { const normalized = string(ref, `condition.fixture_refs[${item}]`); if (!known(registries, "fixtures", normalized)) fail("condition references unknown fixture"); return normalized; });
  if (new Set(fixture_refs).size !== fixture_refs.length) fail("condition fixture refs are duplicated");
  object(value.invalidation, "condition.invalidation", ["paths", "task_ids"]);
  const invalidation = { paths: paths(value.invalidation.paths, "condition.invalidation.paths"), task_ids: array(value.invalidation.task_ids, "condition.invalidation.task_ids").map((entry, item) => id(entry, `condition.invalidation.task_ids[${item}]`)) };
  object(value.remediation, "condition.remediation", ["policy", "allowed_paths", "max_attempts"]);
  const policy = string(value.remediation.policy, "condition.remediation.policy"); if (!["autonomous", "user-approved"].includes(policy)) fail("condition remediation policy is invalid");
  const remediationPaths = paths(value.remediation.allowed_paths, "condition.remediation.allowed_paths"); if (remediationPaths.some((path) => !subset(path, allowedPaths))) fail("condition remediation paths exceed write policy");
  if (!Number.isSafeInteger(value.remediation.max_attempts) || value.remediation.max_attempts < 0) fail("condition remediation max_attempts is invalid");
  object(value.stability, "condition.stability", ["mode", "require_fresh_environment", "count", "require_distinct_environment"]);
  const stability = { ...value.stability };
  if (stability.mode === "single" && stability.require_fresh_environment === true) {
    if (registry(registries, "adapters")[oracle_ref]?.deterministic !== true) fail("single stability requires deterministic adapter");
  } else if (stability.mode === "consecutive" && Number.isSafeInteger(stability.count) && stability.count >= 2 && stability.require_distinct_environment === true) {
    // valid
  } else fail("condition stability is invalid");
  const depends_on = array(value.depends_on, "condition.depends_on").map((ref, item) => { object(ref, `condition.depends_on[${item}]`, ["kind", "id"]); const kind = string(ref.kind, "condition dependency kind"); if (!["task", "condition"].includes(kind)) fail("condition dependency kind is invalid"); return { kind, id: id(ref.id, "condition dependency id") }; });
  const duplicates = new Set(depends_on.map((ref) => `${ref.kind}:${ref.id}`)); if (duplicates.size !== depends_on.length) fail("condition dependencies are duplicated");
  return { id: conditionId, role, enforcement, statement: string(value.statement, "condition.statement"), observable: string(value.observable, "condition.observable"), expected: string(value.expected, "condition.expected"), depends_on, oracle_ref, environment_ref, fixture_refs, invalidation, remediation: { policy, allowed_paths: remediationPaths, max_attempts: value.remediation.max_attempts }, stability };
}

export function normalizeRuntimeGoalInit(input, registries) {
  object(input, "runtime init", ["objective", "scope", "non_goals", "dod", "execution"]);
  if (Object.hasOwn(input, "tasks")) fail("top-level tasks cannot be mixed with execution");
  const execution = object(input.execution, "execution", ["schema", "tasks", "conditions", "write_policy", "budgets"]);
  if (execution.schema !== "goal-runtime.v1") fail("execution.schema must be goal-runtime.v1");
  object(execution.write_policy, "execution.write_policy", ["allowed_paths"]);
  const allowed_paths = paths(execution.write_policy.allowed_paths, "execution.write_policy.allowed_paths");
  const tasks = array(execution.tasks ?? [], "execution.tasks").map(normalizeTask); if (new Set(tasks.map((task) => task.id)).size !== tasks.length) fail("task ids are duplicated");
  try { validateTaskDefinitions(tasks.map((task) => task.id), Object.fromEntries(tasks.map(({ id: taskId, ...task }) => [taskId, task])), { requireNonEmpty: false, runtimeAcceptance: true }); } catch (error) { fail(error.message); }
  if (tasks.some((task) => task.writePaths.some((path) => !subset(path, allowed_paths)))) fail("task writePaths exceed write policy");
  const conditions = array(execution.conditions ?? [], "execution.conditions").map((condition, index) => normalizeCondition(condition, index, allowed_paths, registries));
  if (!tasks.length && !conditions.length) fail("tasks or conditions must be non-empty");
  if (new Set(conditions.map((condition) => condition.id)).size !== conditions.length) fail("condition ids are duplicated");
  const taskIds = new Set(tasks.map((task) => task.id)), conditionIds = new Set(conditions.map((condition) => condition.id));
  for (const condition of conditions) {
    for (const ref of condition.depends_on) if (!(ref.kind === "task" ? taskIds : conditionIds).has(ref.id)) fail("condition dependency is unknown");
    if (condition.invalidation.task_ids.some((taskId) => !taskIds.has(taskId))) fail("condition invalidation task is unknown");
  }
  const edges = new Map(conditions.map((condition) => [condition.id, condition.depends_on.filter((ref) => ref.kind === "condition").map((ref) => ref.id)]));
  const visiting = new Set(), visited = new Set(); const visit = (conditionId) => { if (visiting.has(conditionId)) fail("condition dependency cycle"); if (visited.has(conditionId)) return; visiting.add(conditionId); edges.get(conditionId).forEach(visit); visiting.delete(conditionId); visited.add(conditionId); }; edges.forEach((_, conditionId) => visit(conditionId));
  object(execution.budgets, "execution.budgets", ["max_observations", "max_repairs", "max_elapsed_minutes", "max_no_progress"]);
  const budgets = {}; for (const key of ["max_observations", "max_repairs", "max_elapsed_minutes", "max_no_progress"]) { if (!Number.isSafeInteger(execution.budgets[key]) || execution.budgets[key] < 0) fail(`budget ${key} is invalid`); budgets[key] = execution.budgets[key]; }
  const normalizeText = (key) => Object.hasOwn(input, key) ? array(input[key], key).map((entry, index) => string(entry, `${key}[${index}]`)) : [];
  return freeze({ objective: string(input.objective, "objective"), scope: normalizeText("scope"), non_goals: normalizeText("non_goals"), dod: normalizeText("dod"), execution: { schema: "goal-runtime.v1", tasks, conditions, write_policy: { allowed_paths }, budgets } });
}
export function hashRuntimeExecutionContract(contract) { return createHash("sha256").update(JSON.stringify(canonicalize(contract))).digest("hex"); }
export function deriveInitialShape(contract) { const tasks = contract?.execution?.tasks?.length > 0, conditions = contract?.execution?.conditions?.length > 0; if (tasks && conditions) return "hybrid"; if (tasks) return "planned"; if (conditions) return "convergent"; fail("contract has no obligations"); }
export function validateRuntimeReadiness(contract, registries) {
  const reasons = []; if (!contract || contract.execution?.schema !== "goal-runtime.v1") return { readiness: "unsafe_to_run", reasons: ["invalid runtime contract"] };
  for (const condition of contract.execution.conditions) { if (!known(registries, "adapters", condition.oracle_ref)) reasons.push(`unknown adapter ${condition.oracle_ref}`); else if (!known(registries, "environments", condition.environment_ref)) reasons.push(`unknown environment ${condition.environment_ref}`); else if (registry(registries, "environments")[condition.environment_ref]?.available !== true) reasons.push(`environment ${condition.environment_ref} is unavailable`); for (const ref of condition.fixture_refs) if (!known(registries, "fixtures", ref)) reasons.push(`unknown fixture ${ref}`); else if (registry(registries, "fixtures")[ref]?.available !== true) reasons.push(`fixture ${ref} is unavailable`); }
  const readiness = reasons.some((reason) => reason.includes("unavailable")) ? "environment_blocked" : reasons.length ? "needs_clarification" : "ready"; if (!READINESS.has(readiness)) fail("invalid readiness"); return freeze({ readiness, reasons });
}
