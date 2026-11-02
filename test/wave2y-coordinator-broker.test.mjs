import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createIntegrationQueue, processAliveStatus } from "../packages/pi-subagents-enhanced/src/workspace/integration-queue.ts";
import { createCoordinatorRegistry, COORDINATOR_METADATA_FILE } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-registry.ts";
import { connectRepositoryCoordinator } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-client.ts";
import { DurableStorage, DurableStorageError } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/durable-storage.ts";
import { createCoordinatorProofOutbox } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/coordinator-proof-outbox.ts";


/** 测试内 in-process coordinator 的登记：用 daemon 形 metadata 描述本进程
 * （pid+birthIdentity 真实，audit 视角 alive），取代已移除的 registry.claim。 */
async function registerInProcessCoordinator(registry, repositoryId, storageRepositoryId, stateRoot) {
  const { captureProcessBirthIdentity } = await import("../packages/pi-subagents-enhanced/src/subagent-dispatch/process-birth-identity.ts");
  const metadata = {
    protocol: "repository-workspace-coordinator.v1", kind: "daemon",
    instanceId: `inproc-${process.pid}-${Date.now().toString(16)}`,
    pid: process.pid, birthIdentity: await captureProcessBirthIdentity(process.pid),
    repositoryId, storageRepositoryId: storageRepositoryId ?? repositoryId,
    canonicalStateRoot: stateRoot, endpoint: registry.endpoint,
  };
  await registry.writeRaw(`${JSON.stringify(metadata)}\n`);
  return registry.read();
}

test("B8 process liveness distinguishes identity mismatch from dead", () => {
  const dead = processAliveStatus(999999, "a".repeat(64));
  const mismatch = processAliveStatus(process.pid, "a".repeat(64));
  assert.equal(dead.state, "dead");
  assert.equal(dead.reason, "process-not-found");
  assert.equal(mismatch.state, "mismatch");
  assert.equal(mismatch.reason, "birth-identity-mismatch");
  const status = processAliveStatus(process.pid, "x".repeat(64));
  assert.equal(status.state, "undetermined");
});

test("B7 dead metadata PID is reclaimed when ps rejects it but kill proves ESRCH", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "wave2y-dead-metadata-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await mkdir(repo);
  execFileSync("git", ["init", "-q", repo]);
  const commonDir = path.join(repo, ".git");
  const options = { commonDir, stateRoot: path.join(root, "state") };
  const first = createCoordinatorRegistry(options);
  const metadata = await registerInProcessCoordinator(first, "a".repeat(64), "b".repeat(64), path.join(root, "state"));
  const metadataPath = path.join(commonDir, ".pi-coordinator", COORDINATOR_METADATA_FILE);
  await writeFile(metadataPath, JSON.stringify({ ...metadata, pid: 999999999, birthIdentity: "0".repeat(64) }));
  const { ensureCoordinatorDaemon } = await import("../packages/pi-subagents-enhanced/src/workspace/coordinator-spawn.ts");
  const replacement = await ensureCoordinatorDaemon({ stateRoot: path.join(root, "state"), repositoryId: "a".repeat(64), storageRepositoryId: "b".repeat(64), commonDir, endpoint: first.endpoint, idleExitGraceMs: 60_000 });
  assert.notEqual(replacement.metadata.instanceId, metadata.instanceId);
  try { process.kill(replacement.metadata.pid, "SIGKILL"); } catch { /* 已退出 */ }
});

test("A6 malformed coordinator reply fails the pending request and closes transport", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wave2y-client-"));
  const endpoint = path.join(root, "coordinator.sock");
  const server = net.createServer(socket => { socket.once("data", () => socket.write("not-json\n")); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
  try {
    await assert.rejects(
      connectRepositoryCoordinator({ repositoryId: "a".repeat(64) }, {}, { metadata: { repositoryId: "a".repeat(64), storageRepositoryId: "a".repeat(64), endpoint, instanceId: "i" } }),
      error => error?.code === "COORDINATOR_PROTOCOL_MALFORMED_REPLY" && error.cause instanceof Error,
    );
  } finally { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});

test("C2 proof replay preserves pending and reports the original delivery failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wave2y-outbox-"));
  try {
    const outbox = createCoordinatorProofOutbox(root);
    const proof = { proofId: "a".repeat(64), runId: "run-1" };
    await outbox.enqueue(proof);
    const failure = new Error("delivery refused");
    const diagnostics = [];
    const replay = await outbox.replay(async () => { throw failure; }, { onDiagnostic: entry => diagnostics.push(entry) });
    assert.deepEqual(replay, { delivered: 0, pending: 1 });
    assert.equal(diagnostics[0].error, failure);
    assert.equal((await outbox.status(proof.proofId)).state, "pending");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("B6 durable corruption retains the original cause", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wave2y-storage-"));
  try {
    await writeFile(path.join(root, "bad.json"), "{broken", { mode: 0o600 });
    const storage = new DurableStorage({ root });
    await assert.rejects(storage.read("bad"), error => error instanceof DurableStorageError && error.cause instanceof Error);
  } finally { await rm(root, { recursive: true, force: true }); }
});
