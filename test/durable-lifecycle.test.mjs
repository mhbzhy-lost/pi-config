import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { chmod, mkdtemp, mkdir, stat, symlink, writeFile, readFile, readdir, rm, utimes } from "node:fs/promises";
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
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", 'import { DurableStorage } from "./packages/pi-subagents-enhanced/src/subagent-dispatch/durable-storage.ts"; new DurableStorage({root:process.cwd()})'], { cwd: process.cwd(), encoding: "utf8" });
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
    globalThis.releaseLock = await new DurableStorage({root:${JSON.stringify(root)}}).acquireLock(${JSON.stringify(key)});
    process.stdout.write('lock-ready\\n');
    process.stdin.resume();
  `], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stderr.on('data', chunk => errors += chunk);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error('fixture lock owner deadline')); }, 5000);
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('lock-ready')) { clearTimeout(timer); resolve(); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); if (!output.includes('lock-ready')) reject(Error(`fixture exited ${code}: ${errors}`)); });
  });
  let info;
  try {
    info = await stat(path.join(root, `.flock-v1.${key}.lock`));
    await assert.rejects(new DurableStorage({ root }).acquireLock(key), error => error.code === 'DURABLE_LOCK_HELD');
  } finally {
    await new Promise((resolve, reject) => {
      child.once('exit', (code, signal) => signal === 'SIGKILL' ? resolve() : reject(Error(`fixture exit ${code}/${signal}`)));
      child.kill('SIGKILL');
    });
  }
  assert.throws(() => process.kill(child.pid, 0), error => error.code === 'ESRCH');
  return info.ino;
}

test("public acquireLock 的 owner 被 SIGKILL 后可立即重获同一 inode，活锁老化也不可抢", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "durable-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DurableStorage({ root, staleLockMs: 100 });
  const inode = await terminatedLockOwner(root, 'inventory');
  const release = await store.acquireLock("inventory");
  await release();
  assert.equal((await stat(path.join(root, '.flock-v1.inventory.lock'))).ino, inode);
  assert.deepEqual(await readdir(root), ['.flock-v1.inventory.lock']);
  const release2 = await store.acquireLock("live");
  const old = new Date(Date.now() - 10_000); await utimes(path.join(root, '.flock-v1.live.lock'), old, old);
  await assert.rejects(() => store.acquireLock("live"), error => error.code === "DURABLE_LOCK_HELD");
  await release2();
});

test('两个 public 竞争者只能一个持有；release 并发及重复调用不释放下一任锁', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'durable-recovery-race-')); t.after(() => rm(root, { recursive: true, force: true }));
  const inode = await terminatedLockOwner(root, 'inventory');
  const a = new DurableStorage({ root }), b = new DurableStorage({ root });
  const results = await Promise.allSettled([a.acquireLock('inventory'), b.acquireLock('inventory')]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.find(x => x.status === 'rejected').reason.code, 'DURABLE_LOCK_HELD');
  const first = results.find(x => x.status === 'fulfilled').value;
  const closing = first(); assert.equal(first(), closing); await closing;
  const second = await b.acquireLock('inventory');
  try {
    await first();
    await assert.rejects(a.acquireLock('inventory'), error => error.code === 'DURABLE_LOCK_HELD');
    assert.equal((await stat(path.join(root, '.flock-v1.inventory.lock'))).ino, inode);
  } finally { await second(); }
  assert.deepEqual(await readdir(root), ['.flock-v1.inventory.lock']);
});

test('旧元数据、空锁和 guard 明确要求迁移并保留；新版锁权限和类型异常拒绝', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'durable-unproven-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DurableStorage({ root, staleLockMs: 100 });
  // 明确模拟旧协议文件；新 writer 不再解析 PID 或按年龄推断迁移安全性。
  for (const [key, raw] of [['legacy', JSON.stringify({ owner: 'fixture', processBirth: '123:1' })], ['invalid', '{'], ['empty', '']]) {
    const file = path.join(root, key + '.lock');
    await writeFile(file, raw, { mode: 0o600 });
    const before = await stat(file);
    for (const age of [0, 10_000]) {
      const timestamp = new Date(Date.now() - age); await utimes(file, timestamp, timestamp);
      await assert.rejects(store.acquireLock(key), error => error.code === 'DURABLE_LOCK_MIGRATION_REQUIRED');
      assert.equal(await readFile(file, 'utf8'), raw);
      assert.equal((await stat(file)).ino, before.ino);
    }
  }
  const guard = path.join(root, 'guarded.lock.guard');
  await writeFile(guard, '', { mode: 0o600 });
  const guardInode = (await stat(guard)).ino;
  await assert.rejects(store.acquireLock('guarded'), error => error.code === 'DURABLE_LOCK_MIGRATION_REQUIRED');
  assert.equal((await stat(guard)).ino, guardInode);
  assert.deepEqual((await readdir(root)).sort(), ['empty.lock', 'guarded.lock.guard', 'invalid.lock', 'legacy.lock']);
  const insecure = path.join(root, '.flock-v1.insecure.lock');
  await writeFile(insecure, '', { mode: 0o600 }); await chmod(insecure, 0o644);
  await assert.rejects(store.acquireLock('insecure'), error => error.code === 'DURABLE_LOCK_UNPROVEN');
  await mkdir(path.join(root, '.flock-v1.directory.lock'));
  await assert.rejects(store.acquireLock('directory'), error => error.code === 'DURABLE_LOCK_UNPROVEN');
  await symlink(insecure, path.join(root, '.flock-v1.symlink.lock'));
  await assert.rejects(store.acquireLock('symlink'), error => error.code === 'DURABLE_LOCK_UNPROVEN');
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
