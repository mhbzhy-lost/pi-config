import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createManagedWorkspaceRequestV2 } from "../packages/pi-subagents-enhanced/src/workspace/contract.ts";
import {
  applyManagedWorkspaceCleanup,
  inventoryManagedWorkspaces,
  planManagedWorkspaceCleanup,
} from "../packages/pi-subagents-enhanced/src/workspace/administration.ts";
import { createManagedWorkspaceService } from "../packages/pi-subagents-enhanced/src/workspace/service.ts";
import { createManagedWorkspaceLedger } from "../packages/pi-subagents-enhanced/src/workspace/ledger.ts";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sha64 = (value) => value.repeat(64);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "managed-service-"));
  const originRoot = join(root, "origin");
  const stateRoot = join(root, "state");
  await mkdir(join(originRoot, "src"), { recursive: true });
  git(originRoot, "init", "-b", "main");
  git(originRoot, "config", "user.email", "test@example.com");
  git(originRoot, "config", "user.name", "Test User");
  await writeFile(join(originRoot, "src", "base.txt"), "base\n");
  await writeFile(join(originRoot, "README.md"), "initial\n");
  git(originRoot, "add", ".");
  git(originRoot, "commit", "-m", "initial");
  const cleanup = () => {
    try {
      const entries = git(originRoot, "worktree", "list", "--porcelain").split("\n");
      for (const line of entries) {
        if (!line.startsWith("worktree ")) continue;
        const path = line.slice("worktree ".length);
        if (path !== originRoot) spawnSync("git", ["worktree", "remove", "--force", path], { cwd: originRoot, stdio: "ignore" });
      }
    } catch {}
    return rm(root, { recursive: true, force: true });
  };
  t.after(cleanup);
  return { root, originRoot, stateRoot, baseCommit: git(originRoot, "rev-parse", "HEAD") };
}

const CODING_POLICY = { publication: "allowed", application: "allowed", writePaths: ["src/**"] };
const FROZEN_POLICY = { publication: "forbidden", application: "forbidden", writePaths: [] };

function request(f, workspaceId = "workspace-1", overrides = {}) {
  const { policy = CODING_POLICY, owner = { kind: "standalone-subagent", rootSessionId: "root-1", toolCallId: `tool-${workspaceId}` }, ...rest } = overrides;
  return createManagedWorkspaceRequestV2({
    workspaceId,
    owner,
    originRoot: f.originRoot,
    requestedCwd: join(f.originRoot, "src"),
    originRef: "refs/heads/main",
    baseCommit: f.baseCommit,
    contractHash: sha64("a"),
    policy,
    ...rest,
  });
}

function observedProof(run, { rootSessionId = "root-1", seed = "e" } = {}) {
  return {
    state: "observed",
    conflict: false,
    runId: run.runId,
    rootSessionId,
    asyncDir: run.asyncDir,
    processInstance: `proc-${run.runId}`,
    proofId: sha64(seed),
  };
}

async function commitWorkspace(receipt, name, content = name) {
  await writeFile(join(receipt.path, "src", name), `${content}\n`);
  git(receipt.path, "add", ".");
  git(receipt.path, "commit", "-m", `add ${name}`);
}

test("v2 discard persists the settled terminal proof on the released record and receipt", async (t) => {
  // R12g 归因：v2Receipt 曾结构性缺 terminalProof，settlement 判定的 proof 证据
  // 在 released 后无 durable 投影；proof 应随 ledger 持久化（released 的证明链）。
  const f = await fixture(t);
  const service = createManagedWorkspaceService({ stateRoot: f.stateRoot });
  const active = service.ensureAllocated(request(f, "proof-persist-ws", { policy: { publication: "allowed", application: "allowed", writePaths: ["src/a.txt"] } }));
  await commitWorkspace(active, "proof.txt");
  const run = { runId: "run-pp", asyncDir: "/tmp/pp" };
  service.bindRun({ workspaceId: active.workspaceId, run });
  const proof = { state: "observed", conflict: false, runId: run.runId, rootSessionId: "root-1", asyncDir: run.asyncDir, processInstance: "pp-1", proofId: "7".repeat(64) };
  const issued = service.issueDisposition({ workspaceId: active.workspaceId, terminalProof: proof });
  const discarded = service.dispose({ workspaceId: active.workspaceId, terminalProof: proof, disposition: "discard", reason: "settled", actionToken: issued.actionToken });
  assert.equal(discarded.state, "released");
  assert.equal(discarded.terminalProof?.state, "observed");
  assert.equal(discarded.terminalProof?.conflict, false);
  assert.equal(discarded.terminalProof?.proofId, "7".repeat(64));
  const reloaded = createManagedWorkspaceLedger({ stateRoot: f.stateRoot }).load(active.workspaceId).record;
  assert.equal(reloaded.terminalProof?.proofId, "7".repeat(64), "durable record carries the settled proof");
});

test("discard succeeds with tracked .pi/agents project config and only runtime metadata under .pi/subagents is cleaned", async (t) => {
  // R11 实战归因：fixture 在 base commit 提交了 .pi/agents/executor.md（正当项目配置），
  // 但 RUNTIME_METADATA_ROOTS 曾把整个 .pi 当可删运行时元数据——tracked 检查拒绝 discard，
  // workspace 卡 cleanup-debt。运行时产物真正的根是 .pi/subagents；.pi/agents 等
  // tracked 配置不得阻塞清理。
  const f = await fixture(t);
  await mkdir(join(f.originRoot, ".pi", "agents"), { recursive: true });
  await writeFile(join(f.originRoot, ".pi", "agents", "executor.md"), "---\nname: executor\n---\n");
  git(f.originRoot, "add", ".pi");
  git(f.originRoot, "commit", "-m", "track agent config");
  const baseCommit = git(f.originRoot, "rev-parse", "HEAD");
  const service = createManagedWorkspaceService({ stateRoot: f.stateRoot });
  const active = service.ensureAllocated(request(f, "pi-config-ws", { baseCommit }));
  await commitWorkspace(active, "change.txt");
  await mkdir(join(active.path, ".pi", "subagents", "artifacts"), { recursive: true });
  await writeFile(join(active.path, ".pi", "subagents", "artifacts", "meta.json"), "{}\n");
  const run = { runId: "run-pi-config", asyncDir: join(f.root, "async-pi-config") };
  service.bindRun({ workspaceId: active.workspaceId, run });
  const proof = observedProof(run);
  const issued = service.issueDisposition({ workspaceId: active.workspaceId, terminalProof: proof });
  const discarded = service.dispose({ workspaceId: active.workspaceId, terminalProof: proof, disposition: "discard", reason: "test", actionToken: issued.actionToken });
  assert.equal(discarded.state, "released");
  assert.equal(await lstat(active.path).catch(() => null), null, "worktree removed after discard");
});

async function reserveWithStaleOrigin(f, service, workspaceId, owner, { policy = CODING_POLICY } = {}) {
  const originRoot = join(f.root, `${workspaceId}-stale-origin`);
  await mkdir(join(originRoot, "src"), { recursive: true });
  git(originRoot, "init", "-b", "main");
  git(originRoot, "config", "user.email", "test@example.com");
  git(originRoot, "config", "user.name", "Test User");
  await writeFile(join(originRoot, "src", "base.txt"), "base\n");
  git(originRoot, "add", ".");
  git(originRoot, "commit", "-m", "initial");
  service.reserve(request(f, workspaceId, {
    owner,
    originRoot,
    requestedCwd: join(originRoot, "src"),
    baseCommit: git(originRoot, "rev-parse", "HEAD"),
    policy,
  }));
  await rm(originRoot, { recursive: true, force: true });
}

test("all owner kinds reserve, allocate, and bind through one service state machine", async (t) => {
  const f = await fixture(t);
  const service = createManagedWorkspaceService({ stateRoot: f.stateRoot });
  const inputs = [
    request(f, "standalone"),
    request(f, "goal", { owner: { kind: "goal-task", rootSessionId: "root-1", goalId: "goal-1", taskId: "task-1", attempt: 1, executionRevision: 1 } }),
    request(f, "validation", { owner: { kind: "goal-validation", rootSessionId: "root-1", goalId: "goal-1", validationId: "validation-1", executionRevision: 1 }, policy: FROZEN_POLICY }),
  ];

  for (const [index, input] of inputs.entries()) {
    const reserved = service.reserve(input);
    assert.equal(reserved.state, "reserved");
    const active = service.ensureAllocated(input);
    assert.equal(active.state, "active");
    assert.equal(active.owner.kind, input.owner.kind);
    assert.equal(active.dispatchCwd, join(active.path, "src"));
    assert.equal(Object.hasOwn(active, "ownerToken"), false);
    assert.equal(service.ensureAllocated(input).leaseId, active.leaseId);
    const bound = service.bindRun({ workspaceId: input.workspaceId, run: { runId: `run-${index}`, asyncDir: join(f.root, `async-${index}`) } });
    assert.deepEqual(bound.run, { runId: `run-${index}`, asyncDir: join(f.root, `async-${index}`) });
    assert.deepEqual(service.bindRun({ workspaceId: input.workspaceId, run: bound.run }).run, bound.run);
    assert.throws(() => service.bindRun({ workspaceId: input.workspaceId, run: { ...bound.run, runId: "replacement" } }), /conflict|bound/i);
  }

  assert.equal(inventoryManagedWorkspaces({ stateRoot: f.stateRoot }).workspaces.length, 3);
});

test("allocates from base commit while preserving dirty origin for integration gating", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.originRoot, "src", "pre-existing.txt"), "leave me dirty\n");
  const input = request(f, "dirty-origin");
  const service = createManagedWorkspaceService({ stateRoot: f.stateRoot });

  const receipt = service.ensureAllocated(input);
  assert.equal(receipt.state, "active");
  assert.equal(git(receipt.path, "rev-parse", "HEAD"), f.baseCommit);
  assert.equal(await readFile(join(f.originRoot, "src", "pre-existing.txt"), "utf8"), "leave me dirty\n");

  const run = { runId: "dirty-origin-run", asyncDir: join(f.root, "dirty-origin-async") };
  service.bindRun({ workspaceId: input.workspaceId, run });
  const status = service.status({ workspaceId: input.workspaceId, terminalProof: observedProof(run) });
  assert.equal(status.inspection.originClean, false);
  assert.equal(status.blockedReasons.includes("origin-dirty"), true);
  assert.equal(status.allowedDispositions.includes("integrate"), false);
});

test("allocation recovers after worktree creation without a durable active transition", async (t) => {
  const f = await fixture(t);
  let injected = false;
  const crashing = createManagedWorkspaceService({
    stateRoot: f.stateRoot,
    fault(event) {
      if (!injected && event.operation === "allocate" && event.phase === "after-git") {
        injected = true;
        throw Object.assign(new Error("crash after git"), { code: "TEST_FAULT" });
      }
    },
  });
  const input = request(f, "recover-allocation");
  assert.throws(() => crashing.ensureAllocated(input), /crash after git/);

  const recovered = createManagedWorkspaceService({ stateRoot: f.stateRoot }).ensureAllocated(input);
  assert.equal(recovered.state, "active");
  assert.equal(git(recovered.path, "rev-parse", "HEAD"), f.baseCommit);
  assert.equal(git(f.originRoot, "worktree", "list", "--porcelain").match(/worktree /g).length, 2);
});

test("hostile legacy runtime trees are neither consumed nor modified", async (t) => {
  const f = await fixture(t);
  const legacyFiles = [
    join(f.originRoot, ".pi-subagents", "executor.mjs"),
    join(f.originRoot, ".state", "subagent-dispatch", "record.json"),
    join(f.originRoot, ".state", "worktree-lifecycle", "lease.json"),
  ];
  for (const [index, file] of legacyFiles.entries()) {
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, `hostile-${index}\n`);
  }
  const before = await Promise.all(legacyFiles.map(async (file) => ({
    file,
    bytes: await readFile(file),
    info: await stat(file),
    parent: await lstat(join(file, "..")),
  })));
  for (const file of legacyFiles) await chmod(join(file, ".."), 0o000);

  const input = request(f, "hostile-legacy");
  const receipt = createManagedWorkspaceService({ stateRoot: f.stateRoot }).ensureAllocated(input);
  assert.equal(receipt.state, "active");

  for (const item of before) await chmod(join(item.file, ".."), item.parent.mode & 0o777);
  for (const item of before) {
    const after = await stat(item.file);
    assert.deepEqual(await readFile(item.file), item.bytes);
    assert.equal(after.ino, item.info.ino);
    assert.equal(after.mode, item.info.mode);
    assert.equal(after.mtimeMs, item.info.mtimeMs);
  }
});

test("unbound allocation orphans clean up through preserve and release without a terminal proof", async (t) => {
  // v1 语义（unbound 直接 discard）已随 v1 全删收束：V2 下 discard 需要与 run
  // 绑定的 observed proof，unbound 孤儿工作区的无证明清理路径是 preserve→release。
  const f = await fixture(t);
  const service = createManagedWorkspaceService({ stateRoot: f.stateRoot });
  const active = service.ensureAllocated(request(f, "allocation-orphan"));

  assert.equal(active.run, null, "durable allocation exists before Goal append/run binding");
  const beforePreserve = service.status({ workspaceId: active.workspaceId });
  assert.deepEqual(beforePreserve.receipt.owner, active.owner);
  assert.equal(beforePreserve.receipt.leaseId, active.leaseId);
  assert.deepEqual(beforePreserve.terminalProof, { state: "pending" });
  assert.deepEqual(beforePreserve.allowedDispositions, ["preserve", "release"]);
  assert.equal(beforePreserve.allowedDispositions.includes("discard"), false);
  const issued = service.issueDisposition({ workspaceId: active.workspaceId, terminalProof: { state: "pending" } });
  assert.equal(issued.actionToken.startsWith("managed-workspace-action.v1:"), true);
  const preserved = service.dispose({ workspaceId: active.workspaceId, terminalProof: { state: "pending" }, disposition: "preserve", reason: "orphan inspection", actionToken: issued.actionToken });
  assert.equal(preserved.state, "preserved");
  assert.equal(service.release({ workspaceId: active.workspaceId }).state, "released");
  assert.equal(await lstat(active.path).catch(() => null), null);
});

test("terminal proof and action token gate discard for bound runs, and replay is rejected", async (t) => {
  const f = await fixture(t);
  const service = createManagedWorkspaceService({ stateRoot: f.stateRoot });
  const active = service.ensureAllocated(request(f, "discard"));
  const run = { runId: "bound-discard", asyncDir: join(f.root, "bound-discard") };
  service.bindRun({ workspaceId: active.workspaceId, run });

  const pending = service.issueDisposition({ workspaceId: active.workspaceId, terminalProof: { state: "pending" } });
  assert.deepEqual(pending.allowedDispositions, ["preserve", "release"]);
  assert.throws(() => service.dispose({ workspaceId: active.workspaceId, terminalProof: { state: "pending" }, disposition: "discard", actionToken: pending.actionToken }), /terminal|allowed/i);

  const proof = observedProof(run);
  const issued = service.issueDisposition({ workspaceId: active.workspaceId, terminalProof: proof });
  assert.ok(issued.allowedDispositions.includes("discard"));
  const released = service.dispose({ workspaceId: active.workspaceId, terminalProof: proof, disposition: "discard", actionToken: issued.actionToken });
  assert.equal(released.state, "released");
  assert.equal(await lstat(active.path).catch(() => null), null);
  assert.throws(() => service.dispose({ workspaceId: active.workspaceId, terminalProof: proof, disposition: "discard", actionToken: issued.actionToken }), /state|replay|token/i);
});

test("runtime metadata does not dirty or block release of a managed workspace", async (t) => {
  const f = await fixture(t);
  const service = createManagedWorkspaceService({ stateRoot: f.stateRoot });
  const active = service.ensureAllocated(request(f, "runtime-metadata"));
  await mkdir(join(active.path, ".pi", "subagents"), { recursive: true });
  await writeFile(join(active.path, ".pi", "subagents", "runtime.json"), "{}\n");
  const run = { runId: "runtime-metadata-run", asyncDir: join(f.root, "runtime-metadata-async") };
  service.bindRun({ workspaceId: active.workspaceId, run });
  const proof = observedProof(run, { seed: "a" });

  const status = service.status({ workspaceId: active.workspaceId, terminalProof: proof });
  assert.equal(status.inspection.clean, true);
  assert.equal(status.blockedReasons.includes("workspace-dirty"), false);
  assert.equal(status.allowedDispositions.includes("discard"), true);

  const issued = service.issueDisposition({ workspaceId: active.workspaceId, terminalProof: proof });
  const released = service.dispose({
    workspaceId: active.workspaceId,
    terminalProof: proof,
    disposition: "discard",
    actionToken: issued.actionToken,
  });
  assert.equal(released.state, "released");
  assert.equal(await lstat(active.path).catch(() => null), null);
});

test("ordinary untracked files still block destructive workspace disposition and fail closed as cleanup debt", async (t) => {
  const f = await fixture(t);
  const service = createManagedWorkspaceService({ stateRoot: f.stateRoot });
  const active = service.ensureAllocated(request(f, "ordinary-dirty"));
  await writeFile(join(active.path, "unexpected.txt"), "keep\n");
  const run = { runId: "ordinary-dirty-run", asyncDir: join(f.root, "ordinary-dirty-async") };
  service.bindRun({ workspaceId: active.workspaceId, run });
  const proof = observedProof(run, { seed: "b" });

  const status = service.status({ workspaceId: active.workspaceId, terminalProof: proof });
  assert.equal(status.inspection.clean, false);
  assert.equal(status.blockedReasons.includes("workspace-dirty"), true);

  const issued = service.issueDisposition({ workspaceId: active.workspaceId, terminalProof: proof });
  assert.throws(
    () => service.dispose({ workspaceId: active.workspaceId, terminalProof: proof, disposition: "discard", actionToken: issued.actionToken }),
    /worktree|git/i,
    "a dirty workspace must never be silently destroyed by discard",
  );
  assert.ok(await lstat(active.path), "the untracked file and its workspace survive a failed discard");
  const record = createManagedWorkspaceLedger({ stateRoot: f.stateRoot }).load(active.workspaceId).record;
  assert.equal(record.state, "cleanup-debt", "destructive discard failure must surface as cleanup debt");
});

test("root-side integrate is child-owned and queue admission enforces writePaths on renames", async (t) => {
  // v1 语义（root 直接 cherry-pick integrate）已随 v1 全删收束：publication=allowed 的
  // 集成归 child 队列，root 只能 CHILD_OWNS_INTEGRATION fail closed；writePaths 的
  // rename 源/目的地约束在队列 admission（integrationAdmissionFacts）执行。
  const f = await fixture(t);
  const service = createManagedWorkspaceService({ stateRoot: f.stateRoot });
  const active = service.ensureAllocated(request(f, "integrate"));
  const run = { runId: "bound-integrate", asyncDir: join(f.root, "bound-integrate") };
  service.bindRun({ workspaceId: active.workspaceId, run });
  await commitWorkspace(active, "executor.txt", "executor");

  await writeFile(join(f.originRoot, "README.md"), "origin forward\n");
  git(f.originRoot, "add", "README.md");
  git(f.originRoot, "commit", "-m", "origin forward");

  const proof = observedProof(run);
  const status = service.status({ workspaceId: active.workspaceId, terminalProof: proof });
  assert.equal(status.allowedDispositions.includes("integrate"), false, "v2 dispositions never include root-side integrate");
  const issued = service.issueDisposition({ workspaceId: active.workspaceId, terminalProof: proof });
  assert.throws(
    () => service.dispose({ workspaceId: active.workspaceId, terminalProof: proof, disposition: "integrate", strategy: "cherry-pick", actionToken: issued.actionToken }),
    (error) => error?.code === "CHILD_OWNS_INTEGRATION",
  );

  const binding = { workspaceId: active.workspaceId, leaseId: active.leaseId, runId: run.runId, ownerScope: { kind: "standalone-subagent", rootSessionId: "root-1" } };
  const head = git(active.path, "rev-parse", "HEAD");
  const facts = service.integrationAdmissionFacts({ workspaceId: active.workspaceId, leaseId: active.leaseId, targetRef: "refs/heads/main", authorizedWorkspaceHead: head }, binding);
  assert.equal(typeof facts.targetHead, "string");

  const narrow = service.ensureAllocated(request(f, "rename", {
    baseCommit: git(f.originRoot, "rev-parse", "HEAD"),
    policy: { publication: "allowed", application: "allowed", writePaths: ["src/base.txt"] },
  }));
  const narrowRun = { runId: "bound-rename", asyncDir: join(f.root, "bound-rename") };
  service.bindRun({ workspaceId: narrow.workspaceId, run: narrowRun });
  git(narrow.path, "mv", "src/base.txt", "outside.txt");
  git(narrow.path, "commit", "-m", "move outside scope");
  const narrowBinding = { workspaceId: narrow.workspaceId, leaseId: narrow.leaseId, runId: narrowRun.runId, ownerScope: { kind: "standalone-subagent", rootSessionId: "root-1" } };
  const narrowHead = git(narrow.path, "rev-parse", "HEAD");
  assert.throws(
    () => service.integrationAdmissionFacts({ workspaceId: narrow.workspaceId, leaseId: narrow.leaseId, targetRef: "refs/heads/main", authorizedWorkspaceHead: narrowHead }, narrowBinding),
    (error) => error?.code === "MANAGED_WORKSPACE_WRITE_PATHS",
    "queue admission must reject a rename whose destination escapes policy.writePaths",
  );
});

test("preserved workspaces require explicit release and Git identity drift fails closed", async (t) => {
  const f = await fixture(t);
  const service = createManagedWorkspaceService({ stateRoot: f.stateRoot });
  const active = service.ensureAllocated(request(f, "preserve"));
  const issued = service.issueDisposition({ workspaceId: active.workspaceId, terminalProof: { state: "pending" } });
  const preserved = service.dispose({ workspaceId: active.workspaceId, terminalProof: { state: "pending" }, disposition: "preserve", reason: "awaiting review", actionToken: issued.actionToken });
  assert.equal(preserved.state, "preserved");
  assert.ok(await lstat(preserved.path));
  assert.equal(service.release({ workspaceId: active.workspaceId }).state, "released");
  assert.equal(await lstat(preserved.path).catch(() => null), null);

  const drifted = service.ensureAllocated(request(f, "drift", { baseCommit: git(f.originRoot, "rev-parse", "HEAD") }));
  git(drifted.path, "checkout", "--detach");
  assert.throws(
    () => service.status({ workspaceId: drifted.workspaceId, terminalProof: { state: "pending" } }),
    (error) => error?.code === "MANAGED_WORKSPACE_IDENTITY",
  );
});

test("expectedHead CAS rejects a stale disposition before its durable intent or Git side effects", async (t) => {
  const f = await fixture(t);
  const service = createManagedWorkspaceService({ stateRoot: f.stateRoot });
  const active = service.ensureAllocated(request(f, "expected-head"));
  const run = { runId: "expected-head-run", asyncDir: join(f.root, "expected-head-run") };
  service.bindRun({ workspaceId: active.workspaceId, run });
  await commitWorkspace(active, "expected-head.ts");
  const head = git(active.path, "rev-parse", "HEAD");
  const proof = observedProof(run);
  const issued = service.issueDisposition({ workspaceId: active.workspaceId, terminalProof: proof, expectedHead: head });
  await commitWorkspace(active, "expected-head-drift.ts");
  assert.throws(
    () => service.dispose({ workspaceId: active.workspaceId, terminalProof: proof, expectedHead: head, disposition: "discard", actionToken: issued.actionToken }),
    (error) => error?.code === "MANAGED_WORKSPACE_EXPECTED_HEAD",
  );
  assert.equal(service.status({ workspaceId: active.workspaceId, terminalProof: proof }).receipt.state, "active");
  assert.ok(await lstat(active.path));
});

test("reconcile resumes an authorized disposition without replaying its action token", async (t) => {
  const f = await fixture(t);
  let injected = false;
  const service = createManagedWorkspaceService({
    stateRoot: f.stateRoot,
    fault(event) {
      if (!injected && event.operation === "dispose" && event.phase === "after-intent") {
        injected = true;
        throw Object.assign(new Error("crash after intent"), { code: "TEST_FAULT" });
      }
    },
  });
  const active = service.ensureAllocated(request(f, "reconcile"));
  const run = { runId: "run-reconcile", asyncDir: join(f.root, "async-reconcile") };
  service.bindRun({ workspaceId: active.workspaceId, run });
  const proof = observedProof(run);
  const issued = service.issueDisposition({ workspaceId: active.workspaceId, terminalProof: proof });
  assert.throws(() => service.dispose({ workspaceId: active.workspaceId, terminalProof: proof, disposition: "discard", actionToken: issued.actionToken }), /crash after intent/);

  const recovered = createManagedWorkspaceService({ stateRoot: f.stateRoot }).reconcile({ originRoot: f.originRoot });
  assert.equal(recovered.find((entry) => entry.workspaceId === active.workspaceId).state, "released");
});

test("owner scope gates listOwned and every scoped operation before inspection or mutation", async (t) => {
  const f = await fixture(t);
  const service = createManagedWorkspaceService({ stateRoot: f.stateRoot });
  const ledger = createManagedWorkspaceLedger({ stateRoot: f.stateRoot });
  const own = { kind: "standalone-subagent", rootSessionId: "session-a" };
  const foreign = { kind: "standalone-subagent", rootSessionId: "session-b" };
  const ownA = service.ensureAllocated(request(f, "workspace-a", { owner: { kind: "standalone-subagent", rootSessionId: "session-a", toolCallId: "tool-a" } }));
  const ownZ = service.ensureAllocated(request(f, "workspace-z", { owner: { kind: "standalone-subagent", rootSessionId: "session-a", toolCallId: "tool-z" } }));
  const foreignReceipt = service.ensureAllocated(request(f, "workspace-b", { owner: { kind: "standalone-subagent", rootSessionId: "session-b", toolCallId: "tool-b" } }));
  const goal = service.ensureAllocated(request(f, "goal-workspace", { owner: { kind: "goal-task", rootSessionId: "session-a", goalId: "goal-a", taskId: "task-a", attempt: 1, executionRevision: 1 } }));
  const validation = service.ensureAllocated(request(f, "validation-workspace", { owner: { kind: "goal-validation", rootSessionId: "session-a", goalId: "goal-a", validationId: "validation-a", executionRevision: 1 }, policy: FROZEN_POLICY }));
  service.bindRun({ workspaceId: ownA.workspaceId, run: { runId: "run-a", asyncDir: join(f.root, "run-a") } });
  service.bindRun({ workspaceId: foreignReceipt.workspaceId, run: { runId: "run-b", asyncDir: join(f.root, "run-b") } });

  assert.deepEqual(service.listOwned({ ownerScope: own }).map(({ workspaceId }) => workspaceId), ["workspace-a", "workspace-z"]);
  assert.deepEqual(service.listOwned({ ownerScope: own, runId: "run-a" }).map(({ workspaceId }) => workspaceId), ["workspace-a"]);
  assert.deepEqual(service.listOwned({ ownerScope: own, runId: "run-b" }), []);
  assert.throws(() => service.listOwned({ ownerScope: { ...own, extra: true } }), (error) => error?.code === "MANAGED_WORKSPACE_OWNER_SCOPE");

  const before = Object.fromEntries([foreignReceipt, goal, validation].map(({ workspaceId }) => [workspaceId, structuredClone(ledger.load(workspaceId).record)]));
  const originHead = git(f.originRoot, "rev-parse", "HEAD");
  const terminalProof = observedProof({ runId: "run-a", asyncDir: join(f.root, "run-a") }, { rootSessionId: "session-a" });
  assert.throws(() => service.statusOwned({ workspaceId: foreignReceipt.workspaceId, ownerScope: own, terminalProof }), (error) => error?.code === "MANAGED_WORKSPACE_OWNER_SCOPE");
  assert.throws(() => service.issueOwnedDisposition({ workspaceId: goal.workspaceId, ownerScope: own, terminalProof }), (error) => error?.code === "MANAGED_WORKSPACE_OWNER_SCOPE");
  assert.throws(() => service.releaseOwned({ workspaceId: validation.workspaceId, ownerScope: own }), (error) => error?.code === "MANAGED_WORKSPACE_OWNER_SCOPE");
  assert.throws(() => service.statusOwned({ workspaceId: "unknown-workspace", ownerScope: own }), (error) => error?.code === "MANAGED_WORKSPACE_NOT_FOUND");
  assert.equal(git(f.originRoot, "rev-parse", "HEAD"), originHead);
  for (const [workspaceId, record] of Object.entries(before)) assert.deepEqual(ledger.load(workspaceId).record, record, `${workspaceId} must remain unchanged`);

  const issued = service.issueOwnedDisposition({ workspaceId: ownA.workspaceId, ownerScope: own, terminalProof });
  const ownBeforeForeignToken = structuredClone(ledger.load(ownA.workspaceId).record);
  assert.throws(() => service.disposeOwned({ workspaceId: ownA.workspaceId, ownerScope: foreign, terminalProof, disposition: "preserve", reason: "foreign", actionToken: issued.actionToken }), (error) => error?.code === "MANAGED_WORKSPACE_OWNER_SCOPE");
  assert.deepEqual(ledger.load(ownA.workspaceId).record, ownBeforeForeignToken, "cross-session token rejection must precede pending intent");
  const preserved = service.disposeOwned({ workspaceId: ownA.workspaceId, ownerScope: own, terminalProof, disposition: "preserve", reason: "same session", actionToken: issued.actionToken });
  assert.equal(preserved.state, "preserved");
  assert.equal(service.releaseOwned({ workspaceId: ownA.workspaceId, ownerScope: own }).state, "released");
  assert.equal(service.statusOwned({ workspaceId: ownZ.workspaceId, ownerScope: own }).receipt.state, "active");
});

test("listOwned skips foreign goal and validation records whose origins are stale", async (t) => {
  const f = await fixture(t);
  const service = createManagedWorkspaceService({ stateRoot: f.stateRoot });
  const own = { kind: "standalone-subagent", rootSessionId: "session-a" };
  service.reserve(request(f, "current-live", { owner: { ...own, toolCallId: "tool-current" } }));
  await reserveWithStaleOrigin(f, service, "foreign-goal-stale", {
    kind: "goal-task", rootSessionId: "session-a", goalId: "goal-a", taskId: "task-a", attempt: 1, executionRevision: 1,
  });
  await reserveWithStaleOrigin(f, service, "foreign-validation-stale", {
    kind: "goal-validation", rootSessionId: "session-a", goalId: "goal-a", validationId: "validation-a", executionRevision: 1,
  }, { policy: FROZEN_POLICY });

  assert.deepEqual(service.listOwned({ ownerScope: own }).map(({ workspaceId }) => workspaceId), ["current-live"]);
});

test("listOwned skips a foreign standalone record whose origin is stale", async (t) => {
  const f = await fixture(t);
  const service = createManagedWorkspaceService({ stateRoot: f.stateRoot });
  const own = { kind: "standalone-subagent", rootSessionId: "session-a" };
  service.reserve(request(f, "current-live", { owner: { ...own, toolCallId: "tool-current" } }));
  await reserveWithStaleOrigin(f, service, "foreign-standalone-stale", {
    kind: "standalone-subagent", rootSessionId: "session-b", toolCallId: "tool-foreign",
  });

  assert.deepEqual(service.listOwned({ ownerScope: own }).map(({ workspaceId }) => workspaceId), ["current-live"]);
});

test("listOwned fails closed when the current standalone record has a stale origin", async (t) => {
  const f = await fixture(t);
  const service = createManagedWorkspaceService({ stateRoot: f.stateRoot });
  const own = { kind: "standalone-subagent", rootSessionId: "session-a" };
  await reserveWithStaleOrigin(f, service, "current-standalone-stale", {
    kind: "standalone-subagent", rootSessionId: "session-a", toolCallId: "tool-current",
  });

  assert.throws(() => service.listOwned({ ownerScope: own }), (error) => error?.code === "MANAGED_WORKSPACE_ORIGIN");
});

test("administration cleanup is dry-run until an exact public lease is authorized", async (t) => {
  const f = await fixture(t);
  const service = createManagedWorkspaceService({ stateRoot: f.stateRoot });
  const active = service.ensureAllocated(request(f, "admin-preserved"));
  const issued = service.issueDisposition({ workspaceId: active.workspaceId, terminalProof: { state: "pending" } });
  const preserved = service.dispose({
    workspaceId: active.workspaceId,
    terminalProof: { state: "pending" },
    disposition: "preserve",
    reason: "manual inspection",
    actionToken: issued.actionToken,
  });

  const plan = planManagedWorkspaceCleanup({ stateRoot: f.stateRoot, originRoot: f.originRoot });
  assert.deepEqual(plan.actions, [{ workspaceId: preserved.workspaceId, leaseId: preserved.leaseId, action: "release" }]);
  assert.ok(await lstat(preserved.path), "planning must not release the worktree");
  assert.throws(() => applyManagedWorkspaceCleanup({ stateRoot: f.stateRoot, plan, authorizations: [] }), /authorized/i);
  assert.throws(() => applyManagedWorkspaceCleanup({
    stateRoot: f.stateRoot,
    plan,
    authorizations: [{ workspaceId: preserved.workspaceId, leaseId: "0".repeat(64) }],
  }), /authorized/i);

  const applied = applyManagedWorkspaceCleanup({
    stateRoot: f.stateRoot,
    plan,
    authorizations: [{ workspaceId: preserved.workspaceId, leaseId: preserved.leaseId }],
  });
  assert.equal(applied[0].state, "released");
  assert.equal(await lstat(preserved.path).catch(() => null), null);
  assert.throws(() => applyManagedWorkspaceCleanup({ stateRoot: f.stateRoot, plan, authorizations: [] }), /stale|changed/i);
});

test("administration recovers identity-valid cleanup debt with exact lease authorization", async (t) => {
  const f = await fixture(t);
  const service = createManagedWorkspaceService({ stateRoot: f.stateRoot });
  await reserveWithStaleOrigin(f, service, "unrelated-stale-cleanup", {
    kind: "standalone-subagent",
    rootSessionId: "other-session",
    toolCallId: "other-tool",
  });
  const active = service.ensureAllocated(request(f, "admin-cleanup-debt"));
  await mkdir(join(active.path, ".pi", "subagents"), { recursive: true });
  await writeFile(join(active.path, ".pi", "subagents", "runtime.json"), "{}\n");
  const ledger = createManagedWorkspaceLedger({ stateRoot: f.stateRoot });
  ledger.mutate(active.workspaceId, (record) => {
    record.state = "cleanup-debt";
    record.cleanupDebt = {
      phase: "release",
      code: "MANAGED_WORKSPACE_GIT",
      message: "prior release failed",
    };
    return record;
  }, { leaseId: active.leaseId });

  const plan = planManagedWorkspaceCleanup({ stateRoot: f.stateRoot, originRoot: f.originRoot });
  assert.deepEqual(plan.actions, [{ workspaceId: active.workspaceId, leaseId: active.leaseId, action: "release" }]);
  assert.throws(() => applyManagedWorkspaceCleanup({ stateRoot: f.stateRoot, plan, authorizations: [] }), /authorized/i);

  const applied = applyManagedWorkspaceCleanup({
    stateRoot: f.stateRoot,
    plan,
    authorizations: [{ workspaceId: active.workspaceId, leaseId: active.leaseId }],
  });
  assert.equal(applied[0].state, "released");
  assert.equal(await lstat(active.path).catch(() => null), null);
});
