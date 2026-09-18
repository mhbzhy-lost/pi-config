import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import test from "node:test";

import integrationQueueExtension, { createSubagentIntegrationTool } from "../packages/pi-subagents-enhanced/child-extensions/integration-queue.ts";
import { connectRepositoryCoordinator } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-client.ts";
import { createCoordinatorServer } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts";
import { createCoordinatorRegistry } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-registry.ts";
import { createManagedWorkspaceRequestV2 } from "../packages/pi-subagents-enhanced/src/workspace/contract.ts";
import { createManagedWorkspaceService } from "../packages/pi-subagents-enhanced/src/workspace/service.ts";
import { auditManagedWorkspaces } from "../packages/pi-subagents-enhanced/src/workspace/administration.ts";
import { connectRuntimeCoordinator } from "../packages/pi-subagents-enhanced/extensions/subagent-runtime.ts";
import { RootBrokerServer } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts";
import { startAndBindRootBroker } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-registry.ts";
import { createRunAuthorization } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/run-authorization.ts";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

test("trusted integration extension activates only its registered tool after session_start and reloads idempotently", async () => {
  const registered = [];
  const handlers = [];
  let active = ["read", "bash"];
  const pi = {
    registerTool(tool) { registered.push(tool.name); },
    on(type, handler) { if (type === "session_start") handlers.push(handler); },
    getActiveTools() { return [...active]; },
    setActiveTools(tools) { active = [...tools]; },
  };
  const options = { coordinator: {}, resolveBinding: () => ({}) };
  integrationQueueExtension(pi, options);
  assert.deepEqual(active, ["read", "bash"], "registration alone must not bypass the initial allowlist");
  await handlers[0]({ reason: "startup" }, {});
  assert.deepEqual(active, ["read", "bash", "subagent_integration"]);
  integrationQueueExtension(pi, options);
  await handlers[1]({ reason: "reload" }, {});
  assert.deepEqual(active, ["read", "bash", "subagent_integration"]);
  assert.deepEqual(registered, ["subagent_integration", "subagent_integration"]);
});

test("broker-backed integration factory does not wait for a grant and execute fails closed while it is absent", async (t) => {
  const previousRoot = process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID;
  const previousRun = process.env.PI_SUBAGENT_RUN_ID;
  process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID = `root-grant-not-ready-${process.pid}`;
  process.env.PI_SUBAGENT_RUN_ID = `run-grant-not-ready-${Date.now()}`;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID;
    else process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID = previousRoot;
    if (previousRun === undefined) delete process.env.PI_SUBAGENT_RUN_ID;
    else process.env.PI_SUBAGENT_RUN_ID = previousRun;
  });

  const tool = createSubagentIntegrationTool();
  const result = await tool.execute("enqueue-before-grant", {
    action: "enqueue", authorized_workspace_head: "a".repeat(40), target_ref: "refs/heads/main",
  });
  assert.equal(result.isError, true);
  assert.equal(result.details.code, "GRANT_NOT_READY");
});

test("broker-backed integration returns a bounded isError tool result with safe code/stage/operation when the coordinator is unavailable", async (t) => {
  const rootSessionId = `root-coordinator-unavailable-${process.pid}-${Date.now()}`;
  const runId = `child-coordinator-unavailable-${Date.now()}`;
  const asyncDir = join(tmpdir(), `async-coordinator-unavailable-${process.pid}-${Date.now()}`);
  // A real Root Broker with no coordinator proxy: the broker answers
  // coordinator_unavailable, which is a bounded failure the child must surface
  // as a tool error rather than a silent success.
  const broker = new RootBrokerServer({
    rootSessionId, lifecycleSessionId: rootSessionId,
    captureProcessBirthIdentity: async () => "birth-coordinator-unavailable",
    upstream: {
      async ping() { return {}; },
      async stop(params) {
        const observedAt = Date.now();
        const runnerProcessInstanceId = `${params.runId}-runner`;
        broker.observeTerminal({ version: 1, runId: params.runId, sessionId: rootSessionId, asyncDir, agent: "executor", pid: process.pid, runnerProcessInstanceId, state: "observed", observedAt, instances: [{ processInstanceId: runnerProcessInstanceId, kind: "runner", closeObservedAt: observedAt, exitCode: 0, signal: null }] });
        return { stopped: true };
      },
      async dispose() {},
    },
  });
  const previousRoot = process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID;
  const previousRun = process.env.PI_SUBAGENT_RUN_ID;
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID; else process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID = previousRoot;
    if (previousRun === undefined) delete process.env.PI_SUBAGENT_RUN_ID; else process.env.PI_SUBAGENT_RUN_ID = previousRun;
    await broker.closeRootSession().catch(() => undefined);
  });
  await broker.start();
  await broker.registerAuthorizedRun(createRunAuthorization({ kind: "coding", binding: { runId, asyncDir, sessionId: rootSessionId, pid: process.pid, agentProfile: "executor" }, goal: null }));
  await broker.observeStarted({ runId, asyncDir, sessionId: rootSessionId, pid: process.pid, agent: "executor" });
  process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID = rootSessionId;
  process.env.PI_SUBAGENT_RUN_ID = runId;
  const tool = createSubagentIntegrationTool();
  const result = await tool.execute("enqueue-no-coordinator", { action: "enqueue", authorized_workspace_head: "a".repeat(40), target_ref: "refs/heads/main" });
  assert.equal(result.isError, true);
  assert.equal(result.details.code, "coordinator_unavailable");
  assert.equal(result.details.stage, "coordinator");
  assert.equal(result.details.operation, "enqueue");
});

test("real child integration client maps lifecycle and trusted completion inspection through Root Broker", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "child-broker-coordinator-"));
  const originRoot = join(root, "origin");
  const stateRoot = join(root, "state");
  await mkdir(originRoot);
  git(originRoot, "init", "-b", "main");
  git(originRoot, "config", "user.email", "test@example.com");
  git(originRoot, "config", "user.name", "Test User");
  await writeFile(join(originRoot, "README.md"), "base\n");
  git(originRoot, "add", ".");
  git(originRoot, "commit", "-m", "base");
  const rootSessionId = `root-child-proxy-${process.pid}-${Date.now()}`;
  const pi = {};
  const broker = new RootBrokerServer({ rootSessionId, lifecycleSessionId: rootSessionId, upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} } });
  let runtime;
  const liveRuns = new Map();
  const settleRun = (runId) => {
    const run = liveRuns.get(runId);
    if (!run) return;
    const observedAt = Date.now();
    const runnerProcessInstanceId = `${runId}-runner`;
    broker.observeTerminal({
      version: 1, runId, sessionId: rootSessionId, asyncDir: run.asyncDir, agent: "executor", pid: process.pid,
      runnerProcessInstanceId, state: "observed", observedAt,
      instances: [{ processInstanceId: runnerProcessInstanceId, kind: "runner", closeObservedAt: observedAt, exitCode: 0, signal: null }],
    });
    liveRuns.delete(runId);
  };
  const previousRoot = process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID;
  const previousRun = process.env.PI_SUBAGENT_RUN_ID;
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID; else process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID = previousRoot;
    if (previousRun === undefined) delete process.env.PI_SUBAGENT_RUN_ID; else process.env.PI_SUBAGENT_RUN_ID = previousRun;
    for (const runId of [...liveRuns.keys()]) settleRun(runId);
    await runtime?.close().catch(() => undefined);
    await broker.closeRootSession().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  await startAndBindRootBroker(pi, broker);
  runtime = await connectRuntimeCoordinator({ pi, cwd: originRoot, broker, stateRoot });
  const service = createManagedWorkspaceService({ stateRoot });
  const setup = async (suffix) => {
    const runId = `child-${suffix}`;
    const asyncDir = join(root, `async-${suffix}`);
    const owner = { kind: "standalone-subagent", rootSessionId, toolCallId: `tool-${suffix}` };
    const active = service.ensureAllocated(createManagedWorkspaceRequestV2({
      workspaceId: `workspace-${suffix}`, owner, originRoot, requestedCwd: originRoot,
      originRef: "refs/heads/main", baseCommit: git(originRoot, "rev-parse", "HEAD"), contractHash: "a".repeat(64),
      policy: { publication: "allowed", application: "allowed", writePaths: [`${suffix}.txt`] },
    }));
    service.bindRun({ workspaceId: active.workspaceId, run: { runId, asyncDir } });
    liveRuns.set(runId, { asyncDir });
    await broker.registerAuthorizedRun(createRunAuthorization({ kind: "coding", binding: { runId, asyncDir, sessionId: rootSessionId, pid: process.pid, agentProfile: "executor" }, goal: null }));
    await broker.observeStarted({ runId, asyncDir, sessionId: rootSessionId, pid: process.pid, agent: "executor" });
    await writeFile(join(active.path, `${suffix}.txt`), `${suffix}\n`);
    git(active.path, "add", `${suffix}.txt`);
    git(active.path, "commit", "-m", suffix);
    process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID = rootSessionId;
    process.env.PI_SUBAGENT_RUN_ID = runId;
    return { tool: createSubagentIntegrationTool(), active, head: git(active.path, "rev-parse", "HEAD") };
  };
  const first = await setup("publish");
  const initiallyAbsent = await first.tool.execute("inspect-before-enqueue", { action: "inspect_integration_state" });
  assert.equal(initiallyAbsent.isError, false, initiallyAbsent.content[0].text);
  assert.deepEqual(initiallyAbsent.details, { queueState: "absent", workspaceState: "active", integrationReceipt: false, proofState: "absent", revision: 0 });
  const queued = await first.tool.execute("enqueue-publish", { action: "enqueue", authorized_workspace_head: first.head, target_ref: "refs/heads/main" });
  assert.equal(queued.isError, false, queued.content[0].text);
  const admitted = await first.tool.execute("admit-publish", { action: "await_admission", queue_item_id: queued.details.queueItemId });
  assert.equal(admitted.isError, false, admitted.content[0].text);
  const conflict = await first.tool.execute("conflict-publish", { action: "report_conflict", queue_item_id: queued.details.queueItemId, queue_lease_id: admitted.details.queueLeaseId });
  assert.equal(conflict.isError, false, conflict.content[0].text);
  git(first.active.path, "rebase", admitted.details.targetHead);
  const published = await first.tool.execute("publish", { action: "publish", queue_item_id: queued.details.queueItemId, queue_lease_id: admitted.details.queueLeaseId, candidate_head: git(first.active.path, "rev-parse", "HEAD") });
  assert.equal(published.isError, false, published.content[0].text);
  const completed = await first.tool.execute("inspect-after-publish", { action: "inspect_integration_state" });
  assert.equal(completed.details.queueState, "completed");
  assert.equal(completed.details.integrationReceipt, true);
  settleRun("child-publish");

  const second = await setup("fail");
  const queuedFailure = await second.tool.execute("enqueue-fail", { action: "enqueue", authorized_workspace_head: second.head, target_ref: "refs/heads/main" });
  assert.equal(queuedFailure.isError, false, queuedFailure.content[0].text);
  const admittedFailure = await second.tool.execute("admit-fail", { action: "await_admission", queue_item_id: queuedFailure.details.queueItemId });
  assert.equal(admittedFailure.isError, false, admittedFailure.content[0].text);
  const failed = await second.tool.execute("fail", { action: "fail", queue_item_id: queuedFailure.details.queueItemId, queue_lease_id: admittedFailure.details.queueLeaseId });
  assert.equal(failed.isError, false, failed.content[0].text);
  settleRun("child-fail");
});

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
      if (newline >= 0) { clearTimeout(timer); resolve({ registry: JSON.parse(stdout.slice(0, newline)), child }); }
    });
    child.once("error", reject);
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Root Broker exited ${code}: ${stderr}`)); });
  });
}

test("public typed coding worktree reaches an active run-bound workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "public-worktree-lifecycle-"));
  const originRoot = join(root, "origin");
  const stateRoot = join(root, "state");
  await mkdir(join(originRoot, "src"), { recursive: true });
  git(originRoot, "init", "-b", "main");
  git(originRoot, "config", "user.email", "test@example.com");
  git(originRoot, "config", "user.name", "Test User");
  await writeFile(join(originRoot, "README.md"), "base\n");
  await writeFile(join(originRoot, "src", "base.txt"), "base\n");
  git(originRoot, "add", ".");
  git(originRoot, "commit", "-m", "initial");
  const service = createManagedWorkspaceService({ stateRoot });
  const request = createManagedWorkspaceRequestV2({ workspaceId: "workspace-public", owner: { kind: "standalone-subagent", rootSessionId: "root-session", toolCallId: "tool-public" }, originRoot, requestedCwd: join(originRoot, "src"), originRef: "refs/heads/main", baseCommit: git(originRoot, "rev-parse", "HEAD"), contractHash: "a".repeat(64), policy: { publication: "allowed", application: "allowed", writePaths: ["README.md"] } });
  const allocated = service.ensureAllocated(request);
  const bound = service.bindRun({ workspaceId: allocated.workspaceId, run: { runId: "workflow-1", asyncDir: join(root, "workflow") } });
  t.after(() => rm(root, { recursive: true, force: true }));
  const status = service.status({ workspaceId: bound.workspaceId });
  assert.equal(status.receipt.state, "active");
  assert.deepEqual(status.receipt.run, { runId: "workflow-1", asyncDir: join(root, "workflow") });
});

test("two real Hosts share public child integration while owner scope and terminal cleanup remain isolated", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "public-child-integration-"));
  const originRoot = join(root, "origin");
  const stateRoot = join(root, "state");
  const repositoryId = "d".repeat(64);
  await mkdir(originRoot);
  git(originRoot, "init", "-b", "main");
  git(originRoot, "config", "user.email", "test@example.com");
  git(originRoot, "config", "user.name", "Test User");
  await writeFile(join(originRoot, "README.md"), "base\n");
  git(originRoot, "add", ".");
  git(originRoot, "commit", "-m", "base");
  t.after(() => rm(root, { recursive: true, force: true }));

  const hostA = await spawnRootBroker(t, `root-a-${process.pid}-${Date.now()}`);
  const hostB = await spawnRootBroker(t, `root-b-${process.pid}-${Date.now()}`);
  const registry = createCoordinatorRegistry({ commonDir: path.resolve(originRoot, git(originRoot, "rev-parse", "--git-common-dir")), stateRoot });
  const metadata = await registry.claim({ repositoryId });
  t.after(() => registry.release());
  const coordinator = createCoordinatorServer({ endpoint: metadata.endpoint, repositoryId, instanceId: metadata.instanceId, stateRoot, idleGraceMs: 10_000 });
  await coordinator.listen();
  t.after(() => coordinator.close());
  const clientA = await connectRepositoryCoordinator({ repositoryId }, hostA.registry, { metadata });
  const clientB = await connectRepositoryCoordinator({ repositoryId }, hostB.registry, { metadata });
  t.after(() => Promise.all([clientA.close(), clientB.close()]));

  const service = createManagedWorkspaceService({ stateRoot });
  const request = createManagedWorkspaceRequestV2({
    workspaceId: "workspace-public-child", owner: { kind: "standalone-subagent", rootSessionId: hostA.registry.rootSessionId, toolCallId: "tool-public-child" },
    originRoot, requestedCwd: originRoot, originRef: "refs/heads/main", baseCommit: git(originRoot, "rev-parse", "HEAD"), contractHash: "a".repeat(64),
    policy: { publication: "allowed", application: "allowed", writePaths: ["result.txt"] },
  });
  const active = service.ensureAllocated(request);
  service.bindRun({ workspaceId: active.workspaceId, run: { runId: "child-run-a", asyncDir: join(root, "async-a") } });
  await writeFile(join(active.path, "result.txt"), "integrated\n");
  git(active.path, "add", "result.txt");
  git(active.path, "commit", "-m", "child result");
  const candidateHead = git(active.path, "rev-parse", "HEAD");
  const binding = { workspaceId: active.workspaceId, leaseId: active.leaseId, runId: "child-run-a", ownerScope: { kind: "standalone-subagent", rootSessionId: hostA.registry.rootSessionId } };
  const tool = createSubagentIntegrationTool({ coordinator: clientA, resolveBinding: () => binding });
  const invoke = async (input) => {
    const response = await tool.execute("call", input);
    assert.equal(response.isError, false, response.content[0].text);
    return response.details;
  };
  const queued = await invoke({ action: "enqueue", authorized_workspace_head: candidateHead, target_ref: "refs/heads/main" });
  const admission = await invoke({ action: "await_admission", queue_item_id: queued.queueItemId });
  git(active.path, "rebase", admission.targetHead);
  const published = await invoke({ action: "publish", queue_item_id: queued.queueItemId, queue_lease_id: admission.queueLeaseId, candidate_head: candidateHead });
  assert.equal(published.state, "completed");
  assert.equal(await readFile(join(originRoot, "result.txt"), "utf8"), "integrated\n");
  await assert.rejects(() => clientB.statusOwned({ workspaceId: active.workspaceId }), /owner|belong|scope/i);

  const proof = { state: "observed", conflict: false, runId: "child-run-a", rootSessionId: hostA.registry.rootSessionId, asyncDir: join(root, "async-a"), processInstance: "process-a", proofId: "e".repeat(64) };
  const settled = await clientA.recordTerminalProof({ workspaceId: active.workspaceId, ownerScope: binding.ownerScope, proof });
  assert.equal(settled.receipt.state, "released");
  assert.deepEqual(await clientA.recordTerminalProof({ workspaceId: active.workspaceId, ownerScope: binding.ownerScope, proof }), settled);
  assert.equal(git(originRoot, "worktree", "list", "--porcelain").includes(active.path), false);
});

test("aliased state root keeps queue, records, and coordinator in one canonical bucket without audit debt", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "canonical-lifecycle-"));
  const originRoot = join(root, "origin");
  const stateTarget = join(root, "state");
  const stateRoot = join(root, "state-alias");
  await mkdir(originRoot);
  await mkdir(stateTarget);
  await symlink(stateTarget, stateRoot, "dir");
  const canonicalStateRoot = realpathSync(stateTarget);
  assert.notEqual(stateRoot, canonicalStateRoot, "the fixture must reproduce the macOS /var alias form");
  git(originRoot, "init", "-b", "main");
  git(originRoot, "config", "user.email", "test@example.com");
  git(originRoot, "config", "user.name", "Test User");
  await writeFile(join(originRoot, "README.md"), "base\n");
  git(originRoot, "add", ".");
  git(originRoot, "commit", "-m", "base");
  const rootSessionId = `root-canonical-${process.pid}-${Date.now()}`;
  const pi = {};
  const broker = new RootBrokerServer({ rootSessionId, lifecycleSessionId: rootSessionId, upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} } });
  let runtime;
  t.after(async () => {
    await runtime?.close().catch(() => undefined);
    await broker.closeRootSession().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  await startAndBindRootBroker(pi, broker);
  runtime = await connectRuntimeCoordinator({ pi, cwd: originRoot, broker, stateRoot });
  const metadata = await runtime.registry.read();
  assert.equal(metadata.canonicalStateRoot, canonicalStateRoot);

  const service = createManagedWorkspaceService({ stateRoot });
  assert.equal(service.stateRoot, canonicalStateRoot);
  const runId = "child-canonical";
  const asyncDir = join(root, "async-canonical");
  const active = service.ensureAllocated(createManagedWorkspaceRequestV2({
    workspaceId: "workspace-canonical", owner: { kind: "standalone-subagent", rootSessionId, toolCallId: "tool-canonical" },
    originRoot, requestedCwd: originRoot, originRef: "refs/heads/main", baseCommit: git(originRoot, "rev-parse", "HEAD"), contractHash: "a".repeat(64),
    policy: { publication: "allowed", application: "allowed", writePaths: ["result.txt"] },
  }));
  service.bindRun({ workspaceId: active.workspaceId, run: { runId, asyncDir } });
  await writeFile(join(active.path, "result.txt"), "canonical\n");
  git(active.path, "add", "result.txt");
  git(active.path, "commit", "-m", "canonical");
  const candidateHead = git(active.path, "rev-parse", "HEAD");
  const binding = { workspaceId: active.workspaceId, leaseId: active.leaseId, runId, ownerScope: { kind: "standalone-subagent", rootSessionId } };
  const tool = createSubagentIntegrationTool({ coordinator: runtime.client, resolveBinding: () => binding });
  const invoke = async (input) => {
    const response = await tool.execute("call", input);
    assert.equal(response.isError, false, response.content[0].text);
    return response.details;
  };
  const queued = await invoke({ action: "enqueue", authorized_workspace_head: candidateHead, target_ref: "refs/heads/main" });
  const admission = await invoke({ action: "await_admission", queue_item_id: queued.queueItemId });
  git(active.path, "rebase", admission.targetHead);
  const published = await invoke({ action: "publish", queue_item_id: queued.queueItemId, queue_lease_id: admission.queueLeaseId, candidate_head: candidateHead });
  assert.equal(published.state, "completed");
  const proof = { state: "observed", conflict: false, runId, rootSessionId, asyncDir, processInstance: `${runId}-runner`, proofId: "c".repeat(64) };
  const settled = await runtime.client.recordTerminalProof({ workspaceId: active.workspaceId, ownerScope: binding.ownerScope, proof });
  assert.equal(settled.receipt.state, "released");

  const audit = auditManagedWorkspaces({ stateRoot, originRoot });
  assert.equal(audit.coordinator.status, "observed");
  assert.equal(audit.coordinator.stateRoot, audit.inventory.stateRoot, "coordinator and ledger must record one canonical state root");
  assert.equal(audit.inventory.stateRoot, canonicalStateRoot);
  assert.deepEqual(audit.debts, []);
  assert.equal(audit.queue.items.length, 1, "the queue must be visible in the canonical ledger bucket");
  assert.equal(audit.queue.items[0].state, "completed");
  assert.equal(audit.queue.items[0].workspaceId, active.workspaceId);
  assert.equal(audit.inventory.workspaces.length, 1);
  assert.equal(audit.inventory.workspaces[0].receipt.state, "released");
});

test("audit keeps every repository queue partition visible when another partition has no queue directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "audit-queue-partitions-"));
  try {
    // The ledger records partition sorts before the queue partition, so a
    // missing queue directory must not abort the whole repository scan.
    const queuePartition = "f".repeat(64);
    const recordsPartition = "0".repeat(64);
    await mkdir(join(root, "repositories", recordsPartition, "records"), { recursive: true });
    await mkdir(join(root, "repositories", queuePartition, "integration-queue"), { recursive: true });
    await writeFile(join(root, "repositories", queuePartition, "integration-queue", "queue-item.json"),
      JSON.stringify({ version: "workspace-integration-queue-item.v1", queueItemId: "queue-item", state: "completed" }));
    const audit = auditManagedWorkspaces({ stateRoot: root });
    assert.deepEqual(audit.queue.items.map((item) => item.queueItemId), ["queue-item"],
      "a repository partition without a queue directory must not hide the remaining partitions");
    assert.deepEqual(audit.debts.filter((debt) => debt.kind === "queue-schema"), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
