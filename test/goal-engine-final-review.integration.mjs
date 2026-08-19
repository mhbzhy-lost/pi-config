import assert from "node:assert/strict";
import test from "node:test";
import * as finalReview from "../scripts/lib/goal-engine/final-review.mjs";

const hash = (letter) => letter.repeat(64);
const manifest = (overrides = {}) => ({
  schemaVersion: "dispatch-ir.v1",
  goalId: "goal-r11",
  revision: 11,
  contractHash: hash("9"),
  head: "0123456789abcdef0123456789abcdef01234567",
  worldHash: hash("c"),
  stateHash: hash("b"),
  obligationStateHash: hash("b"),
  tasks: [{ id: "task-r11", status: "accepted" }],
  conditions: [],
  debts: [],
  blockers: [],
  complete: true,
  manifestHash: hash("a"),
  ...overrides,
});
const approval = { entryId: "entry-user-1", sessionId: "session-1", source: "user" };
const store = () => {
  const intents = new Map(); const results = new Map();
  return {
    intents, results,
    async inspect(reviewId) { return { intent: intents.get(reviewId) ?? null, result: results.get(reviewId) ?? null }; },
    async persistIntent(intent) { intents.set(intent.reviewId, structuredClone(intent)); },
    async persistResult(result) { results.set(result.reviewId, structuredClone(result)); },
  };
};
async function run(input) {
  assert.equal(typeof finalReview.runRecoverableFinalReview, "function", "R11 stable API must be exported");
  return finalReview.runRecoverableFinalReview(input);
}

 test("manifest and approval use exact R11 shapes", async () => {
  assert.deepEqual(Object.keys(manifest()).sort(), ["schemaVersion", "goalId", "revision", "contractHash", "head", "worldHash", "stateHash", "obligationStateHash", "tasks", "conditions", "debts", "blockers", "complete", "manifestHash"].sort());
  assert.deepEqual(Object.keys(approval).sort(), ["entryId", "sessionId", "source"]);
});

test("R11 authority is stable manifest/approval/reviewStore API", async () => {
  const reviewStore = store();
  const seen = [];
  const result = await run({ manifest: manifest(), approval, reviewStore, provider: async (input) => { seen.push(input); return { severity: "none", reportRef: "sha256:" + hash("e") }; } });
  assert.equal(result.status, "recorded");
  assert.equal(seen[0].writerLockHeld, false);
  assert.equal(typeof seen[0].reviewId, "string");
  assert.equal(typeof seen[0].idempotencyKey, "string");
  assert.deepEqual(Object.keys(seen[0]).sort(), ["idempotencyKey", "reviewId", "writerLockHeld"]);
});

test("provider cannot supply identity, status, or result hash", async () => {
  const reviewStore = store();
  await run({ manifest: manifest(), approval, reviewStore, provider: async () => ({ severity: "minor", reportRef: "sha256:" + hash("f"), goalId: "attacker", status: "recorded", resultHash: "attacker" }) });
  const result = [...reviewStore.results.values()][0];
  assert.equal(result.goalId, "goal-r11"); assert.notEqual(result.resultHash, "attacker");
});

test("provider raw summary prompt response and error are not durable", async () => {
  const reviewStore = store();
  await run({ manifest: manifest(), approval, reviewStore, provider: async () => ({ severity: "none", reportRef: "sha256:" + hash("1"), summary: "secret", prompt: "secret", response: "secret", error: "secret" }) });
  assert.doesNotMatch(JSON.stringify([...reviewStore.results.values()]), /secret/);
});

test("pass does not append goal.completed", async () => {
  const events = []; const reviewStore = store();
  const result = await run({ manifest: manifest(), approval, reviewStore, provider: async () => ({ severity: "none", reportRef: "sha256:" + hash("2") }), appendEvent: (event) => events.push(event) });
  assert.equal(result.status, "recorded"); assert.equal(events.length, 0);
});

for (const severity of ["none", "minor", "important", "critical"]) {
  test(`severity ${severity} has canonical R11 status`, async () => {
    const reviewStore = store();
    const result = await run({ manifest: manifest(), approval, reviewStore, provider: async () => ({ severity, reportRef: "sha256:" + hash("3") }) });
    assert.equal(result.status, severity === "important" || severity === "critical" ? "changes_required" : "recorded");
    if (severity === "minor") assert.ok(result.residual);
  });
}

for (const field of ["schemaVersion", "goalId", "revision", "contractHash", "head", "worldHash", "stateHash", "obligationStateHash", "tasks", "conditions", "debts", "blockers", "complete", "manifestHash"]) {
  test(`invalid finalization manifest ${field} is rejected`, async () => {
    const bad = manifest({ [field]: field === "complete" ? false : field === "tasks" || field === "conditions" || field === "debts" || field === "blockers" ? null : "drift" });
    await assert.rejects(run({ manifest: bad, approval, reviewStore: store(), provider: async () => ({ severity: "none", reportRef: "sha256:" + hash("4") }) }));
  });
}

test("caller identity fields are rejected rather than ignored", async () => {
  await assert.rejects(run({ manifest: manifest(), approval, reviewStore: store(), reviewId: "caller-review", provider: async () => ({ severity: "none", reportRef: "sha256:" + hash("5") }) }));
  await assert.rejects(run({ manifest: manifest(), approval, reviewStore: store(), identity: { reviewId: "caller-review" }, provider: async () => ({ severity: "none", reportRef: "sha256:" + hash("5") }) }));
});

test("provider receives no caller-controlled approval or hashes", async () => {
  await run({ manifest: manifest(), approval, reviewStore: store(), provider: async (input) => { assert.equal(input.approval, undefined); assert.equal(input.manifestHash, undefined); return { severity: "none", reportRef: "sha256:" + hash("6") }; } });
});

for (const badApproval of [{ entryId: "entry", sessionId: "session" }, { entryId: "entry", sessionId: "session", source: "system" }, { entryId: "entry", sessionId: "session", source: "user", extra: true }]) {
  test(`approval rejects ${JSON.stringify(badApproval)}`, async () => {
    await assert.rejects(run({ manifest: manifest(), approval: badApproval, reviewStore: store(), provider: async () => ({ severity: "none", reportRef: "sha256:" + hash("6") }) }));
  });
}

test("provider report reference is content addressed", async () => {
  await assert.rejects(run({ manifest: manifest(), approval, reviewStore: store(), provider: async () => ({ severity: "none", reportRef: "file:///tmp/report" }) }));
});

for (const approvalDrift of ["entryId", "sessionId", "source"]) {
  test(`approval ${approvalDrift} drift cannot reuse durable review`, async () => {
    const reviewStore = store(); const first = { ...approval }; const second = { ...approval, [approvalDrift]: approvalDrift === "source" ? "system" : "drift" };
    await run({ manifest: manifest(), approval: first, reviewStore, provider: async () => ({ severity: "none", reportRef: "sha256:" + hash("8") }) });
    const result = await run({ manifest: manifest(), approval: second, reviewStore, provider: async () => ({ severity: "none", reportRef: "sha256:" + hash("9") }) });
    assert.notEqual(result.status, "failed");
  });
}
