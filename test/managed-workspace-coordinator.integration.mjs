import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, symlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import net from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalWorkspaceStateRoot, createCoordinatorRegistry } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-registry.ts";
import { ensureCoordinatorDaemon } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-spawn.ts";
import { auditManagedWorkspaces } from "../packages/pi-subagents-enhanced/src/workspace/administration.ts";
import { connectRepositoryCoordinator } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-client.ts";
import { createCoordinatorServer } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts";
import { challengeRootBroker } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-client.ts";
import { RootBrokerServer } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts";
import { startAndBindRootBroker, closeAndUnbindRootBroker, rootBrokerRegistryEntry } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-registry.ts";
import { connectRuntimeCoordinator } from "../packages/pi-subagents-enhanced/extensions/subagent-runtime.ts";

async function spawnRootBroker(t, rootSessionId) {
  const script = `
    import { RootBrokerServer } from ${JSON.stringify(path.resolve("packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts"))};
    import { startAndBindRootBroker, rootBrokerRegistryEntry } from ${JSON.stringify(path.resolve("packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-registry.ts"))};
    const pi = {};
    const broker = new RootBrokerServer({ rootSessionId: process.env.ROOT_SESSION_ID, upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} } });
    await startAndBindRootBroker(pi, broker);
    process.stdout.write(JSON.stringify(await rootBrokerRegistryEntry(pi)) + "\\n");
    process.on("SIGTERM", async () => { await broker.closeRootSession().catch(() => undefined); process.exit(0); });
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    env: { ...process.env, ROOT_SESSION_ID: rootSessionId }, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  return await new Promise((resolve, reject) => {
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => reject(new Error(`Root Broker startup timed out: ${stderr}`)), 5_000);
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline >= 0) { clearTimeout(timer); resolve(JSON.parse(stdout.slice(0, newline))); }
    });
    child.once("error", reject);
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Root Broker exited ${code}: ${stderr}`)); });
  });
}

test("coordinator registry derives one endpoint per common dir and spawn enforces one state-root scope", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coordinator-"));
  const commonDir = path.join(root, "common");
  const a = createCoordinatorRegistry({ commonDir, stateRoot: path.join(root, "state-a") });
  const b = createCoordinatorRegistry({ commonDir, stateRoot: path.join(root, "state-b") });
  assert.equal(a.endpoint, b.endpoint, "endpoint 由 commonDir 哈希推导，与 state root 无关");
  // 预置 daemon 登记（state-a），另一个 state root 的拉起必须 scope fail-closed。
  const handle = await ensureCoordinatorDaemon({ stateRoot: path.join(root, "state-a"), repositoryId: "a".repeat(64), commonDir, endpoint: a.endpoint, idleExitGraceMs: 60_000 });
  try {
    await assert.rejects(() => ensureCoordinatorDaemon({ stateRoot: path.join(root, "state-b"), repositoryId: "a".repeat(64), commonDir, endpoint: b.endpoint }), (error) => error.code === "COORDINATOR_SCOPE_MISMATCH");
  } finally {
    process.kill(handle.metadata.pid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

test("aliased state root is realpath-normalized so coordinator and ledger share one scope", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coordinator-canonical-"));
  const target = path.join(root, "state");
  const alias = path.join(root, "state-alias");
  await mkdir(target, { recursive: true });
  await symlink(target, alias, "dir");
  const canonical = realpathSync(target);
  assert.notEqual(alias, canonical, "the fixture must reproduce the macOS /var alias form");
  assert.equal(canonicalWorkspaceStateRoot(alias), canonical, "规范化把 alias 归一到 realpath");
  const commonDir = path.join(root, "common");
  const repositoryId = "a".repeat(64);
  const registry = createCoordinatorRegistry({ commonDir, stateRoot: alias });
  // daemon 登记面：原子写入 + 读回，canonical scope 一致。
  await registry.writeRaw(`${JSON.stringify({ protocol: "repository-workspace-coordinator.v1", kind: "daemon", instanceId: "i".repeat(8), pid: 1, birthIdentity: "0".repeat(64), repositoryId, storageRepositoryId: repositoryId, canonicalStateRoot: canonical, endpoint: registry.endpoint })}\n`);
  const metadata = await registry.read();
  assert.equal(metadata.canonicalStateRoot, canonical, "登记的 canonical state root 必须是 realpath");
});

test("registry writeRaw is atomic and leaves no temp residue", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coordinator-write-atomic-"));
  const registry = createCoordinatorRegistry({ commonDir: path.join(root, "common"), stateRoot: path.join(root, "state") });
  const payload = { protocol: "repository-workspace-coordinator.v1", kind: "daemon", instanceId: "atomic".slice(0, 8), pid: 1, birthIdentity: "0".repeat(64), repositoryId: "e".repeat(64), storageRepositoryId: "e".repeat(64), canonicalStateRoot: path.join(root, "state"), endpoint: registry.endpoint };
  await registry.writeRaw(`${JSON.stringify(payload)}\n`);
  assert.equal((await registry.read()).instanceId, payload.instanceId);
  const dirEntries = [];
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(registry.metadataDir)) dirEntries.push(entry);
  assert.deepEqual(dirEntries, ["coordinator.json"], "原子写不留 temp 残留");
  assert.equal((await stat(registry.metadataPath)).mode & 0o777, 0o600);
  assert.equal((await stat(registry.metadataDir)).mode & 0o777, 0o700);
});

test("long Git common-dir metadata uses a short endpoint that can listen and connect", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "coordinator-long-path-"));
  const commonDir = path.join(root, "common", ...Array.from({ length: 8 }, (_, i) => `directory-${i}-${"x".repeat(24)}`));
  execFileSync("git", ["init", "--bare", commonDir], { stdio: "ignore" });
  const registry = createCoordinatorRegistry({ commonDir, stateRoot: path.join(root, "state") });
  const endpoint = registry.endpoint;
  await mkdir(registry.metadataDir, { recursive: true, mode: 0o700 });
  assert.ok(endpoint.length < 100);
  const server = createCoordinatorServer({ endpoint, repositoryId: "e".repeat(64), handler: () => ({ accepted: true }) });
  await server.listen();
  t.after(() => server.close());
  const connected = await new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint, () => { socket.end(); resolve(true); });
    socket.once("error", reject);
  });
  assert.equal(connected, true);
  assert.equal((await stat(registry.metadataDir)).mode & 0o777, 0o700);
  assert.equal((await stat(registry.dir)).mode & 0o777, 0o700);
});

test("runtime propagates the claimed hash endpoint instead of rebuilding a socket basename", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "coordinator-runtime-long-path-"));
  const repository = path.join(root, ...Array.from({ length: 8 }, (_, i) => `directory-${i}-${"x".repeat(24)}`), "repository");
  execFileSync("mkdir", ["-p", repository]);
  execFileSync("git", ["init", "-b", "main"], { cwd: repository, stdio: "ignore" });
  const pi = {};
  const broker = new RootBrokerServer({
    rootSessionId: `runtime-endpoint-${process.pid}-${Date.now()}`,
    upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} },
  });
  await startAndBindRootBroker(pi, broker);
  t.after(() => closeAndUnbindRootBroker(pi, broker));

  const runtime = await connectRuntimeCoordinator({ pi, cwd: repository, broker, stateRoot: path.join(root, "state") });
  t.after(() => runtime?.close());
  assert.ok(runtime);
  // 懒加载契约：仓库选择阶段零登记零连接；endpoint 仍由 registry 哈希推导。
  assert.equal(path.basename(runtime.registry.endpoint), runtime.registry.endpoint.split("/").pop());
  assert.notEqual(path.basename(runtime.registry.endpoint), "coordinator.sock");
  await assert.rejects(() => runtime.registry.read());
  // 首个需要类操作拉起 daemon：登记后 instanceId 与 client 一致。
  const client = await runtime.requireClient();
  const metadata = await runtime.registry.read();
  assert.equal(metadata.endpoint, runtime.registry.endpoint);
  assert.notEqual(path.basename(metadata.endpoint), "coordinator.sock");
  assert.equal(client.instanceId, metadata.instanceId);
  assert.deepEqual(await client.ping(), { instanceId: metadata.instanceId, repositoryId: metadata.repositoryId, storageRepositoryId: metadata.storageRepositoryId, endpoint: metadata.endpoint });
});

test("real coordinator process and client bind the registry metadata endpoint and identity", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "coordinator-process-endpoint-"));
  const repositoryId = "9".repeat(64);
  const instanceId = `coordinator-instance-${process.pid}`;
  const endpoint = createCoordinatorRegistry({ commonDir: path.join(root, "common"), stateRoot: path.join(root, "state") }).endpoint;
  const registry = createCoordinatorRegistry({ commonDir: path.join(root, "common"), stateRoot: path.join(root, "state") });
  const broker = await spawnRootBroker(t, `root-process-${process.pid}-${Date.now()}`);
  const child = spawn(process.execPath, ["--experimental-strip-types", path.resolve("packages/pi-subagents-enhanced/src/workspace/coordinator-process.ts")], {
    env: {
      ...process.env,
      PI_COORDINATOR_ENDPOINT: endpoint,
      PI_COORDINATOR_REPOSITORY_ID: repositoryId,
      PI_COORDINATOR_INSTANCE_ID: instanceId,
      PI_COORDINATOR_STATE_ROOT: path.join(root, "state"),
      PI_COORDINATOR_CAPABILITY: "a".repeat(64),
      PI_COORDINATOR_COMMON_DIR: path.join(root, "common"),
      PI_COORDINATOR_IDLE_EXIT_GRACE_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  const ready = await new Promise((resolve, reject) => {
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => reject(new Error(`Coordinator process startup timed out: ${stderr}`)), 5_000);
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline >= 0) { clearTimeout(timer); resolve(JSON.parse(stdout.slice(0, newline))); }
    });
    child.once("error", reject);
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Coordinator process exited ${code}: ${stderr}`)); });
  });
  // daemon 在 startupReady 后自行原子登记 metadata（env 形实例 id 被沿用）。
  const metadata = await registry.read();
  assert.equal(metadata.endpoint, endpoint);
  assert.equal(metadata.instanceId, instanceId);
  assert.deepEqual(ready, {
    protocol: metadata.protocol,
    kind: "daemon",
    repositoryId: metadata.repositoryId,
    storageRepositoryId: metadata.storageRepositoryId,
    instanceId: metadata.instanceId,
    endpoint: metadata.endpoint,
  });
  const client = await connectRepositoryCoordinator({ repositoryId, storageRepositoryId: metadata.storageRepositoryId }, broker, { metadata });
  t.after(() => client.close());
  assert.deepEqual(await client.ping(), { instanceId: metadata.instanceId, repositoryId, storageRepositoryId: metadata.storageRepositoryId, endpoint: metadata.endpoint });
});

test("two real child processes racing to spawn one daemon converge on one instance", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coordinator-race-"));
  const script = `import { createCoordinatorRegistry } from ${JSON.stringify(path.resolve("packages/pi-subagents-enhanced/src/workspace/coordinator-registry.ts"))};
import { ensureCoordinatorDaemon } from ${JSON.stringify(path.resolve("packages/pi-subagents-enhanced/src/workspace/coordinator-spawn.ts"))};
const r = createCoordinatorRegistry({ commonDir: process.env.C, stateRoot: process.env.S });
const h = await ensureCoordinatorDaemon({ stateRoot: process.env.S, repositoryId: process.env.R, commonDir: process.env.C, endpoint: r.endpoint, idleExitGraceMs: 60_000 });
process.stdout.write(JSON.stringify(h.metadata));`;
  const env = { ...process.env, C: path.join(root, "common"), S: path.join(root, "state"), R: "c".repeat(64) };
  await mkdir(path.join(root, "state"), { recursive: true });
  const children = [0, 1].map(() => spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { env, stdio: ["ignore", "pipe", "pipe"] }));
  const outputs = await Promise.all(children.map((child) => new Promise((resolve, reject) => { let out = ""; child.stdout.on("data", (chunk) => { out += chunk; }); child.once("error", reject); child.once("exit", () => { try { resolve(JSON.parse(out)); } catch (error) { reject(error); } }); })));
  assert.equal(outputs[0].instanceId, outputs[1].instanceId, "并发拉起锁内只产生一个 daemon 实例");
  process.kill(outputs[0].pid, "SIGKILL");
});

test("registry rejects malformed metadata and respawn replaces a dead owner", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "coordinator-"));
  const commonDir = path.join(root, "common");
  const stateRoot = path.join(root, "state");
  await mkdir(stateRoot, { recursive: true });
  const registry = createCoordinatorRegistry({ commonDir, stateRoot });
  await registry.writeRaw("not-json");
  await assert.rejects(() => registry.read(), /metadata/i);
  // 预置死 owner 登记（pid 必然不存在），拉起器应锁内清理并重拉。
  await registry.writeRaw(`${JSON.stringify({ protocol: "repository-workspace-coordinator.v1", kind: "daemon", instanceId: "stale0000", pid: 999999999, birthIdentity: "0".repeat(64), repositoryId: "b".repeat(64), storageRepositoryId: "b".repeat(64), canonicalStateRoot: stateRoot, endpoint: registry.endpoint })}\n`);
  const handle = await ensureCoordinatorDaemon({ stateRoot, repositoryId: "b".repeat(64), commonDir, endpoint: registry.endpoint, idleExitGraceMs: 60_000 });
  t.after(() => { try { process.kill(handle.metadata.pid, "SIGKILL"); } catch { /* 已退出 */ } });
  assert.equal(handle.metadata.protocol, "repository-workspace-coordinator.v1");
  assert.notEqual(handle.metadata.pid, 999999999);
});

test("cross state-root coordinator scope fails closed and pre-daemon registration surfaces audit debt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coordinator-stale-root-"));
  const originRoot = path.join(root, "origin");
  execFileSync("git", ["init", "-b", "main", originRoot], { stdio: "ignore" });
  const commonDir = path.join(originRoot, ".git");
  const repositoryId = "7".repeat(64);
  const stateRoot = path.join(root, "state");
  await mkdir(stateRoot, { recursive: true });
  const registry = createCoordinatorRegistry({ commonDir, stateRoot });
  // 预置另一 state root 的死 owner 登记：拉起器必须 scope fail-closed，不自动跨根接管。
  const foreignRoot = path.join(root, "state-foreign");
  await mkdir(foreignRoot, { recursive: true });
  await registry.writeRaw(`${JSON.stringify({ protocol: "repository-workspace-coordinator.v1", kind: "daemon", instanceId: "foreign0", pid: 999999999, birthIdentity: "0".repeat(64), repositoryId, storageRepositoryId: repositoryId, canonicalStateRoot: foreignRoot, endpoint: registry.endpoint })}\n`);
  await assert.rejects(() => ensureCoordinatorDaemon({ stateRoot, repositoryId, commonDir, endpoint: registry.endpoint }), (error) => error.code === "COORDINATOR_SCOPE_MISMATCH");
  // 无 kind 的旧 claim 残留：audit 以 legacy-registration 债暴露，不当作 daemon。
  await registry.writeRaw(`${JSON.stringify({ protocol: "repository-workspace-coordinator.v1", instanceId: "legacy000", pid: 999999999, birthIdentity: "0".repeat(64), repositoryId, storageRepositoryId: repositoryId, canonicalStateRoot: stateRoot, endpoint: registry.endpoint })}\n`);
  const audit = auditManagedWorkspaces({ stateRoot, originRoot });
  assert.equal(audit.coordinator.status, "stale");
  assert.ok(audit.debts.some((debt) => debt.kind === "coordinator-legacy-registration"), "旧 claim 残留以 legacy 债暴露");
});

test("runtime endpoint metadata mismatch fails closed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coordinator-mismatch-"));
  const stateRoot = path.join(root, "state");
  await mkdir(stateRoot, { recursive: true });
  const registry = createCoordinatorRegistry({ commonDir: root, stateRoot });
  // 预置 repositoryId 不匹配的死 owner 登记：拉起器 scope fail-closed。
  await registry.writeRaw(`${JSON.stringify({ protocol: "repository-workspace-coordinator.v1", kind: "daemon", instanceId: "mismatch0", pid: 999999999, birthIdentity: "0".repeat(64), repositoryId: "0".repeat(64), storageRepositoryId: "0".repeat(64), canonicalStateRoot: stateRoot, endpoint: registry.endpoint })}\n`);
  await assert.rejects(() => ensureCoordinatorDaemon({ stateRoot, repositoryId: "f".repeat(64), commonDir: root, endpoint: registry.endpoint }), (error) => error.code === "COORDINATOR_SCOPE_MISMATCH");
});

test("real cross-process Root Broker challenge registers trusted owner and rejects replay or forged identity", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "coordinator-challenge-"));
  const repositoryId = "d".repeat(64);
  const instanceId = "coordinator-instance-1";
  const broker = await spawnRootBroker(t, `root-challenge-${process.pid}-${Date.now()}`);
  const endpoint = path.join(root, "coordinator.sock");
  const handled = [];
  const server = createCoordinatorServer({ endpoint, repositoryId, instanceId, idleGraceMs: 10_000, handler(request) { handled.push(request); return { accepted: true }; } });
  await server.listen();
  t.after(() => server.close());

  const nonce = "1".repeat(64);
  const proof = await challengeRootBroker(broker, { nonce, repositoryId, coordinatorInstanceId: instanceId });
  assert.deepEqual(proof, {
    nonce,
    rootSessionId: broker.rootSessionId,
    brokerPid: broker.pid,
    brokerProcessIdentity: broker.processBirthIdentity,
    repositoryId,
    coordinatorInstanceId: instanceId,
  });
  await assert.rejects(() => challengeRootBroker(broker, { nonce, repositoryId, coordinatorInstanceId: instanceId }), /nonce|replay/i);
  await assert.rejects(() => challengeRootBroker({ ...broker, rootSessionId: "forged-registry" }, { nonce: "2".repeat(64), repositoryId, coordinatorInstanceId: instanceId }), /connect|broker|unavailable/i);
  await assert.rejects(() => challengeRootBroker({ ...broker, processBirthIdentity: "f".repeat(64) }, { nonce: "3".repeat(64), repositoryId, coordinatorInstanceId: instanceId }), /process.*identity/i);
  await assert.rejects(() => challengeRootBroker({ ...broker, pid: broker.pid + 1 }, { nonce: "4".repeat(64), repositoryId, coordinatorInstanceId: instanceId }), /process.*identity|pid/i);

  const identity = { repositoryId };
  const metadata = { protocol: "repository-workspace-coordinator.v1", repositoryId, instanceId, endpoint, pid: process.pid, birthIdentity: "0".repeat(64), canonicalStateRoot: root };
  const first = await connectRepositoryCoordinator(identity, broker, { metadata });
  t.after(() => first.close());
  await first.request({ role: "root-broker", method: "workspace.attach", params: { workspaceId: "workspace-1", owner: { kind: "standalone-subagent", rootSessionId: "forged-root" } } });
  assert.equal(handled.length, 1);
  assert.equal(handled[0].ownerScope.rootSessionId, broker.rootSessionId);
  for (const method of ["bind_run", "record_terminal_proof"]) {
    await assert.rejects(
      () => first.request({ role: "root-broker", method, params: { workspaceId: "workspace-1", owner: { kind: "standalone-subagent", rootSessionId: "foreign-root" } } }),
      /foreign owner scope/i,
    );
  }
  await assert.rejects(() => first.request({ role: "admin", method: "authorized_reconcile", params: {} }), /permission/i);
  assert.equal(handled.length, 1, "foreign bind/proof and unauthorized reconcile are rejected before the handler");

  const second = await connectRepositoryCoordinator(identity, broker, { metadata });
  t.after(() => second.close());
  await assert.rejects(() => first.request({ role: "root-broker", method: "workspace.detach", params: { workspaceId: "workspace-1" } }), /capability|registration/i);
  assert.equal(handled.length, 1, "old capability is rejected before the handler");
  await assert.rejects(
    () => connectRepositoryCoordinator(identity, broker, { metadata: { ...metadata, instanceId: "wrong-instance" } }),
    /reply identity/i,
  );
});
