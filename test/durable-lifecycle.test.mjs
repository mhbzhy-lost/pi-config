import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { mkdtemp, mkdir, stat, writeFile, readFile, readdir, rm, utimes } from "node:fs/promises";
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

async function terminatedLockOwner(root, key) {
  const source = new URL('../packages/pi-subagents-enhanced/src/subagent-dispatch/durable-storage.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    import { DurableStorage } from ${JSON.stringify(source)};
    await new DurableStorage({root:${JSON.stringify(root)}}).acquireLock(${JSON.stringify(key)});
    process.stdout.write('lock-ready\\n');
    process.stdin.once('data',()=>process.exit(0));
  `], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stderr.on('data', chunk => errors += chunk);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error('fixture lock owner deadline')); }, 5000);
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('lock-ready')) { clearTimeout(timer); resolve(); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); if (!output.includes('lock-ready')) reject(Error(`fixture exited ${code}: ${errors}`)); });
  });
  await new Promise((resolve, reject) => { child.once('exit', code => code === 0 ? resolve() : reject(Error('fixture abnormal exit'))); child.stdin.end('exit'); });
  assert.throws(() => process.kill(child.pid, 0), error => error.code === 'ESRCH');
  return child.pid;
}

test("public acquireLock 生成的新鲜死进程锁可立即隔离，活进程锁即使老化也不可抢", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "durable-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DurableStorage({ root, staleLockMs: 100 });
  await terminatedLockOwner(root, 'inventory');
  const release = await store.acquireLock("inventory");
  await release();
  assert.equal((await readdir(root)).filter(file => file.startsWith('inventory.lock.quarantine-')).length, 1);
  const release2 = await store.acquireLock("live");
  const old = new Date(Date.now() - 10_000); await utimes(path.join(root, 'live.lock'), old, old);
  await assert.rejects(() => store.acquireLock("live"), error => error.code === "DURABLE_LOCK_HELD");
  await release2();
});

test('两个public回收者竞争同一dead lock只能一个持有；release幂等不删别人的锁', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'durable-recovery-race-')); t.after(() => rm(root, { recursive: true, force: true }));
  await terminatedLockOwner(root, 'inventory');
  const a = new DurableStorage({ root }), b = new DurableStorage({ root });
  const results = await Promise.allSettled([a.acquireLock('inventory'), b.acquireLock('inventory')]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  const first = results.find(x => x.status === 'fulfilled').value; await first();
  const second = await b.acquireLock('inventory'); const before = await readFile(path.join(root, 'inventory.lock'), 'utf8');
  await first(); assert.equal(await readFile(path.join(root, 'inventory.lock'), 'utf8'), before); await second();
});

test('旧合法pid:uptime元数据可恢复；来源不明/坏格式/权限/guard残留不自动清理', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'durable-unproven-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DurableStorage({ root, staleLockMs: 100 });
  await terminatedLockOwner(root, 'legacy');
  const file = path.join(root, 'legacy.lock'); const metadata = JSON.parse(await readFile(file, 'utf8')); delete metadata.pid;
  // 旧writer schema的精确迁移fixture；owner来源与原子锁由public入口产生。
  await writeFile(file, JSON.stringify(metadata), { mode: 0o600 }); const release = await store.acquireLock('legacy'); await release();
  for (const [key, raw] of [['unknown', { owner: 'fixture', processBirth: 'old' }], ['invalid', { owner: 'fixture', pid: 0 }]]) {
    await writeFile(path.join(root, key + '.lock'), JSON.stringify(raw), { mode: 0o600 });
    await assert.rejects(store.acquireLock(key), error => error.code === 'DURABLE_LOCK_UNPROVEN');
  }
  await writeFile(path.join(root, 'empty.lock'), '', { mode: 0o600 });
  await assert.rejects(store.acquireLock('empty'), error => error.code === 'DURABLE_LOCK_HELD');
  const old = new Date(Date.now() - 10_000); await utimes(path.join(root, 'empty.lock'), old, old);
  await assert.rejects(store.acquireLock('empty'), error => error.code === 'DURABLE_LOCK_UNPROVEN');
  await writeFile(path.join(root, 'guarded.lock.guard'), '', { mode: 0o600 });
  await assert.rejects(store.acquireLock('guarded'), error => error.code === 'DURABLE_LOCK_HELD');
});

test('fresh supervisor ready在public owner退出后立即恢复，不需要等待60秒TTL', async t => {
  const { createHash } = await import('node:crypto');
  const { createSupervisorControlPlane } = await import('../packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-control-plane.ts');
  const root = await mkdtemp(path.join(os.tmpdir(), 'durable-supervisor-start-')); t.after(() => rm(root, { recursive: true, force: true }));
  const key = 'supervisor-' + createHash('sha256').update('fixture-root-session').digest('hex');
  await terminatedLockOwner(root, key);
  assert.equal(await createSupervisorControlPlane({ persistenceRoot: root }).ready('fixture-root-session'), true);
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
