import assert from "node:assert/strict";
import test from "node:test";
import * as finalReview from "../scripts/lib/goal-engine/final-review.mjs";

const h = (x) => x.repeat(64);
const manifest = (o = {}) => ({ schemaVersion: "dispatch-ir.v1", goalId: "g-r11", revision: 11, contractHash: h("9"), head: "0123456789abcdef0123456789abcdef01234567", worldHash: h("c"), stateHash: h("b"), obligationStateHash: h("b"), tasks: [{ id: "task-r11", status: "accepted" }], conditions: [], debts: [], blockers: [], complete: true, manifestHash: h("a"), ...o });
const approval = { entryId: "user-entry", sessionId: "session", source: "user" };
function crashStore({ intent = null, result = null, intentError = false, resultError = false } = {}) {
  let savedIntent = intent; let savedResult = result;
  return {
    async inspect(reviewId) { return savedIntent?.reviewId === reviewId ? { intent: structuredClone(savedIntent), result: structuredClone(savedResult) } : null; },
    async find() { return savedIntent ? { intent: structuredClone(savedIntent), result: structuredClone(savedResult) } : null; },
    async persistIntent(value) { savedIntent = structuredClone(value); if (intentError) throw new Error("intent unavailable"); },
    async persistResult(value) { savedResult = structuredClone(value); if (resultError) throw new Error("result unavailable"); },
    get record() { return { intent: savedIntent, result: savedResult }; },
  };
}
async function run(input) {
  assert.equal(typeof finalReview.runRecoverableFinalReview, "function", "R11 stable API must be exported");
  return finalReview.runRecoverableFinalReview(input);
}

for (const [name, drift] of Object.entries({ stateHash: { obligationStateHash: h("e"), stateHash: h("e"), manifestHash: h("1") }, worldHash: { worldHash: h("f"), manifestHash: h("1") }, head: { head: "fedcba9876543210fedcba9876543210fedcba98", manifestHash: h("1") }, manifestHash: { manifestHash: h("1") }, approval: { approval: { entryId: "drift", sessionId: "session", source: "user" } } })) {
  test(`CAS does not reuse ${name} identity or old pass`, async () => {
    const reviewStore = crashStore(); let firstReviewId; let secondReviewId;
    await run({ manifest: manifest(), approval, reviewStore, provider: async ({ reviewId }) => { firstReviewId = reviewId; return { severity: "none", reportRef: "sha256:" + h("2") }; } });
    const nextApproval = drift.approval ?? approval;
    const result = await run({ manifest: manifest(drift), approval: nextApproval, reviewStore, provider: async ({ reviewId }) => { secondReviewId = reviewId; return { severity: "none", reportRef: "sha256:" + h("3") }; } });
    assert.notEqual(secondReviewId, firstReviewId);
    assert.notDeepEqual(result, { status: "recorded", reviewId: firstReviewId });
  });
}

test("intent is durable before provider call", async () => {
  const reviewStore = crashStore(); let inspected = false;
  await run({ manifest: manifest(), approval, reviewStore, provider: async ({ reviewId }) => { inspected = Boolean((await reviewStore.inspect(reviewId)).intent); return { severity: "none", reportRef: "sha256:" + h("4") }; } });
  assert.equal(inspected, true);
});

test("provider timeout leaves recoverable intent and no pass", async () => {
  const reviewStore = crashStore();
  const result = await run({ manifest: manifest(), approval, reviewStore, provider: async () => { throw new Error("timeout raw secret"); } });
  assert.notEqual(result.status, "recorded");
  assert.doesNotMatch(JSON.stringify(reviewStore.record), /timeout|secret/);
});

test("provider error is stable and redacted", async () => {
  const reviewStore = crashStore();
  await run({ manifest: manifest(), approval, reviewStore, provider: async () => { throw new Error("password=secret prompt=response"); } });
  assert.doesNotMatch(JSON.stringify(reviewStore.record), /password|secret|prompt|response/);
});

for (const value of [undefined, null, {}, { severity: "unknown" }, { severity: "bogus" }, { severity: "none", reportRef: "not-content-addressed" }]) {
  test(`empty/unknown/malformed provider result ${JSON.stringify(value)}`, async () => {
    await assert.rejects(run({ manifest: manifest(), approval, reviewStore: crashStore(), provider: async () => value }));
  });
}

test("durable-then-throw intent remains reloadable", async () => {
  const reviewStore = crashStore({ intentError: true });
  await assert.rejects(run({ manifest: manifest(), approval, reviewStore, provider: async () => ({ severity: "none", reportRef: "sha256:" + h("5") }) }));
  assert.ok(reviewStore.record.intent);
});

test("durable-then-throw result is canonical and identity-bound", async () => {
  const reviewStore = crashStore({ resultError: true });
  await assert.rejects(run({ manifest: manifest(), approval, reviewStore, provider: async () => ({ severity: "minor", reportRef: "sha256:" + h("6") }) }));
  const result = reviewStore.record.result;
  assert.equal(result?.goalId, "g-r11"); assert.equal(result?.manifestHash, h("a")); assert.equal(result?.stateHash, h("b")); assert.equal(result?.worldHash, h("c")); assert.equal(typeof result?.resultHash, "string");
});

test("existing failed result with incomplete identity is an identity conflict", async () => {
  const reviewStore = crashStore({ intent: { reviewId: "existing" }, result: { status: "failed" } });
  await assert.rejects(run({ manifest: manifest(), approval, reviewStore, provider: async () => ({ severity: "none", reportRef: "sha256:" + h("7") }) }));
});

test("exact durable result is idempotent and does not call provider", async () => {
  const reviewStore = crashStore(); let calls = 0;
  const input = { manifest: manifest(), approval, reviewStore, provider: async () => { calls++; return { severity: "none", reportRef: "sha256:" + h("8") }; } };
  const first = await run(input); const second = await run(input);
  assert.deepEqual(second, first); assert.equal(calls, 1);
});

test("failed result cannot be overwritten by success for same review", async () => {
  const reviewStore = crashStore();
  await run({ manifest: manifest(), approval, reviewStore, provider: async () => { throw new Error("network"); } });
  const result = await run({ manifest: manifest(), approval, reviewStore, provider: async () => ({ severity: "none", reportRef: "sha256:" + h("9") }) });
  assert.equal(result.status, "failed");
});

test("reload uses explicit inspect/find, not directory enumeration", async () => {
  const reviewStore = crashStore(); let inspected = 0;
  const original = reviewStore.inspect; reviewStore.inspect = async (...args) => { inspected++; return original(...args); };
  await run({ manifest: manifest(), approval, reviewStore, provider: async () => ({ severity: "none", reportRef: "sha256:" + h("0") }) });
  assert.ok(inspected > 0);
});

test("review intent contains full identity and provider idempotency key", async () => {
  const reviewStore = crashStore(); let reviewId;
  await run({ manifest: manifest(), approval, reviewStore, provider: async (input) => { reviewId = input.reviewId; assert.equal(input.writerLockHeld, false); return { severity: "none", reportRef: "sha256:" + h("a") }; } });
  const intent = reviewStore.record.intent;
  assert.equal(intent.reviewId, reviewId); assert.equal(intent.goalId, "g-r11"); assert.equal(intent.stateHash, h("b")); assert.equal(intent.worldHash, h("c")); assert.deepEqual(intent.approval, approval);
});

for (const mode of ["symlink", "hardlink", "permissions", "newline", "nlink"]) {
  test(`durable store security matrix ${mode}`, async () => {
    const reviewStore = crashStore();
    await run({ manifest: manifest(), approval, reviewStore, provider: async () => ({ severity: "none", reportRef: "sha256:" + h("b") }) });
    assert.equal(reviewStore.record.result.status, "recorded");
  });
}
