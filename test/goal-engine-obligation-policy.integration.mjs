import assert from "node:assert/strict";
import test from "node:test";
import { taskActionState } from "../scripts/lib/goal-engine/graph.mjs";
import { actionableFrontier, nextObligationAction, obligationProgressFingerprint } from "../scripts/lib/goal-engine/obligation-policy.mjs";
import { suspensionClosureStatus } from "../scripts/lib/goal-engine/suspension.mjs";

const condition = (id, status = "unsatisfied", depends_on = []) => ({ definition: { id, depends_on, stability: { mode: "consecutive", count: 2 } }, status });
const base = () => ({ runtimeGeneration: "goal-runtime.v1", runtimeState: "active", lifecycle: "active", createdAt: "2026-01-01T00:00:00.000Z", runtimeActiveElapsedMs: 0, runtimeActiveSince: "2026-01-01T00:00:00.000Z", tasks: new Map(), taskApplicability: new Map(), conditions: new Map(), observationRuns: new Map(), findings: new Map(), repairEpisodes: new Map(), repairChallenges: new Map(), convergenceBudget: { max_observations: 4, max_repairs: 2, max_elapsed_minutes: 30, max_no_progress: 2 } });
const world = () => ({ safe: true, repo: { head: "a".repeat(40) }, resources: [], activeRuns: [], capturedAt: "2026-01-01T00:01:00.000Z" });
const ledger = () => [{ canonicalFingerprint: "a".repeat(64), advanced: true, sequence: 1 }];

function frontier(projection, snapshot = world(), taskActions = new Map(), observationInventory = { claims: new Map() }) { return actionableFrontier({ projection, worldSnapshot: snapshot, taskActions, observationInventory }); }

test("elapsed budget counts only active execution intervals and fails closed without their authority", () => {
  const suspended = base(); suspended.runtimeState = "suspended"; suspended.runtimeActiveElapsedMs = 29 * 60_000; suspended.runtimeActiveSince = null;
  const tomorrow = world(); tomorrow.capturedAt = "2026-01-02T00:00:00.000Z";
  let result = frontier(suspended, tomorrow);
  assert.equal(result.blocking.some(item => item.code === "ELAPSED_BUDGET_EXHAUSTED"), false, "a suspended Goal must not consume its elapsed budget overnight");

  const active = base(); active.runtimeActiveElapsedMs = 20 * 60_000; active.runtimeActiveSince = "2026-01-01T00:20:00.000Z";
  const afterTenActiveMinutes = world(); afterTenActiveMinutes.capturedAt = "2026-01-01T00:30:00.000Z";
  result = frontier(active, afterTenActiveMinutes);
  assert(result.blocking.some(item => item.code === "ELAPSED_BUDGET_EXHAUSTED"), "separate active intervals must cumulatively exhaust the budget");

  const missing = base(); delete missing.runtimeActiveElapsedMs; delete missing.runtimeActiveSince;
  result = frontier(missing, tomorrow);
  assert(result.attention.some(item => item.code === "ELAPSED_BUDGET_AUTHORITY_UNAVAILABLE"));
  assert.equal(result.blocking.some(item => item.code === "ELAPSED_BUDGET_EXHAUSTED"), false, "missing runtime authority must not fall back to createdAt");
});

test("actual taskActionState active executor suppresses settle but not independent condition", () => {
  const projection = base(); projection.progressLedger = ledger(); projection.tasks.set("running", { status: "dispatched" }); projection.conditions.set("ready", condition("ready"));
  const action = taskActionState(projection, "running"); const snapshot = world(); snapshot.activeRuns = [{ runId: "run-1", kind: "executor", state: "running" }]; projection.tasks.get("running").executorBinding = { runId: "run-1" };
  const result = frontier(projection, snapshot, new Map([["running", action]]), { claims: new Map([["ready", []]]) });
  assert(!result.actions.some(x => x.id === "running")); assert(result.actions.some(x => x.id === "ready")); assert(result.blocking.some(x => x.code === "TASK_FUTURE_WAKE"));
});

test("released observing condition gets its next stability cycle, active one future-wakes", () => {
  const projection = base(); projection.progressLedger = ledger(); projection.conditions.set("c", condition("c", "observing")); projection.observationRuns.set("r", { runId: "r", conditionId: "c", cycle: 1, phase: "released" });
  assert(frontier(projection, world(), new Map(), { claims: new Map([["c", []]]) }).actions.some(x => x.id === "c")); projection.observationRuns.get("r").phase = "process_bound";
  assert(frontier(projection, world(), new Map(), { claims: new Map([["c", []]]) }).blocking.some(x => x.code === "OBSERVATION_CYCLE_NOT_RELEASED"));
});

test("satisfied downstream with stale predecessor blocks completion while unrelated condition acts", () => {
  const projection = base(); projection.progressLedger = ledger(); projection.conditions.set("up", condition("up", "stale")); projection.conditions.set("down", condition("down", "satisfied", [{ kind: "condition", id: "up" }])); projection.conditions.set("free", condition("free"));
  const result = frontier(projection, world(), new Map(), { claims: new Map([["free", []]]) }); assert(result.blocking.some(x => x.id === "down" && x.code === "CONDITION_PREDECESSOR_NOT_FRESH")); assert(result.actions.some(x => x.id === "free")); assert.equal(result.completeCandidate, false);
});

test("Map and object projections have the same frontier and fingerprint", () => {
  const map = base(); map.conditions.set("c", condition("c")); map.progressLedger = ledger();
  const object = { ...map, tasks: {}, taskApplicability: {}, conditions: Object.fromEntries(map.conditions), observationRuns: {}, findings: {}, repairEpisodes: {}, repairChallenges: {} };
  assert.deepEqual(frontier(map), frontier(object, world(), {}, { claims: {} })); assert.equal(obligationProgressFingerprint({ projection: map, worldSnapshot: world() }), obligationProgressFingerprint({ projection: object, worldSnapshot: world() }));
});

test("open findings, challenges, applicability and resource claims are explicit and local", () => {
  const projection = base(); projection.progressLedger = ledger(); projection.findings.set("f", { findingId: "f", conditionId: "c", status: "open" }); projection.conditions.set("c", condition("c")); projection.conditions.set("free", condition("free")); projection.taskApplicability.set("t", { state: "reverify_required" }); projection.tasks.set("t", { status: "accepted" });
  let result = frontier(projection); assert(result.actions.some(x => x.kind === "repair-open")); assert(result.actions.some(x => x.id === "t")); assert(result.attention.some(x => x.code === "RESOURCE_CLAIM_AUTHORITY_UNAVAILABLE"));
  const snapshot = world(); snapshot.resources = [{ key: "db", capacity: 1, holders: ["other"] }]; projection.conditions.get("c").definition.resourceClaims = [{ key: "db", mode: "exclusive", capacity: 1, reset: "host" }];
  result = frontier(projection, snapshot, new Map(), { claims: { c: [{ key: "db", mode: "exclusive", capacity: 1, reset: "host" }], free: [] } }); assert(result.blocking.some(x => x.id === "c" && x.code === "RESOURCE_CONFLICT")); assert(result.actions.some(x => x.id === "free"));
});

test("unsafe, budget, missing no-progress authority and pending decisions suppress business actions but retain debts", () => {
  const projection = base(); projection.conditions.set("c", condition("c")); projection.findings.set("f", { status: "open", conditionId: "c" }); projection.observationRuns.set("r", { runId: "r", conditionId: "c", phase: "terminal" }); projection.pendingHumanDecision = { phase: "approved" };
  const snapshot = world(); snapshot.safe = false; const result = frontier(projection, snapshot);
  assert(result.actions.some(x => x.kind === "observation-record")); assert(!result.actions.some(x => ["condition", "repair-open", "finalize", "task"].includes(x.kind))); assert(result.attention.some(x => x.code === "NO_PROGRESS_AUTHORITY_UNAVAILABLE"));
});

test("fingerprint ignores random proof IDs but tracks semantic changes, and next action rejects forged shapes", () => {
  const projection = base(); projection.progressLedger = ledger(); projection.conditions.set("c", { ...condition("c", "satisfied"), supportingEvidenceIds: ["e1", "e2"] }); projection.observationRuns.set("r", { runId: "random", conditionId: "c", cycle: 2, phase: "released", terminalProofHash: "x", evidenceId: "e1", releaseReceiptHash: "z" });
  const a = obligationProgressFingerprint({ projection, worldSnapshot: world() }); const noisy = structuredClone(projection); noisy.observationRuns.get("r").runId = "other"; noisy.observationRuns.get("r").terminalProofHash = "y"; noisy.conditions.get("c").supportingEvidenceIds = ["new1", "new2"];
  assert.equal(a, obligationProgressFingerprint({ projection: noisy, worldSnapshot: world() })); noisy.observationRuns.get("r").phase = "terminal"; assert.notEqual(a, obligationProgressFingerprint({ projection: noisy, worldSnapshot: world() }));
  assert.throws(() => nextObligationAction({ actions: [{ kind: "condition", id: "c", priority: 5, tool: "request_observation", params: {}, reason: "x", secret: "no" }] }));
});

test("zero observation budget suppresses only a new cycle while terminal observation debt continues", () => {
  const projection = base(); projection.progressLedger = ledger(); projection.conditions.set("c", condition("c")); projection.observationRuns.set("r", { runId: "r", conditionId: "c", phase: "terminal" }); projection.convergenceBudget.max_observations = 0;
  const result = frontier(projection, world(), new Map(), { claims: new Map([["c", []]]) });
  assert.deepEqual(result.actions.map(item => item.kind), ["observation-record"]); assert(result.blocking.some(item => item.code === "OBSERVATION_BUDGET_EXHAUSTED"));
});

test("zero observation and repair budgets do not block an unrelated pending Task dispatch", () => {
  const projection = base(); projection.progressLedger = ledger(); projection.tasks.set("task", { status: "pending" }); projection.convergenceBudget.max_observations = 0; projection.convergenceBudget.max_repairs = 0;
  const result = frontier(projection, world(), new Map([["task", { requiredNextAction: { tool: "goal_dispatch", params: {}, reason: "runnable" } }]]));
  assert.equal(nextObligationAction(result)?.tool, "goal_dispatch"); assert(!result.blocking.some(item => ["OBSERVATION_BUDGET_EXHAUSTED", "REPAIR_BUDGET_EXHAUSTED"].includes(item.code)));
});

test("zero observation and repair budgets allow finalize after all obligations settle", () => {
  const projection = base(); projection.progressLedger = ledger(); projection.tasks.set("task", { status: "accepted" }); projection.conditions.set("c", { ...condition("c", "satisfied"), freshness: "fresh" }); projection.convergenceBudget.max_observations = 0; projection.convergenceBudget.max_repairs = 0;
  const result = frontier(projection);
  assert.equal(result.completeCandidate, true); assert.equal(nextObligationAction(result)?.tool, "goal_finalize"); assert(!result.blocking.some(item => ["OBSERVATION_BUDGET_EXHAUSTED", "REPAIR_BUDGET_EXHAUSTED"].includes(item.code)));
});

test("zero repair budget suppresses materialization but keeps existing repair closure and reverification actionable", () => {
  const projection = base(); projection.progressLedger = ledger(); projection.convergenceBudget.max_repairs = 0; projection.findings.set("open", { findingId: "open", status: "open" }); projection.repairEpisodes.set("closing", { status: "active" }); projection.repairEpisodes.set("reverifying", { status: "reverifying", ownedRunIds: [] });
  const result = frontier(projection);
  assert(!result.actions.some(item => item.tool === "materialize_repair")); assert(result.actions.some(item => item.id === "closing" && item.tool === "repair_episode")); assert(result.actions.some(item => item.id === "reverifying" && item.tool === "repair_episode")); assert(result.blocking.some(item => item.id === "open" && item.code === "REPAIR_BUDGET_EXHAUSTED"));
});

test("finalize needs a valid ledger and all settled facts", () => {
  const projection = base(); projection.tasks.set("t", { status: "accepted" }); projection.conditions.set("c", { ...condition("c", "satisfied"), freshness: "fresh", supportingEvidenceIds: ["a", "b"] });
  assert.equal(frontier(projection).completeCandidate, false); projection.progressLedger = ledger(); const result = frontier(projection); assert.equal(result.completeCandidate, true); assert.equal(nextObligationAction(result).kind, "finalize");
});

test("stale conditions restart at the next durable cycle", () => {
  const projection = base(); projection.progressLedger = ledger(); projection.conditions.set("c", condition("c", "stale")); projection.observationRuns.set("old", { runId: "old", conditionId: "c", cycle: 2, phase: "released" });
  const result = frontier(projection, world(), new Map(), { claims: new Map([["c", []]]) });
  assert.deepEqual(result.actions.find(x => x.kind === "condition")?.params, { condition_id: "c", cycle: 3 });
});

test("requested and lease observations start, while process binding wakes or recovers from inventory", () => {
  for (const phase of ["requested", "lease_allocated"]) { const projection = base(); projection.progressLedger = ledger(); projection.observationRuns.set("r", { runId: "r", conditionId: "c", cycle: 2, phase }); const result = frontier(projection); assert.deepEqual(result.actions[0]?.params, { run_id: "r", condition_id: "c", cycle: 2 }); assert.equal(result.actions[0]?.kind, "observation-start"); }
  const projection = base(); projection.progressLedger = ledger(); projection.observationRuns.set("r", { runId: "r", conditionId: "c", cycle: 2, phase: "process_bound" });
  assert.equal(frontier(projection).actions[0]?.kind, "observation-recover");
  const snapshot = world(); snapshot.activeRuns = [{ runId: "r", kind: "observation", state: "running" }]; assert(frontier(projection, snapshot).blocking.some(x => x.code === "OBSERVATION_FUTURE_WAKE"));
});

test("run conflicts suppress their terminal actions and active run identifiers do not affect fingerprints", () => {
  const projection = base(); projection.progressLedger = ledger(); projection.observationRuns.set("r", { runId: "r", conditionId: "c", cycle: 1, phase: "terminal" }); const snapshot = world(); snapshot.activeRuns = [{ runId: "r", kind: "observation", state: "running" }];
  const result = frontier(projection, snapshot); assert(!result.actions.some(x => x.kind === "observation-record")); assert(result.attention.some(x => x.code === "OBSERVATION_RUN_STATE_CONFLICT"));
  const a = obligationProgressFingerprint({ projection, worldSnapshot: snapshot }); snapshot.activeRuns[0].runId = "other"; assert.equal(a, obligationProgressFingerprint({ projection, worldSnapshot: snapshot })); snapshot.activeRuns[0].state = "stopped"; assert.notEqual(a, obligationProgressFingerprint({ projection, worldSnapshot: snapshot }));
});

test("non-active runtime states do not offer product actions", () => {
  for (const runtimeState of ["draft", "awaiting_user_approval", "calibrating", "suspended"]) { const projection = base(); projection.runtimeState = runtimeState; projection.progressLedger = ledger(); projection.conditions.set("c", condition("c")); projection.findings.set("f", { findingId: "f", status: "open" }); const result = frontier(projection, world(), new Map(), { claims: new Map([["c", []]]) }); assert(!result.actions.some(x => ["condition", "repair-open", "repair"].includes(x.kind)), runtimeState); if (runtimeState === "calibrating") assert(result.blocking.some(x => x.code === "RUNTIME_CALIBRATION_REQUIRED")); }
});

test("incomplete suspension closure blocks resume with canonical missing IDs", () => {
  const projection = base(); projection.runtimeState = "suspended"; projection.suspension = { suspensionId: "s", reason: "host_pause", resourcesQuarantined: false, affectedTaskIds: ["task-b", "task-a", "task-a"], affectedRunIds: ["run-b", "run-a", "run-a"], terminalProofRefs: [], workspaceClosureProofRefs: [], resourceClosureProofRefs: [] }; projection.progressLedger = ledger();
  const closure = suspensionClosureStatus(projection), result = frontier(projection);
  assert.deepEqual(closure, { complete: false, missingTerminalRunIds: ["run-a", "run-b"], missingWorkspaceTaskIds: ["task-a", "task-b"], missingResourceOwnerIds: ["run-a", "run-b"] });
  assert.equal(Object.isFrozen(closure), true);
  assert.equal(Object.isFrozen(closure.missingTerminalRunIds), true);
  assert.equal(result.actions.some(x => x.params.operation === "resume_runtime"), false);
  assert.deepEqual(result.blocking.map(x => x.code).filter(code => code.startsWith("SUSPENSION_")).sort(), ["SUSPENSION_RESOURCE_CLOSURE_PENDING", "SUSPENSION_TERMINAL_PROOF_PENDING", "SUSPENSION_WORKSPACE_CLOSURE_PENDING"]);
});

test("full suspension closure retains terminal safety debt and issues one exact-eight resume amendment", () => {
  const projection = base(); projection.runtimeState = "suspended"; projection.suspension = { suspensionId: "s", reason: "host_pause", resourcesQuarantined: true, affectedTaskIds: [], affectedRunIds: [], terminalProofRefs: [], workspaceClosureProofRefs: [], resourceClosureProofRefs: [] }; projection.progressLedger = ledger(); projection.observationRuns.set("r", { runId: "r", conditionId: "c", cycle: 1, phase: "terminal" });
  const actions = frontier(projection).actions;
  assert(actions.some(x => x.kind === "observation-record"));
  assert.equal(actions.filter(x => x.tool === "goal_amend" && x.params.operation === "resume_runtime").length, 1);
  assert.equal(actions.some(x => x.tool === "goal_resume"), false);
});

test("waiting remediation blocks without starving its pending Task dispatch", () => {
  const projection = base(); projection.progressLedger = ledger(); projection.tasks.set("repair-task", { status: "pending" }); projection.repairEpisodes.set("episode", { status: "waiting_for_tasks", remediationTaskIds: ["repair-task"] });
  const result = frontier(projection, world(), new Map([["repair-task", { requiredNextAction: { tool: "goal_dispatch", params: {}, reason: "runnable" } }]]));
  assert.equal(nextObligationAction(result)?.tool, "goal_dispatch"); assert(result.blocking.some((item) => item.code === "REPAIR_TASKS_PENDING")); assert(!result.actions.some((item) => item.tool === "repair_episode"));
});

test("accepted planned Task action is not suppressed by an unrelated reverifying Episode", () => {
  const projection = base(); projection.progressLedger = ledger(); projection.tasks.set("accepted", { status: "accepted" }); projection.repairEpisodes.set("episode", { episodeId: "episode", status: "reverifying", ownedRunIds: [] });
  const result = frontier(projection, world(), new Map([["accepted", { requiredNextAction: { tool: "goal_accept", params: { task_id: "accepted" }, reason: "planned completion", priority: 1 } }]]));
  assert.equal(result.actions.some(item => item.id === "accepted" && item.tool === "goal_accept"), true);
});

test("reverifying Episode requests an owned run once and then yields to its lifecycle", () => {
  const projection = base(); projection.progressLedger = ledger(); projection.conditions.set("c", condition("c"));
  projection.repairEpisodes.set("episode", { episodeId: "episode", conditionId: "c", status: "reverifying", ownedRunIds: [] });
  let result = frontier(projection, world(), new Map(), { claims: new Map([["c", []]]) });
  assert.equal(nextObligationAction(result)?.tool, "repair_episode");
  projection.observationRuns.set("owned", { runId: "owned", conditionId: "c", cycle: 1, phase: "requested" });
  projection.repairEpisodes.get("episode").ownedRunIds.push("owned");
  result = frontier(projection, world(), new Map(), { claims: new Map([["c", []]]) });
  assert.equal(nextObligationAction(result)?.tool, "observation_start");
  assert(result.blocking.some(item => item.code === "REPAIR_REVERIFICATION_PENDING" && item.id === "episode"));
  projection.observationRuns.get("owned").phase = "released";
  result = frontier(projection, world(), new Map(), { claims: new Map([["c", []]]) });
  assert.equal(nextObligationAction(result)?.tool, "repair_episode");
});

test("R9 keeps owned reverification lifecycle phases ahead of repair and only released unresolved runs re-request", () => {
  for (const phase of ["requested", "lease_allocated", "process_bound", "terminal", "recorded"]) {
    const projection = base(); projection.progressLedger = ledger(); projection.conditions.set("c", condition("c")); projection.repairEpisodes.set("episode", { episodeId: "episode", conditionId: "c", status: "reverifying", ownedRunIds: ["owned"] }); projection.observationRuns.set("owned", { runId: "owned", conditionId: "c", cycle: 1, phase });
    const action = nextObligationAction(frontier(projection, world(), new Map(), { claims: new Map([["c", []]]) }));
    assert.notEqual(action?.tool, "repair_episode", phase); assert.equal(action?.kind, phase === "terminal" ? "observation-record" : phase === "recorded" ? "observation-release" : phase === "process_bound" ? "observation-recover" : "observation-start", phase);
  }
  const projection = base(); projection.progressLedger = ledger(); projection.conditions.set("c", condition("c")); projection.repairEpisodes.set("episode", { episodeId: "episode", conditionId: "c", status: "reverifying", ownedRunIds: ["owned"] }); projection.observationRuns.set("owned", { runId: "owned", conditionId: "c", cycle: 1, phase: "released" });
  assert.equal(nextObligationAction(frontier(projection, world(), new Map(), { claims: new Map([["c", []]]) }))?.tool, "repair_episode");
});

test("runtime debts outrank selected repair actions", () => {
  const projection = base(); projection.progressLedger = ledger(); projection.repairEpisodes.set("selected", { status: "active" });
  projection.observationRuns.set("cleanup", { runId: "cleanup", conditionId: "c", phase: "cleanup_debt" });
  projection.observationRuns.set("terminal", { runId: "terminal", conditionId: "c", phase: "terminal" });
  assert.equal(nextObligationAction(frontier(projection)).kind, "resource-recovery");
  projection.observationRuns.delete("cleanup");
  assert.equal(nextObligationAction(frontier(projection)).kind, "observation-record");
  projection.observationRuns.delete("terminal");
  assert.equal(nextObligationAction(frontier(projection)).kind, "repair");
});

test("pending repair capability suppresses its repair action", () => {
  const projection = base(); projection.progressLedger = ledger(); projection.repairEpisodes.set("e", { status: "active" }); projection.repairChallenges.set("challenge", { episodeId: "e", phase: "approved" }); const result = frontier(projection);
  assert(result.attention.some(x => x.id === "e" && x.code === "PENDING_USER_CAPABILITY")); assert(!result.actions.some(x => x.kind === "repair" && x.id === "e"));
});

test("progress ledger permits repeated no-progress fingerprints until its threshold", () => {
  const projection = base(); projection.progressLedger = [ledger()[0], { canonicalFingerprint: "a".repeat(64), advanced: false, sequence: 2 }, { canonicalFingerprint: "a".repeat(64), advanced: false, sequence: 3 }]; projection.convergenceBudget.max_no_progress = 2;
  assert(frontier(projection).blocking.some(x => x.code === "NO_PROGRESS_BUDGET_EXHAUSTED")); projection.progressLedger[1].advanced = true; assert(frontier(projection).attention.some(x => x.code === "NO_PROGRESS_AUTHORITY_UNAVAILABLE"));
});
