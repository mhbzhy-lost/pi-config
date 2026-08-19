import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, symlink, writeFile, chmod, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildObligationFinalizationManifest, validateObligationFinalizationManifest } from "../scripts/lib/goal-engine/finalization.mjs";
import * as finalReview from "../scripts/lib/goal-engine/final-review.mjs";

const h = x => x.repeat(64);
const approval = { entryId: "entry-recovery", sessionId: "session-recovery", source: "user" };
function manifest(change = {}) {
  const projection = { goalId: "goal-recovery", executionRevision: 7, executionContractHash: h("a"), tasks: new Map(), conditions: new Map(), findings: new Map(), repairEpisodes: new Map() };
  const worldSnapshot = { safe: true, repo: { root: "/repo/recovery", head: "b".repeat(40), branch: "main", trackedDirty: [], untracked: [], unmerged: [], sequencer: null }, resources: [], activeRuns: [] };
  if (change.projection) Object.assign(projection, change.projection);
  if (change.world) Object.assign(worldSnapshot, change.world);
  const out = buildObligationFinalizationManifest({ projection, worldSnapshot, conditionValidity: new Map(), resourceInventory: [] });
  assert.equal(validateObligationFinalizationManifest(out), true);
  return out;
}
function crashStore({ intent = null, result = null, intentThrows = false, resultThrows = false } = {}) {
  let savedIntent = intent, savedResult = result;
  return { async inspect(id) { return savedIntent?.reviewId === id ? { intent: structuredClone(savedIntent), result: structuredClone(savedResult) } : { intent: null, result: null }; },
    async persistIntent(value) { savedIntent = structuredClone(value); if (intentThrows) throw Error("intent write failed"); },
    async persistResult(value) { savedResult = structuredClone(value); if (resultThrows) throw Error("result write failed"); },
    get record() { return { intent: savedIntent, result: savedResult }; } };
}
async function run(input) { assert.equal(typeof finalReview.runRecoverableFinalReview, "function", "R11 recovery API must be exported"); return finalReview.runRecoverableFinalReview(input); }
const provider = (severity = "none", ref = `sha256:${h("c")}`) => async () => ({ severity, reportRef: ref });

test("intent is persisted before an unlocked provider invocation", async () => {
  const reviewStore = crashStore(); let persisted = false;
  await run({ manifest: manifest(), approval, reviewStore, provider: async input => { persisted = Boolean((await reviewStore.inspect(input.reviewId)).intent); assert.equal(input.writerLockHeld, false); return { severity: "none", reportRef: `sha256:${h("1")}` }; } });
  assert.equal(persisted, true);
});
test("same identity reload has stable reviewId and idempotency key", async () => {
  const reviewStore = crashStore(), seen = [];
  const input = { manifest: manifest(), approval, reviewStore, provider: async value => { seen.push(value); return { severity: "none", reportRef: `sha256:${h("2")}` }; } };
  await run(input); await run(input);
  assert.equal(seen.length, 1); assert.equal(reviewStore.record.intent.reviewId, seen[0].reviewId); assert.equal(reviewStore.record.intent.idempotencyKey, seen[0].idempotencyKey);
});
for (const [name, next] of [
  ["state", () => manifest({ projection: { executionRevision: 8 } })],
  ["contract", () => { const p = { goalId: "goal-recovery", executionRevision: 7, executionContractHash: h("d"), tasks: new Map(), conditions: new Map(), findings: new Map(), repairEpisodes: new Map() }; const w = { safe: true, repo: { root: "/repo/recovery", head: "b".repeat(40), branch: "main", trackedDirty: [], untracked: [], unmerged: [], sequencer: null }, resources: [], activeRuns: [] }; return buildObligationFinalizationManifest({ projection: p, worldSnapshot: w, conditionValidity: new Map(), resourceInventory: [] }); }],
  ["world", () => manifest({ world: { repo: { root: "/repo/recovery", head: "c".repeat(40), branch: "main", trackedDirty: [], untracked: [], unmerged: [], sequencer: null } } })],
]) test(`identity drift ${name} never reuses prior result`, async () => {
  const reviewStore = crashStore(); let first, second;
  await run({ manifest: manifest(), approval, reviewStore, provider: async x => { first = x.reviewId; return { severity: "none", reportRef: `sha256:${h("3")}` }; } });
  await run({ manifest: next(), approval, reviewStore, provider: async x => { second = x.reviewId; return { severity: "none", reportRef: `sha256:${h("4")}` }; } });
  assert.notEqual(first, second);
});
test("approval entry drift creates a new review rather than old pass", async () => {
  const reviewStore = crashStore(); let first, second;
  await run({ manifest: manifest(), approval, reviewStore, provider: async x => { first = x.reviewId; return { severity: "none", reportRef: `sha256:${h("5")}` }; } });
  await run({ manifest: manifest(), approval: { ...approval, entryId: "new-entry" }, reviewStore, provider: async x => { second = x.reviewId; return { severity: "none", reportRef: `sha256:${h("6")}` }; } });
  assert.notEqual(first, second);
});
test("intent durable then throw reloads and invokes provider once", async () => {
  const failing = crashStore({ intentThrows: true }); let calls = 0;
  await assert.rejects(run({ manifest: manifest(), approval, reviewStore: failing, provider: async () => { calls++; return { severity: "none", reportRef: `sha256:${h("7")}` }; } }));
  assert.ok(failing.record.intent); assert.equal(calls, 0);
  const recovered = crashStore(failing.record);
  await run({ manifest: manifest(), approval, reviewStore: recovered, provider: async () => { calls++; return { severity: "none", reportRef: `sha256:${h("7")}` }; } });
  assert.equal(calls, 1);
});
test("result durable then throw reload reconciles exact result without provider", async () => {
  const failing = crashStore({ resultThrows: true }); let calls = 0;
  await assert.rejects(run({ manifest: manifest(), approval, reviewStore: failing, provider: async () => { calls++; return { severity: "none", reportRef: `sha256:${h("8")}` }; } }));
  assert.ok(failing.record.result);
  const recovered = crashStore(failing.record);
  const result = await run({ manifest: manifest(), approval, reviewStore: recovered, provider: async () => { calls++; return { severity: "none", reportRef: `sha256:${h("8")}` }; } });
  assert.equal(result.status, "recorded"); assert.equal(calls, 1);
});
test("transient provider error retains only intent and permits same-key retry", async () => {
  const reviewStore = crashStore(); let calls = 0;
  const first = await run({ manifest: manifest(), approval, reviewStore, provider: async () => { calls++; throw Error("password=secret timeout"); } });
  assert.notEqual(first.status, "recorded"); assert.equal(reviewStore.record.result, null); assert.doesNotMatch(JSON.stringify(reviewStore.record), /password|secret|timeout/);
  const second = await run({ manifest: manifest(), approval, reviewStore, provider: async () => { calls++; return { severity: "none", reportRef: `sha256:${h("9")}` }; } });
  assert.equal(second.status, "recorded"); assert.equal(calls, 2);
});
test("exact durable changes_required is idempotent with provider zero", async () => {
  const reviewStore = crashStore(); let calls = 0; const input = { manifest: manifest(), approval, reviewStore, provider: async () => { calls++; return { severity: "critical", reportRef: `sha256:${h("d")}` }; } };
  const first = await run(input), second = await run(input); assert.deepEqual(second, first); assert.equal(calls, 1);
});
test("conflicting durable identity fails closed before provider", async () => {
  const reviewStore = crashStore({ intent: { reviewId: "old", goalId: "other" } }); let calls = 0;
  await assert.rejects(run({ manifest: manifest(), approval, reviewStore, provider: async () => { calls++; return { severity: "none", reportRef: `sha256:${h("e")}` }; } })); assert.equal(calls, 0);
});

// Default file-store helpers are a separately observable security boundary.
async function withRoot(fn) { const root = await mkdtemp(join(tmpdir(), "r11-review-")); try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); } }
test("file helper rejects traversal reviewId", async () => withRoot(async stateRoot => {
  await assert.rejects(finalReview.persistFinalReviewIntent({ stateRoot, intent: { goalId: "g", reviewId: "../escape", manifestHash: h("f"), approvalEntryId: "entry" } }));
}));
test("file helper rejects a symlinked state root", async () => withRoot(async stateRoot => {
  const rootLink = `${stateRoot}-link`; await symlink(stateRoot, rootLink);
  await assert.rejects(finalReview.persistFinalReviewIntent({ stateRoot: rootLink, intent: { goalId: "g", reviewId: "safe", manifestHash: h("f"), approvalEntryId: "entry" } }));
  await rm(rootLink, { force: true });
}));
test("file helper rejects a symlinked reviews directory", async () => withRoot(async stateRoot => {
  const target = join(stateRoot, "target"); await writeFile(target, "x"); await symlink(target, join(stateRoot, "final-reviews"));
  await assert.rejects(finalReview.persistFinalReviewIntent({ stateRoot, intent: { goalId: "g", reviewId: "safe", manifestHash: h("f"), approvalEntryId: "entry" } }));
}));
test("file helper rejects hard-linked review records", async () => withRoot(async stateRoot => {
  const intent = { goalId: "g", reviewId: "safe", manifestHash: h("f"), approvalEntryId: "entry" };
  await finalReview.persistFinalReviewIntent({ stateRoot, intent });
  await link(join(stateRoot, "final-reviews", "safe.json"), join(stateRoot, "final-reviews", "alias.json"));
  await assert.rejects(finalReview.recoverFinalReview({ stateRoot, reviewId: "safe" }));
}));
test("file helper rejects insecure existing review permissions", async () => withRoot(async stateRoot => {
  await finalReview.persistFinalReviewIntent({ stateRoot, intent: { goalId: "g", reviewId: "safe", manifestHash: h("f"), approvalEntryId: "entry" } });
  await chmod(join(stateRoot, "final-reviews", "safe.json"), 0o644);
  await assert.rejects(finalReview.recoverFinalReview({ stateRoot, reviewId: "safe" }));
}));
test("file helper atomically refuses a conflicting review record", async () => withRoot(async stateRoot => {
  await finalReview.persistFinalReviewIntent({ stateRoot, intent: { goalId: "g", reviewId: "safe", manifestHash: h("f"), approvalEntryId: "entry" } });
  await assert.rejects(finalReview.persistFinalReviewIntent({ stateRoot, intent: { goalId: "other", reviewId: "safe", manifestHash: h("e"), approvalEntryId: "entry" } }));
}));
test("file helper never persists provider raw text", async () => withRoot(async stateRoot => {
  await finalReview.persistFinalReviewIntent({ stateRoot, intent: { goalId: "g", reviewId: "safe", manifestHash: h("f"), approvalEntryId: "entry" } });
  const recovered = await finalReview.recoverFinalReview({ stateRoot, reviewId: "safe" });
  assert.doesNotMatch(JSON.stringify(recovered), /prompt|response|secret/);
}));
