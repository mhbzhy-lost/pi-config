import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, symlink, writeFile, chmod, link, lstat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildObligationFinalizationManifest, validateObligationFinalizationManifest } from "../src/goal-engine/finalization.ts";
import * as finalReview from "../src/goal-engine/final-review.ts";

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
  assert.equal(seen.length, 1); assert.equal(reviewStore.record.intent.reviewId, seen[0].reviewId); assert.equal(reviewStore.record.intent.idempotencyKey, seen[0].idempotencyKey); assert.equal(seen[0].idempotencyKey, seen[0].reviewId);
});
for (const [name, drift] of [
  ["goalId", intent => ({ ...intent, goalId: "other-goal" })],
  ["manifestHash", intent => ({ ...intent, manifestHash: h("d") })],
  ["stateHash", intent => ({ ...intent, stateHash: h("d") })],
  ["worldHash", intent => ({ ...intent, worldHash: h("d") })],
  ["head", intent => ({ ...intent, head: "d".repeat(40) })],
  ["approval", intent => ({ ...intent, approval: { ...intent.approval, entryId: "other-entry" } })],
]) test(`same reviewId with a drifted ${name} intent fails closed before provider`, async () => {
  const initial = crashStore(); let calls = 0;
  await run({ manifest: manifest(), approval, reviewStore: initial, provider: async () => { calls++; return { severity: "none", reportRef: `sha256:${h("3")}` }; } });
  const conflicting = crashStore({ intent: drift(initial.record.intent), result: initial.record.result });
  await assert.rejects(run({ manifest: manifest(), approval, reviewStore: conflicting, provider: async () => { calls++; return { severity: "none", reportRef: `sha256:${h("4")}` }; } }));
  assert.equal(calls, 1, "the conflicting record uses the real derived reviewId, so inspect cannot miss it");
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
// The file store is a separately observable security boundary.  These are the
// complete, host-derived identity fields; old approvalEntryId-only fixtures are forbidden.
async function withRoot(fn) { const root = await mkdtemp(join(tmpdir(), "r11-review-")); try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); } }
function canonicalIntent(overrides = {}) {
  return { reviewId: "review-safe", idempotencyKey: "review-safe", goalId: "goal-recovery", manifestHash: h("2"), stateHash: h("3"), worldHash: h("4"), head: "b".repeat(40), approval: structuredClone(approval), ...overrides };
}
function fileStore(stateRoot) {
  assert.equal(typeof finalReview.createFinalReviewFileStore, "function", "file review-store factory is a frozen public API");
  const reviewStore = finalReview.createFinalReviewFileStore({ stateRoot });
  assert.deepEqual(Object.keys(reviewStore).sort(), ["inspect", "persistIntent", "persistResult"]);
  return reviewStore;
}
test("file store persists a full happy-path canonical intent and result across reload", async () => withRoot(async stateRoot => {
  const first = fileStore(stateRoot); let reviewId;
  const output = await run({ manifest: manifest(), approval, reviewStore: first, provider: async input => { reviewId = input.reviewId; return { severity: "minor", reportRef: `sha256:${h("5")}` }; } });
  const recovered = await fileStore(stateRoot).inspect(reviewId);
  assert.deepEqual(Object.keys(recovered.intent).sort(), ["approval", "goalId", "head", "idempotencyKey", "manifestHash", "reviewId", "stateHash", "worldHash"]);
  assert.equal(recovered.result.status, output.status); assert.match(recovered.result.resultHash, /^[a-f0-9]{64}$/);
  const reviews = await lstat(join(stateRoot, "final-reviews")); assert.equal(reviews.mode & 0o777, 0o700);
}));
test("file store keeps only intent after transient provider failure and retries the same key", async () => withRoot(async stateRoot => {
  const reviewStore = fileStore(stateRoot); let reviewId, calls = 0;
  const first = await run({ manifest: manifest(), approval, reviewStore, provider: async input => { reviewId = input.reviewId; calls++; throw Error("password=secret timeout"); } });
  assert.notEqual(first.status, "recorded");
  assert.equal((await reviewStore.inspect(reviewId)).result, null);
  const second = await run({ manifest: manifest(), approval, reviewStore: fileStore(stateRoot), provider: async input => { assert.equal(input.reviewId, reviewId); calls++; return { severity: "none", reportRef: `sha256:${h("6")}` }; } });
  assert.equal(second.status, "recorded"); assert.equal(calls, 2);
}));
test("file store durable canonical intent is private single-link newline JSON after reload", async () => withRoot(async stateRoot => {
  const reviewStore = fileStore(stateRoot), intent = canonicalIntent();
  await reviewStore.persistIntent(intent);
  const record = join(stateRoot, "final-reviews", `${intent.reviewId}.json`), stat = await lstat(record);
  assert.equal(stat.mode & 0o777, 0o600); assert.equal(stat.nlink, 1); assert.match(await readFile(record, "utf8"), /\n$/);
  assert.deepEqual(await fileStore(stateRoot).inspect(intent.reviewId), await reviewStore.inspect(intent.reviewId));
}));
test("file store rejects path traversal", async () => withRoot(async stateRoot => {
  await assert.rejects(fileStore(stateRoot).persistIntent(canonicalIntent({ reviewId: "../escape" })));
}));
test("file store rejects hard-linked records", async () => withRoot(async stateRoot => {
  const reviewStore = fileStore(stateRoot);
  const intent = canonicalIntent(); await reviewStore.persistIntent(intent); await link(join(stateRoot, "final-reviews", `${intent.reviewId}.json`), join(stateRoot, "final-reviews", "alias.json"));
  await assert.rejects(reviewStore.inspect(intent.reviewId));
}));
test("file store rejects symlinked state root and reviews directory", async () => withRoot(async stateRoot => {
  const rootLink = `${stateRoot}-link`; await symlink(stateRoot, rootLink); await assert.rejects(async () => fileStore(rootLink).inspect("review-safe")); await rm(rootLink, { force: true });
  const target = join(stateRoot, "target"); await writeFile(target, "x"); await symlink(target, join(stateRoot, "final-reviews"));
  await assert.rejects(fileStore(stateRoot).persistIntent(canonicalIntent()));
}));
test("file store rejects insecure record permissions and identity or result conflicts", async () => withRoot(async stateRoot => {
  const reviewStore = fileStore(stateRoot), intent = canonicalIntent(); let reviewId;
  await run({ manifest: manifest(), approval, reviewStore, provider: async input => { reviewId = input.reviewId; return { severity: "none", reportRef: `sha256:${h("8")}` }; } });
  const record = await reviewStore.inspect(reviewId);
  await assert.rejects(reviewStore.persistIntent({ ...record.intent, goalId: "other" }));
  await assert.rejects(reviewStore.persistIntent({ ...record.intent, idempotencyKey: "drifted-key" }));
  await assert.rejects(reviewStore.persistResult({ ...record.result, status: "changes_required" }));
  await chmod(join(stateRoot, "final-reviews", `${reviewId}.json`), 0o644); await assert.rejects(reviewStore.inspect(reviewId));
}));
test("file store rejects tampered result hashes and never retains provider raw text", async () => withRoot(async stateRoot => {
  const reviewStore = fileStore(stateRoot); let reviewId;
  await run({ manifest: manifest(), approval, reviewStore, provider: async input => { reviewId = input.reviewId; return { severity: "none", reportRef: `sha256:${h("b")}`, prompt: "secret", response: "secret" }; } });
  const recovered = await reviewStore.inspect(reviewId);
  await assert.rejects(reviewStore.persistResult({ ...recovered.result, resultHash: h("c") }));
  assert.doesNotMatch(JSON.stringify(recovered), /secret|prompt|response/);
}));
