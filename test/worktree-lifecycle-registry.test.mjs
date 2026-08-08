import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { createTemporaryArenaSync } from "./helpers/temporary-arena.mjs";

const modulePath = "../scripts/lib/worktree-lifecycle/registry.mjs";
const missing = (name) => () => { throw new Error(`RED: registry API ${name} is not implemented`); };
const registry = await import(modulePath).catch(() => ({
  __missing: true,
  beginAllocation: missing("beginAllocation"),
  activateAllocation: missing("activateAllocation"),
  markDisposition: missing("markDisposition"),
}));
const { beginAllocation, activateAllocation, markDisposition } = registry;

const MANIFEST_KEYS = [
  "schemaVersion", "id", "ownerKind", "ownerId", "ownerToken", "originRoot", "gitCommonDir",
  "path", "branchRef", "baseCommit", "headCommit", "state", "createdAt", "updatedAt",
  "disposition", "lastError",
];

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function repoFixture(t, prefix = "worktree-registry-") {
  const arena = createTemporaryArenaSync(prefix);
  t.after(() => arena.disposeSync());
  const root = arena.mkdtempSync("repo-");
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  writeFileSync(join(root, ".gitignore"), ".state/\n");
  writeFileSync(join(root, "shared.txt"), "base\n");
  git(root, "add", ".gitignore", "shared.txt");
  git(root, "commit", "-m", "initial");
  return { arena, root, baseCommit: git(root, "rev-parse", "HEAD") };
}

function manifestPath(root, id) {
  return join(root, ".state/worktree-lifecycle/leases", `${id}.json`);
}

function readManifest(root, id) {
  return JSON.parse(readFileSync(manifestPath(root, id), "utf8"));
}

function allocationOptions(f, overrides = {}) {
  const id = overrides.id ?? "task-one";
  return {
    originRoot: f.root,
    id,
    path: overrides.path ?? join(f.root, ".state/worktree-lifecycle/worktrees", id),
    branch: overrides.branch ?? `topic-${id}`,
    baseCommit: overrides.baseCommit ?? f.baseCommit,
    owner: overrides.owner ?? { kind: "test", id: "owner-one" },
    ...(overrides.fault ? { fault: overrides.fault } : {}),
    ...(overrides.lockTimeoutMs ? { lockTimeoutMs: overrides.lockTimeoutMs } : {}),
  };
}

function assertCode(code) {
  return (error) => {
    assert.equal(error?.code, code);
    return true;
  };
}

function writeReplacementLock(lockPath, current) {
  const replacement = { ...current, token: "replacement-lock-token" };
  writeFileSync(lockPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
  chmodSync(lockPath, 0o600);
  return replacement;
}

test("registry module exposes only the three frozen owner transition APIs", () => {
  assert.deepEqual(Object.keys(registry).sort(), ["activateAllocation", "beginAllocation", "markDisposition"]);
});

test("allocation intent is an exact 0600 manifest written before activation and transitions by owner-token CAS", (t) => {
  const f = repoFixture(t);
  const options = allocationOptions(f);
  const receipt = beginAllocation(options);
  const path = manifestPath(f.root, options.id);
  const allocating = readManifest(f.root, options.id);

  assert.deepEqual(Object.keys(allocating).sort(), [...MANIFEST_KEYS].sort());
  assert.equal(allocating.schemaVersion, "worktree-lifecycle.owner.v1");
  assert.equal(allocating.state, "allocating");
  assert.equal(allocating.ownerKind, "test");
  assert.equal(allocating.ownerId, "owner-one");
  assert.match(allocating.ownerToken, /^worktree-owner\.v1:[a-f0-9]{64}$/);
  assert.equal(allocating.ownerToken, receipt.ownerToken);
  assert.equal(receipt.manifestPath, path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dirname(path)).filter((name) => name.includes(".tmp")), []);

  mkdirSync(dirname(options.path), { recursive: true });
  git(f.root, "worktree", "add", "-b", options.branch, options.path, options.baseCommit);
  const headCommit = git(options.path, "rev-parse", "HEAD");
  const active = activateAllocation({ originRoot: f.root, id: options.id, ownerToken: receipt.ownerToken, headCommit });
  assert.equal(active.state, "active");
  assert.equal(active.headCommit, headCommit);

  const reclaimable = markDisposition({
    originRoot: f.root,
    id: options.id,
    ownerToken: receipt.ownerToken,
    disposition: "reclaimable",
  });
  assert.equal(reclaimable.state, "reclaimable");
  assert.deepEqual(reclaimable.disposition, { state: "reclaimable", reason: null });
  assert.throws(
    () => markDisposition({ originRoot: f.root, id: options.id, ownerToken: "worktree-owner.v1:dead", disposition: "preserved" }),
    assertCode("WORKTREE_LIFECYCLE_OWNER_MISMATCH"),
  );
});

test("same allocation retry reuses its durable token while a different owner or identity cannot overwrite it", (t) => {
  const f = repoFixture(t);
  const options = allocationOptions(f);
  const first = beginAllocation(options);
  const retry = beginAllocation(options);
  assert.equal(retry.ownerToken, first.ownerToken);
  const before = readFileSync(first.manifestPath, "utf8");

  assert.throws(
    () => beginAllocation(allocationOptions(f, { owner: { kind: "test", id: "replacement" } })),
    assertCode("WORKTREE_LIFECYCLE_MANIFEST_CONFLICT"),
  );
  assert.throws(
    () => beginAllocation(allocationOptions(f, { path: join(f.root, "different-path") })),
    assertCode("WORKTREE_LIFECYCLE_MANIFEST_CONFLICT"),
  );
  assert.equal(readFileSync(first.manifestPath, "utf8"), before);
});

test("a structurally valid released manifest cannot be replaced while its old worktree resources remain", (t) => {
  const f = repoFixture(t);
  const options = allocationOptions(f);
  const receipt = beginAllocation(options);
  mkdirSync(dirname(options.path), { recursive: true });
  git(f.root, "worktree", "add", "-b", options.branch, options.path, options.baseCommit);
  activateAllocation({ originRoot: f.root, id: options.id, ownerToken: receipt.ownerToken, headCommit: f.baseCommit });
  const forged = readManifest(f.root, options.id);
  forged.state = "released";
  forged.disposition = { state: "released", reason: null };
  forged.updatedAt = new Date().toISOString();
  writeFileSync(receipt.manifestPath, `${JSON.stringify(forged)}\n`, { mode: 0o600 });

  assert.throws(
    () => beginAllocation(allocationOptions(f, { branch: "replacement", owner: { kind: "test", id: "replacement" } })),
    assertCode("WORKTREE_LIFECYCLE_IDENTITY_MISMATCH"),
  );
  assert.equal(existsSync(options.path), true);
  assert.equal(readManifest(f.root, options.id).ownerId, "owner-one");
});

test("unknown, corrupted, symlinked, or broadly-readable manifests fail closed without replacement", (t) => {
  for (const mutation of [
    (path) => writeFileSync(path, "{not-json\n"),
    (path) => writeFileSync(path, JSON.stringify({ schemaVersion: "unknown" })),
    (path) => { const target = `${path}.target`; renameSync(path, target); symlinkSync(target, path); },
    (path) => chmodSync(path, 0o644),
  ]) {
    const f = repoFixture(t);
    const options = allocationOptions(f);
    const receipt = beginAllocation(options);
    mutation(receipt.manifestPath);
    const before = readFileSync(receipt.manifestPath, "utf8");
    assert.throws(
      () => beginAllocation(options),
      assertCode("WORKTREE_LIFECYCLE_MANIFEST_INVALID"),
    );
    assert.equal(readFileSync(receipt.manifestPath, "utf8"), before);
  }

  const broken = repoFixture(t);
  const options = allocationOptions(broken);
  const receipt = beginAllocation(options);
  const target = `${receipt.manifestPath}.missing`;
  renameSync(receipt.manifestPath, `${receipt.manifestPath}.original`);
  symlinkSync(target, receipt.manifestPath);
  assert.throws(() => beginAllocation(options), assertCode("WORKTREE_LIFECYCLE_MANIFEST_INVALID"));
  assert.equal(lstatSync(receipt.manifestPath).isSymbolicLink(), true);
  assert.equal(readlinkSync(receipt.manifestPath), target);
});

test("registry state directories cannot escape the repository through a symlink", (t) => {
  const f = repoFixture(t);
  const external = f.arena.mkdtempSync("external-");
  mkdirSync(join(f.root, ".state"), { recursive: true });
  symlinkSync(external, join(f.root, ".state/worktree-lifecycle"));

  assert.throws(
    () => beginAllocation(allocationOptions(f)),
    assertCode("WORKTREE_LIFECYCLE_STATE_ROOT_INSECURE"),
  );
  assert.deepEqual(readdirSync(external), []);
});

test("two real processes racing the same id publish exactly one valid owner", async (t) => {
  const f = repoFixture(t);
  const barrier = join(f.root, "start-race");
  const registryUrl = pathToFileURL(join(f.root, "..", "does-not-exist")).href;
  const actualRegistryUrl = new URL(modulePath, import.meta.url).href;
  const childSource = (ownerId) => `
    import { existsSync } from "node:fs";
    import { beginAllocation } from ${JSON.stringify(actualRegistryUrl)};
    while (!existsSync(${JSON.stringify(barrier)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    try {
      const result = beginAllocation(${JSON.stringify(allocationOptions(f, { owner: { kind: "child", id: ownerId } }))});
      process.stdout.write(JSON.stringify({ ok: true, ownerId: ${JSON.stringify(ownerId)}, token: result.ownerToken }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, ownerId: ${JSON.stringify(ownerId)}, code: error.code }));
      process.exitCode = 3;
    }
  `;
  void registryUrl;
  const run = (ownerId) => new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childSource(ownerId)], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  const first = run("owner-a");
  const second = run("owner-b");
  writeFileSync(barrier, "go\n");
  const results = await Promise.all([first, second]);
  const reports = results.map((result) => JSON.parse(result.stdout || JSON.stringify({ ok: false, stderr: result.stderr })));
  assert.equal(reports.filter((report) => report.ok).length, 1, JSON.stringify({ results, reports }));
  assert.equal(reports.filter((report) => report.code === "WORKTREE_LIFECYCLE_MANIFEST_CONFLICT").length, 1);
  const stored = readManifest(f.root, "task-one");
  assert.equal(stored.ownerId, reports.find((report) => report.ok).ownerId);
  assert.equal(statSync(manifestPath(f.root, "task-one")).mode & 0o777, 0o600);
});

test("PID birth mismatch is recoverable but malformed live lock identity fails closed", (t) => {
  const recoverable = repoFixture(t);
  const stateDir = join(recoverable.root, ".state/worktree-lifecycle");
  const lockPath = join(stateDir, ".registry.lock");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(lockPath, `${JSON.stringify({
    schemaVersion: "worktree-lifecycle.registry-lock.v1",
    token: "stale-token",
    pid: process.pid,
    birthIdentity: "0".repeat(64),
    createdAt: new Date(0).toISOString(),
  })}\n`, { mode: 0o600 });
  const receipt = beginAllocation(allocationOptions(recoverable, { lockTimeoutMs: 200 }));
  assert.equal(existsSync(receipt.manifestPath), true);
  assert.equal(existsSync(lockPath), false);

  const blocked = repoFixture(t);
  const blockedState = join(blocked.root, ".state/worktree-lifecycle");
  const blockedLock = join(blockedState, ".registry.lock");
  mkdirSync(blockedState, { recursive: true });
  writeFileSync(blockedLock, `${JSON.stringify({ pid: process.pid, token: "unknown" })}\n`, { mode: 0o600 });
  assert.throws(
    () => beginAllocation(allocationOptions(blocked, { lockTimeoutMs: 30 })),
    assertCode("WORKTREE_LIFECYCLE_LOCK_TIMEOUT"),
  );
  assert.equal(existsSync(blockedLock), true);
});

test("a stale PID-birth recovery guard cannot permanently block stale registry lock recovery", (t) => {
  const f = repoFixture(t);
  const stateDir = join(f.root, ".state/worktree-lifecycle");
  mkdirSync(stateDir, { recursive: true });
  const stale = (token) => ({
    schemaVersion: "worktree-lifecycle.registry-lock.v1",
    token,
    pid: process.pid,
    birthIdentity: "0".repeat(64),
    createdAt: new Date(0).toISOString(),
  });
  writeFileSync(join(stateDir, ".registry.lock"), `${JSON.stringify(stale("stale-main"))}\n`, { mode: 0o600 });
  writeFileSync(join(stateDir, ".registry.lock.recovery.guard"), `${JSON.stringify(stale("stale-guard"))}\n`, { mode: 0o600 });

  const receipt = beginAllocation(allocationOptions(f, { lockTimeoutMs: 200 }));
  assert.equal(existsSync(receipt.manifestPath), true);
  assert.equal(existsSync(join(stateDir, ".registry.lock")), false);
  assert.equal(existsSync(join(stateDir, ".registry.lock.recovery.guard")), false);
});

test("a stale writer receipt cannot unlink or write through a replacement registry lock", (t) => {
  const f = repoFixture(t);
  let replacement;
  const options = allocationOptions(f, {
    fault(event) {
      if (event.operation !== "registry-lock" || event.phase !== "acquired") return;
      const current = JSON.parse(readFileSync(event.lockPath, "utf8"));
      replacement = writeReplacementLock(event.lockPath, current);
    },
  });
  assert.throws(() => beginAllocation(options), assertCode("WORKTREE_LIFECYCLE_LOCK_LOST"));
  const lockPath = join(f.root, ".state/worktree-lifecycle/.registry.lock");
  assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).token, replacement.token);
  assert.equal(existsSync(manifestPath(f.root, options.id)), false);
});
