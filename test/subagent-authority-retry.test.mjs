import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthorityStore, AuthorityStoreError } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/authority-store.ts";
import { DurableStorageError } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/durable-storage.ts";
import { RootBrokerServer } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts";
import { createRunAuthorization } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/run-authorization.ts";
import { createOwnerReceipt } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/authority-contract.ts";

function ownerReceipt(rootSessionId, runId, processBirth) {
  return createOwnerReceipt({
    receiptId: `owner-${runId}`,
    rootSessionId,
    runId,
    ownerGeneration: 1,
    processBirth,
    revision: 1,
    authorizationReference: `sha256:${"a".repeat(64)}`,
  });
}

function genericAuthorization(rootSessionId, runId) {
  return createRunAuthorization({
    kind: "generic",
    binding: { runId, asyncDir: `/tmp/${runId}`, sessionId: rootSessionId, pid: 123, agentProfile: "probe-worker" },
    goal: null,
  });
}

// Delegates to a real AuthorityStore while holding the real authority-index
// lock for the first `contendAttempts` registrations, reproducing a parallel
// registrant racing the same index lock inside one dispatch window
// (bug #4: two generic dispatches raced one authority-index lock).
function contendedAuthorityStore(realStore, root, contendAttempts) {
  let attempts = 0;
  const store = {
    setRootSessionId: (rootSessionId) => realStore.setRootSessionId(rootSessionId),
    async createWithLease(receipt, input) {
      attempts += 1;
      if (attempts <= contendAttempts) {
        const lock = join(root, "authority-index.lock");
        await writeFile(lock, JSON.stringify({ owner: `parallel-${attempts}`, processBirth: `parallel-birth-${attempts}` }), { mode: 0o600 });
        try {
          return await realStore.createWithLease(receipt, input);
        } finally {
          await rm(lock, { force: true });
        }
      }
      return realStore.createWithLease(receipt, input);
    },
  };
  store.attempts = () => attempts;
  return store;
}

test("AuthorityStore maps a fresh index lock to authority_lock_contention and preserves the storage cause", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "authority-contention-code-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new AuthorityStore({ root, rootSessionId: "root-contention" });
  // A parallel registrant holds a fresh authority-index lock.
  await writeFile(join(root, "authority-index.lock"), JSON.stringify({ owner: "parallel", processBirth: "parallel-birth" }), { mode: 0o600 });
  await assert.rejects(
    () => store.createWithLease(ownerReceipt("root-contention", "run-contention", "birth-contention"), { leaseId: "lease-contention", now: 1_000, windowMs: 60_000 }),
    (error) => {
      assert.ok(error instanceof AuthorityStoreError, `expected AuthorityStoreError, got ${error?.constructor?.name}`);
      assert.equal(error.code, "authority_lock_contention");
      assert.ok(error.cause instanceof DurableStorageError, "lock contention must preserve the underlying storage error as cause");
      assert.equal(error.cause.code, "DURABLE_LOCK_HELD");
      return true;
    },
  );
});

test("AuthorityStore keeps authority_store_unavailable for unknown storage errors and attaches the cause", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "authority-unknown-cause-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new AuthorityStore({ root, rootSessionId: "root-unknown-cause" });
  // A corrupt index is not lock contention: the generic unavailable code must
  // survive while the underlying storage error chain stays attached.
  await writeFile(join(root, "authority-index.json"), "{", { mode: 0o600 });
  await assert.rejects(
    () => store.createWithLease(ownerReceipt("root-unknown-cause", "run-unknown-cause", "birth-unknown-cause"), { leaseId: "lease-unknown-cause", now: 1_000, windowMs: 60_000 }),
    (error) => {
      assert.ok(error instanceof AuthorityStoreError, `expected AuthorityStoreError, got ${error?.constructor?.name}`);
      assert.equal(error.code, "authority_store_unavailable");
      assert.ok(error.cause instanceof DurableStorageError, "unknown storage errors must attach the underlying error as cause");
      assert.equal(error.cause.code, "DURABLE_STORAGE_CORRUPT");
      return true;
    },
  );
});

test("registerAuthorizedRun retries transient lock contention and settles the dispatch in the same window", async (t) => {
  const rootSessionId = "root-retry-success";
  const runId = "run-retry-success";
  const root = await mkdtemp(join(tmpdir(), "authority-retry-success-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const realStore = new AuthorityStore({ root, rootSessionId });
  const store = contendedAuthorityStore(realStore, root, 1);
  const broker = new RootBrokerServer({
    rootSessionId,
    lifecycleSessionId: rootSessionId,
    authorityStore: store,
    captureProcessBirthIdentity: async () => "birth-retry-success",
    upstream: { async ping() {}, async stop() {}, async dispose() {} },
  });
  t.after(() => broker.closeRootSession().catch(() => undefined));
  await broker.registerAuthorizedRun(genericAuthorization(rootSessionId, runId));
  assert.equal(store.attempts(), 2, "the contended first attempt must be retried, not failed fast");
  const owner = await realStore.read(runId);
  assert.equal(owner.receipt.processBirth, "birth-retry-success");
  const lease = await realStore.readLease(runId);
  assert.equal(lease.runId, runId);
  assert.equal(broker.ownedRuns.has(runId), false, "generic runs stay facade-only principals");
});

test("registerAuthorizedRun keeps the distinctive contention code after exhausting the bounded retries", async (t) => {
  const rootSessionId = "root-retry-exhausted";
  const runId = "run-retry-exhausted";
  const root = await mkdtemp(join(tmpdir(), "authority-retry-exhausted-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const realStore = new AuthorityStore({ root, rootSessionId });
  const store = contendedAuthorityStore(realStore, root, Number.POSITIVE_INFINITY);
  const broker = new RootBrokerServer({
    rootSessionId,
    lifecycleSessionId: rootSessionId,
    authorityStore: store,
    captureProcessBirthIdentity: async () => "birth-retry-exhausted",
    upstream: { async ping() {}, async stop() {}, async dispose() {} },
  });
  t.after(() => broker.closeRootSession().catch(() => undefined));
  await assert.rejects(
    () => broker.registerAuthorizedRun(genericAuthorization(rootSessionId, runId)),
    (error) => {
      assert.ok(error instanceof AuthorityStoreError, `expected AuthorityStoreError, got ${error?.constructor?.name}`);
      assert.equal(error.code, "authority_lock_contention", "exhausted contention must keep the distinctive code, not the generic unavailable code");
      assert.ok(error.cause instanceof DurableStorageError);
      assert.equal(error.cause.code, "DURABLE_LOCK_HELD");
      return true;
    },
  );
  assert.equal(store.attempts(), 3, "retry must stay bounded at three attempts");
  await assert.rejects(() => realStore.read(runId), /unknown_run/);
});

test("registerAuthorizedRun does not retry non-transient cas_conflict authority errors", async (t) => {
  const rootSessionId = "root-no-retry";
  const runId = "run-no-retry";
  const root = await mkdtemp(join(tmpdir(), "authority-no-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const realStore = new AuthorityStore({ root, rootSessionId });
  const store = contendedAuthorityStore(realStore, root, 0);
  let processBirth = "birth-cas-first";
  const broker = new RootBrokerServer({
    rootSessionId,
    lifecycleSessionId: rootSessionId,
    authorityStore: store,
    captureProcessBirthIdentity: async () => processBirth,
    upstream: { async ping() {}, async stop() {}, async dispose() {} },
  });
  t.after(() => broker.closeRootSession().catch(() => undefined));
  // The first registration settles a real owner receipt and lease.
  await broker.registerAuthorizedRun(genericAuthorization(rootSessionId, runId));
  const attemptsAfterFirst = store.attempts();
  // A second registration of the same run with a different process birth is a
  // deterministic digest conflict: it must fail immediately with zero retries.
  processBirth = "birth-cas-second";
  await assert.rejects(
    () => broker.registerAuthorizedRun(genericAuthorization(rootSessionId, runId)),
    (error) => {
      assert.ok(error instanceof AuthorityStoreError, `expected AuthorityStoreError, got ${error?.constructor?.name}`);
      assert.equal(error.code, "cas_conflict");
      return true;
    },
  );
  assert.equal(store.attempts(), attemptsAfterFirst + 1, "non-transient failures must make exactly one store attempt");
});
