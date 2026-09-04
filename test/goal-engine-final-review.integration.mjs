import assert from "node:assert/strict";
import test from "node:test";
import { buildObligationFinalizationManifest, validateObligationFinalizationManifest } from "../src/goal-engine/finalization.ts";
import * as finalReview from "../src/goal-engine/final-review.ts";

const h = (letter) => letter.repeat(64);
const head = "0123456789abcdef0123456789abcdef01234567";
const approval = { entryId: "entry-user-r11", sessionId: "session-r11", source: "user" };

function completeManifest(overrides = {}) {
  const projection = { goalId: "goal-r11", executionRevision: 11, executionContractHash: h("9"), tasks: new Map(), conditions: new Map(), findings: new Map(), repairEpisodes: new Map() };
  const worldSnapshot = { safe: true, repo: { root: "/repo/r11", head, branch: "main", trackedDirty: [], untracked: [], unmerged: [], sequencer: null }, resources: [], activeRuns: [] };
  const manifest = buildObligationFinalizationManifest({ projection, worldSnapshot, conditionValidity: new Map(), resourceInventory: [] });
  assert.equal(validateObligationFinalizationManifest(manifest), true, "fixture must use the frozen 5266647 manifest ABI");
  if (!Object.keys(overrides).length) return manifest;
  // Any caller mutation loses deep-freeze/hash authority; this is intentionally a bad manifest.
  return { ...manifest, ...overrides };
}
function store() {
  const intents = new Map(), results = new Map();
  return { intents, results,
    async inspect(reviewId) { return { intent: intents.get(reviewId) ?? null, result: results.get(reviewId) ?? null }; },
    async persistIntent(intent) { intents.set(intent.reviewId, structuredClone(intent)); },
    async persistResult(result) { results.set(result.reviewId, structuredClone(result)); },
  };
}
async function run(input) {
  assert.equal(typeof finalReview.runRecoverableFinalReview, "function", "runRecoverableFinalReview is the R11 host API");
  return finalReview.runRecoverableFinalReview(input);
}
const provider = (severity = "none", reportRef = `sha256:${h("e")}`) => async () => ({ severity, reportRef });

// The fixture deliberately has no Tasks/Conditions: complete is derived by the authoritative
// finalization builder, not by a hand-written schemaVersion, hash, debts, or caller verdict.
test("R11 uses a deep-frozen complete authoritative manifest", () => {
  const manifest = completeManifest();
  assert.equal(manifest.complete, true); assert.equal(Object.isFrozen(manifest), true);
  assert.equal(manifest.schemaVersion, "goal-runtime.v1.finalization-manifest.v1");
});
test("stable host API accepts exactly manifest approval reviewStore and provider", async () => {
  const seen = [];
  const result = await run({ manifest: completeManifest(), approval, reviewStore: store(), provider: async input => { seen.push(input); return { severity: "none", reportRef: `sha256:${h("a")}` }; } });
  assert.equal(result.status, "recorded");
  assert.deepEqual(Object.keys(seen[0]).sort(), ["idempotencyKey", "reviewId", "writerLockHeld"]);
  assert.equal(seen[0].writerLockHeld, false);
  assert.equal(seen[0].idempotencyKey, seen[0].reviewId);
});
for (const extra of [
  { appendEvent: async () => {} },
  { reviewId: "attacker" },
  { identity: { goalId: "attacker" } },
]) test(`stable host API rejects unsupported ${Object.keys(extra)[0]} without invoking provider`, async () => {
  let calls = 0;
  await assert.rejects(run({ manifest: completeManifest(), approval, reviewStore: store(), provider: async () => { calls++; return { severity: "none", reportRef: `sha256:${h("b")}` }; }, ...extra }));
  assert.equal(calls, 0);
});
for (const bad of [
  { entryId: "x", sessionId: "s" }, { entryId: "x", sessionId: "s", source: "system" },
  { entryId: "x", sessionId: "s", source: "user", extra: true }, { entryId: "", sessionId: "s", source: "user" },
]) test(`approval is exact user capability: ${JSON.stringify(bad)}`, async () => {
  await assert.rejects(run({ manifest: completeManifest(), approval: bad, reviewStore: store(), provider: provider() }));
});
for (const [name, mutate] of [
  ["unfrozen clone", m => structuredClone(m)], ["incomplete", m => completeManifest({ complete: false })],
  ["wrong manifest hash", m => completeManifest({ manifestHash: h("0") })], ["wrong state hash", m => completeManifest({ stateHash: h("0") })],
  ["wrong world hash", m => completeManifest({ worldHash: h("0") })], ["wrong head", m => completeManifest({ head: "f".repeat(40) })],
]) test(`host rejects ${name} finalization manifest before provider`, async () => {
  let calls = 0;
  await assert.rejects(run({ manifest: mutate(completeManifest()), approval, reviewStore: store(), provider: async () => { calls++; return { severity: "none", reportRef: `sha256:${h("1")}` }; } }));
  assert.equal(calls, 0);
});
for (const severity of ["none", "minor", "important", "critical"]) test(`canonical severity ${severity}`, async () => {
  const result = await run({ manifest: completeManifest(), approval, reviewStore: store(), provider: provider(severity) });
  assert.equal(result.status, ["important", "critical"].includes(severity) ? "changes_required" : "recorded");
  if (severity === "minor") assert.ok(result.residual, "minor is a residual, not a pass-through provider field");
});
test("provider cannot control host identity status or resultHash", async () => {
  const reviewStore = store();
  await run({ manifest: completeManifest(), approval, reviewStore, provider: async () => ({ severity: "minor", reportRef: `sha256:${h("2")}`, goalId: "attacker", status: "recorded", resultHash: "attacker" }) });
  const result = [...reviewStore.results.values()][0];
  assert.equal(result.goalId, "goal-r11"); assert.notEqual(result.resultHash, "attacker");
});
test("final review binds expected intent stateHash directly to manifest Store stateHash", async () => {
  const manifest = completeManifest(), reviewStore = store();
  await run({ manifest, approval, reviewStore, provider: provider() });
  const intent = [...reviewStore.intents.values()][0];
  assert.equal(intent.stateHash, manifest.stateHash);
  assert.notEqual(manifest.stateHash, manifest.obligationStateHash, "fixture distinguishes Store state from obligation binding");
});
test("provider raw text is not made durable", async () => {
  const reviewStore = store();
  await run({ manifest: completeManifest(), approval, reviewStore, provider: async () => ({ severity: "none", reportRef: `sha256:${h("3")}`, summary: "secret", prompt: "secret", response: "secret" }) });
  assert.doesNotMatch(JSON.stringify([...reviewStore.results.values()]), /secret/);
});
test("provider gets no manifest or approval payload", async () => {
  await run({ manifest: completeManifest(), approval, reviewStore: store(), provider: async input => {
    assert.equal(input.manifestHash, undefined); assert.equal(input.approval, undefined);
    return { severity: "none", reportRef: `sha256:${h("4")}` };
  } });
});
for (const output of [undefined, null, {}, { severity: "unknown" }, { severity: "bogus", reportRef: `sha256:${h("5")}` }, { severity: "none", reportRef: "sha256:short" }, { severity: "none", reportRef: "file:///tmp/report" }]) test(`fail closed malformed provider output ${JSON.stringify(output)}`, async () => {
  await assert.rejects(run({ manifest: completeManifest(), approval, reviewStore: store(), provider: async () => output }));
});
