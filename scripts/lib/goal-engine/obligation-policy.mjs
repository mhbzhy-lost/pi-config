import { createHash } from "node:crypto";

const ACTION_FIELDS = ["kind", "id", "priority", "tool", "params", "reason"];
const TERMINAL = new Set(["terminal", "recorded", "released", "cleanup_debt"]);
const ACTIVE = new Set(["requested", "lease_allocated", "process_bound"]);
const TASK_ACTIONS = new Set(["goal_dispatch", "goal_settle", "goal_integrate", "goal_accept", "goal_amend"]);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value instanceof Map ? canonical(Object.fromEntries([...value.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))))) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const freeze = value => { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; for (const child of Object.values(value)) freeze(child); return Object.freeze(value); };
const rows = value => (value instanceof Map ? [...value.entries()] : value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : []).sort(([a], [b]) => String(a).localeCompare(String(b)));
const values = value => rows(value).map(([, item]) => item);
const byId = value => new Map(rows(value));
const cleanId = value => typeof value === "string" && /^[A-Za-z0-9._-]{1,160}$/.test(value);
const add = (actions, kind, id, priority, tool, params, reason) => actions.push({ kind, id, priority, tool, params, reason });
const note = (list, kind, id, code) => list.push({ kind, id, code });
const sort = list => list.sort((a, b) => a.priority - b.priority || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));

function validInput({ projection, worldSnapshot, taskActions, observationInventory }) {
  if (!projection || typeof projection !== "object" || !(projection.tasks instanceof Map || projection.tasks === undefined) || !(projection.conditions instanceof Map || projection.conditions === undefined) || !worldSnapshot || typeof worldSnapshot !== "object" || !taskActions || typeof taskActions !== "object" || !observationInventory || typeof observationInventory !== "object") throw new Error("invalid obligation policy input");
}
function applicability(projection, id) { return byId(projection.taskApplicability).get(id)?.state ?? "applicable"; }
function depsReady(state, projection, blocking, id) {
  const deps = state?.definition?.depends_on ?? state?.definition?.dependsOn;
  if (!Array.isArray(deps)) { note(blocking, "condition", id, "CONDITION_DEPENDENCY_AUTHORITY_UNAVAILABLE"); return false; }
  for (const dep of deps) {
    if (!dep || !cleanId(dep.id) || !["task", "condition"].includes(dep.kind)) { note(blocking, "condition", id, "INVALID_CONDITION_DEPENDENCY"); return false; }
    if (dep.kind === "task") {
      const task = byId(projection.tasks).get(dep.id);
      if (!task || task.status !== "accepted" || applicability(projection, dep.id) === "reverify_required") { note(blocking, "condition", id, "TASK_PREDECESSOR_NOT_ACCEPTED"); return false; }
    } else {
      const predecessor = byId(projection.conditions).get(dep.id);
      if (!predecessor || predecessor.status !== "satisfied" || predecessor.freshness === "stale" || predecessor.status === "stale" || predecessor.status === "blocked") { note(blocking, "condition", id, "CONDITION_PREDECESSOR_NOT_FRESH"); return false; }
    }
  }
  return true;
}
function claimsFor(state, id, inventory) {
  const claims = inventory.claims instanceof Map ? inventory.claims.get(id) : inventory.claims?.[id];
  const declared = claims ?? state?.definition?.resourceClaims ?? state?.definition?.resource_claims ?? [];
  if (!Array.isArray(declared)) return null;
  if (declared.some(c => !c || !cleanId(c.key) || !["exclusive", "shared"].includes(c.mode ?? "exclusive"))) return null;
  return declared;
}
function resourceBlocked(claims, resources) {
  const map = new Map();
  for (const resource of resources ?? []) { if (!resource || !cleanId(resource.key) || map.has(resource.key) || !Number.isSafeInteger(resource.capacity) || resource.capacity < 0 || !Array.isArray(resource.holders) || new Set(resource.holders).size !== resource.holders.length) return true; map.set(resource.key, resource); }
  return claims.some(claim => { const resource = map.get(claim.key); if (!resource) return true; return claim.mode === "exclusive" ? resource.holders.length > 0 : resource.holders.length >= resource.capacity; });
}
function safeTaskAction(id, state) {
  const action = state?.requiredNextAction;
  if (!action || !TASK_ACTIONS.has(action.tool) || typeof action.reason !== "string") return null;
  const params = { task_id: id };
  for (const [key, value] of Object.entries(action.params ?? {})) if (["action", "strategy"].includes(key) && typeof value === "string") params[key] = value;
  const disposition = ["goal_settle", "goal_integrate", "goal_accept", "goal_amend"].includes(action.tool);
  return { priority: disposition ? 3 : 5, tool: action.tool, params, reason: action.reason };
}
function budgetFacts(projection, world, blocking, attention) {
  const budget = projection.convergenceBudget ?? projection.budgets ?? {};
  const runs = values(projection.observationRuns), episodes = values(projection.repairEpisodes);
  const observationCount = runs.filter(run => Number.isInteger(run.cycle) && run.cycle > 0).length;
  const repairCount = episodes.length;
  if (Number.isSafeInteger(budget.max_observations) && observationCount >= budget.max_observations) note(blocking, "budget", "observations", "OBSERVATION_BUDGET_EXHAUSTED");
  if (Number.isSafeInteger(budget.max_repairs) && repairCount >= budget.max_repairs) note(blocking, "budget", "repairs", "REPAIR_BUDGET_EXHAUSTED");
  if (Number.isSafeInteger(budget.max_elapsed_minutes)) {
    const created = Date.parse(budget.createdAt ?? projection.createdAt); const captured = Date.parse(world.capturedAt);
    if (!Number.isFinite(created) || !Number.isFinite(captured)) note(attention, "budget", "elapsed", "ELAPSED_BUDGET_AUTHORITY_UNAVAILABLE");
    else if (captured - created >= budget.max_elapsed_minutes * 60000) note(blocking, "budget", "elapsed", "ELAPSED_BUDGET_EXHAUSTED");
  }
  if (Number.isSafeInteger(budget.max_no_progress)) {
    const ledger = projection.progressLedger ?? projection.evidenceHistory;
    if (!Array.isArray(ledger)) note(attention, "budget", "no-progress", "NO_PROGRESS_AUTHORITY_UNAVAILABLE");
    else if (ledger.filter(row => row?.progress === false || row?.kind === "no_progress").length >= budget.max_no_progress) note(blocking, "budget", "no-progress", "NO_PROGRESS_BUDGET_EXHAUSTED");
  }
}

export function actionableFrontier(input = {}) {
  validInput(input); const { projection, worldSnapshot: world, taskActions, observationInventory: inventory } = input;
  const actions = [], blocking = [], attention = [];
  if (world.safe === false) note(blocking, "world", "snapshot", "WORLD_SNAPSHOT_UNSAFE");
  const suspension = projection.suspension;
  if (projection.runtimeState === "suspended" || suspension) add(actions, "suspension-recovery", suspension?.suspensionId ?? "runtime", 1, "goal_resume", {}, "Suspension requires reconciliation before obligations continue");
  for (const [id, run] of rows(projection.observationRuns)) {
    const runId = run?.runId ?? id;
    if (!cleanId(runId) || !cleanId(run?.conditionId ?? "")) { note(attention, "observation", String(runId), "OBSERVATION_IDENTITY_UNAVAILABLE"); continue; }
    if (run.phase === "cleanup_debt") add(actions, "resource-recovery", runId, 1, "recover_observation", { run_id: runId }, "Observation cleanup debt requires recovery");
    else if (run.phase === "terminal") add(actions, "observation-record", runId, 2, "record_observation", { run_id: runId }, "Terminal observation must be recorded before release");
    else if (run.phase === "recorded") add(actions, "observation-release", runId, 2, "release_observation", { run_id: runId }, "Recorded observation must release its resources");
    else if (ACTIVE.has(run.phase)) note(blocking, "observation", runId, "OBSERVATION_FUTURE_WAKE");
    else if (!TERMINAL.has(run.phase)) note(attention, "observation", runId, "OBSERVATION_PHASE_UNKNOWN");
  }
  for (const [id, task] of rows(projection.tasks)) {
    const action = safeTaskAction(id, byId(taskActions).get(id));
    if (action && applicability(projection, id) !== "superseded") add(actions, "task", id, action.priority, action.tool, action.params, action.reason);
    else if (["dispatched", "running", "settling"].includes(task?.status)) note(blocking, "task", id, "TASK_FUTURE_WAKE");
  }
  for (const [id, finding] of rows(projection.findings)) if (["open", "repairing", "reverification"].includes(finding?.status)) note(blocking, "finding", finding.findingId ?? id, "FINDING_REQUIRES_REPAIR");
  for (const [id, episode] of rows(projection.repairEpisodes)) {
    const pendingChallenge = episode?.pendingUserChallenge || values(projection.repairChallenges).some(challenge => challenge?.episodeId === id && ["created", "approved"].includes(challenge.phase));
    if (["active", "waiting_for_tasks", "reverifying", "blocked", "cancel_pending"].includes(episode?.status)) {
      if (episode.status === "active" && pendingChallenge) note(attention, "repair", id, "PENDING_USER_CAPABILITY");
      else add(actions, "repair", id, 4, "repair_episode", { episode_id: id }, "Repair episode requires disposition or reverification");
    }
    if (episode?.cancellation?.resourceDebt) note(blocking, "repair", id, "RESOURCE_DEBT");
  }
  for (const [id, state] of rows(projection.conditions)) {
    if (!cleanId(id) || !state?.definition) { note(attention, "condition", String(id), "CONDITION_IDENTITY_UNAVAILABLE"); continue; }
    if (["satisfied", "observing"].includes(state.status)) continue;
    if (state.status === "blocked") { note(blocking, "condition", id, "CONDITION_BLOCKED"); continue; }
    const activeRun = values(projection.observationRuns).some(run => run?.conditionId === id && run.phase !== "released");
    if (activeRun) { note(blocking, "condition", id, "OBSERVATION_CYCLE_NOT_RELEASED"); continue; }
    if (!depsReady(state, projection, blocking, id)) continue;
    const claims = claimsFor(state, id, inventory);
    if (!claims) { note(attention, "condition", id, "RESOURCE_CLAIM_AUTHORITY_UNAVAILABLE"); continue; }
    if (resourceBlocked(claims, world.resources)) { note(blocking, "condition", id, "RESOURCE_CONFLICT"); continue; }
    add(actions, "condition", id, 5, "request_observation", { condition_id: id }, "Condition is activated and requires fresh observation");
  }
  budgetFacts(projection, world, blocking, attention);
  const activeRuns = Array.isArray(world.activeRuns) && world.activeRuns.some(run => !["terminal", "released", "cancelled"].includes(run?.state));
  if (activeRuns) note(blocking, "world", "active-runs", "OWNED_ACTIVE_RUN");
  const taskDone = rows(projection.tasks).every(([id, task]) => applicability(projection, id) === "superseded" || task?.status === "accepted");
  const conditionDone = values(projection.conditions).every(state => state?.status === "satisfied" && state.freshness !== "stale");
  const complete = taskDone && conditionDone && !actions.length && !blocking.length && !attention.length && !suspension && !activeRuns;
  if (complete) add(actions, "finalize", "goal", 6, "goal_finalize", {}, "All obligations have durable terminal facts");
  return freeze({ actions: sort(actions).map(action => freeze(Object.fromEntries(ACTION_FIELDS.map(key => [key, action[key]])))), blocking: sort(blocking), attention: sort(attention), completeCandidate: complete });
}

export function nextObligationAction(frontier) {
  if (!frontier || !Array.isArray(frontier.actions)) throw new Error("invalid frontier");
  const action = [...frontier.actions].sort((a, b) => a.priority - b.priority || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))[0];
  return action ? freeze(structuredClone(action)) : null;
}

export function obligationProgressFingerprint({ projection, worldSnapshot } = {}) {
  if (!projection || !worldSnapshot || typeof projection !== "object" || typeof worldSnapshot !== "object") throw new Error("projection and world snapshot are required");
  const tasks = rows(projection.tasks).map(([id, task]) => [id, { status: task?.status, applicability: applicability(projection, id), workspace: task?.workspace ? { phase: task.workspace.phase, disposition: task.workspace.disposition, released: task.workspace.released } : null }]);
  const conditions = rows(projection.conditions).map(([id, state]) => [id, { status: state?.status, freshness: state?.freshness, evidence: state?.supportingEvidenceIds }]);
  const runs = rows(projection.observationRuns).map(([id, run]) => [id, { conditionId: run?.conditionId, cycle: run?.cycle, phase: run?.phase, terminal: run?.terminalProofHash, evidence: run?.evidenceId, released: run?.releaseReceiptHash }]);
  const payload = { executionRevision: projection.executionRevision, tasks, conditions, runs, findings: rows(projection.findings).map(([id, f]) => [id, { status: f?.status, conditionId: f?.conditionId }]), repairs: rows(projection.repairEpisodes).map(([id, e]) => [id, { status: e?.status, resourceDebt: e?.cancellation?.resourceDebt }]), suspension: projection.suspension ? { reason: projection.suspension.reason, id: projection.suspension.suspensionId } : null, budget: projection.convergenceBudget ?? projection.budgets, world: { repo: { head: worldSnapshot.repo?.head, root: worldSnapshot.repo?.root }, resources: worldSnapshot.resources, activeRuns: worldSnapshot.activeRuns, safe: worldSnapshot.safe } };
  return createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
}
