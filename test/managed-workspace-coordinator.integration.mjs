import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, symlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import net from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalWorkspaceStateRoot, createCoordinatorRegistry } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-registry.ts";
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

test("coordinator registry uses one endpoint per common dir and canonical state root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coordinator-"));
  const a = createCoordinatorRegistry({ commonDir: path.join(root, "common"), stateRoot: path.join(root, "state-a") });
  const first = await a.claim({ repositoryId: "a".repeat(64), endpoint: path.join(root, "coordinator.sock") });
  const b = createCoordinatorRegistry({ commonDir: path.join(root, "common"), stateRoot: path.join(root, "state-b") });
  await assert.rejects(() => b.claim({ repositoryId: "a".repeat(64), endpoint: path.join(root, "other.sock") }), /state root/i);
  await a.release();
});

test("aliased state root is realpath-normalized so coordinator and ledger claim one scope", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coordinator-canonical-"));
  const target = path.join(root, "state");
  const alias = path.join(root, "state-alias");
  await mkdir(target, { recursive: true });
  await symlink(target, alias, "dir");
  const canonical = realpathSync(target);
  assert.notEqual(alias, canonical, "the fixture must reproduce the macOS /var alias form");
  const commonDir = path.join(root, "common");
  const repositoryId = "a".repeat(64);
  const registry = createCoordinatorRegistry({ commonDir, stateRoot: alias });
  const metadata = await registry.claim({ repositoryId });
  assert.equal(metadata.canonicalStateRoot, canonical, "coordinator metadata must record the ledger canonical state root");
  const canonicalRegistry = createCoordinatorRegistry({ commonDir, stateRoot: canonical });
  assert.equal((await canonicalRegistry.claim({ repositoryId })).instanceId, metadata.instanceId,
    "the canonical and aliased state root must not be treated as two coordinator scopes");
  await registry.release();
});

test("release retains coordinator metadata so durable audits stay observable after idle exit", async (t) => {
  // R12f 归因：daemon idle-exit 删除 metadata 后，audit 的 coordinator.status 恒为
  // missing，验收 settlement 判定永远不满足；而 claim 路径已具备 pid+birth-identity
  // 活性检查与 stale-owner 接管，退出保留 metadata 是安全的。
  const root = await mkdtemp(path.join(tmpdir(), "coordinator-release-retains-"));
  const commonDir = path.join(root, "common");
  const repositoryId = "f".repeat(64);
  const registry = createCoordinatorRegistry({ commonDir, stateRoot: path.join(root, "state") });
  const metadata = await registry.claim({ repositoryId });
  await registry.release();
  const retained = JSON.parse(await readFile(registry.metadataPath, "utf8"));
  assert.equal(retained.instanceId, metadata.instanceId, "release must retain the coordinator metadata for durable audits");
  // 下一个 daemon 可以识别 stale owner 并接管
  const next = createCoordinatorRegistry({ commonDir, stateRoot: path.join(root, "state") });
  const reclaimed = await next.claim({ repositoryId });
  assert.equal(typeof reclaimed.endpoint, "string");
  await next.release();
});

test("long Git common-dir metadata uses a short endpoint that can listen and connect", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "coordinator-long-path-"));
  const commonDir = path.join(root, "common", ...Array.from({ length: 8 }, (_, i) => `directory-${i}-${"x".repeat(24)}`));
  execFileSync("git", ["init", "--bare", commonDir], { stdio: "ignore" });
  const registry = createCoordinatorRegistry({ commonDir, stateRoot: path.join(root, "state") });
  const metadata = await registry.claim({ repositoryId: "e".repeat(64), endpoint: path.join(commonDir, ".pi-coordinator", "coordinator.sock") });
  assert.ok(metadata.endpoint.length < 100);
  const server = createCoordinatorServer({ endpoint: metadata.endpoint, repositoryId: metadata.repositoryId, idleGraceMs: 10_000, handler: () => ({ accepted: true }) });
  await server.listen();
  t.after(async () => { await server.close(); await registry.release(); });
  const connected = await new Promise((resolve, reject) => {
    const socket = net.createConnection(metadata.endpoint, () => { socket.end(); resolve(true); });
    socket.once("error", reject);
  });
  assert.equal(connected, true);
  assert.equal((await stat(registry.metadataPath)).mode & 0o777, 0o600);
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
  const metadata = await runtime.registry.read();
  assert.equal(metadata.endpoint, runtime.registry.endpoint);
  assert.notEqual(path.basename(metadata.endpoint), "coordinator.sock");
  assert.equal(runtime.client.instanceId, metadata.instanceId);
  assert.deepEqual(await runtime.client.ping(), { instanceId: metadata.instanceId, repositoryId: metadata.repositoryId, storageRepositoryId: metadata.storageRepositoryId, endpoint: metadata.endpoint });
});

test("real coordinator process and client bind the registry metadata endpoint and identity", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "coordinator-process-endpoint-"));
  const repositoryId = "9".repeat(64);
  const registry = createCoordinatorRegistry({ commonDir: path.join(root, "common"), stateRoot: path.join(root, "state") });
  const metadata = await registry.claim({ repositoryId, endpoint: path.join(root, "renamed-regression.sock") });
  const broker = await spawnRootBroker(t, `root-process-${process.pid}-${Date.now()}`);
  const child = spawn(process.execPath, ["--experimental-strip-types", path.resolve("packages/pi-subagents-enhanced/src/workspace/coordinator-process.ts")], {
    env: {
      ...process.env,
      PI_COORDINATOR_ENDPOINT: metadata.endpoint,
      PI_COORDINATOR_REPOSITORY_ID: metadata.repositoryId,
      PI_COORDINATOR_STORAGE_REPOSITORY_ID: metadata.storageRepositoryId,
      PI_COORDINATOR_INSTANCE_ID: metadata.instanceId,
      PI_COORDINATOR_STATE_ROOT: metadata.canonicalStateRoot,
      PI_COORDINATOR_CAPABILITY: "a".repeat(64),
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
  assert.deepEqual(ready, {
    protocol: metadata.protocol,
    repositoryId: metadata.repositoryId,
    storageRepositoryId: repositoryId,
    instanceId: metadata.instanceId,
    endpoint: metadata.endpoint,
  });
  const client = await connectRepositoryCoordinator({ repositoryId }, broker, { metadata });
  t.after(() => client.close());
  assert.deepEqual(await client.ping(), { instanceId: metadata.instanceId, repositoryId, storageRepositoryId: metadata.storageRepositoryId, endpoint: metadata.endpoint });
});

test("two real child processes racing for one repository converge on one coordinator", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coordinator-race-"));
  const script = `import { createCoordinatorRegistry } from ${JSON.stringify(path.resolve("packages/pi-subagents-enhanced/src/workspace/coordinator-registry.ts") )}; const r=createCoordinatorRegistry({commonDir:process.env.C,stateRoot:process.env.S}); const m=await r.claim({repositoryId:process.env.R,endpoint:process.env.E}); process.stdout.write(JSON.stringify(m)); setTimeout(()=>{},1000);`;
  const env = { ...process.env, C: path.join(root, "common"), S: path.join(root, "state"), R: "c".repeat(64), E: path.join(root, "coordinator.sock") };
  const children = [0, 1].map(() => spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { env, stdio: ["ignore", "pipe", "pipe"] }));
  const outputs = await Promise.all(children.map((child) => new Promise((resolve, reject) => { let out = ""; child.stdout.on("data", (chunk) => { out += chunk; }); child.once("error", reject); setTimeout(() => resolve(JSON.parse(out)), 3000); })));
  assert.equal(outputs[0].instanceId, outputs[1].instanceId);
  for (const child of children) child.kill("SIGKILL");
});

test("registry rejects malformed metadata and supports stale takeover", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coordinator-"));
  const registry = createCoordinatorRegistry({ commonDir: root, stateRoot: path.join(root, "state") });
  await registry.writeRaw("not-json");
  await assert.rejects(() => registry.read(), /metadata/i);
  const claimed = await registry.claim({ repositoryId: "b".repeat(64), endpoint: path.join(root, "c.sock") });
  assert.equal(claimed.protocol, "repository-workspace-coordinator.v1");
  await registry.release();
});

test("a confirmed dead coordinator owner is replaced for a new canonical state root while its abandoned root stays audit debt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coordinator-stale-root-"));
  const originRoot = path.join(root, "origin");
  execFileSync("git", ["init", "-b", "main", originRoot], { stdio: "ignore" });
  const commonDir = path.join(originRoot, ".git");
  const repositoryId = "7".repeat(64);
  const abandoned = createCoordinatorRegistry({ commonDir, stateRoot: path.join(root, "state-abandoned") });
  const owner = await abandoned.claim({ repositoryId });
  const abandonedRoot = owner.canonicalStateRoot;
  // A live owner keeps exactly one coordinator scope per repository common dir.
  const liveConflict = createCoordinatorRegistry({ commonDir, stateRoot: path.join(root, "state-live") });
  await assert.rejects(() => liveConflict.claim({ repositoryId }), /state root/i);
  // Only a dead owner whose recorded process birth identity no longer matches may be replaced.
  await abandoned.writeRaw(JSON.stringify({ ...owner, pid: 1, birthIdentity: "0".repeat(64) }));
  const recoveredRoot = path.join(root, "state-recovered");
  const recovered = createCoordinatorRegistry({ commonDir, stateRoot: recoveredRoot });
  const metadata = await recovered.claim({ repositoryId });
  assert.notEqual(metadata.instanceId, owner.instanceId, "a dead owner must not retain the coordinator generation");
  assert.equal(metadata.canonicalStateRoot, canonicalWorkspaceStateRoot(recoveredRoot));
  assert.equal(metadata.endpoint, owner.endpoint, "the replacement reuses the one repository endpoint");
  assert.deepEqual(metadata.supersededStateRoots, [abandonedRoot], "the abandoned canonical state root must stay observable");
  const audit = auditManagedWorkspaces({ stateRoot: recoveredRoot, originRoot });
  assert.equal(audit.coordinator.status, "observed");
  assert.equal(audit.coordinator.instanceId, metadata.instanceId);
  assert.deepEqual(audit.debts.filter((debt) => debt.kind === "state-root-split-brain"),
    [{ kind: "state-root-split-brain", status: "migration-debt", supersededStateRoot: abandonedRoot }]);
  await recovered.release();
});

test("runtime endpoint metadata mismatch fails closed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coordinator-mismatch-"));
  const registry = createCoordinatorRegistry({ commonDir: root, stateRoot: path.join(root, "state") });
  const claimed = await registry.claim({ repositoryId: "f".repeat(64), endpoint: path.join(root, "too-long.sock") });
  await registry.release();
  await registry.writeRaw(JSON.stringify({ ...claimed, repositoryId: "0".repeat(64) }));
  await assert.rejects(() => registry.claim({ repositoryId: "f".repeat(64), endpoint: claimed.endpoint }), /repository scope mismatch/i);
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
