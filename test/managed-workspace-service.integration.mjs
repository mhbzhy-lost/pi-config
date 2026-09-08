import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createManagedWorkspaceRequest } from "../packages/pi-subagents-enhanced/src/workspace/contract.ts";
import {
  applyManagedWorkspaceCleanup,
  inventoryManagedWorkspaces,
  planManagedWorkspaceCleanup,
} from "../packages/pi-subagents-enhanced/src/workspace/administration.ts";
import { createManagedWorkspaceService } from "../packages/pi-subagents-enhanced/src/workspace/service.ts";
import { createManagedWorkspaceLedger } from "../packages/pi-subagents-enhanced/src/workspace/ledger.ts";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sha64 = (value) => value.repeat(64);
const observed = (value = "e") => ({ state: "observed", conflict: false, proofHash: sha64(value) });

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

function request(f, workspaceId = "workspace-1", overrides = {}) {
  return createManagedWorkspaceRequest({
    workspaceId,
    owner: { kind: "standalone-subagent", rootSessionId: "root-1", toolCallId: `tool-${workspaceId}` },
    originRoot: f.originRoot,
    requestedCwd: join(f.originRoot, "src"),
    originRef: "refs/heads/main",
    baseCommit: f.baseCommit,
    contractHash: sha64("a"),
    mode: "coding",
    writePaths: ["src/**"],
    ...overrides,
  });
}

async function commitWorkspace(receipt, name, content = name) {
  await writeFile(join(receipt.path, "src", name), `${content}\n`);
  git(receipt.path, "add", ".");
  git(receipt.path, "commit", "-m", `add ${name}`);
}

async function reserveWithStaleOrigin(f, service, workspaceId, owner, { mode = "coding", writePaths = ["src/**"] } = {}) {
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
    mode,
    writePaths,
  }));
  await rm(originRoot, { recursive: true, force: true });
}

test("all owner kinds reserve, allocate, and bind through one service state machine", async (t) => {
  const f = await fixture(t);
  const service = createManagedWorkspaceService({ stateRoot: f.stateRoot });
  const inputs = [
    request(f, "standalone"),
    request(f, "goal", { owner: { kind: "goal-task", rootSessionId: "root-1", goalId: "goal-1", taskId: "task-1", attempt: 1, executionRevision: 1 } }),
    request(f, "validation", { owner: { kind: "goal-validation", rootSessionId: "root-1", goalId: "goal-1", validationId: "validation-1", executionRevision: 1 }, mode: "validation", writePaths: [] }),
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

test("unbound allocation orphan disposes without terminal proof but retains service identity gates", async (t) => {
  const f = await fixture(t);
  const service = createManagedWorkspaceService({ stateRoot: f.stateRoot });
  const active = service.ensureAllocated(request(f, "allocation-orphan-discard"));

  assert.equal(active.run, null, "durable allocation exists before Goal append/run binding");
  const beforeDiscard = service.status({ workspaceId: active.workspaceId });
  assert.deepEqual(beforeDiscard.receipt.owner, active.owner);
  assert.equal(beforeDiscard.receipt.leaseId, active.leaseId);
  const discard = service.issueDisposition({ workspaceId: active.workspaceId });
  assert.equal(discard.actionToken.startsWith("managed-workspace-action.v1:"), true);
  const released = service.dispose({ workspaceId: active.workspaceId, disposition: "discard", actionToken: discard.actionToken });
  assert.equal(released.state, "released");
  assert.equal(await lstat(active.path).catch(() => null), null);

  const preservedActive = service.ensureAllocated(request(f, "allocation-orphan-preserve"));
  const status = service.status({ workspaceId: preservedActive.workspaceId });
  assert.equal(status.terminalProof, null);
  assert.deepEqual(status.allowedDispositions, ["discard", "preserve"]);
  assert.equal(status.allowedDispositions.includes("integrate"), false);
  const issued = service.issueDisposition({ workspaceId: preservedActive.workspaceId });
  assert.throws(() => service.dispose({ workspaceId: preservedActive.workspaceId, disposition: "integrate", strategy: "cherry-pick", actionToken: issued.actionToken }), /terminal|allowed/i);
  const preserved = service.dispose({ workspaceId: preservedActive.workspaceId, disposition: "preserve", reason: "orphan inspection", actionToken: issued.actionToken });
  assert.equal(preserved.state, "preserved");
  assert.equal(service.release({ workspaceId: preservedActive.workspaceId }).state, "released");
});

test("terminal proof and action token gate discard for bound runs, and replay is rejected", async (t) => {
  const f = await fixture(t);
  const service = createManagedWorkspaceService({ stateRoot: f.stateRoot });
  const active = service.ensureAllocated(request(f, "discard"));
  service.bindRun({ workspaceId: active.workspaceId, run: { runId: "bound-discard", asyncDir: join(f.root, "bound-discard") } });

  const pending = service.issueDisposition({ workspaceId: active.workspaceId, terminalProof: { state: "pending" } });
  assert.deepEqual(pending.allowedDispositions, ["preserve"]);
  assert.throws(() => service.dispose({ workspaceId: active.workspaceId, terminalProof: { state: "pending" }, disposition: "discard", actionToken: pending.actionToken }), /terminal|allowed/i);

  const issued = service.issueDisposition({ workspaceId: active.workspaceId, terminalProof: observed() });
  assert.ok(issued.allowedDispositions.includes("discard"));
  const released = service.dispose({ workspaceId: active.workspaceId, terminalProof: observed(), disposition: "discard", actionToken: issued.actionToken });
  assert.equal(released.state, "released");
  assert.equal(await lstat(active.path).catch(() => null), null);
  assert.throws(() => service.dispose({ workspaceId: active.workspaceId, terminalProof: observed(), disposition: "discard", actionToken: issued.actionToken }), /state|replay|token/i);
});

test("integration accepts a clean forward origin and enforces rename source and destination writePaths", async (t) => {
  const f = await fixture(t);
  const service = createManagedWorkspaceService({ stateRoot: f.stateRoot });
  const active = service.ensureAllocated(request(f, "integrate"));
  service.bindRun({ workspaceId: active.workspaceId, run: { runId: "bound-integrate", asyncDir: join(f.root, "bound-integrate") } });
  await commitWorkspace(active, "executor.txt", "executor");

  await writeFile(join(f.originRoot, "README.md"), "origin forward\n");
  git(f.originRoot, "add", "README.md");
  git(f.originRoot, "commit", "-m", "origin forward");

  const status = service.status({ workspaceId: active.workspaceId, terminalProof: observed() });
  assert.ok(status.allowedDispositions.includes("integrate"), status.blockedReasons.join(","));
  const issued = service.issueDisposition({ workspaceId: active.workspaceId, terminalProof: observed() });
  const released = service.dispose({ workspaceId: active.workspaceId, terminalProof: observed(), disposition: "integrate", strategy: "cherry-pick", actionToken: issued.actionToken });
  assert.equal(released.state, "released");
  assert.equal(await readFile(join(f.originRoot, "src", "executor.txt"), "utf8"), "executor\n");

  const narrow = service.ensureAllocated(request(f, "rename", {
    baseCommit: git(f.originRoot, "rev-parse", "HEAD"),
    writePaths: ["src/base.txt"],
  }));
  service.bindRun({ workspaceId: narrow.workspaceId, run: { runId: "bound-rename", asyncDir: join(f.root, "bound-rename") } });
  git(narrow.path, "mv", "src/base.txt", "outside.txt");
  git(narrow.path, "commit", "-m", "move outside scope");
  const blocked = service.status({ workspaceId: narrow.workspaceId, terminalProof: observed("f") });
  assert.ok(blocked.blockedReasons.includes("writePaths-out-of-scope"));
  assert.equal(blocked.allowedDispositions.includes("integrate"), false);
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
    () => service.status({ workspaceId: drifted.workspaceId, terminalProof: observed() }),
    (error) => error?.code === "MANAGED_WORKSPACE_IDENTITY",
  );
});

test("expectedHead CAS rejects a stale disposition before its durable intent or Git side effects", async (t) => {
  const f = await fixture(t);
  const service = createManagedWorkspaceService({ stateRoot: f.stateRoot });
  const active = service.ensureAllocated(request(f, "expected-head"));
  service.bindRun({ workspaceId: active.workspaceId, run: { runId: "expected-head-run", asyncDir: join(f.root, "expected-head-run") } });
  await commitWorkspace(active, "expected-head.ts");
  const head = git(active.path, "rev-parse", "HEAD");
  const issued = service.issueDisposition({ workspaceId: active.workspaceId, terminalProof: observed(), expectedHead: head });
  await commitWorkspace(active, "expected-head-drift.ts");
  assert.throws(
    () => service.dispose({ workspaceId: active.workspaceId, terminalProof: observed(), expectedHead: head, disposition: "discard", actionToken: issued.actionToken }),
    (error) => error?.code === "MANAGED_WORKSPACE_EXPECTED_HEAD",
  );
  assert.equal(service.status({ workspaceId: active.workspaceId }).receipt.state, "active");
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
  const issued = service.issueDisposition({ workspaceId: active.workspaceId, terminalProof: observed() });
  assert.throws(() => service.dispose({ workspaceId: active.workspaceId, terminalProof: observed(), disposition: "discard", actionToken: issued.actionToken }), /crash after intent/);

  const recovered = createManagedWorkspaceService({ stateRoot: f.stateRoot }).reconcile({ originRoot: f.originRoot });
  assert.equal(recovered.find((entry) => entry.workspaceId === active.workspaceId).state, "released");
});

test("owner scope gates listOwned and every scoped operation before inspection or mutation", async (t) => {
  const f = await fixture(t);
  let inspections = 0;
  const service = createManagedWorkspaceService({
    stateRoot: f.stateRoot,
    fault(event) { if (event.operation === "status" && event.phase === "after-inspection") inspections += 1; },
  });
  const ledger = createManagedWorkspaceLedger({ stateRoot: f.stateRoot });
  const own = { kind: "standalone-subagent", rootSessionId: "session-a" };
  const foreign = { kind: "standalone-subagent", rootSessionId: "session-b" };
  const ownA = service.ensureAllocated(request(f, "workspace-a", { owner: { kind: "standalone-subagent", rootSessionId: "session-a", toolCallId: "tool-a" } }));
  const ownZ = service.ensureAllocated(request(f, "workspace-z", { owner: { kind: "standalone-subagent", rootSessionId: "session-a", toolCallId: "tool-z" } }));
  const foreignReceipt = service.ensureAllocated(request(f, "workspace-b", { owner: { kind: "standalone-subagent", rootSessionId: "session-b", toolCallId: "tool-b" } }));
  const goal = service.ensureAllocated(request(f, "goal-workspace", { owner: { kind: "goal-task", rootSessionId: "session-a", goalId: "goal-a", taskId: "task-a", attempt: 1, executionRevision: 1 } }));
  const validation = service.ensureAllocated(request(f, "validation-workspace", { owner: { kind: "goal-validation", rootSessionId: "session-a", goalId: "goal-a", validationId: "validation-a", executionRevision: 1 }, mode: "validation", writePaths: [] }));
  service.bindRun({ workspaceId: ownA.workspaceId, run: { runId: "run-a", asyncDir: join(f.root, "run-a") } });
  service.bindRun({ workspaceId: foreignReceipt.workspaceId, run: { runId: "run-b", asyncDir: join(f.root, "run-b") } });

  assert.deepEqual(service.listOwned({ ownerScope: own }).map(({ workspaceId }) => workspaceId), ["workspace-a", "workspace-z"]);
  assert.deepEqual(service.listOwned({ ownerScope: own, runId: "run-a" }).map(({ workspaceId }) => workspaceId), ["workspace-a"]);
  assert.deepEqual(service.listOwned({ ownerScope: own, runId: "run-b" }), []);
  assert.throws(() => service.listOwned({ ownerScope: { ...own, extra: true } }), (error) => error?.code === "MANAGED_WORKSPACE_OWNER_SCOPE");

  const before = Object.fromEntries([foreignReceipt, goal, validation].map(({ workspaceId }) => [workspaceId, structuredClone(ledger.load(workspaceId).record)]));
  const originHead = git(f.originRoot, "rev-parse", "HEAD");
  const terminalProof = observed();
  assert.throws(() => service.statusOwned({ workspaceId: foreignReceipt.workspaceId, ownerScope: own, terminalProof }), (error) => error?.code === "MANAGED_WORKSPACE_OWNER_SCOPE");
  assert.throws(() => service.issueOwnedDisposition({ workspaceId: goal.workspaceId, ownerScope: own, terminalProof }), (error) => error?.code === "MANAGED_WORKSPACE_OWNER_SCOPE");
  assert.throws(() => service.releaseOwned({ workspaceId: validation.workspaceId, ownerScope: own }), (error) => error?.code === "MANAGED_WORKSPACE_OWNER_SCOPE");
  assert.throws(() => service.statusOwned({ workspaceId: "unknown-workspace", ownerScope: own }), (error) => error?.code === "MANAGED_WORKSPACE_NOT_FOUND");
  assert.equal(inspections, 0, "rejected scopes must not inspect Git");
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
  }, { mode: "validation", writePaths: [] });

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
