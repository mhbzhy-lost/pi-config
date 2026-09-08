import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createManagedWorkspaceRequest, deterministicGoalWorkspaceId, validateManagedWorkspaceReceipt } from "../packages/pi-subagents-enhanced/src/workspace/contract.ts";
import { createManagedWorkspaceService } from "../packages/pi-subagents-enhanced/src/workspace/service.ts";
import { goalWorkspaceTerminalProof } from "../src/goal-engine/managed-workspace.ts";

const hash = (value) => execFileSync("git", ["hash-object", "--stdin"], { input: value, encoding: "utf8" }).trim().padEnd(64, "0");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function fixture() {
  const originRoot = mkdtempSync(join(tmpdir(), "goal-engine-workspace-origin-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "goal-engine-workspace-state-"));
  git(originRoot, "init", "--initial-branch=main");
  git(originRoot, "config", "user.email", "test@example.invalid");
  git(originRoot, "config", "user.name", "Goal Engine Test");
  writeFileSync(join(originRoot, "README.md"), "fixture\n");
  git(originRoot, "add", "README.md");
  git(originRoot, "commit", "-m", "test: initialize workspace fixture");
  return { originRoot, stateRoot, baseCommit: git(originRoot, "rev-parse", "HEAD") };
}

function request(f, { taskId = "task-1", writePaths = ["src/result.ts"] } = {}) {
  const contractHash = "a".repeat(64);
  return createManagedWorkspaceRequest({
    workspaceId: deterministicGoalWorkspaceId({ goalId: "goal-1", taskId, attempt: 1, executionRevision: 1, contractHash, baseCommit: f.baseCommit }),
    owner: { kind: "goal-task", rootSessionId: "root-1", goalId: "goal-1", taskId, attempt: 1, executionRevision: 1 },
    originRoot: f.originRoot,
    requestedCwd: f.originRoot,
    originRef: "refs/heads/main",
    baseCommit: f.baseCommit,
    contractHash,
    mode: "coding",
    writePaths,
  });
}

const officialExecutorProof = { runId: "run-1", proofId: "b".repeat(64), rootSessionId: "root-1", observedAt: 1, outcome: "succeeded" };
const observed = goalWorkspaceTerminalProof(officialExecutorProof);

function dispose(service, receipt, disposition, extra = {}) {
  const issued = service.issueDisposition({ workspaceId: receipt.workspaceId, terminalProof: observed });
  return service.dispose({ workspaceId: receipt.workspaceId, terminalProof: observed, disposition, actionToken: issued.actionToken, ...extra });
}

test("public managed workspace contract allocates a deterministic Goal workspace and validates its receipt", () => {
  const f = fixture();
  const service = createManagedWorkspaceService({ stateRoot: f.stateRoot });
  const input = request(f);
  const receipt = service.ensureAllocated(input);

  assert.equal(receipt.workspaceId, input.workspaceId);
  assert.equal(receipt.state, "active");
  assert.equal(receipt.path.startsWith("/"), true);
  assert.deepEqual(validateManagedWorkspaceReceipt(receipt), receipt);
  assert.deepEqual(service.ensureAllocated(input), receipt, "allocation is idempotent for the exact public request");
});

test("public managed workspace service integrates a clean allowed Goal workspace after bind and official terminal proof", () => {
  const f = fixture();
  const service = createManagedWorkspaceService({ stateRoot: f.stateRoot });
  const receipt = service.ensureAllocated(request(f));
  service.bindRun({ workspaceId: receipt.workspaceId, run: { runId: officialExecutorProof.runId, asyncDir: join(f.stateRoot, "runs", officialExecutorProof.runId) } });
  mkdirSync(join(receipt.path, "src"), { recursive: true });
  writeFileSync(join(receipt.path, "src", "result.ts"), "export const result = true;\n");
  git(receipt.path, "add", "src/result.ts");
  git(receipt.path, "commit", "-m", "feat: add result");

  const status = service.status({ workspaceId: receipt.workspaceId, terminalProof: observed });
  assert.equal(status.receipt.state, "active");
  assert.deepEqual(status.terminalProof, observed);
  assert.equal(status.inspection.clean, true);
  assert.deepEqual(status.inspection.changedFiles, ["src/result.ts"]);
  assert.deepEqual(status.blockedReasons, []);
  assert.equal(status.allowedDispositions.includes("integrate"), true);
  const released = dispose(service, receipt, "integrate");
  assert.equal(released.state, "released");
  assert.deepEqual(released.disposition, { action: "integrate", strategy: "cherry-pick" });
  assert.equal(git(f.originRoot, "show", "HEAD:src/result.ts"), "export const result = true;");
});

test("public managed workspace service fails closed when committed writes escape writePaths", () => {
  const f = fixture();
  const service = createManagedWorkspaceService({ stateRoot: f.stateRoot });
  const receipt = service.ensureAllocated(request(f));
  writeFileSync(join(receipt.path, "outside.ts"), "export {};\n");
  git(receipt.path, "add", "outside.ts");
  git(receipt.path, "commit", "-m", "feat: out of scope");

  const issued = service.issueDisposition({ workspaceId: receipt.workspaceId, terminalProof: observed });
  assert.equal(issued.allowedDispositions.includes("integrate"), false);
  assert.throws(() => service.dispose({ workspaceId: receipt.workspaceId, terminalProof: observed, disposition: "integrate", actionToken: issued.actionToken }), /not allowed/);
  assert.equal(service.status({ workspaceId: receipt.workspaceId }).receipt.state, "active");
});

test("public managed workspace service preserves and explicitly releases a workspace", () => {
  const f = fixture();
  const service = createManagedWorkspaceService({ stateRoot: f.stateRoot });
  const receipt = service.ensureAllocated(request(f));
  const preserved = dispose(service, receipt, "preserve", { reason: "retain for manual inspection" });
  assert.equal(preserved.state, "preserved");
  assert.equal(service.status({ workspaceId: receipt.workspaceId }).receipt.state, "preserved");
  assert.equal(service.release({ workspaceId: receipt.workspaceId }).state, "released");
});

test("public request validation rejects unsafe Goal write paths", () => {
  const f = fixture();
  assert.throws(() => request(f, { taskId: "unsafe", writePaths: ["../outside.ts"] }), /unsafe|segment/i);
});
