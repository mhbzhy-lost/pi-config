import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RootBrokerServer } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts";
import { createRunAuthorization } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/run-authorization.ts";
import * as protocol from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-protocol.ts";

test("authority contract exports strict owner receipt, lease and CAS schemas", async () => {
  const authority = await import("../packages/pi-subagents-enhanced/src/subagent-dispatch/authority-contract.ts");
  assert.equal(typeof authority.createOwnerReceipt, "function");
  const receipt = authority.createOwnerReceipt({ receiptId: "receipt-1", rootSessionId: "root-1", runId: "run-1", ownerGeneration: 1, processBirth: "birth-1", revision: 1, authorizationReference: "sha256:" + "a".repeat(64) });
  assert.equal(receipt.digest, authority.digestOwnerReceipt(receipt));
  assert.deepEqual(authority.parseOwnerReceipt(receipt), receipt);
  assert.throws(() => authority.parseOwnerReceipt({ ...receipt, revision: 0 }), /revision|invalid/);
  assert.equal(authority.RECOVERY_RPC_DEADLINE_MS, 5000);
  assert.equal(protocol.BROKER_FRAME_LIMIT_BYTES, 64 * 1024);
});

test("rebind and lease contracts reject stale generation, CAS and process birth", async () => {
  const authority = await import("../packages/pi-subagents-enhanced/src/subagent-dispatch/authority-contract.ts");
  assert.equal(authority.AUTHORITY_ERROR_CODES.STALE_GENERATION, "stale_generation");
  assert.equal(authority.AUTHORITY_ERROR_CODES.CAS_CONFLICT, "cas_conflict");
  assert.equal(authority.AUTHORITY_ERROR_CODES.PROCESS_BIRTH_MISMATCH, "process_birth_mismatch");
  assert.throws(() => authority.parseRebindRequest({ sourceRunId: "run-1", expectedGeneration: 0, expectedProcessBirth: "birth", resumedRunId: "run-2", expectedRevision: 1, expectedResumedRevision: 1 }), /expectedGeneration/);
  assert.throws(() => authority.parseRebindRequest({ sourceRunId: "run-1", expectedGeneration: 1, expectedProcessBirth: "birth", resumedRunId: "run-1", expectedRevision: 1, expectedResumedRevision: 1 }), /different/);
  assert.deepEqual(authority.parseRenewLeaseRequest({ runId: "run-1", leaseId: "lease-1", ownerGeneration: 1, expectedRevision: 2, expectedRenewalSequence: 3, processBirth: "birth" }).expectedRenewalSequence, 3);
});

test("AuthorityStore fails closed on legacy owner-*.json layout and preserves the evidence", async (t) => {
  const { AuthorityStore } = await import("../packages/pi-subagents-enhanced/src/subagent-dispatch/authority-store.ts");
  const { createOwnerReceipt } = await import("../packages/pi-subagents-enhanced/src/subagent-dispatch/authority-contract.ts");
  const root = await mkdtemp(join(tmpdir(), "root-authority-legacy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Legacy per-run layout evidence: owner-<runId>.json files written by the
  // pre-authority-index broker. It must never be migrated, rewritten or deleted.
  const legacyBytes = JSON.stringify({ runId: "run-legacy", pid: 4242, token: "legacy" });
  await writeFile(join(root, "owner-run-legacy.json"), legacyBytes, { mode: 0o600 });
  const store = new AuthorityStore({ root, rootSessionId: "root-legacy" });
  const receipt = createOwnerReceipt({
    receiptId: "receipt-legacy", rootSessionId: "root-legacy", runId: "run-new", ownerGeneration: 1,
    processBirth: "birth-legacy", revision: 1, authorizationReference: `sha256:${"a".repeat(64)}`,
  });

  // Every authority operation fails closed with the same stable layout error.
  await assert.rejects(store.read("run-legacy"), { code: "unsupported_layout" });
  await assert.rejects(store.read("run-new"), { code: "unsupported_layout" });
  await assert.rejects(store.create(receipt), { code: "unsupported_layout" });
  await assert.rejects(store.revoke("run-legacy", 1), { code: "unsupported_layout" });
  await assert.rejects(store.associate("run-a", "run-b", `sha256:${"b".repeat(64)}`, 1, 1), { code: "unsupported_layout" });
  // Repeated calls keep the same stable code (no transient success window).
  await assert.rejects(store.read("run-legacy"), { code: "unsupported_layout" });

  // The legacy evidence is preserved byte-for-byte and no authority index was
  // created or migrated; the transient lock (if any) is released.
  assert.equal(await readFile(join(root, "owner-run-legacy.json"), "utf8"), legacyBytes);
  await assert.rejects(() => readFile(join(root, "authority-index.json")), { code: "ENOENT" });
  await assert.rejects(() => readFile(join(root, "authority-index.lock")), { code: "ENOENT" });
});

test("Root broker registration fails closed and rolls back on a legacy authority layout", async (t) => {
  const { AuthorityStore } = await import("../packages/pi-subagents-enhanced/src/subagent-dispatch/authority-store.ts");
  const root = await mkdtemp(join(tmpdir(), "root-broker-legacy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacyBytes = JSON.stringify({ runId: "run-legacy", pid: 4242 });
  await writeFile(join(root, "owner-run-legacy.json"), legacyBytes, { mode: 0o600 });
  const broker = new RootBrokerServer({
    rootSessionId: "root-legacy-broker", lifecycleSessionId: "root-legacy-broker",
    authorityStore: new AuthorityStore({ root, rootSessionId: "root-legacy-broker" }),
    captureProcessBirthIdentity: async (pid) => `birth-${pid}`,
    upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} },
  });
  const authorization = createRunAuthorization({ kind: "coding", binding: { runId: "run-legacy-broker", asyncDir: "/tmp/run-legacy-broker", sessionId: "root-legacy-broker", pid: 123, agentProfile: "executor" }, goal: null });
  await assert.rejects(broker.registerAuthorizedRun(authorization), { code: "unsupported_layout" });
  assert.equal(broker.ownedRuns.has("run-legacy-broker"), false, "failed registration must not keep owned-run authority");
  assert.equal(broker.principals.has("run-legacy-broker"), false, "failed registration must not mint a principal");
  assert.equal(await readFile(join(root, "owner-run-legacy.json"), "utf8"), legacyBytes);
});

test("AuthorityStore durably issues, renews and releases a fenced execution lease", async (t) => {
  const { AuthorityStore } = await import("../packages/pi-subagents-enhanced/src/subagent-dispatch/authority-store.ts");
  const { createOwnerReceipt } = await import("../packages/pi-subagents-enhanced/src/subagent-dispatch/authority-contract.ts");
  const root = await mkdtemp(join(tmpdir(), "root-authority-lease-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new AuthorityStore({ root, rootSessionId: "root-lease" });
  const receipt = createOwnerReceipt({ receiptId: "receipt-lease", rootSessionId: "root-lease", runId: "run-lease", ownerGeneration: 1, processBirth: "birth-lease", revision: 1, authorizationReference: `sha256:${"a".repeat(64)}` });
  await store.create(receipt);
  const lease = await store.issueLease({ leaseId: "lease-1", runId: "run-lease", ownerGeneration: 1, processBirth: "birth-lease", expectedRevision: 1, now: 100, windowMs: 60_000 });
  assert.deepEqual(await store.readLease("run-lease"), lease);
  const renewed = await store.renewLease({ runId: "run-lease", leaseId: "lease-1", ownerGeneration: 1, processBirth: "birth-lease", expectedRevision: lease.revision, expectedRenewalSequence: 0, now: 200, windowMs: 60_000 });
  assert.deepEqual(renewed, { ...lease, lastRenewedAt: 200, expiresAt: 60_200, renewalSequence: 1, revision: 2 });
  await assert.rejects(store.renewLease({ runId: "run-lease", leaseId: "lease-1", ownerGeneration: 1, processBirth: "birth-lease", expectedRevision: lease.revision, expectedRenewalSequence: 0, now: 300, windowMs: 60_000 }), { code: "cas_conflict" });
  await store.releaseLease({ runId: "run-lease", leaseId: "lease-1", ownerGeneration: 1, processBirth: "birth-lease", expectedRevision: renewed.revision });
  await assert.rejects(store.readLease("run-lease"), { code: "unknown_run" });
});

test("Root Broker durably issues generation one only after verified birth and fences rebind/revoke", async (t) => {
  const { AuthorityStore } = await import("../packages/pi-subagents-enhanced/src/subagent-dispatch/authority-store.ts");
  const root = await mkdtemp(join(tmpdir(), "root-authority-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const births = new Map([[123, "birth-1"], [456, "birth-2"]]);
  const broker = new RootBrokerServer({ rootSessionId: "root-1", lifecycleSessionId: "root-1", authorityStore: new AuthorityStore({ root }), captureProcessBirthIdentity: async (pid) => births.get(pid), upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} } });
  const authorization = (runId, pid) => createRunAuthorization({ kind: "coding", binding: { runId, asyncDir: `/tmp/${runId}`, sessionId: "root-1", pid, agentProfile: "executor" }, goal: null });
  await broker.registerAuthorizedRun(authorization("run-1", 123));
  await broker.registerAuthorizedRun(authorization("run-2", 456));
  const issued = await broker.readOwnerReceipt("run-1");
  const resumed = await broker.readOwnerReceipt("run-2");
  assert.equal(issued.processBirth, "birth-1");
  assert.equal(resumed.processBirth, "birth-2");
  const request = { sourceRunId: "run-1", expectedGeneration: 1, expectedRevision: issued.revision, expectedProcessBirth: "birth-1", resumedRunId: "run-2", expectedResumedRevision: resumed.revision };
  const rebound = await broker.rebindRun(request);
  assert.deepEqual(await broker.rebindRun(request), rebound, "same CAS request is idempotent");
  assert.equal(rebound.runId, "run-2");
  await assert.rejects(broker.readOwnerReceipt("run-1"), { code: "unknown_run" });
  await assert.rejects(broker.rebindRun({ ...request, resumedRunId: "run-1" }), /different/);
  await assert.rejects(broker.rebindRun({ ...request, expectedResumedRevision: 99 }), { code: "cas_conflict" });
  await assert.rejects(broker.rebindRun({ ...request, resumedRunId: "missing-run" }), { code: "unknown_run" });
  await broker.revokeOwner({ runId: "run-2", ownerGeneration: 1, processBirth: "birth-2", expectedRevision: resumed.revision });
  await assert.rejects(broker.readOwnerReceipt("run-2"), { code: "unknown_run" });
});
