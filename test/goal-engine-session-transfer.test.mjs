import assert from "node:assert/strict";
import test from "node:test";
import { applyEvent, createProjection } from "../scripts/lib/goal-engine/events.mjs";
import { createGoalEngineExtension } from "../scripts/lib/goal-engine/extension.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
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
async function input(pi, text, source = "interactive") {
  for (const handler of pi.hooks.input || []) await handler({ source, text, entryId: crypto.randomUUID() }, pi.executeContext);
}
function bytes(path) { return existsSync(path) ? readFileSync(path).toString("hex") : null; }
function stateInventory(cwd, pi) {
  const root = join(cwd, ".state", "goal-engine");
  const walk = (path) => existsSync(path) ? readdirSync(path, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(path, entry.name)) : [[join(path, entry.name).slice(cwd.length), bytes(join(path, entry.name))]]) : [];
  return {
    state: walk(root).sort(([a], [b]) => a.localeCompare(b)),
    entries: structuredClone(pi.entries),
    branches: git(cwd, "branch", "--format=%(refname:short)"),
    worktrees: git(cwd, "worktree", "list", "--porcelain"),
  };
}
async function rejectsWithoutWrites(run, snapshot) {
  await assert.rejects(run);
  assert.deepEqual(snapshot.after(), snapshot.before);
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

test("transfer challenge rejection matrix keeps list and rejected paths side-effect free", async () => {
  const { cwd, owner, target } = transferFixture();
  const initialized = JSON.parse(await execute(owner, "goal_init", { objective: "Private Transfer Goal", tasks: [{ id: "t", description: "t", deps: [], writePaths: ["src/a"], workflow: "tdd", acceptance: { criteria: [{ id: "c", statement: "passes", evidenceKinds: ["tests"] }] } }] }));
  const goalId = initialized.goalId;
  const snapshot = () => ({ before: stateInventory(cwd, target), after: null });
  const listSnapshot = snapshot();
  const listed = JSON.parse(await execute(target, "goal_status", { list_cwd_goals: true }));
  listSnapshot.after = stateInventory(cwd, target);
  assert.deepEqual(listSnapshot.after, listSnapshot.before);
  assert.deepEqual(Object.keys(listed[0]), ["goalId", "lifecycle", "ownerSessionId", "ownedByCurrentSession", "transferEligible", "transferBlockedReason"]);
  assert.deepEqual(listed.map((item) => item.goalId), [...listed.map((item) => item.goalId)].sort());
  assert.ok(Object.keys(listed[0]).every((key) => !["objective", "scope", "tasks", "checkpoint", "nextAction", "action_token", "evidence"].includes(key)));

  const noChallenge = snapshot();
  assert.equal(await execute(target, "goal_status", { transfer_challenge_id: "unknown" }), "NO_ACTIVE_GOAL");
  noChallenge.after = stateInventory(cwd, target); assert.deepEqual(noChallenge.after, noChallenge.before);
  await input(target, "批准"); // approval before a challenge is never retained
  const proposal = JSON.parse(await execute(target, "goal_amend", { goal_id: goalId, operation: "propose_transfer_session", reason: "continue securely" }));
  for (const text of ["同意", "批准一下"]) await input(target, text);
  assert.equal(JSON.parse(await execute(target, "goal_status", { transfer_challenge_id: proposal.challenge_id })).status, "PENDING");
  await input(target, "reject");
  const rejected = JSON.parse(await execute(target, "goal_status", { transfer_challenge_id: proposal.challenge_id }));
  assert.deepEqual(rejected, { challenge_id: proposal.challenge_id, status: "REJECTED" });
  const rejectedSnapshot = snapshot();
  await rejectsWithoutWrites(() => execute(target, "goal_amend", { goal_id: goalId, operation: "transfer_session", challenge_id: proposal.challenge_id, reason: "continue securely", action_token: "wrong" }), { before: rejectedSnapshot.before, after: () => stateInventory(cwd, target) });
});

test("approved transfer rejects mismatched offers and target ownership races without consuming metadata", async () => {
  const { cwd, owner, target } = transferFixture();
  const init = (pi, objective) => execute(pi, "goal_init", { objective, tasks: [{ id: "t", description: "t", deps: [], writePaths: ["src/a"], workflow: "tdd", acceptance: { criteria: [{ id: "c", statement: "passes", evidenceKinds: ["tests"] }] } }] });
  const goalId = JSON.parse(await init(owner, "Race Transfer Goal")).goalId;
  const proposal = JSON.parse(await execute(target, "goal_amend", { goal_id: goalId, operation: "propose_transfer_session", reason: "continue securely" }));
  await input(target, "approve");
  const approved = JSON.parse(await execute(target, "goal_status", { transfer_challenge_id: proposal.challenge_id }));
  assert.deepEqual(approved.machineAction, { tool: "goal_amend", params: { goal_id: goalId, operation: "transfer_session", challenge_id: proposal.challenge_id, reason: "continue securely" } });
  const offered = stateInventory(cwd, target);
  for (const params of [
    { ...approved.machineAction.params, action_token: "wrong" },
    { ...approved.machineAction.params, challenge_id: "wrong", action_token: approved.action_token },
    { ...approved.machineAction.params, goal_id: "wrong", action_token: approved.action_token },
    { ...approved.machineAction.params, reason: "drift", action_token: approved.action_token },
  ]) await rejectsWithoutWrites(() => execute(target, "goal_amend", params), { before: offered, after: () => stateInventory(cwd, target) });
  await init(target, "Target Own Goal");
  const raced = stateInventory(cwd, target);
  assert.deepEqual(JSON.parse(await execute(target, "goal_status", { transfer_challenge_id: proposal.challenge_id })), { challenge_id: proposal.challenge_id, status: "TARGET_SESSION_HAS_ACTIVE_GOAL" });
  assert.deepEqual(stateInventory(cwd, target), raced);
  await rejectsWithoutWrites(() => execute(target, "goal_amend", { ...approved.machineAction.params, action_token: approved.action_token }), { before: raced, after: () => stateInventory(cwd, target) });
});

test("an approved transfer fails closed when the old owner activates a workspace", async () => {
  const { cwd, owner, target } = transferFixture();
  const initialized = JSON.parse(await execute(owner, "goal_init", { objective: "Unsafe Transfer Goal", tasks: [{ id: "t", description: "t", deps: [], writePaths: ["src/a"], workflow: "tdd", acceptance: { criteria: [{ id: "c", statement: "passes", evidenceKinds: ["tests"] }] } }] }));
  const proposal = JSON.parse(await execute(target, "goal_amend", { goal_id: initialized.goalId, operation: "propose_transfer_session", reason: "continue securely" }));
  await input(target, "approve");
  const approved = JSON.parse(await execute(target, "goal_status", { transfer_challenge_id: proposal.challenge_id }));
  const ownerStatus = JSON.parse(await execute(owner, "goal_status", { goal_id: initialized.goalId }));
  await execute(owner, "goal_dispatch", { ...ownerStatus.machineAction.params, action_token: ownerStatus.action_token });
  const unsafe = stateInventory(cwd, target);
  assert.deepEqual(JSON.parse(await execute(target, "goal_status", { transfer_challenge_id: proposal.challenge_id })), { challenge_id: proposal.challenge_id, status: "ACTIVE_WORKSPACE" });
  assert.deepEqual(stateInventory(cwd, target), unsafe);
  await rejectsWithoutWrites(() => execute(target, "goal_amend", { ...approved.machineAction.params, action_token: approved.action_token }), { before: unsafe, after: () => stateInventory(cwd, target) });
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
