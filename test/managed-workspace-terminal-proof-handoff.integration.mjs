import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCoordinatorProofOutbox } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/coordinator-proof-outbox.ts";
import { createCoordinatorServer } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts";
import { createManagedWorkspaceRequestV2 } from "../packages/pi-subagents-enhanced/src/workspace/contract.ts";
import { createManagedWorkspaceService } from "../packages/pi-subagents-enhanced/src/workspace/service.ts";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const modulePath = path.resolve("packages/pi-subagents-enhanced/src/subagent-dispatch/coordinator-proof-outbox.ts");
const proof = { proofId: "e".repeat(64), workspaceId: "workspace-proof", runId: "run-proof", rootSessionId: "root-proof", processInstance: "process-proof" };

test("terminal proof outbox retains daemon failure and stores an idempotent delivery receipt", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "proof-outbox-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outbox = createCoordinatorProofOutbox(root);
  await outbox.enqueue(proof);
  await outbox.enqueue(proof);
  assert.deepEqual(await outbox.replay(async () => { throw new Error("daemon unavailable"); }), { delivered: 0, pending: 1 });
  const restarted = createCoordinatorProofOutbox(root);
  assert.deepEqual(await restarted.replay(async (entry) => ({ accepted: true, proofId: entry.proofId, receipt: { state: "released" } })), { delivered: 1, pending: 0 });
  assert.deepEqual(await restarted.receipt(proof.proofId), { accepted: true, proofId: proof.proofId, receipt: { state: "released" } });
  assert.deepEqual(await restarted.replay(async () => { throw new Error("must not replay delivered proof"); }), { delivered: 0, pending: 0 });
});

test("proof written before Root SIGKILL is replayed by a fresh process", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "proof-sigkill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = `
    import { createCoordinatorProofOutbox } from ${JSON.stringify(modulePath)};
    const outbox = createCoordinatorProofOutbox(process.env.OUTBOX);
    await outbox.enqueue(${JSON.stringify(proof)});
    process.stdout.write("ready\\n");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { env: { ...process.env, OUTBOX: root }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; if (output.includes("ready\n")) resolve(); });
    child.once("error", reject);
  });
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  const restarted = createCoordinatorProofOutbox(root);
  let observed;
  assert.deepEqual(await restarted.replay(async (entry) => { observed = entry; return { accepted: true, proofId: entry.proofId }; }), { delivered: 1, pending: 0 });
  assert.deepEqual(observed, proof);
});

test("reconcile persists proof debt after a real Root process dies before proof", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "proof-debt-"));
  const originRoot = path.join(root, "repo");
  await mkdir(originRoot); execFileSync("git", ["init", "-b", "main"], { cwd: originRoot });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: originRoot });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: originRoot });
  await writeFile(path.join(originRoot, "README"), "base\n");
  execFileSync("git", ["add", "."], { cwd: originRoot }); execFileSync("git", ["commit", "-m", "base"], { cwd: originRoot });
  const stateRoot = path.join(root, "state");
  const request = createManagedWorkspaceRequestV2({ workspaceId: "proof-debt", owner: { kind: "standalone-subagent", rootSessionId: "root-debt", toolCallId: "tool-debt" }, originRoot, requestedCwd: originRoot, originRef: "refs/heads/main", baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: originRoot, encoding: "utf8" }).trim(), contractHash: "a".repeat(64), policy: { publication: "allowed", application: "forbidden", writePaths: ["README"] } });
  const service = createManagedWorkspaceService({ stateRoot });
  const active = service.ensureAllocated(request);
  const asyncDir = path.join(root, "async"); await mkdir(asyncDir);
  service.bindRun({ workspaceId: active.workspaceId, run: { runId: "run-debt", asyncDir } });
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  child.kill("SIGKILL"); await new Promise((resolve) => child.once("exit", resolve));
  const audit = createManagedWorkspaceService({ stateRoot }).reconcile({ originRoot });
  assert.equal(audit[0].state, "cleanup-debt");
  assert.equal(audit[0].cleanupDebt.phase, "terminal-proof");
  assert.ok(await import("node:fs/promises").then(({ lstat }) => lstat(active.path)));
  t.after(() => rm(root, { recursive: true, force: true }));
});

test("authoritative proof replay settles proof debt exactly once and permits cleanup", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "proof-debt-replay-"));
  const originRoot = path.join(root, "repo"); await mkdir(originRoot);
  execFileSync("git", ["init", "-b", "main"], { cwd: originRoot }); execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: originRoot }); execFileSync("git", ["config", "user.name", "Test"], { cwd: originRoot });
  await writeFile(path.join(originRoot, "README"), "base\n"); execFileSync("git", ["add", "."], { cwd: originRoot }); execFileSync("git", ["commit", "-m", "base"], { cwd: originRoot });
  const stateRoot = path.join(root, "state"); const service = createManagedWorkspaceService({ stateRoot });
  const request = createManagedWorkspaceRequestV2({ workspaceId: "proof-replay", owner: { kind: "standalone-subagent", rootSessionId: "root-replay", toolCallId: "tool-replay" }, originRoot, requestedCwd: originRoot, originRef: "refs/heads/main", baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: originRoot, encoding: "utf8" }).trim(), contractHash: "b".repeat(64), policy: { publication: "allowed", application: "forbidden", writePaths: ["README"] } });
  const active = service.ensureAllocated(request); const asyncDir = path.join(root, "async");
  service.bindRun({ workspaceId: active.workspaceId, run: { runId: "run-replay", asyncDir } }); service.reconcile({ originRoot });
  const proof = { state: "observed", conflict: false, runId: "run-replay", rootSessionId: "root-replay", asyncDir, processInstance: "proc-replay", proofId: "f".repeat(64) };
  assert.equal(typeof service.recordTerminalProof, "function");
  assert.equal(service.recordTerminalProof({ workspaceId: active.workspaceId, ownerScope: { kind: "standalone-subagent", rootSessionId: "root-replay" }, proof }).state, "active");
  assert.equal(service.recordTerminalProof({ workspaceId: active.workspaceId, ownerScope: { kind: "standalone-subagent", rootSessionId: "root-replay" }, proof }).state, "active");
  t.after(() => rm(root, { recursive: true, force: true }));
});

const lifecycleModuleRoot = path.resolve("packages/pi-subagents-enhanced");

async function handoffFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "proof-handoff-"));
  const originRoot = path.join(root, "origin");
  const stateRoot = path.join(root, "state");
  await mkdir(originRoot, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: originRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: originRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: originRoot, stdio: "ignore" });
  await writeFile(path.join(originRoot, "README.md"), "base\n");
  execFileSync("git", ["add", "."], { cwd: originRoot, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "base"], { cwd: originRoot, stdio: "ignore" });
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root, originRoot, stateRoot,
    baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: originRoot, encoding: "utf8" }).trim(),
  };
}

async function handoffRuntime(t, fixture, rootSessionId) {
  const { RootBrokerServer } = await import(path.join(lifecycleModuleRoot, "src/subagent-dispatch/root-broker-server.ts"));
  const { startAndBindRootBroker } = await import(path.join(lifecycleModuleRoot, "src/subagent-dispatch/root-broker-registry.ts"));
  const { connectRuntimeCoordinator } = await import(path.join(lifecycleModuleRoot, "extensions/subagent-runtime.ts"));
  const { resolveRepositoryIdentity } = await import(path.join(lifecycleModuleRoot, "src/workspace/repository-identity.ts"));
  const pi = {};
  const broker = new RootBrokerServer({ rootSessionId, lifecycleSessionId: rootSessionId, upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} } });
  await startAndBindRootBroker(pi, broker);
  const runtime = await connectRuntimeCoordinator({ pi, cwd: fixture.originRoot, broker, stateRoot: fixture.stateRoot });
  t.after(async () => { await runtime?.close().catch(() => undefined); await broker.closeRootSession().catch(() => undefined); });
  const metadata = await runtime.registry.read();
  const identity = await resolveRepositoryIdentity(fixture.originRoot);
  return {
    broker, runtime, metadata, identity,
    service: createManagedWorkspaceService({ stateRoot: fixture.stateRoot }),
    outboxFile: path.join(metadata.canonicalStateRoot, "repositories", identity.storageRepositoryId, "terminal-proof-outbox", "terminal-proofs.json"),
  };
}

function terminalEvent(runId, { sessionId, asyncDir, pid }) {
  const observedAt = Date.now();
  const runnerProcessInstanceId = `${runId}-runner`;
  return {
    version: 1, runId, sessionId, asyncDir, agent: "executor", pid, runnerProcessInstanceId, state: "observed", observedAt,
    instances: [{ processInstanceId: runnerProcessInstanceId, kind: "runner", closeObservedAt: observedAt, exitCode: 0, signal: null }],
  };
}

async function readOutbox(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
}

async function waitForOutbox(file, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await readOutbox(file);
    if (state && predicate(state)) return state;
    if (Date.now() > deadline) throw new Error(`terminal proof outbox never reached the expected state: ${JSON.stringify(state)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function allocatedChild(fixture, runtime, ownerRootSessionId, { workspaceId, runId, toolCallId, publish = true, authorizationSessionId }) {
  const { createRunAuthorization } = await import(path.join(lifecycleModuleRoot, "src/subagent-dispatch/run-authorization.ts"));
  const { createSubagentIntegrationTool } = await import(path.join(lifecycleModuleRoot, "child-extensions/integration-queue.ts"));
  const asyncDir = path.join(fixture.root, `async-${runId}`);
  const active = runtime.service.ensureAllocated(createManagedWorkspaceRequestV2({
    workspaceId, owner: { kind: "standalone-subagent", rootSessionId: ownerRootSessionId, toolCallId },
    originRoot: fixture.originRoot, requestedCwd: fixture.originRoot, originRef: "refs/heads/main", baseCommit: fixture.baseCommit, contractHash: "a".repeat(64),
    policy: { publication: "allowed", application: "allowed", writePaths: ["result.txt"] },
  }));
  runtime.service.bindRun({ workspaceId: active.workspaceId, run: { runId, asyncDir } });
  // The workspace owner scope and the broker authorization session are
  // independent identities: a run can be authorized by a broker that does not
  // own the workspace, which is exactly the unresolved-binding case.
  const sessionId = authorizationSessionId ?? ownerRootSessionId;
  await runtime.broker.registerAuthorizedRun(createRunAuthorization({ kind: "coding", binding: { runId, asyncDir, sessionId, pid: process.pid, agentProfile: "executor" }, goal: null }));
  await runtime.broker.observeStarted({ runId, asyncDir, sessionId, pid: process.pid, agent: "executor" });
  if (!publish) return { active, asyncDir };
  await writeFile(path.join(active.path, "result.txt"), `${runId}\n`);
  execFileSync("git", ["add", "result.txt"], { cwd: active.path, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", runId], { cwd: active.path, stdio: "ignore" });
  const candidateHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: active.path, encoding: "utf8" }).trim();
  const binding = { workspaceId: active.workspaceId, leaseId: active.leaseId, runId, ownerScope: { kind: "standalone-subagent", rootSessionId: ownerRootSessionId } };
  const tool = createSubagentIntegrationTool({ coordinator: runtime.client ?? runtime.runtime.client, resolveBinding: () => binding });
  const invoke = async (input) => {
    const response = await tool.execute("call", input);
    assert.equal(response.isError, false, response.content[0].text);
    return response.details;
  };
  const queued = await invoke({ action: "enqueue", authorized_workspace_head: candidateHead, target_ref: "refs/heads/main" });
  const admission = await invoke({ action: "await_admission", queue_item_id: queued.queueItemId });
  execFileSync("git", ["rebase", admission.targetHead], { cwd: active.path, stdio: "ignore" });
  const published = await invoke({ action: "publish", queue_item_id: queued.queueItemId, queue_lease_id: admission.queueLeaseId, candidate_head: candidateHead });
  assert.equal(published.state, "completed");
  return { active, asyncDir, binding };
}

/** A released v2 workspace has no status snapshot; the ledger receipt is the fact. */
function ownedReceipt(runtime, workspaceId, rootSessionId) {
  return runtime.service.listOwned({ ownerScope: { kind: "standalone-subagent", rootSessionId } })
    .find((entry) => entry.workspaceId === workspaceId);
}

test("authoritative child terminal is delivered through Root Broker and persisted as a coordinator receipt", { timeout: 60_000 }, async (t) => {
  const fixture = await handoffFixture(t);
  const rootSessionId = `root-handoff-${process.pid}-${Date.now()}`;
  const runtime = await handoffRuntime(t, fixture, rootSessionId);
  const runId = "child-handoff";
  const child = await allocatedChild(fixture, { ...runtime, client: runtime.runtime.client }, rootSessionId, { workspaceId: "workspace-handoff", runId, toolCallId: "tool-handoff" });
  assert.equal(runtime.broker.inspectTerminalProofDelivery(runId).state, "none", "no terminal has been accepted yet");
  runtime.broker.observeTerminal(terminalEvent(runId, { sessionId: rootSessionId, asyncDir: child.asyncDir, pid: process.pid }));
  const state = await waitForOutbox(runtime.outboxFile, (value) => Object.keys(value.receipts).length === 1 && value.pending.length === 0);
  const [proofId, receipt] = Object.entries(state.receipts)[0];
  assert.match(proofId, /^[a-f0-9]{64}$/);
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.receipt.state, "released");
  assert.equal(ownedReceipt(runtime, child.active.workspaceId, rootSessionId).state, "released");
  assert.equal(runtime.broker.inspectTerminalProofDelivery(runId).state, "delivered");
});

test("coordinator unavailability leaves a replayable pending proof that a restarted coordinator delivers", { timeout: 60_000 }, async (t) => {
  const fixture = await handoffFixture(t);
  const rootSessionId = `root-replay-${process.pid}-${Date.now()}`;
  const runtime = await handoffRuntime(t, fixture, rootSessionId);
  const runId = "child-replay";
  const child = await allocatedChild(fixture, { ...runtime, client: runtime.runtime.client }, rootSessionId, { workspaceId: "workspace-replay", runId, toolCallId: "tool-replay" });
  await runtime.runtime.server.close();
  runtime.broker.observeTerminal(terminalEvent(runId, { sessionId: rootSessionId, asyncDir: child.asyncDir, pid: process.pid }));
  const pending = await waitForOutbox(runtime.outboxFile, (value) => value.pending.length === 1 && Object.keys(value.receipts).length === 0);
  assert.equal(pending.pending[0].runId, runId);
  assert.equal(pending.pending[0].workspaceId, child.active.workspaceId);
  assert.equal(runtime.broker.inspectTerminalProofDelivery(runId).state, "pending");
  assert.equal(ownedReceipt(runtime, child.active.workspaceId, rootSessionId).state, "active", "an undelivered proof must retain the workspace");
  const restarted = createCoordinatorServer({ endpoint: runtime.metadata.endpoint, repositoryId: runtime.identity.repositoryId, storageRepositoryId: runtime.identity.storageRepositoryId, instanceId: runtime.metadata.instanceId, stateRoot: runtime.metadata.canonicalStateRoot, idleGraceMs: 10_000 });
  await restarted.listen();
  t.after(() => restarted.close());
  const delivered = await waitForOutbox(runtime.outboxFile, (value) => Object.keys(value.receipts).length === 1 && value.pending.length === 0);
  assert.equal(Object.values(delivered.receipts)[0].receipt.state, "released");
  assert.equal(ownedReceipt(runtime, child.active.workspaceId, rootSessionId).state, "released");
});

test("unresolved trusted run binding forms an observable proof debt and retains the workspace", { timeout: 60_000 }, async (t) => {
  const fixture = await handoffFixture(t);
  const ownerRootSessionId = `root-owner-${process.pid}-${Date.now()}`;
  const brokerRootSessionId = `root-debt-${process.pid}-${Date.now()}`;
  const runtime = await handoffRuntime(t, fixture, brokerRootSessionId);
  const runId = "child-debt";
  const child = await allocatedChild(fixture, { ...runtime, client: runtime.runtime.client }, ownerRootSessionId, { workspaceId: "workspace-debt", runId, toolCallId: "tool-debt", publish: false, authorizationSessionId: brokerRootSessionId });
  runtime.broker.observeTerminal(terminalEvent(runId, { sessionId: brokerRootSessionId, asyncDir: child.asyncDir, pid: process.pid }));
  const state = await waitForOutbox(runtime.outboxFile, (value) => Object.keys(value.debts ?? {}).length === 1);
  const debt = Object.values(state.debts)[0];
  assert.equal(state.pending.length, 0);
  assert.equal(Object.keys(state.receipts).length, 0);
  assert.equal(debt.runId, runId);
  assert.match(debt.reason, /binding/i);
  assert.equal(ownedReceipt(runtime, child.active.workspaceId, ownerRootSessionId).state, "active", "an unresolved binding must never infer a terminal");
  assert.equal(runtime.broker.inspectTerminalProofDelivery(runId).state, "debt");
});
