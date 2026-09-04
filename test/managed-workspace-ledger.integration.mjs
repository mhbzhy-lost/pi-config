import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createManagedWorkspaceRequest } from "../packages/pi-subagents-enhanced/src/workspace/contract.ts";
import { createManagedWorkspaceLedger, managedWorkspacePaths } from "../packages/pi-subagents-enhanced/src/workspace/ledger.ts";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "managed-ledger-"));
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
  return { root, originRoot, stateRoot, baseCommit: git(originRoot, "rev-parse", "HEAD") };
}

function request(f, overrides = {}) {
  return createManagedWorkspaceRequest({
    workspaceId: "workspace-1",
    owner: { kind: "standalone-subagent", rootSessionId: "root-1", toolCallId: "tool-1" },
    originRoot: f.originRoot,
    requestedCwd: f.originRoot,
    originRef: "refs/heads/main",
    baseCommit: f.baseCommit,
    contractHash: "a".repeat(64),
    mode: "coding",
    writePaths: ["README.md"],
    ...overrides,
  });
}

test("ledger requires an absolute global state root", () => {
  assert.throws(() => createManagedWorkspaceLedger({ stateRoot: "relative/state" }), /absolute/i);
});

test("ledger reserves one durable private record and replays the exact request idempotently", async (t) => {
  const f = await fixture(t);
  const ledger = createManagedWorkspaceLedger({ stateRoot: f.stateRoot });
  const input = request(f);
  const first = ledger.reserve(input);
  const second = ledger.reserve(structuredClone(input));
  const paths = managedWorkspacePaths({ stateRoot: f.stateRoot, originRoot: f.originRoot, workspaceId: input.workspaceId });

  assert.equal(first.ownerToken, second.ownerToken);
  assert.equal(first.record.requestHash, second.record.requestHash);
  assert.equal(first.record.state, "reserved");
  assert.equal(first.record.path, paths.worktreePath);
  assert.equal((await lstat(paths.recordPath)).mode & 0o777, 0o600);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(paths.recordPath, "utf8")), "ownerToken"), true);
  assert.equal(await lstat(join(f.originRoot, ".state")).catch(() => null), null, "ledger state must not be written to the target repository");

  assert.throws(
    () => ledger.reserve(request(f, { contractHash: "b".repeat(64) })),
    /conflict/i,
  );
});

test("all workspace owners use the same record schema and state transition implementation", async (t) => {
  const f = await fixture(t);
  const ledger = createManagedWorkspaceLedger({ stateRoot: f.stateRoot });
  const requests = [
    request(f, { workspaceId: "standalone", owner: { kind: "standalone-subagent", rootSessionId: "root-1", toolCallId: "tool-1" } }),
    request(f, { workspaceId: "goal-task", owner: { kind: "goal-task", rootSessionId: "root-1", goalId: "goal-1", taskId: "task-1", attempt: 1, executionRevision: 1 } }),
    request(f, { workspaceId: "validation", owner: { kind: "goal-validation", rootSessionId: "root-1", goalId: "goal-1", validationId: "validation-1", executionRevision: 1 }, mode: "validation", writePaths: [] }),
  ];

  const records = requests.map((input) => ledger.reserve(input).record);
  assert.deepEqual(records.map((record) => Object.keys(record).sort()), [0, 1, 2].map(() => Object.keys(records[0]).sort()));
  assert.deepEqual(records.map((record) => record.request.owner.kind), ["standalone-subagent", "goal-task", "goal-validation"]);
  assert.deepEqual(ledger.list().map((record) => record.workspaceId).sort(), ["goal-task", "standalone", "validation"]);
});

test("ledger reads records without following symlinks", async (t) => {
  const f = await fixture(t);
  const ledger = createManagedWorkspaceLedger({ stateRoot: f.stateRoot });
  ledger.reserve(request(f));
  const paths = managedWorkspacePaths({ stateRoot: f.stateRoot, originRoot: f.originRoot, workspaceId: "workspace-1" });
  const replacement = join(f.root, "replacement.json");
  await writeFile(replacement, "{}\n");
  await chmod(replacement, 0o600);
  await unlink(paths.recordPath);
  await symlink(replacement, paths.recordPath);

  assert.throws(() => ledger.load("workspace-1"), /regular|symlink|record/i);
});

test("ledger quarantines a lock whose process birth identity no longer matches", async (t) => {
  const f = await fixture(t);
  const paths = managedWorkspacePaths({ stateRoot: f.stateRoot, originRoot: f.originRoot, workspaceId: "workspace-1" });
  await mkdir(paths.recordsDir, { recursive: true, mode: 0o700 });
  await writeFile(paths.lockPath, `${JSON.stringify({
    schemaVersion: "managed-workspace-lock.v1",
    token: "stale-lock",
    pid: process.pid,
    birthIdentity: "0".repeat(64),
    createdAt: new Date().toISOString(),
  })}\n`);
  await chmod(paths.lockPath, 0o600);

  const ledger = createManagedWorkspaceLedger({ stateRoot: f.stateRoot });
  assert.equal(ledger.reserve(request(f)).record.state, "reserved");
});
