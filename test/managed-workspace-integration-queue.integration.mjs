import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createManagedWorkspaceRequestV2 } from "../packages/pi-subagents-enhanced/src/workspace/contract.ts";
import { createCoordinatorServer } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts";
import { connectRepositoryCoordinator } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-client.ts";
import { createChildIntegrationLifecycle, resetChildIntegrationLifecyclesForTest } from "../packages/pi-subagents-enhanced/src/workspace/child-integration-lifecycle.ts";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "managed-integration-queue-"));
  const originRoot = join(root, "origin");
  const stateRoot = join(root, "state");
  await mkdir(join(originRoot, "src"), { recursive: true });
  git(originRoot, "init", "-b", "main");
  git(originRoot, "config", "user.email", "test@example.com");
  git(originRoot, "config", "user.name", "Test User");
  await writeFile(join(originRoot, "src", "base.txt"), "base\n");
  git(originRoot, "add", ".");
  git(originRoot, "commit", "-m", "base");
  const repositoryId = createHash("sha256").update(git(originRoot, "rev-parse", "--git-common-dir").startsWith("/")
    ? git(originRoot, "rev-parse", "--git-common-dir") : join(originRoot, git(originRoot, "rev-parse", "--git-common-dir"))).digest("hex");
  let fault = null;
  let admissionInspectionCount = 0;
  const admissionProbe = options.admissionProbe ? () => { admissionInspectionCount++; } : undefined;
  const coordinator = createCoordinatorServer({ endpoint: join(root, "coordinator.sock"), repositoryId, stateRoot, idleGraceMs: 10_000,
    challengeBroker: async (registry, challenge) => ({ ...challenge, rootSessionId: registry.rootSessionId, brokerProcessIdentity: "b".repeat(64) }), fault: event => fault?.(event), admissionProbe });
  t.after(async () => {
    await coordinator.close();
    try {
      for (const line of git(originRoot, "worktree", "list", "--porcelain").split("\n")) {
        if (line.startsWith("worktree ") && line.slice(9) !== originRoot) spawnSync("git", ["worktree", "remove", "--force", line.slice(9)], { cwd: originRoot });
      }
    } catch {}
    await rm(root, { recursive: true, force: true });
  });
  return { root, originRoot, stateRoot, repositoryId, baseCommit: git(originRoot, "rev-parse", "HEAD"), coordinator, setFault(value) { fault = value; }, admissionInspections: () => admissionInspectionCount };
}

async function connectRealClient(f, rootSessionId = "root-a") {
  return connectRepositoryCoordinator({ repositoryId: f.repositoryId }, { protocol: "pi-root-subagent-broker-registry.v1", rootSessionId, endpoint: "broker.sock", pid: process.pid, processBirthIdentity: "b".repeat(64) }, {
    metadata: { protocol: "repository-workspace-coordinator.v1", repositoryId: f.repositoryId, storageRepositoryId: f.repositoryId, endpoint: join(f.root, "coordinator.sock"), instanceId: f.coordinator.instanceId, pid: process.pid, birthIdentity: "c".repeat(64), canonicalStateRoot: f.stateRoot },
  });
}

function request(f, workspaceId, owner) {
  return createManagedWorkspaceRequestV2({
    workspaceId,
    owner: { kind: "standalone-subagent", rootSessionId: owner, toolCallId: `tool-${workspaceId}` },
    originRoot: f.originRoot,
    requestedCwd: join(f.originRoot, "src"),
    originRef: "refs/heads/main",
    baseCommit: f.baseCommit,
    contractHash: "a".repeat(64),
    policy: { publication: "allowed", application: "allowed", writePaths: ["src/**"] },
  });
}

async function allocateCandidate(f, workspaceId, owner, filename) {
  const receipt = f.coordinator.internal.workspaceService.ensureAllocated(request(f, workspaceId, owner));
  const run = { runId: `run-${workspaceId}`, asyncDir: join(f.root, `async-${workspaceId}`) };
  f.coordinator.internal.workspaceService.bindRun({ workspaceId, run });
  await writeFile(join(receipt.path, "src", filename), `${workspaceId}\n`);
  git(receipt.path, "add", ".");
  git(receipt.path, "commit", "-m", workspaceId);
  return { receipt, run, head: git(receipt.path, "rev-parse", "HEAD"), binding: { workspaceId, leaseId: receipt.leaseId, ownerScope: { kind: "standalone-subagent", rootSessionId: owner }, runId: run.runId } };
}

function enqueue(f, candidate) {
  return f.coordinator.internal.enqueueIntegration({
    requestId: `request-${candidate.receipt.workspaceId}`,
    workspaceId: candidate.receipt.workspaceId,
    leaseId: candidate.receipt.leaseId,
    strategy: "rebase-ff",
    targetRef: "refs/heads/main",
    authorizedWorkspaceHead: candidate.head,
    observedTargetHead: f.baseCommit,
  }, candidate.binding);
}

class EventBus {
  handlers = new Map();
  on(type, handler) { const handlers = this.handlers.get(type) ?? []; handlers.push(handler); this.handlers.set(type, handlers); return () => handlers.splice(handlers.indexOf(handler), 1); }
  async emit(type) { for (const handler of [...this.handlers.get(type) ?? []]) await handler({}); }
}

test("two owners are admitted FIFO and publish exact rebased candidates with ff-only", async (t) => {
  const f = await fixture(t);
  const first = await allocateCandidate(f, "first", "root-a", "first.txt");
  const second = await allocateCandidate(f, "second", "root-b", "second.txt");
  const firstItem = enqueue(f, first);
  const secondItem = enqueue(f, second);

  const firstAdmission = f.coordinator.internal.awaitIntegrationAdmission(firstItem.queueItemId, first.binding);
  assert.equal(firstAdmission.targetHead, f.baseCommit);
  assert.equal(f.coordinator.internal.awaitIntegrationAdmission(secondItem.queueItemId, second.binding), null);
  const firstReceipt = f.coordinator.internal.publishRebasedCandidate({ queueItemId: firstItem.queueItemId, queueLeaseId: firstAdmission.queueLeaseId, candidateHead: first.head }, first.binding);
  assert.equal(firstReceipt.state, "completed");
  assert.equal(git(f.originRoot, "symbolic-ref", "HEAD"), "refs/heads/main");
  assert.equal(git(f.originRoot, "rev-parse", "HEAD"), first.head);
  assert.equal(git(f.originRoot, "status", "--porcelain"), "");

  const secondAdmission = f.coordinator.internal.awaitIntegrationAdmission(secondItem.queueItemId, second.binding);
  assert.equal(secondAdmission.targetHead, first.head);
  git(second.receipt.path, "rebase", secondAdmission.targetHead);
  second.head = git(second.receipt.path, "rev-parse", "HEAD");
  const secondReceipt = f.coordinator.internal.publishRebasedCandidate({ queueItemId: secondItem.queueItemId, queueLeaseId: secondAdmission.queueLeaseId, candidateHead: second.head }, second.binding);
  assert.equal(secondReceipt.state, "completed");
  assert.equal(git(f.originRoot, "rev-parse", "HEAD"), second.head);
  assert.equal(git(f.originRoot, "diff", "--cached", "--quiet"), "");
  assert.equal(git(f.originRoot, "status", "--porcelain"), "");
});

test("real coordinator socket clients prepare idempotently, preserve FIFO waiting, and reload admission", async (t) => {
  const f = await fixture(t);
  await f.coordinator.listen();
  const first = await allocateCandidate(f, "real-first", "root-a", "first.txt");
  const second = await allocateCandidate(f, "real-second", "root-b", "second.txt");
  const firstClient = await connectRealClient(f, "root-a");
  const secondClient = await connectRealClient(f, "root-b");
  t.after(async () => { await firstClient.close(); await secondClient.close(); });
  const firstBindingInput = { workspaceId: first.binding.workspaceId, leaseId: first.binding.leaseId, runId: first.binding.runId };
  const secondBindingInput = { workspaceId: second.binding.workspaceId, leaseId: second.binding.leaseId, runId: second.binding.runId };
  const firstPrepared = await firstClient.prepareAutoIntegration(firstBindingInput);
  const firstAgain = await firstClient.prepareAutoIntegration(firstBindingInput);
  assert.equal(firstAgain.queueItem.queueItemId, firstPrepared.queueItem.queueItemId);
  assert.equal(firstAgain.queueItem.requestId, firstPrepared.queueItem.requestId);
  assert.equal(f.coordinator.internal.integrationQueue.listQueue().length, 1);
  const secondPrepared = await secondClient.prepareAutoIntegration(secondBindingInput);
  assert.equal(secondPrepared.queueState, "queued");
  assert.equal(await secondClient.awaitIntegrationAdmission({ queueItemId: secondPrepared.queueItem.queueItemId, ...secondBindingInput }), null);
  const firstAdmission = await firstClient.awaitIntegrationAdmission({ queueItemId: firstPrepared.queueItem.queueItemId, workspaceId: first.binding.workspaceId, leaseId: first.binding.leaseId, runId: first.binding.runId });
  assert.equal(firstAdmission.targetHead, f.baseCommit);
  const reloaded = await connectRealClient(f, "root-a");
  t.after(() => reloaded.close());
  const restored = await reloaded.inspectAutoIntegration(firstBindingInput);
  assert.equal(Object.hasOwn(restored, "queueLease"), false, "trusted inspection must not expose the private queue lease");
  assert.equal(restored.admissionGeneration, firstAdmission.admissionGeneration);
  assert.equal(restored.targetHead, firstAdmission.targetHead);
  await assert.rejects(() => reloaded.publishRebasedCandidate({ queueItemId: firstPrepared.queueItem.queueItemId, queueLeaseId: firstAdmission.queueLeaseId, candidateHead: first.head, ...firstBindingInput }), /auto integration generation/i);
  const firstReceipt = await reloaded.advanceAutoIntegration({});
  assert.equal(firstReceipt.state, "completed");
  assert.equal(f.coordinator.internal.integrationQueue.getItem(firstPrepared.queueItem.queueItemId).admissionGeneration, 1);
  const secondAdmission = await secondClient.awaitIntegrationAdmission({ queueItemId: secondPrepared.queueItem.queueItemId, workspaceId: second.binding.workspaceId, leaseId: second.binding.leaseId, runId: second.binding.runId });
  assert.equal(secondAdmission.targetHead, first.head);
});

test("non-LLM agent_end wiring advances enqueue through admission, rebase, publish and receipt", async (t) => {
  resetChildIntegrationLifecyclesForTest();
  const f = await fixture(t); await f.coordinator.listen();
  const candidate = await allocateCandidate(f, "wired", "root-wired", "wired.txt");
  const client = await connectRealClient(f, "root-wired"); const bus = new EventBus();
  const lifecycle = createChildIntegrationLifecycle({ pi: { on: bus.on.bind(bus), async sendMessage() { throw new Error("clean wiring must not invoke a model continuation"); } }, coordinator: client,
    resolveBinding: () => candidate.binding, key: "root-wired/run-wired", maxAdmissionPolls: 2, pollDelayMs: 0 });
  t.after(async () => { lifecycle.dispose(); resetChildIntegrationLifecyclesForTest(); await client.close(); });

  await bus.emit("agent_end");
  const item = f.coordinator.internal.integrationQueue.findByBinding(candidate.binding);
  assert.equal(item.admissionGeneration, 1);
  assert.equal(item.state, "completed");
  assert.equal(git(f.originRoot, "rev-parse", "HEAD"), git(candidate.receipt.path, "rev-parse", "HEAD"));
  const state = await client.inspectIntegrationState(candidate.binding);
  assert.equal(state.integrationReceipt, true);
  assert.equal(typeof item.workspaceDispositionReceiptId, "string");
});

test("auto integration prepare and inspect expose only the lifecycle projection allowlist", async (t) => {
  const f = await fixture(t);
  const candidate = await allocateCandidate(f, "projection", "root-projection", "projection.txt");
  const prepared = f.coordinator.internal.prepareAutoIntegration(candidate.binding);
  const allowed = ["queueItem", "queueState", "admissionGeneration", "targetHead", "workspaceState"];
  assert.deepEqual(Object.keys(prepared).sort(), [...allowed].sort());
  assert.deepEqual(Object.keys(prepared.queueItem).sort(), ["queueItemId", "requestId", "revision", "state"].sort());
  for (const sensitive of ["path", "branch", "branchRef", "head", "originRef", "token", "sessionId", "workspacePath"]) {
    assert.equal(Object.hasOwn(prepared, sensitive), false, `inspect projection leaked ${sensitive}`);
    assert.equal(JSON.stringify(prepared).includes(sensitive), false, `inspect projection serialized ${sensitive}`);
  }
  const inspected = f.coordinator.internal.inspectAutoIntegration(candidate.binding);
  assert.deepEqual(Object.keys(inspected).sort(), [...allowed].sort());
  assert.deepEqual(Object.keys(inspected.queueItem).sort(), ["queueItemId", "requestId", "revision", "state"].sort());
});

test("trusted completion projection reports absent queue and durably preserves exhausted integration debt", async (t) => {
  const f = await fixture(t);
  const candidate = await allocateCandidate(f, "guard", "root-guard", "guard.txt");
  const absent = f.coordinator.internal.inspectIntegrationState(candidate.binding);
  assert.deepEqual(absent, { queueState: "absent", workspaceState: "active", integrationReceipt: false, proofState: "absent", revision: 0 });
  const preserved = f.coordinator.internal.preserveIntegrationDebt(candidate.binding);
  assert.equal(preserved.queueState, "absent");
  assert.equal(preserved.workspaceState, "preserved");
  assert.equal(preserved.proofState, "debt");
  assert.deepEqual(f.coordinator.internal.preserveIntegrationDebt(candidate.binding), preserved);
  assert.throws(() => f.coordinator.internal.inspectIntegrationState({ ...candidate.binding, runId: "foreign" }), /binding|owner|run/i);
  assert.equal(Object.hasOwn(preserved, "path"), false);
  assert.equal(Object.hasOwn(preserved, "leaseId"), false);
});

test("preservation persists the caller's recovery reason classification", async (t) => {
  const f = await fixture(t);
  const reasons = ["guard-no-progress", "shutdown", "rpc-rejected", "coordinator-unavailable", "explicit"];
  for (const [index, reason] of reasons.entries()) {
    const candidate = await allocateCandidate(f, `reason-${index}`, `root-reason-${index}`, `reason-${index}.txt`);
    enqueue(f, candidate);
    f.coordinator.internal.preserveIntegrationDebt(candidate.binding, reason);
    const item = f.coordinator.internal.integrationQueue.findByBinding(candidate.binding);
    assert.equal(item.preserveReason, reason);
  }
});

test("sealed candidate rejects foreign binding, lease replay, drift, dirt, and writePath escape", async (t) => {
  const f = await fixture(t);
  const candidate = await allocateCandidate(f, "sealed", "root-a", "sealed.txt");
  const item = enqueue(f, candidate);
  const admission = f.coordinator.internal.awaitIntegrationAdmission(item.queueItemId, candidate.binding);
  assert.throws(() => f.coordinator.internal.publishRebasedCandidate({ queueItemId: item.queueItemId, queueLeaseId: admission.queueLeaseId, candidateHead: candidate.head }, { ...candidate.binding, runId: "foreign" }), /binding|owner|run/i);
  await writeFile(join(candidate.receipt.path, "dirty.txt"), "dirty\n");
  assert.throws(() => f.coordinator.internal.publishRebasedCandidate({ queueItemId: item.queueItemId, queueLeaseId: admission.queueLeaseId, candidateHead: candidate.head }, candidate.binding), /clean|dirty/i);
  await rm(join(candidate.receipt.path, "dirty.txt"));
  const receipt = f.coordinator.internal.publishRebasedCandidate({ queueItemId: item.queueItemId, queueLeaseId: admission.queueLeaseId, candidateHead: candidate.head }, candidate.binding);
  assert.equal(receipt.state, "completed");
  assert.throws(() => f.coordinator.internal.publishRebasedCandidate({ queueItemId: item.queueItemId, queueLeaseId: admission.queueLeaseId, candidateHead: candidate.head }, candidate.binding), /lease|state|completed|replay/i);
});

test("conflict state retains admission and canonical checkout identity and CAS fail closed", async (t) => {
  const f = await fixture(t);
  const conflict = await allocateCandidate(f, "conflict", "root-a", "conflict.txt");
  const item = enqueue(f, conflict);
  const admission = f.coordinator.internal.awaitIntegrationAdmission(item.queueItemId, conflict.binding);
  assert.equal(f.coordinator.internal.reportResolvingConflict({ queueItemId: item.queueItemId, queueLeaseId: admission.queueLeaseId }, conflict.binding).state, "resolving-conflict");
  assert.equal(f.coordinator.internal.awaitIntegrationAdmission(item.queueItemId, conflict.binding).queueLeaseId, admission.queueLeaseId);

  git(f.originRoot, "switch", "-c", "wrong");
  assert.throws(() => f.coordinator.internal.publishRebasedCandidate({ queueItemId: item.queueItemId, queueLeaseId: admission.queueLeaseId, candidateHead: conflict.head }, conflict.binding), /target ref|canonical|branch|drift/i);
  git(f.originRoot, "switch", "main");
  await writeFile(join(f.originRoot, "external.txt"), "external\n");
  git(f.originRoot, "add", "."); git(f.originRoot, "commit", "-m", "external advance");
  assert.throws(() => f.coordinator.internal.publishRebasedCandidate({ queueItemId: item.queueItemId, queueLeaseId: admission.queueLeaseId, candidateHead: conflict.head }, conflict.binding), /advanced|CAS|target HEAD/i);
  const retry = f.coordinator.internal.abandonIntegration({ queueItemId: item.queueItemId, queueLeaseId: admission.queueLeaseId, retry: true }, conflict.binding);
  assert.equal(retry.attempt, 2);
  assert.ok(retry.sequence > item.sequence);
  const retriedAdmission = f.coordinator.internal.awaitIntegrationAdmission(retry.queueItemId, conflict.binding);
  assert.equal(retriedAdmission.targetHead, git(f.originRoot, "rev-parse", "HEAD"));
});

test("detached target is rejected at claim", async (t) => {
  const f = await fixture(t);
  const detached = await allocateCandidate(f, "detached", "root-a", "detached.txt");
  git(f.originRoot, "checkout", "--detach");
  const detachedItem = enqueue(f, detached);
  assert.equal(detachedItem.state, "queued");
  assert.throws(() => f.coordinator.internal.awaitIntegrationAdmission(detachedItem.queueItemId, detached.binding), /attached|canonical|target ref|identity|origin/i);
});

test("out-of-scope sealed candidate is rejected at claim", async (t) => {
  const f = await fixture(t);
  const escaped = await allocateCandidate(f, "escaped", "root-b", "allowed.txt");
  await writeFile(join(escaped.receipt.path, "outside.txt"), "outside\n");
  git(escaped.receipt.path, "add", "."); git(escaped.receipt.path, "commit", "-m", "outside scope");
  escaped.head = git(escaped.receipt.path, "rev-parse", "HEAD");
  const escapedItem = enqueue(f, escaped);
  assert.equal(escapedItem.state, "queued");
  assert.throws(() => f.coordinator.internal.awaitIntegrationAdmission(escapedItem.queueItemId, escaped.binding), /writePaths|outside/i);
});

test("source edits during the merge leave exact intent recovery without a duplicate commit", async (t) => {
  const f = await fixture(t);
  const candidate = await allocateCandidate(f, "source-race", "root-a", "race.txt");
  const item = enqueue(f, candidate);
  const admission = f.coordinator.internal.awaitIntegrationAdmission(item.queueItemId, candidate.binding);
  let injected = false;
  f.setFault(event => {
    if (!injected && event.operation === "integration" && event.phase === "before-merge") {
      injected = true;
      execFileSync("sh", ["-c", "printf dirty > concurrent.txt"], { cwd: candidate.receipt.path });
    }
  });
  assert.throws(() => f.coordinator.internal.publishRebasedCandidate({ queueItemId: item.queueItemId, queueLeaseId: admission.queueLeaseId, candidateHead: candidate.head }, candidate.binding), /source workspace changed|dirty/i);
  assert.equal(git(f.originRoot, "rev-parse", "HEAD"), candidate.head);
  await rm(join(candidate.receipt.path, "concurrent.txt"));
  f.setFault(null);
  const recovered = f.coordinator.internal.reconcileIntegrations();
  assert.equal(recovered[0].state, "completed");
  assert.equal(git(f.originRoot, "rev-list", "--count", `${f.baseCommit}..HEAD`), "1");
});

test("target advance after intent archives the failed attempt before retry", async (t) => {
  const f = await fixture(t);
  const candidate = await allocateCandidate(f, "intent-cas", "root-a", "intent-cas.txt");
  const item = enqueue(f, candidate);
  const admission = f.coordinator.internal.awaitIntegrationAdmission(item.queueItemId, candidate.binding);
  let injected = false;
  f.setFault(event => {
    if (!injected && event.operation === "integration" && event.phase === "before-merge") {
      injected = true;
      execFileSync("sh", ["-c", "printf external > external-after-intent.txt && git add . && git commit -m external-after-intent"], { cwd: f.originRoot, stdio: "ignore" });
    }
  });
  assert.throws(() => f.coordinator.internal.publishRebasedCandidate({ queueItemId: item.queueItemId, queueLeaseId: admission.queueLeaseId, candidateHead: candidate.head }, candidate.binding), /git merge|failed|fast-forward/i);
  f.setFault(null);
  const retry = f.coordinator.internal.abandonIntegration({ queueItemId: item.queueItemId, queueLeaseId: admission.queueLeaseId, retry: true }, candidate.binding);
  const state = f.coordinator.internal.workspaceService.integrationState(retry, candidate.binding);
  assert.equal(state.intent, null);
  const retryAdmission = f.coordinator.internal.awaitIntegrationAdmission(retry.queueItemId, candidate.binding);
  git(candidate.receipt.path, "rebase", retryAdmission.targetHead);
  candidate.head = git(candidate.receipt.path, "rev-parse", "HEAD");
  assert.equal(f.coordinator.internal.publishRebasedCandidate({ queueItemId: retry.queueItemId, queueLeaseId: retryAdmission.queueLeaseId, candidateHead: candidate.head }, candidate.binding).state, "completed");
});

test("prepared, intent, merged, and receipt crash windows recover idempotently", async (t) => {
  for (const phase of ["after-prepared", "after-intent", "after-merge", "before-queue-complete"]) {
    await t.test(phase, async (t) => {
      const f = await fixture(t);
      const candidate = await allocateCandidate(f, `crash-${phase}`, "root-a", `${phase}.txt`);
      const item = enqueue(f, candidate);
      const admission = f.coordinator.internal.awaitIntegrationAdmission(item.queueItemId, candidate.binding);
      let injected = false;
      f.setFault(event => {
        if (!injected && event.operation === "integration" && event.phase === phase) {
          injected = true; const error = new Error(`crash at ${phase}`); error.code = "TEST_FAULT"; throw error;
        }
      });
      assert.throws(() => f.coordinator.internal.publishRebasedCandidate({ queueItemId: item.queueItemId, queueLeaseId: admission.queueLeaseId, candidateHead: candidate.head }, candidate.binding), /crash/);
      f.setFault(null);
      const recovered = f.coordinator.internal.reconcileIntegrations();
      assert.equal(recovered[0].state, "completed", JSON.stringify(recovered));
      const workspace = f.coordinator.internal.workspaceService.status({ workspaceId: candidate.receipt.workspaceId });
      assert.equal(workspace.receipt.state, "active", "queue completion must not perform terminal cleanup");
      assert.equal(git(f.originRoot, "rev-parse", "HEAD"), candidate.head);
    });
  }
});

test("coordinator restart reconciliation visits every live queue state", async (t) => {
  for (const stage of ["queued", "admitted", "rebasing", "resolving-conflict", "prepared"]) {
    await t.test(stage, async (t) => {
      const f = await fixture(t);
      const candidate = await allocateCandidate(f, `restart-${stage}`, "root-restart", `${stage}.txt`);
      const item = enqueue(f, candidate);
      if (stage !== "queued") {
        const admission = f.coordinator.internal.awaitIntegrationAdmission(item.queueItemId, candidate.binding);
        if (stage === "prepared") f.coordinator.internal.integrationQueue.prepareCandidate({ queueItemId: item.queueItemId, queueLeaseId: admission.queueLeaseId, admissionGeneration: admission.admissionGeneration, candidateHead: candidate.head });
        if (stage === "resolving-conflict") f.coordinator.internal.integrationQueue.markResolvingConflict({ queueItemId: item.queueItemId, queueLeaseId: admission.queueLeaseId, admissionGeneration: admission.admissionGeneration });
        if (stage === "rebasing") {
          const file = join(f.stateRoot, "repositories", f.repositoryId, "integration-queue", `${item.queueItemId}.json`);
          await writeFile(file, `${JSON.stringify({ ...f.coordinator.internal.integrationQueue.getItem(item.queueItemId), state: "rebasing" })}\n`);
        }
      }
      const restarted = createCoordinatorServer({ endpoint: join(f.root, `restart-${stage}.sock`), repositoryId: f.repositoryId, stateRoot: f.stateRoot });
      t.after(() => restarted.close());
      const result = restarted.internal.reconcileIntegrations();
      assert.equal(result.length, 1, `${stage} was not visited`);
      assert.equal(["completed", "preserved"].includes(result[0].state), true, JSON.stringify(result));
    });
  }
});

test("stale Git operation lock is recovered using PID birth identity", async (t) => {
  const f = await fixture(t);
  const candidate = await allocateCandidate(f, "stale-lock", "root-a", "lock.txt");
  const item = enqueue(f, candidate);
  const admission = f.coordinator.internal.awaitIntegrationAdmission(item.queueItemId, candidate.binding);
  const lock = join(f.originRoot, ".git", "pi-managed-workspace-operation.lock");
  await mkdir(lock);
  await writeFile(join(lock, "owner.json"), `${JSON.stringify({ token: "stale", pid: 999999, birthIdentity: "0".repeat(64), createdAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  const receipt = f.coordinator.internal.publishRebasedCandidate({ queueItemId: item.queueItemId, queueLeaseId: admission.queueLeaseId, candidateHead: candidate.head }, candidate.binding);
  assert.equal(receipt.state, "completed");
});

test("enqueue accepts a dirty workspace and admission facts run only at claim", async (t) => {
  const f = await fixture(t);
  const candidate = await allocateCandidate(f, "dirty", "root-dirty", "dirty.txt");
  // allocateCandidate 已提交；追加未提交改动产生脏态
  await writeFile(join(candidate.receipt.path, "src", "dirty.txt"), "uncommitted\n");
  const prepared = f.coordinator.internal.prepareAutoIntegration(candidate.binding);
  assert.equal(prepared.queueState, "queued");
  assert.throws(() => f.coordinator.internal.advanceAutoIntegration({}, candidate.binding), /workspace admission requires the authorized clean committed HEAD/);
});

test("concurrent advances for the same head share one admission inspection", async (t) => {
  const f = await fixture(t, { admissionProbe: true });
  const candidate = await allocateCandidate(f, "shared", "root-shared", "shared.txt");
  f.coordinator.internal.prepareAutoIntegration(candidate.binding);
  const before = f.admissionInspections();
  // 两次 advance：第一次 claim 触发一次 inspection，第二次看到已 admitted 直接返回不重复 inspection
  const a = f.coordinator.internal.advanceAutoIntegration({}, candidate.binding);
  const b = f.coordinator.internal.advanceAutoIntegration({}, candidate.binding);
  assert.equal(f.admissionInspections() - before, 1);
  void a; void b;
});

test("首个文本 turn 过早入队后，child commit 刷新授权头并完成 FIFO 集成", async (t) => {
  const f = await fixture(t);
  // 手动构造：分配 workspace 并绑 run，但不 commit（模拟 GLM 首个纯文本 turn
  // 时 HEAD 仍为 base）。
  const receipt = f.coordinator.internal.workspaceService.ensureAllocated(request(f, "premature", "root-a"));
  const run = { runId: "run-premature", asyncDir: join(f.root, "async-premature") };
  f.coordinator.internal.workspaceService.bindRun({ workspaceId: "premature", run });
  const binding = { workspaceId: "premature", leaseId: receipt.leaseId, ownerScope: { kind: "standalone-subagent", rootSessionId: "root-a" }, runId: run.runId };

  const firstPrepare = f.coordinator.internal.prepareAutoIntegration(binding);
  assert.equal(firstPrepare.queueState, "queued");
  assert.equal(f.coordinator.internal.integrationQueue.getItem(firstPrepare.queueItem.queueItemId).authorizedWorkspaceHead, f.baseCommit);

  // child 在后续 turn 完成自有 commit：HEAD 前进为旧授权头的后代。
  await writeFile(join(receipt.path, "src", "premature.txt"), "premature\n");
  git(receipt.path, "add", "src/premature.txt");
  git(receipt.path, "commit", "-m", "premature work");
  const committedHead = git(receipt.path, "rev-parse", "HEAD");

  const secondPrepare = f.coordinator.internal.prepareAutoIntegration(binding);
  assert.equal(secondPrepare.queueState, "queued");
  const refreshedItem = f.coordinator.internal.integrationQueue.getItem(firstPrepare.queueItem.queueItemId);
  assert.equal(refreshedItem.authorizedWorkspaceHead, committedHead, "授权头必须刷新为 child commit 后的 HEAD");

  // admission 现在成功：claim → rebase → publish → completed。
  const admission = f.coordinator.internal.awaitIntegrationAdmission(refreshedItem.queueItemId, binding);
  assert.equal(admission.targetHead, f.baseCommit);
  const publishReceipt = f.coordinator.internal.publishRebasedCandidate({ queueItemId: refreshedItem.queueItemId, queueLeaseId: admission.queueLeaseId, candidateHead: committedHead }, binding);
  assert.equal(publishReceipt.state, "completed");
});

test("非后代 HEAD 拒绝刷新授权头（fail closed）", async (t) => {
  const f = await fixture(t);
  const receipt = f.coordinator.internal.workspaceService.ensureAllocated(request(f, "drifted", "root-a"));
  const run = { runId: "run-drifted", asyncDir: join(f.root, "async-drifted") };
  f.coordinator.internal.workspaceService.bindRun({ workspaceId: "drifted", run });
  const binding = { workspaceId: "drifted", leaseId: receipt.leaseId, ownerScope: { kind: "standalone-subagent", rootSessionId: "root-a" }, runId: run.runId };

  await writeFile(join(receipt.path, "src", "drifted.txt"), "drifted\n");
  git(receipt.path, "add", "src/drifted.txt");
  git(receipt.path, "commit", "-m", "drifted work");
  const committedHead = git(receipt.path, "rev-parse", "HEAD");
  const firstPrepare = f.coordinator.internal.prepareAutoIntegration(binding);
  assert.equal(firstPrepare.queueState, "queued");

  // 把 workspace HEAD 重置为 base（非旧授权头的后代——丢弃 child commit）。
  git(receipt.path, "reset", "--hard", f.baseCommit);
  f.coordinator.internal.prepareAutoIntegration(binding);
  const item = f.coordinator.internal.integrationQueue.getItem(firstPrepare.queueItem.queueItemId);
  assert.equal(item.authorizedWorkspaceHead, committedHead, "非后代 HEAD 不得刷新授权头");
  // admission 保持失败（fail closed，人工处置）。
  await assert.rejects(async () => f.coordinator.internal.awaitIntegrationAdmission(item.queueItemId, binding), /authorized clean committed HEAD|admission/i);
});
