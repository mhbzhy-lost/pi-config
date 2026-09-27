import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJiti } from "../packages/pi-subagents-enhanced/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const contract = await jiti.import("../packages/pi-subagents-enhanced/src/subagent-dispatch/durable-contract.ts");
const storageModule = await jiti.import("../packages/pi-subagents-enhanced/src/subagent-dispatch/durable-storage.ts");
const registryModule = await jiti.import("../packages/pi-subagents-enhanced/src/subagent-dispatch/durable-run-registry.ts");
const { parseDurableEnvelopeV1, parseReplayCursorV1, parseInventoryReferenceV1, parseProvenanceV1 } = contract;
const { DurableStorage, DurableStorageError } = storageModule;
const { DurableRunRegistry } = registryModule;

const ref = (id) => ({ id, digest: "a".repeat(64), revision: 1, reference: `opaque:${id}` });

test("durable storage loads through Node native type stripping", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", 'import "./packages/pi-subagents-enhanced/src/subagent-dispatch/durable-storage.ts"'], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
const inventory = () => ({ runId: "run-1", authorizationReference: ref("authorization-1"), ownerReference: ref("owner-1"), workspaceReference: ref("workspace-1"), provenance: { classification: "production", observedAt: "2026-01-01T00:00:00.000Z" } });

test("durable contract rejects non-JSON, sensitive, oversized and forged authority envelope fields", () => {
  const valid = { version: "durable-envelope.v1", eventId: "event-1", payload: { message: "ok" }, metadata: { kind: "notice" } };
  assert.deepEqual(parseDurableEnvelopeV1(valid), valid);
  assert.throws(() => parseDurableEnvelopeV1({ ...valid, payload: { nested: [{ privateKey: "x" }] } }), /DURABLE_SENSITIVE_KEY/);
  assert.throws(() => parseDurableEnvelopeV1({ ...valid, ownerToken: "x" }), /DURABLE_UNKNOWN_FIELD/);
  assert.throws(() => parseDurableEnvelopeV1({ ...valid, payload: "x".repeat(32 * 1024 + 1) }), /DURABLE_PAYLOAD_TOO_LARGE/);
  assert.throws(() => parseDurableEnvelopeV1({ ...valid, metadata: { text: "x".repeat(64 * 1024) } }), /DURABLE_FRAME_TOO_LARGE/);
  assert.throws(() => parseDurableEnvelopeV1({ ...valid, payload: new Date() }), /DURABLE_JSON_ONLY/);
});

test("receipt, opaque reference, cursor and provenance contracts fail closed", () => {
  assert.deepEqual(parseInventoryReferenceV1(ref("workspace-1")), ref("workspace-1"));
  assert.throws(() => parseInventoryReferenceV1({ ...ref("x"), token: "x" }), /DURABLE_REFERENCE_FIELDS/);
  assert.deepEqual(parseReplayCursorV1({ rootSessionId: "root-1", runId: "run-1", ownerGeneration: 2, epoch: 3, sequence: 4 }), { rootSessionId: "root-1", runId: "run-1", ownerGeneration: 2, epoch: 3, sequence: 4 });
  assert.throws(() => parseReplayCursorV1({ rootSessionId: "root-1", runId: "run-1", ownerGeneration: -1, epoch: 3, sequence: 4 }), /DURABLE_CURSOR/);
  assert.equal(parseProvenanceV1({ classification: "unconfirmed", observedAt: "2026-01-01T00:00:00.000Z", quarantineReference: ref("q") }).status, "blocked-unknown");
  assert.throws(() => parseProvenanceV1({ classification: "unconfirmed", observedAt: "2026-01-01T00:00:00.000Z" }), /DURABLE_PROVENANCE/);
});

test("storage uses private 0600 revision CAS and rejects malformed files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "durable-test-"));
  const store = new DurableStorage({ root });
  const first = await store.write("inventory", { hello: "world" }, 0);
  assert.equal(first.revision, 1);
  assert.equal((await stat(path.join(root, "inventory.json"))).mode & 0o777, 0o600);
  assert.deepEqual(await store.read("inventory"), first);
  await assert.rejects(() => store.write("inventory", { hello: "again" }, 0), error => error.code === "DURABLE_REVISION_CONFLICT");
  await writeFile(path.join(root, "bad.json"), "{", { mode: 0o600 });
  await assert.rejects(() => store.read("bad"), error => error.code === "DURABLE_STORAGE_CORRUPT");
});

test("storage quarantines demonstrably stale lock and refuses live lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "durable-lock-"));
  const store = new DurableStorage({ root, staleLockMs: 100 });
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(path.join(root, "inventory.lock"), JSON.stringify({ owner: "dead", processBirth: "old" }), { mode: 0o600 });
  await new Promise(resolve => setTimeout(resolve, 150));
  const release = await store.acquireLock("inventory");
  await release();
  const release2 = await store.acquireLock("live");
  await assert.rejects(() => store.acquireLock("live"), error => error.code === "DURABLE_LOCK_HELD");
  await release2();
});

test("inventory remains reference-only and unconfirmed evidence is blocked", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "durable-registry-"));
  const registry = new DurableRunRegistry({ storage: new DurableStorage({ root }) });
  const saved = await registry.recordInventory(inventory());
  assert.deepEqual((await registry.loadInventory("run-1")).inventory, saved.inventory);
  await assert.rejects(() => registry.recordInventory({ ...inventory(), stop: true }), /DURABLE_INVENTORY_FIELDS/);
  await assert.rejects(() => registry.markOrphaned("run-1", { disposition: "discard" }), /DURABLE_ORPHAN_FIELDS/);
  const blocked = await registry.recordInventory({ ...inventory(), runId: "run-unknown", provenance: { classification: "unconfirmed", observedAt: "2026-01-01T00:00:00.000Z", quarantineReference: ref("diagnostic") } });
  assert.equal(blocked.status, "blocked-unknown");
});
