import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const origin = mkdtempSync("/tmp/subagent-ledger-");
test.after(() => rmSync(origin, { recursive: true, force: true }));

const ledger = await import("../scripts/lib/subagent-dispatch/workspace-ledger.mjs");
const base = (workspaceId) => ({
  workspaceId, kind: "coding", rootSessionId: "session-1", toolCallId: "call-1",
  contractHash: "a".repeat(64), originRoot: origin, originRef: "refs/heads/main",
  originHeadAtAllocation: "b".repeat(40), requestedCwd: origin,
  workspacePath: join(origin, "workspace"), dispatchCwd: join(origin, "workspace", "src"),
  branchRef: "refs/heads/subagent/test", baseCommit: "b".repeat(40), writePaths: ["src/**"],
});
const file = (id) => join(origin, ".state/subagent-dispatch/workspaces", `${id}.json`);

test("allocates an exact private durable schema with private modes and public projection", () => {
  const lease = ledger.allocateWorkspaceIntent(base("one"));
  const raw = JSON.parse(readFileSync(file("one"), "utf8"));
  assert.deepEqual(Object.keys(raw).sort(), ["actionChallenge", "asyncDir", "baseCommit", "branchRef", "contractHash", "createdAt", "dispatchCwd", "kind", "originHeadAtAllocation", "originRef", "originRoot", "ownerToken", "pendingDisposition", "requestedCwd", "rootSessionId", "runId", "schemaVersion", "state", "toolCallId", "updatedAt", "workspaceId", "workspacePath", "writePaths", "revision"].sort());
  assert.equal(raw.schemaVersion, "subagent-workspace-ledger.v1");
  assert.equal(raw.state, "allocating"); assert.equal(raw.actionChallenge, null); assert.equal(raw.revision, 0);
  assert.equal(statSync(join(origin, ".state/subagent-dispatch/workspaces")).mode & 0o777, 0o700);
  assert.equal(statSync(file("one")).mode & 0o777, 0o600);
  assert.ok(lease.ownerToken); assert.equal(JSON.stringify(ledger.publicWorkspace(lease)).includes(lease.ownerToken), false);
  assert.equal(JSON.stringify(raw).includes("actionToken"), false);
});

test("rejects duplicate ids, tampering, insecure modes, and stale private leases", () => {
  const lease = ledger.allocateWorkspaceIntent(base("two"));
  assert.throws(() => ledger.allocateWorkspaceIntent(base("two")), /exists|duplicate/i);
  const active = ledger.activateWorkspace(lease, { workspacePath: lease.record.workspacePath, dispatchCwd: lease.record.dispatchCwd, branchRef: lease.record.branchRef, baseCommit: lease.record.baseCommit });
  assert.throws(() => ledger.bindWorkspaceRun({ lease, runId: "run-1", asyncDir: "/tmp/a" }), /stale|revision|CAS/i);
  chmodSync(file("two"), 0o644);
  assert.throws(() => ledger.loadWorkspace({ originRoot: origin, workspaceId: "two" }), /mode|secure/i);
  chmodSync(file("two"), 0o600);
  const raw = JSON.parse(readFileSync(file("two"), "utf8")); raw.state = "evil"; writeFileSync(file("two"), JSON.stringify(raw), { mode: 0o600 });
  assert.throws(() => ledger.loadWorkspace({ originRoot: origin, workspaceId: "two" }), /schema|state|invalid/i);
  assert.equal(active.record.state, "active");
});

test("recovers after allocation or activation crash and binds a run once", () => {
  const allocating = ledger.allocateWorkspaceIntent(base("three"));
  assert.equal(ledger.recoverPrivateWorkspaceLease({ originRoot: origin, workspaceId: "three" }).record.state, "allocating");
  const active = ledger.activateWorkspace(allocating, { workspacePath: allocating.record.workspacePath, dispatchCwd: allocating.record.dispatchCwd, branchRef: allocating.record.branchRef, baseCommit: allocating.record.baseCommit });
  const reloaded = ledger.recoverPrivateWorkspaceLease({ originRoot: origin, workspaceId: "three" });
  const bound = ledger.bindWorkspaceRun({ lease: reloaded, runId: "run-3", asyncDir: "/tmp/async-3" });
  assert.equal(bound.record.runId, "run-3");
  assert.throws(() => ledger.bindWorkspaceRun({ lease: bound, runId: "run-other", asyncDir: "/tmp/b" }), /already|run/i);
  const publicLoaded = ledger.loadWorkspace({ originRoot: origin, workspaceId: "three" });
  assert.equal(publicLoaded.asyncDir, "/tmp/async-3");
  assert.equal(JSON.stringify(publicLoaded).includes(reloaded.ownerToken), false);
  assert.equal(active.record.state, "active");
});

test("issues a hashed one-shot action challenge bound to snapshot and disposition", () => {
  let lease = ledger.allocateWorkspaceIntent(base("four"));
  lease = ledger.activateWorkspace(lease, { workspacePath: lease.record.workspacePath, dispatchCwd: lease.record.dispatchCwd, branchRef: lease.record.branchRef, baseCommit: lease.record.baseCommit });
  const issued = ledger.issueWorkspaceAction({ lease, snapshotHash: "snap-a", allowed: ["preserve", "discard"] });
  assert.match(issued.actionToken, /^subagent-action\.v1:/);
  const raw = readFileSync(file("four"), "utf8"); assert.equal(raw.includes(issued.actionToken), false); assert.match(raw, /tokenHash/);
  assert.throws(() => ledger.consumeWorkspaceAction({ lease: issued.lease, actionToken: issued.actionToken, snapshotHash: "snap-b", disposition: "preserve" }), /snapshot/i);
  const consumed = ledger.consumeWorkspaceAction({ lease: issued.lease, actionToken: issued.actionToken, snapshotHash: "snap-a", disposition: "preserve" });
  assert.equal(consumed.record.actionChallenge.used, true);
  assert.deepEqual(consumed.record.pendingDisposition, { disposition: "preserve", strategy: null, snapshotHash: "snap-a", proofHash: null, executorHead: null, authorizedAt: consumed.record.pendingDisposition.authorizedAt });
  assert.equal(JSON.stringify(ledger.publicWorkspace(consumed)).includes("pendingDisposition"), false);
  assert.throws(() => ledger.consumeWorkspaceAction({ lease: consumed, actionToken: issued.actionToken, snapshotHash: "snap-a", disposition: "preserve" }), /used|replay/i);
  const next = ledger.issueWorkspaceAction({ lease: consumed, snapshotHash: "snap-c", allowed: ["discard"] });
  assert.throws(() => ledger.consumeWorkspaceAction({ lease: next.lease, actionToken: next.actionToken, snapshotHash: "snap-c", disposition: "integrate" }), /allowed|disposition|used/i);
});

test("rejects pending disposition field combinations that are not exact", () => {
  let lease = ledger.allocateWorkspaceIntent(base("pending-schema"));
  lease = ledger.activateWorkspace(lease, { workspacePath: lease.record.workspacePath, dispatchCwd: lease.record.dispatchCwd, branchRef: lease.record.branchRef, baseCommit: lease.record.baseCommit });
  const raw = JSON.parse(readFileSync(file("pending-schema"), "utf8"));
  const pending = { disposition: "integrate", strategy: "cherry-pick", snapshotHash: "snapshot", proofHash: "proof", executorHead: "c".repeat(40), authorizedAt: new Date().toISOString() };
  for (const mutate of [
    (value) => { value.disposition = "discard"; },
    (value) => { value.strategy = null; },
    (value) => { value.executorHead = null; },
    (value) => { value.proofHash = ""; },
    (value) => { value.disposition = "preserve"; value.strategy = "merge"; },
  ]) {
    const value = structuredClone(raw); value.pendingDisposition = structuredClone(pending); mutate(value.pendingDisposition);
    writeFileSync(file("pending-schema"), JSON.stringify(value), { mode: 0o600 }); chmodSync(file("pending-schema"), 0o600);
    assert.throws(() => ledger.loadWorkspace({ originRoot: origin, workspaceId: "pending-schema" }), /pending|schema|invalid/i);
  }
});

test("marks only legal owner-CAS state transitions", () => {
  let lease = ledger.allocateWorkspaceIntent(base("five"));
  lease = ledger.activateWorkspace(lease, { workspacePath: lease.record.workspacePath, dispatchCwd: lease.record.dispatchCwd, branchRef: lease.record.branchRef, baseCommit: lease.record.baseCommit });
  lease = ledger.markWorkspaceState({ lease, state: "preserved" });
  assert.equal(lease.record.state, "preserved");
  assert.throws(() => ledger.markWorkspaceState({ lease, state: "active" }), /transition/i);
});

test("accepts a safe 0755 state parent and recovers a dead receipt lock", () => {
  const safeOrigin = mkdtempSync("/tmp/subagent-ledger-safe-");
  try {
    mkdirSync(join(safeOrigin, ".state"), { mode: 0o755 });
    chmodSync(join(safeOrigin, ".state"), 0o755);
    const input = { ...base("six"), originRoot: safeOrigin, requestedCwd: safeOrigin, workspacePath: join(safeOrigin, "workspace"), dispatchCwd: join(safeOrigin, "workspace", "src") };
    const first = ledger.allocateWorkspaceIntent(input);
    const lockPath = join(safeOrigin, ".state/subagent-dispatch/workspaces/.ledger.lock");
    const child = spawnSync(process.execPath, ["-e", `const {execFileSync}=require('node:child_process');const {createHash}=require('node:crypto');const fs=require('node:fs');const b=execFileSync('/bin/ps',['-ww','-p',String(process.pid),'-o','lstart=','-o','command=']);fs.writeFileSync(process.argv[1],JSON.stringify({schemaVersion:'subagent-workspace-ledger.lock.v1',token:'dead-token',pid:process.pid,birthIdentity:createHash('sha256').update(b).digest('hex'),createdAt:new Date().toISOString()})+'\\n',{mode:0o600})`, lockPath], { encoding: "utf8" });
    assert.equal(child.status, 0);
    const reloaded = ledger.recoverPrivateWorkspaceLease({ originRoot: safeOrigin, workspaceId: "six" });
    const active = ledger.activateWorkspace(reloaded, { workspacePath: reloaded.record.workspacePath, dispatchCwd: reloaded.record.dispatchCwd, branchRef: reloaded.record.branchRef, baseCommit: reloaded.record.baseCommit });
    assert.equal(active.record.revision, first.record.revision + 1);
    assert.equal(statSync(join(safeOrigin, ".state")).mode & 0o777, 0o755);
    assert.equal(statSync(join(safeOrigin, ".state/subagent-dispatch")).mode & 0o777, 0o700);
  } finally { rmSync(safeOrigin, { recursive: true, force: true }); }
});

test("does not steal a live or unknown receipt lock", async () => {
  const lockOrigin = mkdtempSync("/tmp/subagent-ledger-live-");
  const input = { ...base("live"), originRoot: lockOrigin, requestedCwd: lockOrigin, workspacePath: join(lockOrigin, "workspace"), dispatchCwd: join(lockOrigin, "workspace", "src") };
  const lease = ledger.allocateWorkspaceIntent(input);
  const lockPath = join(lockOrigin, ".state/subagent-dispatch/workspaces/.ledger.lock");
  const script = `const {execFileSync}=require('node:child_process');const {createHash}=require('node:crypto');const fs=require('node:fs');const b=execFileSync('/bin/ps',['-ww','-p',String(process.pid),'-o','lstart=','-o','command=']);fs.writeFileSync(process.argv[1],JSON.stringify({schemaVersion:'subagent-workspace-ledger.lock.v1',token:'live-token',pid:process.pid,birthIdentity:createHash('sha256').update(b).digest('hex'),createdAt:new Date().toISOString()})+'\\n',{mode:0o600});setTimeout(()=>{},5000)`;
  const child = spawn(process.execPath, ["-e", script, lockPath]);
  try {
    for (let i = 0; i < 100 && !existsSync(lockPath); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(existsSync(lockPath), true);
    assert.throws(() => ledger.activateWorkspace(lease, { workspacePath: lease.record.workspacePath, dispatchCwd: lease.record.dispatchCwd, branchRef: lease.record.branchRef, baseCommit: lease.record.baseCommit }), /busy|lock/i);
    writeFileSync(lockPath, "not a receipt\n", { mode: 0o600 }); chmodSync(lockPath, 0o600);
    assert.throws(() => ledger.activateWorkspace(lease, { workspacePath: lease.record.workspacePath, dispatchCwd: lease.record.dispatchCwd, branchRef: lease.record.branchRef, baseCommit: lease.record.baseCommit }), /busy|lock/i);
  } finally { child.kill(); rmSync(lockOrigin, { recursive: true, force: true }); }
});

test("rejects unsafe persisted identity shapes", () => {
  const lease = ledger.allocateWorkspaceIntent(base("seven"));
  const raw = JSON.parse(readFileSync(file("seven"), "utf8"));
  raw.dispatchCwd = join(origin, "outside");
  writeFileSync(file("seven"), JSON.stringify(raw), { mode: 0o600 }); chmodSync(file("seven"), 0o600);
  assert.throws(() => ledger.loadWorkspace({ originRoot: origin, workspaceId: "seven" }), /identity|invalid/i);
  assert.throws(() => ledger.allocateWorkspaceIntent({ ...base("eight"), branchRef: "main" }), /invalid|identity/i);
  assert.throws(() => ledger.allocateWorkspaceIntent({ ...base("nine"), writePaths: [] }), /invalid/i);
  assert.ok(lease.ownerToken);
});
