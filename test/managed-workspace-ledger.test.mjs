import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as workspaceContract from "../packages/pi-subagents-enhanced/src/workspace/contract.ts";
import { createManagedWorkspaceLedger, managedWorkspacePaths } from "../packages/pi-subagents-enhanced/src/workspace/ledger.ts";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "managed-workspace-v2-ledger-"));
  const originRoot = join(root, "origin");
  await mkdir(originRoot);
  git(originRoot, "init", "-b", "main");
  git(originRoot, "config", "user.email", "test@example.com");
  git(originRoot, "config", "user.name", "Test User");
  await writeFile(join(originRoot, "README.md"), "initial\n");
  git(originRoot, "add", "README.md");
  git(originRoot, "commit", "-m", "initial");
  t.after(() => rm(root, { recursive: true, force: true }));
  return { originRoot, stateRoot: join(root, "state"), baseCommit: git(originRoot, "rev-parse", "HEAD") };
}

test("ledger writes a versioned v2 record without converting its policy to v1 mode", async (t) => {
  const f = await fixture(t);
  assert.equal(typeof workspaceContract.createManagedWorkspaceRequestV2, "function");
  const request = workspaceContract.createManagedWorkspaceRequestV2({
    workspaceId: "v2-ledger-1",
    owner: { kind: "standalone-subagent", rootSessionId: "root-1", toolCallId: "tool-1" },
    originRoot: f.originRoot,
    requestedCwd: f.originRoot,
    originRef: "refs/heads/main",
    baseCommit: f.baseCommit,
    contractHash: "a".repeat(64),
    policy: { publication: "allowed", application: "allowed", writePaths: ["README.md"] },
  });
  const ledger = createManagedWorkspaceLedger({ stateRoot: f.stateRoot });
  const first = ledger.reserve(request);
  const replayed = ledger.reserve(structuredClone(request));

  assert.equal(first.record.schemaVersion, "managed-workspace-ledger.v2");
  assert.equal(first.record.request.workspaceId, request.workspaceId);
  assert.deepEqual(first.record.request.policy, request.policy);
  assert.deepEqual(replayed.record.request.policy, request.policy);
  assert.equal(Object.hasOwn(first.record.request, "mode"), false);
});

test("v1 creation entry is removed and the v1 request shape is rejected", async (t) => {
  const f = await fixture(t);
  assert.equal(typeof workspaceContract.createManagedWorkspaceRequest, "undefined", "v1 request codec must not exist");
  assert.equal(typeof workspaceContract.validateManagedWorkspaceReceipt, "undefined", "v1 receipt codec must not exist");
  assert.equal(typeof workspaceContract.publicManagedWorkspaceReceipt, "undefined", "v1 receipt codec must not exist");
  const ledger = createManagedWorkspaceLedger({ stateRoot: f.stateRoot });
  const v1Shape = {
    workspaceId: "v1-remnant",
    owner: { kind: "standalone-subagent", rootSessionId: "root-1", toolCallId: "tool-1" },
    originRoot: f.originRoot,
    requestedCwd: f.originRoot,
    originRef: "refs/heads/main",
    baseCommit: f.baseCommit,
    contractHash: "a".repeat(64),
    mode: "coding",
    writePaths: ["README.md"],
  };
  assert.throws(() => ledger.reserve(v1Shape), /unknown field mode|policy/i, "reserve must reject the v1 mode/writePaths shape");
});

test("v1 record read compatibility is removed", async (t) => {
  const f = await fixture(t);
  const workspaceId = "v1-durable-remnant";
  const canonicalOrigin = realpathSync(f.originRoot);
  const request = {
    workspaceId,
    owner: { kind: "standalone-subagent", rootSessionId: "root-1", toolCallId: "tool-1" },
    originRoot: canonicalOrigin,
    requestedCwd: canonicalOrigin,
    originRef: "refs/heads/main",
    baseCommit: f.baseCommit,
    contractHash: "a".repeat(64),
    mode: "coding",
    writePaths: ["README.md"],
  };
  const ownerToken = `managed-workspace-owner.v1:${"0".repeat(64)}`;
  const timestamp = new Date().toISOString();
  const record = {
    schemaVersion: "managed-workspace-ledger.v1",
    workspaceId,
    request,
    requestHash: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
    ownerToken,
    leaseId: createHash("sha256").update(ownerToken).digest("hex"),
    path: managedWorkspacePaths({ stateRoot: f.stateRoot, originRoot: canonicalOrigin, workspaceId }).worktreePath,
    dispatchCwd: managedWorkspacePaths({ stateRoot: f.stateRoot, originRoot: canonicalOrigin, workspaceId }).worktreePath,
    branchRef: `refs/heads/pi-managed/${workspaceId}`,
    state: "reserved",
    run: null,
    disposition: null,
    cleanupDebt: null,
    actionChallenge: null,
    pendingAction: null,
    integrationIntent: null,
    integrationReceipt: null,
    integrationHistory: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 0,
  };
  const paths = managedWorkspacePaths({ stateRoot: f.stateRoot, originRoot: canonicalOrigin, workspaceId });
  await mkdir(paths.recordsDir, { recursive: true, mode: 0o700 });
  await writeFile(paths.recordPath, `${JSON.stringify(record)}\n`);
  await chmod(paths.recordPath, 0o600);

  const ledger = createManagedWorkspaceLedger({ stateRoot: f.stateRoot });
  assert.throws(() => ledger.load(workspaceId), /schema/i, "a durable v1 record must fail schema validation instead of loading");
});
