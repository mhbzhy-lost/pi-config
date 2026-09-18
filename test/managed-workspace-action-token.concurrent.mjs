import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createManagedWorkspaceRequestV2 } from "../packages/pi-subagents-enhanced/src/workspace/contract.ts";
import { createManagedWorkspaceService } from "../packages/pi-subagents-enhanced/src/workspace/service.ts";
import { applyPublishedArtifact, fastForwardManagedGitWorkspace, publishWorkspaceSnapshot } from "../packages/pi-subagents-enhanced/src/workspace/git-worktree.ts";
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function fixture(t) { const root = await mkdtemp(join(tmpdir(), "action-token-v2-")); const originRoot = join(root, "origin"); await mkdir(originRoot); git(originRoot, "init", "-b", "main"); git(originRoot, "config", "user.email", "test@example.com"); git(originRoot, "config", "user.name", "Test"); await writeFile(join(originRoot, "README"), "base\n"); git(originRoot, "add", "."); git(originRoot, "commit", "-m", "base"); t.after(() => rm(root, { recursive: true, force: true })); return { root, originRoot, baseCommit: git(originRoot, "rev-parse", "HEAD") }; }
test("two service processes cannot consume one v2 action token", async t => {
  const f = await fixture(t); const request = createManagedWorkspaceRequestV2({ workspaceId: "token-race", owner: { kind: "standalone-subagent", rootSessionId: "root-token", toolCallId: "tool-token" }, originRoot: f.originRoot, requestedCwd: f.originRoot, originRef: "refs/heads/main", baseCommit: f.baseCommit, contractHash: "a".repeat(64), policy: { publication: "allowed", application: "allowed", writePaths: ["README"] } });
  const options = { stateRoot: join(f.root, "state") }; const first = createManagedWorkspaceService(options); const second = createManagedWorkspaceService(options); const active = first.ensureAllocated(request); const proof = { state: "observed", conflict: false, runId: "run-token", rootSessionId: "root-token", asyncDir: join(f.root, "async"), processInstance: "proc-token", proofId: "f".repeat(64) }; first.bindRun({ workspaceId: active.workspaceId, run: { runId: proof.runId, asyncDir: proof.asyncDir } });
  const ownerScope = { kind: "standalone-subagent", rootSessionId: "root-token" }; const issued = first.issueAction({ workspaceId: active.workspaceId, ownerScope, action: "publish", terminalProof: proof });
  const results = await Promise.allSettled([Promise.resolve().then(() => first.publishOwned({ workspaceId: active.workspaceId, ownerScope, terminalProof: proof, actionToken: issued.actionToken })), Promise.resolve().then(() => second.publishOwned({ workspaceId: active.workspaceId, ownerScope, terminalProof: proof, actionToken: issued.actionToken }))]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1); assert.equal(results.filter(r => r.status === "rejected").length, 1); assert.match(results.find(r => r.status === "rejected").reason.message, /action|replay|stale/i);
});
test("reconcile repairs receipt after publish effect completed", async t => {
  const f = await fixture(t); const stateRoot = join(f.root, "recovery-state"); const request = createManagedWorkspaceRequestV2({ workspaceId: "receipt-recovery", owner: { kind: "standalone-subagent", rootSessionId: "root-recovery", toolCallId: "tool-recovery" }, originRoot: f.originRoot, requestedCwd: f.originRoot, originRef: "refs/heads/main", baseCommit: f.baseCommit, contractHash: "b".repeat(64), policy: { publication: "allowed", application: "forbidden", writePaths: ["README"] } });
  let crash = true; const service = createManagedWorkspaceService({ stateRoot, fault: event => { if (crash && event.operation === "publish" && event.phase === "after-effect") { crash = false; const error = new Error("crash"); error.code = "TEST_FAULT"; throw error; } } }); const active = service.ensureAllocated(request); const proof = { state: "observed", conflict: false, runId: "run-recovery", rootSessionId: "root-recovery", asyncDir: join(f.root, "async-recovery"), processInstance: "proc-recovery", proofId: "d".repeat(64) }; service.bindRun({ workspaceId: active.workspaceId, run: { runId: proof.runId, asyncDir: proof.asyncDir } }); const ownerScope = { kind: "standalone-subagent", rootSessionId: "root-recovery" }; const issued = service.issueAction({ workspaceId: active.workspaceId, ownerScope, action: "publish", terminalProof: proof });
  assert.throws(() => service.publishOwned({ workspaceId: active.workspaceId, ownerScope, terminalProof: proof, actionToken: issued.actionToken }), /crash/); const recovered = service.reconcile({ originRoot: f.originRoot }); assert.equal(recovered[0].state, "active"); assert.ok(recovered[0].publishedArtifact);
});
test("reconcile records released after the worktree was removed before the disposition receipt", async t => {
  const f = await fixture(t); const stateRoot = join(f.root, "dispose-recovery-state"); let crash = true;
  const request = createManagedWorkspaceRequestV2({ workspaceId: "dispose-recovery", owner: { kind: "standalone-subagent", rootSessionId: "root-dispose", toolCallId: "tool-dispose" }, originRoot: f.originRoot, requestedCwd: f.originRoot, originRef: "refs/heads/main", baseCommit: f.baseCommit, contractHash: "c".repeat(64), policy: { publication: "allowed", application: "forbidden", writePaths: ["README"] } });
  const service = createManagedWorkspaceService({ stateRoot, fault: event => { if (crash && event.operation === "dispose" && event.phase === "after-git") { crash = false; const error = new Error("crash after worktree removal"); error.code = "TEST_FAULT"; throw error; } } });
  const active = service.ensureAllocated(request); const run = { runId: "run-dispose", asyncDir: join(f.root, "async-dispose") };
  service.bindRun({ workspaceId: active.workspaceId, run });
  const proof = { state: "observed", conflict: false, runId: run.runId, rootSessionId: "root-dispose", asyncDir: run.asyncDir, processInstance: "proc-dispose", proofId: "e".repeat(64) };
  const issued = service.issueDisposition({ workspaceId: active.workspaceId, terminalProof: proof });
  assert.throws(() => service.dispose({ workspaceId: active.workspaceId, terminalProof: proof, disposition: "discard", actionToken: issued.actionToken }), /crash after worktree removal/);
  const recovered = createManagedWorkspaceService({ stateRoot }).reconcile({ originRoot: f.originRoot });
  assert.equal(recovered[0].state, "released");
});
test("Goal reconcile does not invert the queue publish Git lock and Goal apply shares it", async t => {
  const f = await fixture(t); const stateRoot = join(f.root, "goal-lock-state"); const service = createManagedWorkspaceService({ stateRoot });
  const policy = { publication: "allowed", application: "allowed", writePaths: ["README"] };
  const request = createManagedWorkspaceRequestV2({ workspaceId: "goal-lock", owner: { kind: "goal-task", rootSessionId: "root-goal", goalId: "goal", taskId: "task", attempt: 1, executionRevision: 1 }, originRoot: f.originRoot, requestedCwd: f.originRoot, originRef: "refs/heads/main", baseCommit: f.baseCommit, contractHash: "f".repeat(64), policy });
  const goal = service.ensureAllocated(request);
  await writeFile(join(goal.path, "README"), "goal result\n");
  const canonicalRequest = { ...request, originRoot: goal.originRoot, requestedCwd: goal.requestedCwd };
  const goalRecord = { path: goal.path, dispatchCwd: goal.dispatchCwd, branchRef: goal.branchRef, request: canonicalRequest };
  const artifact = publishWorkspaceSnapshot({ record: goalRecord, policy, proofId: "a".repeat(64) });

  const queuePath = join(f.root, "queue-worktree"); git(f.originRoot, "worktree", "add", "-b", "queue-lock", queuePath, "main");
  await writeFile(join(queuePath, "queue.txt"), "queue\n"); git(queuePath, "add", "."); git(queuePath, "commit", "-m", "queue candidate");
  const candidateHead = git(queuePath, "rev-parse", "HEAD");
  const canonicalQueuePath = git(queuePath, "rev-parse", "--show-toplevel");
  const queueRecord = { path: canonicalQueuePath, dispatchCwd: canonicalQueuePath, branchRef: "refs/heads/queue-lock", request: { workspaceId: "queue-lock", originRoot: goal.originRoot, originRef: "refs/heads/main", baseCommit: f.baseCommit, policy: { publication: "allowed", application: "allowed", writePaths: ["queue.txt"] } } };
  let applyError;
  fastForwardManagedGitWorkspace({ record: queueRecord, targetRef: "refs/heads/main", targetHead: f.baseCommit, candidateHead, fault(phase) {
    if (phase !== "before-merge") return;
    assert.equal(service.reconcile({ originRoot: f.originRoot }).find(entry => entry.workspaceId === goal.workspaceId).state, "active");
    try { applyPublishedArtifact({ record: goalRecord, artifact }); } catch (error) { applyError = error; }
  } });
  assert.match(applyError?.message ?? "", /lock/i);
  assert.deepEqual(applyPublishedArtifact({ record: goalRecord, artifact }).changedFiles, ["README"]);
});
