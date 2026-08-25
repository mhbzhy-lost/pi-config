import { createHash } from "node:crypto";
import { suspensionClosureStatus } from "./suspension.mjs";

const ACTION_FIELDS = ["kind", "id", "priority", "tool", "params", "reason"];
const ACTIVE_RUN_PHASES = new Set(["requested", "lease_allocated", "process_bound"]);
const TASK_TOOLS = new Set(["goal_dispatch", "goal_settle", "goal_integrate", "goal_accept", "goal_amend"]);
const ID = /^[A-Za-z0-9._-]{1,160}$/;

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const collection = (value, name) => {
  if (value instanceof Map) return [...value.entries()].sort(([a], [b]) => String(a).localeCompare(String(b)));
  if (isObject(value)) return Object.entries(value).sort(([a], [b]) => String(a).localeCompare(String(b)));
  throw new Error(`invalid ${name}`);
};
const values = (value, name) => collection(value, name).map(([, item]) => item);
const lookup = (value, name) => new Map(collection(value, name));
const validId = value => typeof value === "string" && ID.test(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value instanceof Map ? canonical(Object.fromEntries(collection(value, "map"))) : isObject(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const freeze = value => { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; for (const child of Object.values(value)) freeze(child); return Object.freeze(value); };
const ordered = entries => entries.sort((a, b) => a.priority - b.priority || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
const note = (list, kind, id, code) => list.push({ kind, id, code });
const action = (list, kind, id, priority, tool, params, reason) => list.push({ kind, id, priority, tool, params, reason });

function validInput(input) {
  if (!isObject(input) || !isObject(input.projection) || !isObject(input.worldSnapshot) || !isObject(input.taskActions) && !(input.taskActions instanceof Map) || !isObject(input.observationInventory)) throw new Error("invalid obligation policy input");
  for (const name of ["tasks", "conditions", "observationRuns", "findings", "repairEpisodes", "taskApplicability", "repairChallenges"]) collection(input.projection[name] ?? {}, name);
  if (input.observationInventory.claims !== undefined) collection(input.observationInventory.claims, "observation claims");
}
function taskApplicability(projection, id) { return lookup(projection.taskApplicability ?? {}, "taskApplicability").get(id)?.state ?? "applicable"; }
function dependencyReady(state, projection, blocking, id) {
  const deps = state?.definition?.depends_on ?? state?.definition?.dependsOn;
  if (!Array.isArray(deps)) { note(blocking, "condition", id, "CONDITION_DEPENDENCY_AUTHORITY_UNAVAILABLE"); return false; }
  const tasks = lookup(projection.tasks ?? {}, "tasks"), conditions = lookup(projection.conditions ?? {}, "conditions");
  for (const dep of deps) {
    if (!isObject(dep) || !validId(dep.id) || !["task", "condition"].includes(dep.kind)) { note(blocking, "condition", id, "INVALID_CONDITION_DEPENDENCY"); return false; }
    if (dep.kind === "task") {
      const task = tasks.get(dep.id), applicability = taskApplicability(projection, dep.id);
      if (!task || applicability === "reverify_required" || (applicability !== "superseded" && task.status !== "accepted")) { note(blocking, "condition", id, "TASK_PREDECESSOR_NOT_ACCEPTED"); return false; }
    } else {
      const prior = conditions.get(dep.id);
      if (!prior || prior.status !== "satisfied" || prior.freshness === "stale") { note(blocking, "condition", id, "CONDITION_PREDECESSOR_NOT_FRESH"); return false; }
    }
  }
  return true;
}
function claimsFor(id, inventory) {
  const claims = lookup(inventory.claims ?? {}, "observation claims").get(id);
  if (!Array.isArray(claims)) return null;
  const seen = new Set();
  if (claims.some(claim => !isObject(claim) || Object.keys(claim).length !== 4 || !["key", "mode", "capacity", "reset"].every(key => Object.hasOwn(claim, key)) || !validId(claim.key) || !["exclusive", "shared"].includes(claim.mode) || !Number.isSafeInteger(claim.capacity) || claim.capacity < 1 || typeof claim.reset !== "string" || !claim.reset || seen.has(claim.key) || !seen.add(claim.key))) return null;
  return claims;
}
function resourceBlocked(claims, resources) {
  if (!Array.isArray(resources)) return true;
  const map = new Map();
  for (const resource of resources) {
    if (!isObject(resource) || Object.keys(resource).some(key => !["key", "holders", "capacity"].includes(key)) || !validId(resource.key) || map.has(resource.key) || !Number.isSafeInteger(resource.capacity) || resource.capacity < 1 || !Array.isArray(resource.holders) || resource.holders.some(holder => !validId(holder)) || new Set(resource.holders).size !== resource.holders.length) return true;
    map.set(resource.key, resource);
  }
  return claims.some(claim => { const resource = map.get(claim.key); return !resource || resource.capacity !== claim.capacity || (claim.mode === "exclusive" ? resource.holders.length !== 0 : resource.holders.length >= resource.capacity); });
}
function progressAuthority(projection, blocking, attention) {
  const ledger = projection.progressLedger;
  if (!Array.isArray(ledger) || !ledger.length) { note(attention, "budget", "no-progress", "NO_PROGRESS_AUTHORITY_UNAVAILABLE"); return false; }
  let last = 0, previous = null;
  if (ledger.some((row, index) => { const invalid = !isObject(row) || Object.keys(row).length !== 3 || !["canonicalFingerprint", "advanced", "sequence"].every(key => Object.hasOwn(row, key)) || !/^[a-f0-9]{64}$/.test(row.canonicalFingerprint) || typeof row.advanced !== "boolean" || !Number.isSafeInteger(row.sequence) || row.sequence <= last || (index === 0 ? !row.advanced : row.advanced === (row.canonicalFingerprint === previous)); last = row?.sequence; previous = row?.canonicalFingerprint; return invalid; })) { note(attention, "budget", "no-progress", "NO_PROGRESS_AUTHORITY_UNAVAILABLE"); return false; }
  const max = projection.convergenceBudget?.max_no_progress ?? projection.budgets?.max_no_progress;
  let tail = 0; for (const row of [...ledger].reverse()) { if (row.advanced) break; tail++; }
  if (Number.isSafeInteger(max) && max >= 0 && tail > 0 && tail >= max) note(blocking, "budget", "no-progress", "NO_PROGRESS_BUDGET_EXHAUSTED");
  return true;
}
function budgetFacts(projection, world, blocking, attention) {
  const budget = projection.convergenceBudget ?? projection.budgets ?? {};
  const runs = values(projection.observationRuns ?? {}, "observationRuns"), episodes = values(projection.repairEpisodes ?? {}, "repairEpisodes");
  const observationExhausted = Number.isSafeInteger(budget.max_observations) && runs.filter(run => Number.isSafeInteger(run?.cycle) && run.cycle > 0).length >= budget.max_observations;
  const repairExhausted = Number.isSafeInteger(budget.max_repairs) && episodes.length >= budget.max_repairs;
  if (Number.isSafeInteger(budget.max_elapsed_minutes) && projection.runtimeState === "active") {
    const elapsed = projection.runtimeActiveElapsedMs, since = projection.runtimeActiveSince, end = Date.parse(world.capturedAt);
    const canonical = value => typeof value === "string" && Number.isSafeInteger(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
    const limit = budget.max_elapsed_minutes * 60000;
    if (!Number.isSafeInteger(elapsed) || elapsed < 0 || !canonical(since) || !canonical(world.capturedAt) || !Number.isSafeInteger(end) || end < Date.parse(since) || !Number.isSafeInteger(limit) || !Number.isSafeInteger(elapsed + end - Date.parse(since))) note(attention, "budget", "elapsed", "ELAPSED_BUDGET_AUTHORITY_UNAVAILABLE");
    else if (elapsed + end - Date.parse(since) >= limit) note(blocking, "budget", "elapsed", "ELAPSED_BUDGET_EXHAUSTED");
  }
  progressAuthority(projection, blocking, attention);
  return { observationExhausted, repairExhausted };
}
function safeTaskAction(id, state) {
  const next = state?.requiredNextAction;
  if (!isObject(next) || !TASK_TOOLS.has(next.tool) || typeof next.reason !== "string" || !isObject(next.params)) return null;
  const params = { task_id: id }; for (const key of ["action", "strategy"]) if (typeof next.params[key] === "string") params[key] = next.params[key];
  return { tool: next.tool, params, reason: next.reason, priority: ["goal_settle", "goal_integrate", "goal_accept", "goal_amend"].includes(next.tool) ? 3 : 5 };
}

export function actionableFrontier(input = {}) {
  validInput(input); const { projection, worldSnapshot: world, taskActions, observationInventory: inventory } = input;
  const actions = [], blocking = [], attention = [];
  if (world.safe !== true) note(blocking, "world", "snapshot", "WORLD_SNAPSHOT_UNSAFE");
  if (projection.pendingHumanDecision) note(blocking, "decision", "pending", "PENDING_HUMAN_DECISION");
  const suspension = projection.suspension;
  const suspensionClosure = suspension ? suspensionClosureStatus(projection) : null;
  if (projection.runtimeState === "suspended" || suspension) {
    if (suspensionClosure?.complete && !projection.pendingHumanDecision) action(actions, "suspension-recovery", suspension?.suspensionId ?? "runtime", 1, "goal_amend", { operation: "resume_runtime" }, "Suspension closure is complete");
    else {
      if (suspensionClosure?.missingTerminalRunIds.length) note(blocking, "suspension", "terminal", "SUSPENSION_TERMINAL_PROOF_PENDING");
      if (suspensionClosure?.missingWorkspaceTaskIds.length) note(blocking, "suspension", "workspace", "SUSPENSION_WORKSPACE_CLOSURE_PENDING");
      if (suspensionClosure?.missingResourceOwnerIds.length) note(blocking, "suspension", "resource", "SUSPENSION_RESOURCE_CLOSURE_PENDING");
    }
  }
  const activeWorldRuns = Array.isArray(world.activeRuns) ? world.activeRuns : null, conflictedRuns = new Set();
  if (!activeWorldRuns) note(attention, "world", "active-runs", "ACTIVE_RUN_AUTHORITY_UNAVAILABLE");
  else {
    const seen = new Set();
    if (activeWorldRuns.some(candidate => !isObject(candidate) || Object.keys(candidate).length !== 3 || !["runId", "kind", "state"].every(key => Object.hasOwn(candidate, key)) || !validId(candidate.runId) || !["executor", "observation"].includes(candidate.kind) || typeof candidate.state !== "string" || !candidate.state || seen.has(candidate.runId) || !seen.add(candidate.runId))) note(attention, "world", "active-runs", "ACTIVE_RUN_AUTHORITY_UNAVAILABLE");
    for (const [key, run] of collection(projection.observationRuns ?? {}, "observationRuns")) {
      const id = run?.runId ?? key, active = activeWorldRuns.some(candidate => candidate?.runId === id);
      if ((["requested", "lease_allocated"].includes(run?.phase) && active) || (["terminal", "recorded", "released"].includes(run?.phase) && active)) { conflictedRuns.add(id); note(attention, "observation", String(id), "OBSERVATION_RUN_STATE_CONFLICT"); }
    }
    if (activeWorldRuns.length) note(blocking, "world", "active-runs", "OWNED_ACTIVE_RUN");
  }
  for (const [key, run] of collection(projection.observationRuns ?? {}, "observationRuns")) {
    const id = run?.runId ?? key; if (!validId(id) || !validId(run?.conditionId)) { note(attention, "observation", String(id), "OBSERVATION_IDENTITY_UNAVAILABLE"); continue; }
    if (run.phase === "cleanup_debt") action(actions, "resource-recovery", id, 1, "recover_observation", { run_id: id }, "Observation cleanup debt requires recovery");
    else if (conflictedRuns.has(id)) continue;
    else if (["requested", "lease_allocated"].includes(run.phase)) action(actions, "observation-start", id, 5, "observation_start", { run_id: id, condition_id: run.conditionId, cycle: run.cycle }, "Durable observation requires start");
    else if (run.phase === "process_bound") { if (activeWorldRuns?.some(candidate => candidate?.runId === id)) note(blocking, "observation", id, "OBSERVATION_FUTURE_WAKE"); else action(actions, "observation-recover", id, 1, "observation_recover", { run_id: id, condition_id: run.conditionId }, "Bound observation requires recovery"); }
    else if (run.phase === "terminal") action(actions, "observation-record", id, 2, "record_observation", { run_id: id }, "Terminal observation must be recorded");
    else if (run.phase === "recorded") action(actions, "observation-release", id, 2, "release_observation", { run_id: id }, "Recorded observation must release resources");
    else if (run.phase !== "released") note(attention, "observation", id, "OBSERVATION_PHASE_UNKNOWN");
  }
  for (const [id, task] of collection(projection.tasks ?? {}, "tasks")) {
    const app = taskApplicability(projection, id); if (app === "reverify_required") { action(actions, "task-reverify", id, 3, "goal_amend", { task_id: id }, "Task requires reverify"); note(blocking, "task", id, "TASK_REVERIFY_REQUIRED"); continue; }
    if (app === "superseded") continue;
    const bound = task?.executorBinding?.runId; const active = validId(bound) && activeWorldRuns?.some(run => run?.runId === bound);
    const next = safeTaskAction(id, lookup(taskActions, "taskActions").get(id));
    if (active && next?.tool === "goal_settle") note(blocking, "task", id, "TASK_FUTURE_WAKE"); else if (next) action(actions, "task", id, next.priority, next.tool, next.params, next.reason); else if (["dispatched", "running", "settling"].includes(task?.status)) note(blocking, "task", id, "TASK_FUTURE_WAKE");
  }
  for (const [id, finding] of collection(projection.findings ?? {}, "findings")) if (finding?.status === "open") { action(actions, "repair-open", finding.findingId ?? id, 4, "materialize_repair", { finding_id: finding.findingId ?? id }, "Open finding requires repair materialization"); note(blocking, "finding", finding.findingId ?? id, "FINDING_REQUIRES_REPAIR"); } else if (["repairing", "reverification"].includes(finding?.status)) note(blocking, "finding", finding.findingId ?? id, "FINDING_REQUIRES_REPAIR");
  for (const [id, episode] of collection(projection.repairEpisodes ?? {}, "repairEpisodes")) { const pending = values(projection.repairChallenges ?? {}, "repairChallenges").some(challenge => challenge?.episodeId === id && ["created", "approved", "consumed"].includes(challenge.phase) && !challenge.applied); if (pending) note(attention, "repair", id, "PENDING_USER_CAPABILITY"); else if (episode?.status === "waiting_for_tasks") note(blocking, "repair", id, "REPAIR_TASKS_PENDING"); else if (episode?.status === "reverifying") { const ownedUnfinished = values(projection.observationRuns ?? {}, "observationRuns").some(run => episode.ownedRunIds?.includes(run?.runId) && ["requested", "lease_allocated", "process_bound", "terminal", "recorded"].includes(run?.phase)); if (ownedUnfinished) note(blocking, "repair", id, "REPAIR_REVERIFICATION_PENDING"); else action(actions, "repair", id, 4, "repair_episode", { episode_id: id }, "Repair episode requires reobservation"); } else if (["active", "cancel_pending"].includes(episode?.status)) action(actions, "repair", id, 4, "repair_episode", { episode_id: id }, "Repair episode requires attention"); if (episode?.cancellation?.resourceDebt) note(blocking, "repair", id, "RESOURCE_DEBT"); }
  for (const [id, state] of collection(projection.conditions ?? {}, "conditions")) {
    if (!validId(id) || !state?.definition) { note(attention, "condition", String(id), "CONDITION_IDENTITY_UNAVAILABLE"); continue; }
    const deps = dependencyReady(state, projection, blocking, id); if (state.status === "blocked") { note(blocking, "condition", id, "CONDITION_BLOCKED"); continue; } if (state.status === "satisfied" && state.freshness !== "stale") continue;
    const hasActive = values(projection.observationRuns ?? {}, "observationRuns").some(run => run?.conditionId === id && ACTIVE_RUN_PHASES.has(run.phase)); if (hasActive) { note(blocking, "condition", id, "OBSERVATION_CYCLE_NOT_RELEASED"); continue; }
    if (!deps) continue; const claims = claimsFor(id, inventory); if (!claims) { note(attention, "condition", id, "RESOURCE_CLAIM_AUTHORITY_UNAVAILABLE"); continue; } if (resourceBlocked(claims, world.resources)) { note(blocking, "condition", id, "RESOURCE_CONFLICT"); continue; } const cycle = values(projection.observationRuns ?? {}, "observationRuns").filter(run => run?.conditionId === id && Number.isSafeInteger(run.cycle) && run.cycle >= 1).reduce((max, run) => Math.max(max, run.cycle), 0) + 1; action(actions, "condition", id, 5, "request_observation", { condition_id: id, cycle }, "Condition requires fresh observation");
  }
  const { observationExhausted, repairExhausted } = budgetFacts(projection, world, blocking, attention);
  const budgetPermitted = actions.filter(item => {
    if (observationExhausted && item.tool === "request_observation") { note(blocking, "budget", item.id, "OBSERVATION_BUDGET_EXHAUSTED"); return false; }
    if (repairExhausted && item.tool === "materialize_repair") { note(blocking, "budget", item.id, "REPAIR_BUDGET_EXHAUSTED"); return false; }
    return true;
  });
  const runtimeState = projection.runtimeState;
  if (projection.lifecycle !== "active") note(blocking, "runtime", "lifecycle", "RUNTIME_LIFECYCLE_INACTIVE");
  if (["draft", "awaiting_user_approval"].includes(runtimeState)) note(blocking, "runtime", runtimeState, "RUNTIME_READINESS_REQUIRED");
  if (runtimeState === "calibrating") note(blocking, "runtime", runtimeState, "RUNTIME_CALIBRATION_REQUIRED");
  const globalGate = blocking.some(item => ["WORLD_SNAPSHOT_UNSAFE", "ELAPSED_BUDGET_EXHAUSTED", "NO_PROGRESS_BUDGET_EXHAUSTED", "PENDING_HUMAN_DECISION", "RUNTIME_LIFECYCLE_INACTIVE", "RUNTIME_READINESS_REQUIRED", "RUNTIME_CALIBRATION_REQUIRED"].includes(item.code)) || attention.some(item => ["NO_PROGRESS_AUTHORITY_UNAVAILABLE", "OBSERVATION_RUN_STATE_CONFLICT", "ACTIVE_RUN_AUTHORITY_UNAVAILABLE"].includes(item.code));
  const debtAction = item => ["suspension-recovery", "resource-recovery", "observation-record", "observation-release"].includes(item.kind) || (item.kind === "task" && ["goal_settle", "goal_integrate", "goal_accept"].includes(item.tool));
  const suspensionDebtAction = item => ["suspension-recovery", "resource-recovery", "observation-record", "observation-release"].includes(item.kind) || (item.kind === "task" && (item.tool === "goal_settle" || (item.tool === "goal_integrate" && ["discard", "preserve"].includes(item.params.action))));
  const permitted = runtimeState === "suspended" || suspension ? budgetPermitted.filter(suspensionDebtAction) : globalGate ? budgetPermitted.filter(debtAction) : runtimeState === "active" && projection.lifecycle === "active" ? budgetPermitted : [];
  const tasksDone = collection(projection.tasks ?? {}, "tasks").every(([id, task]) => { const app = taskApplicability(projection, id); return app === "superseded" || (app === "applicable" && task?.status === "accepted"); });
  const conditionsDone = collection(projection.conditions ?? {}, "conditions").every(([, state]) => state?.status === "satisfied" && state.freshness !== "stale" && dependencyReady(state, projection, [], "complete"));
  const complete = tasksDone && conditionsDone && !permitted.length && !blocking.length && !attention.length && !suspension;
  if (complete) action(permitted, "finalize", "goal", 6, "goal_finalize", {}, "All obligations have durable terminal facts");
  return freeze({ actions: ordered(permitted).map(item => Object.fromEntries(ACTION_FIELDS.map(key => [key, item[key]]))), blocking: ordered(blocking.map(item => ({ ...item, priority: 0 }))).map(({ priority, ...item }) => item), attention: ordered(attention.map(item => ({ ...item, priority: 0 }))).map(({ priority, ...item }) => item), completeCandidate: complete });
}

export function nextObligationAction(frontier) {
  if (!isObject(frontier) || !Array.isArray(frontier.actions)) throw new Error("invalid frontier");
  for (const candidate of frontier.actions) if (!isObject(candidate) || Object.keys(candidate).length !== ACTION_FIELDS.length || !ACTION_FIELDS.every(key => Object.hasOwn(candidate, key)) || !validId(candidate.id) || !Number.isSafeInteger(candidate.priority) || candidate.priority < 1 || candidate.priority > 6 || typeof candidate.kind !== "string" || typeof candidate.tool !== "string" || !isObject(candidate.params) || typeof candidate.reason !== "string") throw new Error("invalid frontier action");
  const selected = ordered([...frontier.actions])[0]; return selected ? freeze(structuredClone(selected)) : null;
}

export function obligationProgressFingerprint({ projection, worldSnapshot } = {}) {
  if (!isObject(projection) || !isObject(worldSnapshot)) throw new Error("projection and world snapshot are required");
  const tasks = collection(projection.tasks ?? {}, "tasks").map(([id, task]) => [id, { status: task?.status, applicability: taskApplicability(projection, id), workspace: task?.workspace ? { phase: task.workspace.phase, disposition: task.workspace.disposition, released: task.workspace.released } : null }]);
  const conditions = collection(projection.conditions ?? {}, "conditions").map(([id, state]) => [id, { status: state?.status, freshness: state?.freshness, passStreak: Array.isArray(state?.supportingEvidenceIds) ? state.supportingEvidenceIds.length : 0 }]);
  const runs = values(projection.observationRuns ?? {}, "observationRuns").map(run => ({ conditionId: run?.conditionId, cycle: run?.cycle, phase: run?.phase })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const activeRuns = Array.isArray(worldSnapshot.activeRuns) ? worldSnapshot.activeRuns.map(run => ({ kind: run?.kind, state: run?.state })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : worldSnapshot.activeRuns;
  const payload = { tasks, conditions, runs, findings: collection(projection.findings ?? {}, "findings").map(([, finding]) => ({ conditionId: finding?.conditionId, status: finding?.status })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), repairs: collection(projection.repairEpisodes ?? {}, "repairEpisodes").map(([, episode]) => ({ conditionId: episode?.conditionId, status: episode?.status, resourceDebt: episode?.cancellation?.resourceDebt === true })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), suspension: projection.suspension ? { reason: projection.suspension.reason } : null, budget: projection.convergenceBudget ?? projection.budgets, world: { head: worldSnapshot.repo?.head, resources: worldSnapshot.resources, activeRuns, safe: worldSnapshot.safe } };
  return createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
}
