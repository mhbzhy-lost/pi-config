import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { RootBrokerServer } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts";
import { startAndBindRootBroker, closeAndUnbindRootBroker, rootBrokerRegistryEntry } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-registry.ts";
import { createTypedSubagentExtension } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts";
import { auditManagedWorkspaces } from "../packages/pi-subagents-enhanced/src/workspace/administration.ts";
import { createChildIntegrationLifecycle, resetChildIntegrationLifecyclesForTest } from "../packages/pi-subagents-enhanced/src/workspace/child-integration-lifecycle.ts";
import { connectRepositoryCoordinator } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-client.ts";
import { createCoordinatorServer } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts";
import { createManagedWorkspaceRequestV2 } from "../packages/pi-subagents-enhanced/src/workspace/contract.ts";
import { createManagedWorkspaceLedger } from "../packages/pi-subagents-enhanced/src/workspace/ledger.ts";
import { resolveRepositoryIdentity } from "../packages/pi-subagents-enhanced/src/workspace/repository-identity.ts";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
class Bus {
  handlers = new Map();
  on(type, fn) { const handlers = this.handlers.get(type) ?? []; handlers.push(fn); this.handlers.set(type, handlers); return () => handlers.splice(handlers.indexOf(fn), 1); }
  async emit(type) { for (const fn of [...this.handlers.get(type) ?? []]) await fn({}); }
}
const privateMaterial = /(?:workspacePath|workspaceId|leaseId|queueLease|token|sessionId|\/private\/|coordinator\.sock)/i;

async function fixture(t) {
  resetChildIntegrationLifecyclesForTest();
  const root = await mkdtemp(path.join(tmpdir(), "auto-integration-real-git-"));
  const originRoot = path.join(root, "main"); const stateRoot = path.join(root, "state");
  await mkdir(originRoot); git(originRoot, "init", "-b", "main"); git(originRoot, "config", "user.email", "test@example.invalid"); git(originRoot, "config", "user.name", "Test");
  await writeFile(path.join(originRoot, "shared.txt"), "base\n"); git(originRoot, "add", "."); git(originRoot, "commit", "-m", "base");
  const base = git(originRoot, "rev-parse", "HEAD"); const identity = await resolveRepositoryIdentity(originRoot);
  const pi = {}; const rootSessionId = `auto-real-${process.pid}-${Date.now()}`;
  const broker = new RootBrokerServer({ rootSessionId, lifecycleSessionId: rootSessionId, upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} } });
  await startAndBindRootBroker(pi, broker); const brokerRegistration = await rootBrokerRegistryEntry(pi);
  const endpoint = path.join(root, "coordinator.sock");
  const server = createCoordinatorServer({ endpoint, repositoryId: identity.repositoryId, storageRepositoryId: identity.storageRepositoryId, stateRoot, idleGraceMs: 10_000 });
  await server.listen();
  const metadata = { protocol: "repository-workspace-coordinator.v1", repositoryId: identity.repositoryId, storageRepositoryId: identity.storageRepositoryId, endpoint, instanceId: server.instanceId, pid: process.pid, birthIdentity: "a".repeat(64), canonicalStateRoot: stateRoot };
  const client = await connectRepositoryCoordinator(identity, brokerRegistration, { metadata });
  t.after(async () => { await client.close(); await server.close(); await closeAndUnbindRootBroker(pi, broker); await rm(root, { recursive: true, force: true }); resetChildIntegrationLifecyclesForTest(); });
  return { root, originRoot, stateRoot, base, identity, rootSessionId, server, client };
}

async function child(f, ordinal) {
  const workspaceId = `workspace-${ordinal}`; const runId = `run-${ordinal}`; const asyncDir = path.join(f.root, `async-${ordinal}`); await mkdir(asyncDir);
  const active = await f.client.ensureAllocated(createManagedWorkspaceRequestV2({
    workspaceId, owner: { kind: "standalone-subagent", rootSessionId: f.rootSessionId, toolCallId: `tool-${ordinal}` }, originRoot: f.originRoot,
    requestedCwd: f.originRoot, originRef: "refs/heads/main", baseCommit: f.base, contractHash: String(ordinal).repeat(64),
    policy: { publication: "allowed", application: "allowed", writePaths: ["shared.txt"] },
  }));
  await f.client.bindRun({ workspaceId, run: { runId, asyncDir } });
  await writeFile(path.join(active.path, "shared.txt"), `child-${ordinal}-first\n`); git(active.path, "add", "shared.txt"); git(active.path, "commit", "-m", `child-${ordinal}-first`);
  if (ordinal === 2) { await writeFile(path.join(active.path, "shared.txt"), "child-2-second\n"); git(active.path, "add", "shared.txt"); git(active.path, "commit", "-m", "child-2-second"); }
  const binding = { workspaceId, leaseId: active.leaseId, runId, ownerScope: { kind: "standalone-subagent", rootSessionId: f.rootSessionId } };
  const bus = new Bus(); const messages = [];
  const lifecycle = createChildIntegrationLifecycle({ pi: { on: bus.on.bind(bus), async sendMessage(message, options) { messages.push({ message, options }); } }, coordinator: f.client, resolveBinding: () => binding, key: `${f.rootSessionId}/${runId}`, maxAdmissionPolls: 1, pollDelayMs: 10 });
  return { active, asyncDir, binding, bus, messages, lifecycle };
}

async function settle(candidate) { await candidate.bus.emit("agent_end"); await candidate.bus.emit("agent_settled"); }
async function waitFor(fn, description, timeout = 5_000) { const end = Date.now() + timeout; for (;;) { const value = await fn(); if (value) return value; if (Date.now() > end) throw new Error(`timed out waiting for ${description}`); await new Promise(resolve => setTimeout(resolve, 10)); } }
function resolveConflict(candidate, text) { assert.notEqual(git(candidate.active.path, "ls-files", "-u", "-z"), ""); assert.match(git(candidate.active.path, "status", "--porcelain"), /^UU /m); return writeFile(path.join(candidate.active.path, "shared.txt"), text).then(() => git(candidate.active.path, "add", "shared.txt")); }
async function proof(f, candidate, digit) { return f.client.recordTerminalProof({ workspaceId: candidate.binding.workspaceId, ownerScope: candidate.binding.ownerScope, proof: { state: "observed", conflict: false, runId: candidate.binding.runId, rootSessionId: f.rootSessionId, asyncDir: candidate.asyncDir, processInstance: `runner-${digit}`, proofId: digit.repeat(64) } }); }

test("real Root Broker/coordinator/Git lifecycle preserves FIFO, continues two conflicts, publishes, proves and releases", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t); const candidates = [await child(f, 1), await child(f, 2), await child(f, 3)];
  for (const candidate of candidates) t.after(() => candidate.lifecycle.dispose());

  // Hold the first lifecycle immediately after its real prepare/enqueue so the
  // other same-base worktrees can enter the durable FIFO before admission.
  let releaseFirst; let preparedFirst; let preparedSignal;
  const firstPrepared = new Promise(resolve => { preparedSignal = resolve; });
  const firstRelease = new Promise(resolve => { releaseFirst = resolve; });
  candidates[0].lifecycle.dispose();
  const gatedCoordinator = new Proxy(f.client, { get(target, property) {
    if (property !== "prepareAutoIntegration") return target[property];
    return async binding => { preparedFirst = await target.prepareAutoIntegration(binding); preparedSignal(); await firstRelease; return preparedFirst; };
  } });
  candidates[0].lifecycle = createChildIntegrationLifecycle({ pi: { on: candidates[0].bus.on.bind(candidates[0].bus), async sendMessage(message, options) { candidates[0].messages.push({ message, options }); } }, coordinator: gatedCoordinator, resolveBinding: () => candidates[0].binding, key: `${f.rootSessionId}/${candidates[0].binding.runId}-gated`, maxAdmissionPolls: 1, pollDelayMs: 10 });
  const firstSettling = settle(candidates[0]); await firstPrepared;
  const prepared = [preparedFirst, await f.client.prepareAutoIntegration(candidates[1].binding), await f.client.prepareAutoIntegration(candidates[2].binding)];
  assert.deepEqual(prepared.map(value => value.queueState), ["queued", "queued", "queued"]);
  assert.equal(JSON.stringify(prepared).match(privateMaterial), null, "trusted auto inspect must not expose path/lease/token/session material");
  await assert.rejects(() => f.client.enqueueIntegration({ ...candidates[1].binding, requestId: "manual-race", authorizedWorkspaceHead: git(candidates[1].active.path, "rev-parse", "HEAD"), targetRef: "refs/heads/main" }), /auto|queued|generation/i);

  releaseFirst(); await firstSettling;
  const firstSettled = await f.client.inspectIntegrationState(candidates[0].binding);
  assert.notEqual(firstSettled.queueState, "preserved", `clean auto path was preserved: ${JSON.stringify(firstSettled)}`);
  const first = await waitFor(() => f.client.inspectIntegrationState(candidates[0].binding).then(value => value.queueState === "completed" && value), "first completion");
  assert.equal(first.integrationReceipt, true); const firstHead = git(f.originRoot, "rev-parse", "HEAD"); assert.equal(git(f.originRoot, "merge-base", "--is-ancestor", f.base, firstHead), "");

  await settle(candidates[1]);
  await waitFor(() => f.client.inspectAutoIntegration(candidates[1].binding).then(value => value.queueState === "resolving-conflict"), "second first conflict");
  await settle(candidates[2]);
  assert.equal((await f.client.inspectAutoIntegration(candidates[2].binding)).queueState, "queued", "non-head stays queued");
  assert.equal(candidates[2].messages.length, 0, "non-head never wakes the model");
  assert.equal(candidates[1].messages.length, 1); assert.equal(candidates[1].messages[0].options.deliverAs, "followUp"); assert.doesNotMatch(JSON.stringify(candidates[1].messages), privateMaterial);
  assert.equal(f.server.internal.integrationQueue.getItem(prepared[1].queueItem.queueItemId).admittedTargetHead, firstHead);

  await resolveConflict(candidates[1], "resolved-2-first\n"); await settle(candidates[1]);
  await waitFor(() => Promise.resolve(candidates[1].messages.length === 2), "bounded second conflict");
  assert.notEqual(git(candidates[1].active.path, "ls-files", "-u", "-z"), "", "second conflict remains for the model");
  await resolveConflict(candidates[1], "resolved-2-second\n"); await settle(candidates[1]);
  await waitFor(() => f.client.inspectIntegrationState(candidates[1].binding).then(value => value.queueState === "completed"), "second completion");
  assert.equal(candidates[1].messages.length, 2, "one continuation per real conflict, with bounded progress"); const secondHead = git(f.originRoot, "rev-parse", "HEAD");

  await waitFor(() => f.client.inspectAutoIntegration(candidates[2].binding).then(value => value.queueState === "resolving-conflict"), "third FIFO admission");
  assert.equal(f.server.internal.integrationQueue.getItem(prepared[2].queueItem.queueItemId).admittedTargetHead, secondHead);
  assert.equal(candidates[2].messages.length, 1);
  await resolveConflict(candidates[2], "resolved-3\n"); await settle(candidates[2]);
  await waitFor(() => f.client.inspectIntegrationState(candidates[2].binding).then(value => value.queueState === "completed"), "third completion");
  assert.equal(git(f.originRoot, "status", "--porcelain"), "");

  await assert.rejects(() => f.client.publishRebasedCandidate({ ...candidates[2].binding, queueItemId: prepared[2].queueItem.queueItemId, queueLeaseId: f.server.internal.integrationQueue.getItem(prepared[2].queueItem.queueItemId).queueLeaseId, candidateHead: git(candidates[2].active.path, "rev-parse", "HEAD") }), /auto|completed|replay/i);
  for (let i = 0; i < candidates.length; i++) assert.equal((await proof(f, candidates[i], String(i + 4))).receipt.state, "released");
  const audit = auditManagedWorkspaces({ stateRoot: f.stateRoot, originRoot: f.originRoot });
  assert.deepEqual(audit.debts, []); assert.deepEqual(audit.queue.items.map(item => item.state), ["completed", "completed", "completed"]);
  assert.deepEqual(f.server.internal.workspaceService.listOwned({ ownerScope: candidates[0].binding.ownerScope }).map(item => item.state), ["released", "released", "released"]);
});

async function allocateChild(f, { workspaceId, runId, toolCallId, file, content, contractHash }) {
  const asyncDir = path.join(f.root, `async-${runId}`); await mkdir(asyncDir);
  const active = await f.client.ensureAllocated(createManagedWorkspaceRequestV2({
    workspaceId, owner: { kind: "standalone-subagent", rootSessionId: f.rootSessionId, toolCallId }, originRoot: f.originRoot,
    requestedCwd: f.originRoot, originRef: "refs/heads/main", baseCommit: f.base, contractHash,
    policy: { publication: "allowed", application: "allowed", writePaths: [file] },
  }));
  await f.client.bindRun({ workspaceId, run: { runId, asyncDir } });
  await writeFile(path.join(active.path, file), content); git(active.path, "add", file); git(active.path, "commit", "-m", runId);
  return { active, asyncDir, binding: { workspaceId, leaseId: active.leaseId, runId, ownerScope: { kind: "standalone-subagent", rootSessionId: f.rootSessionId } } };
}
const observedProof = (f, candidate, processInstance) => ({ state: "observed", conflict: false, runId: candidate.binding.runId, rootSessionId: f.rootSessionId, asyncDir: candidate.asyncDir, processInstance, proofId: processInstance.replace(/[^0-9]/g, "").slice(0, 1).repeat(64) });
const queueState = (value) => value?.queueState ?? value?.state;

async function completeAutoIntegration(f, binding, description) {
  const prepared = await f.client.prepareAutoIntegration(binding);
  assert.equal(prepared.queueState, "queued");
  const completed = await waitFor(async () => { const value = await f.client.advanceAutoIntegration(binding); return queueState(value) === "completed" && value; }, description);
  assert.equal(queueState(completed), "completed");
  return completed;
}

test("queue completion auto-replays a terminal proof that arrived pending, without a manual retry or coordinator restart", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const candidate = await allocateChild(f, { workspaceId: "workspace-replay-complete", runId: "run-replay-complete", toolCallId: "tool-replay-complete", file: "shared.txt", content: "replay-complete-child\n", contractHash: "5".repeat(64) });
  const terminalProof = observedProof(f, candidate, "runner-5");

  // The proof arrives while the child is still queued behind FIFO admission:
  // delivery is rejected and durably retained as pending, without a receipt.
  await assert.rejects(() => f.client.recordTerminalProof({ workspaceId: candidate.binding.workspaceId, ownerScope: candidate.binding.ownerScope, proof: terminalProof }), /completed child integration|pending/i);
  assert.equal(await f.server.proofOutbox.receipt(terminalProof.proofId), undefined, "pre-completion delivery must stay pending without a receipt");

  // The trusted auto path completes the queue item; the test never retries the
  // proof RPC and never restarts the coordinator.
  await completeAutoIntegration(f, candidate.binding, "replay-complete auto integration completion");

  // Completing the queue item must settle the pending proof by itself.
  const receipt = await waitFor(() => f.server.proofOutbox.receipt(terminalProof.proofId), "terminal proof auto-settlement after queue completion");
  assert.equal(receipt.receipt.state, "released");
  assert.equal(f.server.internal.workspaceService.listOwned({ ownerScope: candidate.binding.ownerScope }).find((entry) => entry.workspaceId === candidate.binding.workspaceId).state, "released");
});

test("a FIFO follower's early terminal proof settles automatically once integrations complete, while undeliverable proofs stay pending", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const first = await allocateChild(f, { workspaceId: "workspace-fifo-first", runId: "run-fifo-first", toolCallId: "tool-fifo-first", file: "shared.txt", content: "fifo-first\n", contractHash: "6".repeat(64) });
  const second = await allocateChild(f, { workspaceId: "workspace-fifo-second", runId: "run-fifo-second", toolCallId: "tool-fifo-second", file: "second.txt", content: "fifo-second\n", contractHash: "7".repeat(64) });

  // The follower's proof and an unbindable proof arrive while both children
  // are still queued: both deliveries are rejected and retained as pending.
  const secondProof = observedProof(f, second, "runner-7");
  const ghostProof = { state: "observed", conflict: false, runId: "run-ghost", rootSessionId: f.rootSessionId, asyncDir: path.join(f.root, "async-ghost"), processInstance: "runner-8", proofId: "8".repeat(64) };
  await assert.rejects(() => f.client.recordTerminalProof({ workspaceId: second.binding.workspaceId, ownerScope: second.binding.ownerScope, proof: secondProof }), /completed child integration|pending/i);
  await assert.rejects(() => f.client.recordTerminalProof({ workspaceId: "workspace-ghost", ownerScope: second.binding.ownerScope, proof: ghostProof }), /completed child integration|pending/i);
  assert.equal(await f.server.proofOutbox.receipt(secondProof.proofId), undefined);
  assert.equal(await f.server.proofOutbox.receipt(ghostProof.proofId), undefined);

  // The head integrates first; its queue commit must not be blocked by the
  // concurrent replay attempt, and the still-queued follower must not settle.
  await completeAutoIntegration(f, first.binding, "FIFO head completion");
  const firstHead = git(f.originRoot, "rev-parse", "HEAD");
  assert.equal(await f.server.proofOutbox.receipt(secondProof.proofId), undefined, "a queued follower must not settle early");

  // The follower's own completion settles its early proof with no further
  // proof RPC and no coordinator restart.
  const secondCompleted = await completeAutoIntegration(f, second.binding, "FIFO follower completion");
  assert.equal(f.server.internal.integrationQueue.getItem(secondCompleted.queueItemId).admittedTargetHead, firstHead);
  const receipt = await waitFor(() => f.server.proofOutbox.receipt(secondProof.proofId), "FIFO follower terminal proof auto-settlement");
  assert.equal(receipt.receipt.state, "released");
  assert.equal(f.server.internal.workspaceService.listOwned({ ownerScope: second.binding.ownerScope }).find((entry) => entry.workspaceId === second.binding.workspaceId).state, "released");

  // The unbindable proof stays pending for the next trigger, and repeating a
  // settled delivery is idempotent.
  const outboxFile = path.join(f.server.proofOutboxDirectory, "terminal-proofs.json");
  const outbox = JSON.parse(await readFile(outboxFile, "utf8"));
  assert.deepEqual(outbox.pending.map((entry) => entry.proofId), [ghostProof.proofId]);
  assert.deepEqual(Object.keys(outbox.receipts), [secondProof.proofId]);
  const again = await f.client.recordTerminalProof({ workspaceId: second.binding.workspaceId, ownerScope: second.binding.ownerScope, proof: secondProof });
  assert.equal(again.receipt.state, "released");
  assert.deepEqual(JSON.parse(await readFile(outboxFile, "utf8")), outbox, "a repeated delivery is idempotent");
});

function dispatchPiHarness(originRoot, leafAsyncDir) {
  const sessionRoot = realpathSync(originRoot);
  const tools = [];
  const listeners = new Map();
  const events = {
    on(type, listener) {
      const current = listeners.get(type) ?? new Set();
      current.add(listener); listeners.set(type, current);
      return () => current.delete(listener);
    },
    emit(type, value) { for (const listener of listeners.get(type) ?? []) listener(value); },
  };
  const pi = { events, registerTool(tool) { tools.push(tool); }, on() {} };
  const rpc = {
    async ping() { return { version: 1, methods: ["spawn"], session: { sessionId: "root-session", sessionFile: "root-session", cwd: sessionRoot } }; },
    async spawn(params) {
      const match = params.workflowScript.match(/^return await runs\.run\(([^,]+), (.*)\);$/);
      const workflowKey = JSON.parse(match[1]);
      const leaf = JSON.parse(match[2]);
      queueMicrotask(() => events.emit("subagent:async-started", {
        parentWorkflowRunId: "workflow-root",
        runId: "leaf-run",
        asyncDir: leafAsyncDir,
        sessionId: "root-session",
        pid: process.pid,
        agent: leaf.agent,
        workflowKey,
      }));
      return { details: { runId: "workflow-root", asyncDir: path.join(originRoot, "async-root") } };
    },
    dispose() {},
  };
  return { pi, tools, rpc };
}

function realDispatchCodingContract(originRoot) {
  return {
    version: "dispatch-ir.v1",
    taskId: "real-dispatch-v2",
    title: "Allocate through the real dispatch entry",
    agent: "executor",
    risk: "normal",
    objective: "Prove the real Auto Integration allocation path creates a v2 ledger and settles its terminal proof.",
    requirements: ["Commit the allowed change."],
    context: { knownFacts: [], decisions: [], relevantFiles: ["shared.txt"] },
    boundaries: { writePaths: ["shared.txt"], excludedWork: [], forbiddenActions: [] },
    acceptance: { criteria: ["The ledger is v2 and the proof settles."] },
    execution: { cwd: originRoot, worktree: true },
  };
}

test("real dispatch allocation is v2 and its terminal proof settles from pending to receipts", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const leafAsyncDir = path.join(f.root, "async-dispatch");
  await mkdir(leafAsyncDir);
  const { pi, tools, rpc } = dispatchPiHarness(f.originRoot, leafAsyncDir);
  const registered = [];
  createTypedSubagentExtension(pi, {
    rpc,
    cleanupStore: {},
    randomUUID: () => "real-dispatch-workspace",
    discoverAgents() { return { agents: [{ name: "executor" }, { name: "reviewer" }] }; },
    workspaceService: f.server.internal.workspaceService,
    resolveRootSessionId: () => f.rootSessionId,
    registerAuthorizedRun(authorization) { registered.push(authorization); },
  });

  const spawned = await tools[0].execute("real-dispatch", realDispatchCodingContract(f.originRoot), undefined, undefined, { cwd: f.originRoot, sessionManager: {} });
  assert.equal(spawned.isError, false, spawned.content[0]?.text);
  const workspaceId = spawned.details.workspace_id;
  assert.equal(registered.length, 1);

  const ledger = createManagedWorkspaceLedger({ stateRoot: f.stateRoot });
  const record = ledger.load(workspaceId).record;
  assert.equal(record.schemaVersion, "managed-workspace-ledger.v2");
  assert.deepEqual(record.request.policy, { publication: "allowed", application: "allowed", writePaths: ["shared.txt"] });

  const binding = { workspaceId, leaseId: spawned.details.lease_id, runId: "leaf-run", ownerScope: { kind: "standalone-subagent", rootSessionId: f.rootSessionId } };
  await writeFile(path.join(spawned.details.dispatch_cwd, "shared.txt"), "real-dispatch-child\n");
  git(spawned.details.dispatch_cwd, "add", "shared.txt");
  git(spawned.details.dispatch_cwd, "commit", "-m", "real dispatch child change");

  const terminalProof = { state: "observed", conflict: false, runId: "leaf-run", rootSessionId: f.rootSessionId, asyncDir: leafAsyncDir, processInstance: "runner-real-dispatch", proofId: "9".repeat(64) };
  await assert.rejects(() => f.client.recordTerminalProof({ workspaceId, ownerScope: binding.ownerScope, proof: terminalProof }), /completed child integration|pending/i);
  assert.equal(await f.server.proofOutbox.receipt(terminalProof.proofId), undefined, "undeliverable proof must stay pending without a receipt");

  const prepared = await f.client.prepareAutoIntegration(binding);
  assert.equal(prepared.queueState, "queued");
  const queueState = (value) => value?.queueState ?? value?.state;
  await waitFor(async () => { const value = await f.client.advanceAutoIntegration(binding); return queueState(value) === "completed" && value; }, "real dispatch auto integration completion");

  const delivered = await f.client.recordTerminalProof({ workspaceId, ownerScope: binding.ownerScope, proof: terminalProof });
  assert.equal(delivered.receipt.state, "released");
  assert.equal((await f.server.proofOutbox.receipt(terminalProof.proofId)).receipt.state, "released");
  const completion = await f.client.inspectIntegrationState(binding);
  assert.deepEqual({ queueState: completion.queueState, integrationReceipt: completion.integrationReceipt, proofState: completion.proofState, workspaceState: completion.workspaceState },
    { queueState: "completed", integrationReceipt: true, proofState: "accepted", workspaceState: "released" });
  assert.equal(await readFile(path.join(f.originRoot, "shared.txt"), "utf8"), "real-dispatch-child\n");
  const audit = auditManagedWorkspaces({ stateRoot: f.stateRoot, originRoot: f.originRoot });
  assert.deepEqual(audit.debts, []);
  assert.equal(audit.queue.items.filter(item => item.workspaceId === workspaceId).every(item => item.state === "completed"), true);
});
