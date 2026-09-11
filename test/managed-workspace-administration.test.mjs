import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inventoryManagedWorkspaces, planManagedWorkspaceCleanup } from "../packages/pi-subagents-enhanced/src/workspace/administration.ts";
import { createManagedWorkspaceLedger } from "../packages/pi-subagents-enhanced/src/workspace/ledger.ts";
import { createManagedWorkspaceRequestV2 } from "../packages/pi-subagents-enhanced/src/workspace/contract.ts";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("audit inventory exposes ledger version and generation without mutating an empty ledger", () => {
  const stateRoot = join(mkdtempSync(join(tmpdir(), "managed-admin-")), "state");
  const before = inventoryManagedWorkspaces({ stateRoot });
  const after = inventoryManagedWorkspaces({ stateRoot });
  assert.equal(before.schemaVersion, "managed-workspace-inventory.v2");
  assert.deepEqual(after, before);
});

test("reconcile plan is explicitly authorization-bound and never performs cleanup during planning", () => {
  const stateRoot = join(mkdtempSync(join(tmpdir(), "managed-admin-")), "state");
  const plan = planManagedWorkspaceCleanup({ stateRoot });
  assert.equal(plan.schemaVersion, "managed-workspace-reconcile-plan.v2");
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.requiresExplicitAuthorization, true);
});

test("v2 recovery challenge is bound to generation and is consumed once", () => {
  const root = mkdtempSync(join(tmpdir(), "managed-admin-"));
  const originRoot = join(root, "origin");
  const stateRoot = join(root, "state");
  mkdirSync(originRoot, { recursive: true });
  writeFileSync(join(originRoot, "README.md"), "base\n");
  git(originRoot, "init", "-b", "main");
  git(originRoot, "config", "user.email", "test@example.com");
  git(originRoot, "config", "user.name", "Test User");
  git(originRoot, "add", "."); git(originRoot, "commit", "-m", "base");
  const ledger = createManagedWorkspaceLedger({ stateRoot });
  const request = createManagedWorkspaceRequestV2({ workspaceId: "challenge", owner: { kind: "standalone-subagent", rootSessionId: "root", toolCallId: "tool" }, originRoot, requestedCwd: originRoot, originRef: "refs/heads/main", baseCommit: git(originRoot, "rev-parse", "HEAD"), contractHash: "a".repeat(64), policy: { publication: "allowed", application: "forbidden", writePaths: ["README.md"] } });
  ledger.reserve(request);
  const challenge = ledger.issueRecoveryChallenge(request.workspaceId, { planHash: "b".repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const consumed = ledger.consumeRecoveryChallenge(request.workspaceId, challenge);
  assert.equal(consumed.record.recoveryChallenge.consumedAt !== null, true);
  assert.throws(() => ledger.consumeRecoveryChallenge(request.workspaceId, challenge), /replayed|stale/i);
  rmSync(root, { recursive: true, force: true });
});
