import assert from "node:assert/strict";
import test from "node:test";
import { deriveFindingFromFailedEvidence, openRepairEpisode, repairEpisodeTransition, validateRemediationTask } from "../scripts/lib/goal-engine/repair-policy.mjs";

const hash = (letter) => letter.repeat(64);
function projection() {
  return {
    goalId: "goal-1", executionRevision: 3, writePolicy: { allowedPaths: ["src/**", "test/**"] },
    conditions: new Map([["c-1", { definition: { remediation: { policy: "autonomous", allowed_paths: ["src/fix/**", "test/fix/**"] } } }]]),
    findings: new Map(), repairEpisodes: new Map(), tasks: new Map(), observationRuns: new Map(),
  };
}
function failed() { return { kind: "failed", evidenceId: hash("a"), failureCode: "FAIL", findingFingerprint: hash("b"), identity: { goalId: "goal-1", conditionId: "c-1", executionRevision: 3, runId: "run-1" } }; }
function task(writePaths = ["src/fix/a.mjs"]) { return { description: "修复失败条件", deps: [], writePaths, acceptance: { criteria: ["通过复验"], commands: ["node --test test/fix/a.test.mjs"] }, workflow: "tdd" }; }

test("only canonical failed Host evidence derives a bound finding and fingerprint is idempotent", () => {
  const p = projection();
  const first = deriveFindingFromFailedEvidence({ projection: p, evidence: failed() });
  assert.deepEqual(first.events, [{ type: "finding.recorded", data: { findingId: first.finding.findingId, conditionId: "c-1", runId: "run-1", evidenceId: hash("a"), fingerprint: hash("b"), verdict: "failed" } }]);
  p.findings.set(first.finding.findingId, first.finding);
  assert.equal(deriveFindingFromFailedEvidence({ projection: p, evidence: failed() }).finding.findingId, first.finding.findingId);
  for (const evidence of [{ ...failed(), kind: "passed" }, { ...failed(), kind: "inconclusive" }, { ...failed(), kind: "infrastructure_error" }, { ...failed(), error: "caller text" }, { ...failed(), identity: { ...failed().identity, goalId: "other" } }]) assert.throws(() => deriveFindingFromFailedEvidence({ projection: p, evidence }), /canonical|failed|identity|unknown/i);
});

test("opens one episode for multiple same-revision open findings without writing projection", () => {
  const p = projection();
  p.findings.set("f-1", { findingId: "f-1", conditionId: "c-1", executionRevision: 3, status: "open", episodeId: null });
  p.findings.set("f-2", { findingId: "f-2", conditionId: "c-1", executionRevision: 3, status: "open", episodeId: null });
  const result = openRepairEpisode({ projection: p, findingIds: ["f-1", "f-2"] });
  assert.deepEqual(result.events, [{ type: "repair.episode_opened", data: { episodeId: result.episodeId, conditionId: "c-1", findingIds: ["f-1", "f-2"] } }]);
  assert.equal(p.findings.get("f-1").status, "open");
  p.findings.get("f-2").episodeId = "active";
  assert.throws(() => openRepairEpisode({ projection: p, findingIds: ["f-1", "f-2"] }), /active|open/i);
});

test("remediation tasks prove autonomous scope or require a separate challenge-bound capability", () => {
  const p = projection(); p.repairEpisodes.set("ep-1", { episodeId: "ep-1", conditionId: "c-1", findingIds: ["f-1"], remediationTaskIds: [], status: "active" });
  p.findings.set("f-1", { findingId: "f-1", conditionId: "c-1", executionRevision: 3, status: "repairing", episodeId: "ep-1" });
  const result = validateRemediationTask({ projection: p, episodeId: "ep-1", findingIds: ["f-1"], taskDef: task() });
  assert.deepEqual(result.taskDef.metadata, { kind: "remediation", findingIds: ["f-1"], episodeId: "ep-1" });
  assert.deepEqual(result.events, [{ type: "repair.task_linked", data: { episodeId: "ep-1", taskId: result.taskId } }]);
  assert.throws(() => validateRemediationTask({ projection: p, episodeId: "ep-1", findingIds: ["f-1"], taskDef: task(["src/other/a.mjs"]) }), /subset|scope/i);
  p.conditions.get("c-1").definition.remediation.policy = "user-approved";
  assert.throws(() => validateRemediationTask({ projection: p, episodeId: "ep-1", findingIds: ["f-1"], taskDef: task() }), /capability/i);
  assert.doesNotThrow(() => validateRemediationTask({ projection: p, episodeId: "ep-1", findingIds: ["f-1"], taskDef: task(), capability: { prefix: "goal-repair-capability.v1", goalId: "goal-1", executionRevision: 3, episodeId: "ep-1", challenge: "challenge-1", nonce: "nonce-1", singleUse: true } }));
});

test("accepted repair only requests reverification; fresh pass or real user rejection closes", () => {
  const p = projection(); p.repairEpisodes.set("ep-1", { episodeId: "ep-1", conditionId: "c-1", findingIds: ["f-1"], remediationTaskIds: ["t-1"], status: "waiting_for_tasks" }); p.findings.set("f-1", { findingId: "f-1", conditionId: "c-1", executionRevision: 3, status: "repairing", episodeId: "ep-1" });
  const accepted = repairEpisodeTransition({ projection: p, episodeId: "ep-1", event: { type: "task.accepted", taskId: "t-1" } });
  assert.equal(accepted.events[0].type, "repair.reverification_requested");
  assert.throws(() => repairEpisodeTransition({ projection: p, episodeId: "ep-1", event: { type: "condition.observation_recorded", conditionId: "c-1", runId: "old", verdict: "passed", fresh: true } }), /reverifying/i);
  p.repairEpisodes.get("ep-1").status = "reverifying";
  assert.deepEqual(repairEpisodeTransition({ projection: p, episodeId: "ep-1", event: { type: "condition.observation_recorded", conditionId: "c-1", runId: "run-2", verdict: "inconclusive" } }).events, []);
  assert.deepEqual(repairEpisodeTransition({ projection: p, episodeId: "ep-1", event: { type: "condition.observation_recorded", conditionId: "c-1", runId: "run-3", verdict: "failed" } }).events, []);
  const passed = repairEpisodeTransition({ projection: p, episodeId: "ep-1", event: { type: "condition.observation_recorded", conditionId: "c-1", runId: "run-4", verdict: "passed", fresh: true } });
  assert.equal(passed.events[0].type, "repair.episode_resolved");
  assert.throws(() => repairEpisodeTransition({ projection: p, episodeId: "ep-1", event: { type: "finding.status_changed", findingId: "f-1", status: "rejected_by_user" } }), /user/i);
});

test("cancellation remains pending until every owned resource closes and debt never finalizes", () => {
  const p = projection(); p.repairEpisodes.set("ep-1", { episodeId: "ep-1", conditionId: "c-1", findingIds: ["f-1"], remediationTaskIds: ["t-1"], status: "waiting_for_tasks" });
  p.tasks.set("t-1", { status: "accepted" }); p.observationRuns.set("run-1", { phase: "released" });
  const cancellation = { ownedTaskIds: ["t-1"], ownedRunIds: ["run-1"], terminalProofRefs: ["terminal-1"], workspaceClosureProofRefs: ["workspace-1"], resourceClosureProofRefs: ["resource-1"], resourceDebt: false };
  const request = repairEpisodeTransition({ projection: p, episodeId: "ep-1", event: { type: "cancel", cancellation } });
  assert.equal(request.events[0].type, "repair.episode_cancel_requested");
  assert.throws(() => repairEpisodeTransition({ projection: p, episodeId: "ep-1", event: { type: "cancelled", cancellation } }), /cancel_pending/i);
  p.repairEpisodes.get("ep-1").status = "cancel_pending";
  assert.equal(repairEpisodeTransition({ projection: p, episodeId: "ep-1", event: { type: "cancelled", cancellation } }).events[0].type, "repair.episode_cancelled");
  assert.throws(() => repairEpisodeTransition({ projection: p, episodeId: "ep-1", event: { type: "cancelled", cancellation: { ...cancellation, resourceDebt: true } } }), /debt/i);
});
