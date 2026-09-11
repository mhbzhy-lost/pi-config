import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as workspaceContract from "../packages/pi-subagents-enhanced/src/workspace/contract.ts";
import { createManagedWorkspaceLedger } from "../packages/pi-subagents-enhanced/src/workspace/ledger.ts";

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
