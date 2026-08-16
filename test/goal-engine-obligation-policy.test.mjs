import assert from "node:assert/strict";
import test from "node:test";
import { actionableFrontier, nextObligationAction, obligationProgressFingerprint } from "../scripts/lib/goal-engine/obligation-policy.mjs";

const condition = (id, depends_on = []) => ({ definition: { id, depends_on, stability: { mode: "single" } }, status: "unsatisfied" });
const base = () => ({ runtimeGeneration: "goal-runtime.v1", runtimeState: "active", lifecycle: "active", executionRevision: 1, tasks: new Map(), taskApplicability: new Map(), conditions: new Map(), observationRuns: new Map(), findings: new Map(), repairEpisodes: new Map(), convergenceBudget: { max_observations: 4, max_repairs: 2, max_elapsed_minutes: 30, max_no_progress: 2, createdAt: "2026-01-01T00:00:00.000Z" } });
const world = () => ({ safe: true, repo: { head: "a".repeat(40) }, resources: [], activeRuns: [], capturedAt: "2026-01-01T00:01:00.000Z" });

test("running future Task does not starve an independent runnable Condition", () => {
  const projection = base(); projection.tasks.set("running", { status: "running" }); projection.conditions.set("ready", condition("ready"));
  const frontier = actionableFrontier({ projection, worldSnapshot: world(), taskActions: new Map([["running", { allowedActions: [], requiredNextAction: null }]]), observationInventory: {} });
  assert.deepEqual(frontier.actions.map((x) => [x.kind, x.id]), [["condition", "ready"]]);
  assert.equal(nextObligationAction(frontier).id, "ready"); assert(Object.isFrozen(frontier)); assert(Object.isFrozen(frontier.actions));
});

test("priority and canonical id selection are stable", () => {
  const projection = base(); projection.conditions.set("z", condition("z")); projection.conditions.set("a", condition("a"));
  projection.observationRuns.set("r", { runId: "r", conditionId: "z", phase: "terminal" });
  const frontier = actionableFrontier({ projection, worldSnapshot: world(), taskActions: {}, observationInventory: {} });
  assert.deepEqual(frontier.actions.map((x) => [x.kind, x.id, x.priority]), [["observation-record", "r", 2], ["condition", "a", 5]]);
  assert.deepEqual(nextObligationAction(frontier), frontier.actions[0]);
});

test("dependency freshness, local resources, repair and finalize gates are explicit", () => {
  const projection = base(); projection.conditions.set("blocked", condition("blocked", [{ kind: "condition", id: "stale" }])); projection.conditions.set("stale", { ...condition("stale"), status: "stale" }); projection.conditions.set("free", condition("free"));
  projection.conditions.set("busy", { ...condition("busy"), definition: { ...condition("busy").definition, resourceClaims: [{ key: "db", mode: "exclusive" }] } });
  const snapshot = world(); snapshot.resources = [{ key: "db", capacity: 1, holders: ["other"] }];
  const frontier = actionableFrontier({ projection, worldSnapshot: snapshot, taskActions: {}, observationInventory: { claims: { busy: [{ key: "db", mode: "exclusive" }] } } });
  assert(frontier.actions.some((x) => x.id === "free")); assert(!frontier.actions.some((x) => x.id === "busy")); assert(frontier.blocking.some((x) => x.id === "blocked")); assert(frontier.blocking.some((x) => x.id === "busy"));
});

test("full priority order puts recovery, terminal facts, task disposition, repair, runnable and finalize candidates in order", () => {
  const projection = base(); projection.suspension = { suspensionId: "s" }; projection.tasks.set("t", { status: "pending" }); projection.conditions.set("c", condition("c"));
  projection.observationRuns.set("debt", { runId: "debt", conditionId: "c", phase: "cleanup_debt" }); projection.observationRuns.set("terminal", { runId: "terminal", conditionId: "c", phase: "terminal" });
  projection.repairEpisodes.set("repair", { status: "active" });
  const frontier = actionableFrontier({ projection, worldSnapshot: world(), taskActions: { t: { requiredNextAction: { tool: "goal_accept", params: {}, reason: "accept" } } }, observationInventory: {} });
  assert.deepEqual(frontier.actions.map(x => x.priority), [1, 1, 2, 3, 4]);
});

test("budget authority fails closed and finalize requires fresh settled facts", () => {
  const projection = base(); projection.conditions.set("c", { ...condition("c"), status: "satisfied", freshness: "fresh" }); projection.tasks.set("t", { status: "accepted" });
  let frontier = actionableFrontier({ projection, worldSnapshot: world(), taskActions: {}, observationInventory: {} });
  assert.equal(frontier.completeCandidate, false); assert(frontier.attention.some(x => x.code === "NO_PROGRESS_AUTHORITY_UNAVAILABLE"));
  projection.evidenceHistory = []; frontier = actionableFrontier({ projection, worldSnapshot: world(), taskActions: {}, observationInventory: {} });
  assert.equal(frontier.completeCandidate, true); assert.equal(frontier.actions[0].kind, "finalize");
});

test("fingerprint excludes noise but includes obligation semantics", () => {
  const projection = base(); projection.tasks.set("t", { status: "accepted", workspace: { phase: "disposed", disposition: "integrated", released: true } }); projection.conditions.set("c", { ...condition("c"), status: "satisfied" });
  const a = obligationProgressFingerprint({ projection: structuredClone(projection), worldSnapshot: world() });
  const noisy = structuredClone(projection); noisy.version = 99; noisy.checkpoint = "noise"; noisy.actionOffer = { token: "secret", id: "x" };
  assert.equal(a, obligationProgressFingerprint({ projection: noisy, worldSnapshot: { ...world(), capturedAt: "later" } }));
  noisy.conditions.get("c").status = "stale"; assert.notEqual(a, obligationProgressFingerprint({ projection: noisy, worldSnapshot: world() }));
});
