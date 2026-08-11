import assert from "node:assert/strict";
import test from "node:test";
import { applyEvent, createProjection } from "../scripts/lib/goal-engine/events.mjs";
import { createGoalEngineExtension } from "../scripts/lib/goal-engine/extension.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function git(cwd, ...args) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function fixturePi(cwd, sessionId) {
  const tools = []; const entries = []; const hooks = {};
  const sessionManager = { getSessionId: () => sessionId, getSessionFile: () => join(cwd, `${sessionId}.jsonl`), getLeafId: () => "leaf", getEntries: () => entries };
  return { tools, entries, hooks, executeContext: { cwd, sessionManager }, sessionManager,
    registerTool(tool) { tools.push(tool); }, on(name, handler) { (hooks[name] ||= []).push(handler); },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
  };
}
async function execute(pi, name, params = {}) {
  const tool = pi.tools.find((item) => item.name === name);
  const result = await tool.execute("test", params, new AbortController().signal, undefined, pi.executeContext);
  return result.content[0].text;
}
async function input(pi, text) {
  for (const handler of pi.hooks.input || []) await handler({ source: "interactive", text, entryId: "approval" }, pi.executeContext);
}
function transferFixture() {
  const cwd = mkdtempSync(join(tmpdir(), "goal-transfer-"));
  git(cwd, "init", "-b", "main"); git(cwd, "config", "user.email", "test@example.invalid"); git(cwd, "config", "user.name", "Test");
  writeFileSync(join(cwd, ".gitignore"), ".state/goal-engine/\n"); git(cwd, "add", ".gitignore"); git(cwd, "commit", "-m", "test: 初始化仓库");
  const owner = fixturePi(cwd, "session-A"); const target = fixturePi(cwd, "session-B");
  createGoalEngineExtension(owner, { goalStateEnv: {} }); createGoalEngineExtension(target, { goalStateEnv: {} });
  return { cwd, owner, target };
}

function event(type, data, occurredAt) {
  return { schemaVersion: "planned.v1", eventId: crypto.randomUUID(), goalId: "transfer-goal", type, occurredAt, data };
}

test("production Extension transfers an unowned Goal only through an approved challenge offer", async () => {
  const { owner, target } = transferFixture();
  const initialized = JSON.parse(await execute(owner, "goal_init", { objective: "Transfer Extension Goal", tasks: [{ id: "t", description: "t", deps: [], writePaths: ["src/a"], workflow: "tdd", acceptance: { criteria: [{ id: "c", statement: "passes", evidenceKinds: ["tests"] }] } }] }));
  const goalId = initialized.goalId;
  assert.equal(await execute(target, "goal_status", { goal_id: goalId }), "NO_ACTIVE_GOAL");
  const listed = JSON.parse(await execute(target, "goal_status", { list_cwd_goals: true }));
  assert.deepEqual(Object.keys(listed[0]), ["goalId", "lifecycle", "ownerSessionId", "ownedByCurrentSession", "transferEligible", "transferBlockedReason"]);
  const proposal = JSON.parse(await execute(target, "goal_amend", { goal_id: goalId, operation: "propose_transfer_session", reason: "continue work" }));
  assert.equal(proposal.status, "TRANSFER_PENDING");
  assert.equal(JSON.parse(await execute(target, "goal_status", { transfer_challenge_id: proposal.challenge_id })).status, "PENDING");
  await input(target, "批准");
  const approved = JSON.parse(await execute(target, "goal_status", { transfer_challenge_id: proposal.challenge_id }));
  assert.deepEqual(Object.keys(approved).sort(), ["action_token", "challenge_id", "machineAction", "status"]);
  assert.equal(approved.status, "APPROVED");
  assert.deepEqual(approved.machineAction, { tool: "goal_amend", params: { goal_id: goalId, operation: "transfer_session", challenge_id: proposal.challenge_id, reason: "continue work" } });
  await execute(target, "goal_amend", { ...approved.machineAction.params, action_token: approved.action_token });
  assert.equal(await execute(owner, "goal_status", { goal_id: goalId }), "NO_ACTIVE_GOAL");
  assert.equal(JSON.parse(await execute(target, "goal_status", { goal_id: goalId })).goalId, goalId);
});

test("approved session transfer advances owner while retaining the source binding audit trail", () => {
  let projection = applyEvent(createProjection(), event("goal.created", {
    objective: "Transfer fixture", scope: [], nonGoals: [], dod: [], tasks: ["t"],
    taskDefs: { t: { description: "t", deps: [], writePaths: ["src/a"], workflow: "tdd", acceptance: { criteria: [{ id: "c", statement: "passes", evidenceKinds: ["tests"] }] } } },
  }, "2026-08-10T00:00:00.000Z"));
  projection = applyEvent(projection, event("goal.session_bound", { sessionId: "A", leafId: "a" }, "2026-08-10T00:00:01.000Z"));
  projection = applyEvent(projection, event("goal.session_transferred", {
    fromSessionId: "A", toSessionId: "B", challengeId: "challenge", reason: "approved", ownershipRevision: 2,
  }, "2026-08-10T00:00:02.000Z"));
  assert.equal(projection.sessionBindings.at(-1).sessionId, "B");
  assert.deepEqual(projection.sessionBindings.map((binding) => binding.state), ["transferred", "watching"]);
  assert.equal(projection.ownershipRevision, 2);
});
