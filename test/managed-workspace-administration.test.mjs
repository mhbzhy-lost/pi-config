import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inventoryManagedWorkspaces, planManagedWorkspaceCleanup, auditManagedWorkspaces } from "../packages/pi-subagents-enhanced/src/workspace/administration.ts";
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

test("audit 分类 queue item / resume intent / legacy recovery intent，intent 文件不产生 queue-schema 债", () => {
  const stateRoot = join(mkdtempSync(join(tmpdir(), "managed-admin-audit-")), "state");
  const queueRoot = join(stateRoot, "repositories", "a".repeat(64), "integration-queue");
  mkdirSync(queueRoot, { recursive: true });
  writeFileSync(join(queueRoot, "queue-meta.json"), JSON.stringify({ nextSequence: 2 }));
  writeFileSync(join(queueRoot, "queue-index.json"), JSON.stringify(["queue-1.json"]));
  writeFileSync(join(queueRoot, "queue-1.json"), JSON.stringify({ version: "workspace-integration-queue-item.v1", queueItemId: "queue-1", workspaceId: "ws-1", state: "completed" }));
  writeFileSync(join(queueRoot, "resume-intent-index.json"), JSON.stringify(["resume-i1.json"]));
  writeFileSync(join(queueRoot, "resume-i1.json"), JSON.stringify({ version: "integration-resume-intent.v1", resumeIntentId: "i1", queueItemId: "queue-1", workspaceId: "ws-1", state: "completed", attempt: 1 }));
  writeFileSync(join(queueRoot, "recovery-intent-index.json"), JSON.stringify(["recovery-r1.json"]));
  writeFileSync(join(queueRoot, "recovery-r1.json"), JSON.stringify({ version: "recovery-intent.v1", recoveryIntentId: "r1", queueItemId: "queue-1", workspaceId: "ws-1", requiredAction: "preserve", state: "preserved" }));
  const audit = auditManagedWorkspaces({ stateRoot });
  assert.equal(audit.queue.items.length, 1);
  assert.equal(audit.queue.items[0].queueItemId, "queue-1");
  assert.equal(audit.queue.resumeIntents.length, 1);
  assert.equal(audit.queue.resumeIntents[0].resumeIntentId, "i1");
  assert.equal(audit.queue.recoveryIntents.length, 1);
  assert.equal(audit.queue.recoveryIntents[0].recoveryIntentId, "r1");
  assert.equal(audit.debts.some((debt) => debt.kind === "queue-schema"), false, "intent 与索引文件不得被误判为 queue item 债");
  writeFileSync(join(queueRoot, "bogus.json"), JSON.stringify({ version: "unknown" }));
  const degraded = auditManagedWorkspaces({ stateRoot });
  assert.equal(degraded.queue.items.length, 2, "未知 schema 文件仍按既有行为入 items 并可见");
  assert.equal(degraded.debts.some((debt) => debt.kind === "queue-schema"), true, "真正的未知 schema 仍然可见");
  rmSync(join(stateRoot, ".."), { recursive: true, force: true });
});

test("audit 的 queue items 按 sequence 确定性排序（与目录顺序无关）", () => {
  const stateRoot = join(mkdtempSync(join(tmpdir(), "managed-admin-sort-")), "state");
  const queueRoot = join(stateRoot, "repositories", "a".repeat(64), "integration-queue");
  mkdirSync(queueRoot, { recursive: true });
  writeFileSync(join(queueRoot, "zzz-late.json"), JSON.stringify({ version: "workspace-integration-queue-item.v1", queueItemId: "late", sequence: 9, state: "completed" }));
  writeFileSync(join(queueRoot, "aaa-early.json"), JSON.stringify({ version: "workspace-integration-queue-item.v1", queueItemId: "early", sequence: 2, state: "completed" }));
  writeFileSync(join(queueRoot, "mmm-mid.json"), JSON.stringify({ version: "workspace-integration-queue-item.v1", queueItemId: "mid", sequence: 5, state: "completed" }));
  const audit = auditManagedWorkspaces({ stateRoot });
  assert.deepEqual(audit.queue.items.map((item) => item.queueItemId), ["early", "mid", "late"]);
  rmSync(join(stateRoot, ".."), { recursive: true, force: true });
});
