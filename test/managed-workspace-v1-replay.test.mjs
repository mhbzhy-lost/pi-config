import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createManagedWorkspaceRequest } from "../packages/pi-subagents-enhanced/src/workspace/contract.ts";
import { createManagedWorkspaceLedger, managedWorkspacePaths } from "../packages/pi-subagents-enhanced/src/workspace/ledger.ts";
import { createManagedWorkspaceService } from "../packages/pi-subagents-enhanced/src/workspace/service.ts";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const V1_REQUEST_HASH = "f12d04faee61ac96493e274089c5a1f2b7dcbfe66321309905bf435e8298e1fa";
const V1_DURABLE_PROJECTION = Object.freeze({
  keys: ["actionChallenge", "branchRef", "cleanupDebt", "createdAt", "dispatchCwd", "disposition", "leaseId", "ownerToken", "path", "pendingAction", "request", "requestHash", "revision", "run", "schemaVersion", "state", "updatedAt", "workspaceId"],
  schemaVersion: "managed-workspace-ledger.v1",
  workspaceId: "v1-replay-1",
  request: {
    workspaceId: "v1-replay-1",
    owner: { kind: "standalone-subagent", rootSessionId: "root-1", toolCallId: "tool-1" },
    originRoot: "<origin>",
    requestedCwd: "<origin>",
    originRef: "refs/heads/main",
    baseCommit: "<base-commit>",
    contractHash: "a".repeat(64),
    mode: "coding",
    writePaths: ["README.md"],
  },
  state: "released",
  run: { runId: "run-v1", asyncDir: "/async/run-v1" },
  disposition: { action: "preserve", reason: "frozen v1 disposition" },
  cleanupDebt: null,
  revision: 7,
});

function durableProjection(record) {
  return {
    keys: Object.keys(record).sort(),
    schemaVersion: record.schemaVersion,
    workspaceId: record.workspaceId,
    request: {
      ...record.request,
      originRoot: "<origin>",
      requestedCwd: "<origin>",
      baseCommit: "<base-commit>",
    },
    state: record.state,
    run: record.run,
    disposition: record.disposition,
    cleanupDebt: record.cleanupDebt,
    revision: record.revision,
  };
}

test("v1 golden replay preserves canonical record and public bound-run disposition semantics", async (t) => {
  const canonicalRequest = createManagedWorkspaceRequest({
    workspaceId: "v1-golden-1",
    owner: { kind: "standalone-subagent", rootSessionId: "root-1", toolCallId: "tool-1" },
    originRoot: "/repo",
    requestedCwd: "/repo",
    originRef: "refs/heads/main",
    baseCommit: "b".repeat(40),
    contractHash: "a".repeat(64),
    mode: "coding",
    writePaths: ["README.md"],
  });
  assert.equal(createHash("sha256").update(JSON.stringify(canonicalRequest)).digest("hex"), V1_REQUEST_HASH);

  const root = await mkdtemp(join(tmpdir(), "managed-workspace-v1-replay-"));
  const originRoot = join(root, "origin");
  const stateRoot = join(root, "state");
  await mkdir(originRoot);
  git(originRoot, "init", "-b", "main");
  git(originRoot, "config", "user.email", "test@example.com");
  git(originRoot, "config", "user.name", "Test User");
  await writeFile(join(originRoot, "README.md"), "initial\n");
  git(originRoot, "add", "README.md");
  git(originRoot, "commit", "-m", "initial");
  t.after(() => rm(root, { recursive: true, force: true }));

  const request = createManagedWorkspaceRequest({
    ...canonicalRequest,
    workspaceId: "v1-replay-1",
    originRoot,
    requestedCwd: originRoot,
    baseCommit: git(originRoot, "rev-parse", "HEAD"),
  });
  const service = createManagedWorkspaceService({ stateRoot });
  const allocated = service.ensureAllocated(request);
  const ledger = createManagedWorkspaceLedger({ stateRoot });
  const paths = managedWorkspacePaths({ stateRoot, originRoot, workspaceId: request.workspaceId });
  const bytesBeforeReplay = await readFile(paths.recordPath, "utf8");
  const replayed = ledger.reserve(structuredClone(request));
  const bytesAfterReplay = await readFile(paths.recordPath, "utf8");

  assert.equal(bytesAfterReplay, bytesBeforeReplay, "v1 ledger replay remains byte-identical");
  assert.equal(replayed.record.requestHash, ledger.load(request.workspaceId).record.requestHash);
  assert.equal(Object.hasOwn(replayed.record.request, "policy"), false);

  const bound = service.bindRun({ workspaceId: allocated.workspaceId, run: { runId: "run-v1", asyncDir: "/async/run-v1" } });
  const terminalProof = { state: "observed", conflict: false, proofHash: "c".repeat(64) };
  const status = service.status({ workspaceId: allocated.workspaceId, terminalProof });
  assert.deepEqual(bound.run, { runId: "run-v1", asyncDir: "/async/run-v1" });
  assert.deepEqual(status.terminalProof, terminalProof);
  assert.deepEqual(status.allowedDispositions, ["preserve", "discard"]);
  assert.equal(status.allowedDispositions.includes("publish"), false);
  assert.equal(status.allowedDispositions.includes("apply"), false);

  const issued = service.issueDisposition({ workspaceId: allocated.workspaceId, terminalProof });
  const preserved = service.dispose({
    workspaceId: allocated.workspaceId,
    terminalProof,
    disposition: "preserve",
    reason: "frozen v1 disposition",
    actionToken: issued.actionToken,
  });
  const released = service.release({ workspaceId: allocated.workspaceId });
  assert.deepEqual(preserved.disposition, { action: "preserve", reason: "frozen v1 disposition" });
  assert.equal(released.state, "released");
  assert.equal(Object.hasOwn(released, "policy"), false);
  assert.deepEqual(durableProjection(ledger.load(request.workspaceId).record), V1_DURABLE_PROJECTION);
});
