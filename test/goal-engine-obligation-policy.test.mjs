import assert from "node:assert/strict";
import test from "node:test";
import { taskActionState } from "../scripts/lib/goal-engine/graph.mjs";
import { actionableFrontier, nextObligationAction, obligationProgressFingerprint } from "../scripts/lib/goal-engine/obligation-policy.mjs";

const condition = (id, status = "unsatisfied", depends_on = []) => ({ definition: { id, depends_on, stability: { mode: "consecutive", count: 2 } }, status });
const base = () => ({ runtimeGeneration: "goal-runtime.v1", runtimeState: "active", lifecycle: "active", createdAt: "2026-01-01T00:00:00.000Z", tasks: new Map(), taskApplicability: new Map(), conditions: new Map(), observationRuns: new Map(), findings: new Map(), repairEpisodes: new Map(), repairChallenges: new Map(), convergenceBudget: { max_observations: 4, max_repairs: 2, max_elapsed_minutes: 30, max_no_progress: 2 } });
const world = () => ({ safe: true, repo: { head: "a".repeat(40) }, resources: [], activeRuns: [], capturedAt: "2026-01-01T00:01:00.000Z" });
const ledger = () => [{ canonicalFingerprint: "a".repeat(64), advanced: true, sequence: 1 }];

function frontier(projection, snapshot = world(), taskActions = new Map(), observationInventory = { claims: new Map() }) { return actionableFrontier({ projection, worldSnapshot: snapshot, taskActions, observationInventory }); }

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

test("priority order and zero budget boundary keep only terminal debt actions", () => {
  const projection = base(); projection.progressLedger = ledger(); projection.conditions.set("c", condition("c")); projection.observationRuns.set("r", { runId: "r", conditionId: "c", phase: "terminal" }); projection.convergenceBudget.max_observations = 0;
  const result = frontier(projection, world(), new Map(), { claims: new Map([["c", []]]) });
  assert.deepEqual(result.actions.map(item => item.kind), ["observation-record"]); assert(result.blocking.some(item => item.code === "OBSERVATION_BUDGET_EXHAUSTED"));
});

test("finalize needs a valid ledger and all settled facts", () => {
  const projection = base(); projection.tasks.set("t", { status: "accepted" }); projection.conditions.set("c", { ...condition("c", "satisfied"), freshness: "fresh", supportingEvidenceIds: ["a", "b"] });
  assert.equal(frontier(projection).completeCandidate, false); projection.progressLedger = ledger(); const result = frontier(projection); assert.equal(result.completeCandidate, true); assert.equal(nextObligationAction(result).kind, "finalize");
});
