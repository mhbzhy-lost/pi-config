import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRunAuthorization,
  capabilitiesForRun,
  createRunAuthorization,
} from "../packages/pi-subagents-enhanced/src/subagent-dispatch/run-authorization.ts";

const binding = Object.freeze({
  runId: "run-42",
  asyncDir: "/tmp/pi-subagents/run-42",
  sessionId: "root-session-42",
  pid: 4242,
  agentProfile: "coder-alpha",
});

const goal = Object.freeze({
  ticketId: "a".repeat(64),
  goalId: "goal-42",
  taskId: "task-42",
  attempt: 1,
  contractHash: "b".repeat(64),
  workspaceId: "goal-42-task-42-1",
  executionRevision: 2,
  expectedCriteria: ["build", "test"],
});

function authorization(input = {}) {
  return createRunAuthorization({ kind: "coding", binding, goal: null, ...input });
}

function assertDeepFrozen(value) {
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") assertDeepFrozen(child);
  }
}

test("authorization matrix is structural and has canonical capabilities", () => {
  assert.deepEqual(capabilitiesForRun({ kind: "generic", goal: null }), []);
  assert.deepEqual(capabilitiesForRun({ kind: "coding", goal: null }), ["root.subscribe"]);
  assert.deepEqual(capabilitiesForRun({ kind: "coding", goal }), ["acceptance.submit", "root.subscribe"]);
  assert.throws(() => capabilitiesForRun({ kind: "generic", goal }), /generic.*Goal|Goal.*generic/i);

  assert.deepEqual(authorization().capabilities, ["root.subscribe"]);
  assert.deepEqual(authorization({ kind: "generic" }).capabilities, []);
  assert.deepEqual(authorization({ goal }).capabilities, ["acceptance.submit", "root.subscribe"]);
  assert.throws(() => authorization({ kind: "generic", goal }), /generic.*Goal|Goal.*generic/i);
});

test("authorization is exact and deeply frozen", () => {
  const value = authorization({ goal });
  assert.deepEqual(Object.keys(value).sort(), ["binding", "capabilities", "goal", "kind", "version"]);
  assert.equal(value.version, "subagent-run-authorization.v1");
  assertDeepFrozen(value);
  assert.throws(() => { value.binding.pid = 1; }, TypeError);
  assert.doesNotThrow(() => assertRunAuthorization(value));
});

test("caller cannot inject capabilities or unrecognized authorization fields", () => {
  assert.throws(() => authorization({ capabilities: ["acceptance.submit"] }), /capabilit|unknown|exact/i);
  assert.throws(() => authorization({ privileged: true }), /unknown|exact/i);
  assert.throws(() => capabilitiesForRun({ kind: "coding", goal: null, capabilities: ["acceptance.submit"] }), /capabilit/i);
});

test("agent profile is an identity only and never selects capabilities", () => {
  for (const agentProfile of ["executor", "reviewer", "package.coder-alpha", "../executor"]) {
    assert.deepEqual(authorization({ binding: { ...binding, agentProfile } }).capabilities, ["root.subscribe"]);
  }
});

test("agent profile uses the public profile identity domain independently from safe run IDs", () => {
  const longProfile = `package.${"a".repeat(200)}`;
  for (const [input, expected] of [
    [" package.coder-alpha ", "package.coder-alpha"],
    [longProfile, longProfile],
  ]) {
    const value = authorization({ binding: { ...binding, agentProfile: input } });
    assert.equal(value.binding.agentProfile, expected);
    assert.deepEqual(value.capabilities, ["root.subscribe"]);
  }

  for (const agentProfile of ["   ", "coder\u0000alpha", "coder\nalpha", "coder\u0085alpha", "a".repeat(257)]) {
    assert.throws(() => authorization({ binding: { ...binding, agentProfile } }), /agentProfile|identity/i);
  }
});

test("binding identity rejects unsafe or malformed fields", () => {
  for (const [label, mutate] of [
    ["runId", (value) => { value.runId = "../run"; }],
    ["asyncDir", (value) => { value.asyncDir = "relative/run"; }],
    ["sessionId", (value) => { value.sessionId = "session\n42"; }],
    ["pid", (value) => { value.pid = 0; }],
    ["agentProfile", (value) => { value.agentProfile = ""; }],
    ["unknown field", (value) => { value.extra = true; }],
  ]) {
    assert.throws(() => {
      const invalid = { ...binding };
      mutate(invalid);
      authorization({ binding: invalid });
    }, /identity|asyncDir|pid|exact|unknown/i, label);
  }
});

test("standalone authorization preserves persisted lifecycle identities independently of root identities", () => {
  for (const sessionId of ["root-session-42", "/tmp/pi sessions/root.jsonl"]) {
    const value = authorization({ binding: { ...binding, sessionId } });
    assert.equal(value.binding.sessionId, sessionId);
    assert.deepEqual(value.capabilities, ["root.subscribe"]);
    assert.doesNotThrow(() => assertRunAuthorization(value));
  }
  for (const sessionId of [null, 42, "", " ", "relative/session.jsonl", "../session", "/tmp/session\0.jsonl", "/tmp/session\n.jsonl", "/tmp/session\u0085.jsonl", "/tmp/../session", "/" + "a".repeat(4096)]) {
    assert.throws(() => authorization({ binding: { ...binding, sessionId } }), /sessionId/);
  }
});

test("Goal authority is exact and fails closed for missing or drifted fields", () => {
  for (const [label, mutate] of [
    ["ticketId missing", (value) => { delete value.ticketId; }],
    ["goalId drift", (value) => { value.goalId = "../goal"; }],
    ["taskId drift", (value) => { value.taskId = ""; }],
    ["attempt drift", (value) => { value.attempt = 0; }],
    ["contractHash drift", (value) => { value.contractHash = "not-a-hash"; }],
    ["workspaceId drift", (value) => { value.workspaceId = "/tmp/workspace"; }],
    ["executionRevision drift", (value) => { value.executionRevision = 0; }],
    ["expectedCriteria missing", (value) => { delete value.expectedCriteria; }],
    ["expectedCriteria duplicate", (value) => { value.expectedCriteria = ["build", "build"]; }],
    ["unknown Goal field", (value) => { value.agent = "executor"; }],
  ]) {
    assert.throws(() => {
      const invalid = { ...goal, expectedCriteria: [...goal.expectedCriteria] };
      mutate(invalid);
      authorization({ goal: invalid });
    }, /goal|ticket|identity|criteria|hash|exact|unknown/i, label);
  }
});

test("assertRunAuthorization rejects capability, Goal, and binding mutations", () => {
  const valid = authorization({ goal });
  for (const [label, mutate] of [
    ["generic acceptance capability", (value) => { value.kind = "generic"; }],
    ["capability order", (value) => { value.capabilities.reverse(); }],
    ["Goal removed capability retained", (value) => { value.goal = null; }],
    ["Goal binding drift", (value) => { value.goal.executionRevision = 3; }],
    ["binding pid drift", (value) => { value.binding.pid = 0; }],
  ]) {
    const mutable = structuredClone(valid);
    mutate(mutable);
    assert.throws(() => assertRunAuthorization(mutable), /authorization|capabilit|goal|binding|pid/i, label);
  }
});
