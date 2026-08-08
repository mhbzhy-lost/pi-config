import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createTemporaryArenaSync } from "./helpers/temporary-arena.mjs";
import { createManagedWorktree, releaseManagedWorktree } from "../scripts/lib/worktree-lifecycle/managed-worktree.mjs";
import { markDisposition } from "../scripts/lib/worktree-lifecycle/registry.mjs";
import { inventoryRepositoryWorktrees, reconcileManagedWorktrees } from "../scripts/lib/worktree-lifecycle/inventory.mjs";

function git(cwd, ...args) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function repo(t, prefix = "worktree-recovery-") {
  const arena = createTemporaryArenaSync(prefix); t.after(() => arena.disposeSync());
  const root = arena.mkdtempSync("repo-"); git(root, "init", "--initial-branch=main"); git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "user.name", "Test");
  writeFileSync(join(root, ".gitignore"), ".state/\n"); writeFileSync(join(root, "a"), "a\n"); git(root, "add", "."); git(root, "commit", "-m", "initial");
  return { root, base: git(root, "rev-parse", "HEAD") };
}
function allocation(f, id = "safe") { return createManagedWorktree({ originRoot: f.root, id, branch: id, baseCommit: f.base, owner: { kind: "test", id: "one" } }); }
function reclaim(f, a) { markDisposition({ originRoot: f.root, id: a.id, ownerToken: a.ownerToken, disposition: "reclaimable" }); }
function lease(f, id) { return join(f.root, ".state/worktree-lifecycle/leases", `${id}.json`); }
function manifest(f, id) { return JSON.parse(readFileSync(lease(f, id), "utf8")); }
function factsById(facts) { return Object.fromEntries(facts.filter((x) => x.id).map((x) => [x.id, x])); }
function oneShotFault(operation, phase) { let fired = false; return (event) => { if (!fired && event.operation === operation && event.phase === phase) { fired = true; const error = new Error("fault"); error.code = "TEST_FAULT"; throw error; } }; }

// This is deliberately a real managed repository: the bit-map is an external contract,
// not a copy of inventory's implementation.
test("RED resource bitmap is stable and only strict reclaimable 111/001 are candidates", async (t) => {
  const f = repo(t); const full = allocation(f, "full"); reclaim(f, full);
  const missing = allocation(f, "missing"); reclaim(f, missing);
  assert.throws(() => releaseManagedWorktree({ originRoot: f.root, id: missing.id, ownerToken: missing.ownerToken, fault: oneShotFault("worktree-remove", "after") }), /fault/);
  const byId = factsById(await inventoryRepositoryWorktrees({ originRoot: f.root }));
  assert.deepEqual({ resources: byId.full.resources, state: byId.full.state, eligible: byId.full.automaticAction }, { resources: "111", state: "reclaimable", eligible: "release-worktree-only" });
  // A post-remove crash is the durable 001 recovery receipt, not permission to infer
  // ownership from any partial resource combination.
  assert.deepEqual({ resources: byId.missing.resources, state: byId.missing.state, eligible: byId.missing.automaticAction }, { resources: "001", state: "reclaimable", eligible: "release-worktree-only" });
  for (const bits of ["000", "010", "011", "100", "101", "110"]) {
    const item = (await inventoryRepositoryWorktrees({ originRoot: f.root })).find((x) => x.resources === bits);
    if (item) assert.equal(item.automaticAction, "none", `${bits} must fail closed`);
  }
});

test("RED strict manifests reject every non-authoritative shape and never apply", async (t) => {
  const cases = [
    ["extra", (m) => ({ ...m, probe: "stdout-sentinel" })],
    ["owner blank", (m) => ({ ...m, ownerId: " " })],
    ["owner token", (m) => ({ ...m, ownerToken: "owner-token" })],
    ["origin", (m) => ({ ...m, originRoot: "/tmp/not-canonical" })],
    ["common", (m) => ({ ...m, gitCommonDir: "/tmp/not-common" })],
    ["branch", (m) => ({ ...m, branchRef: "topic" })],
    ["hash", (m) => ({ ...m, headCommit: "not-a-hash" })],
    ["time", (m) => ({ ...m, updatedAt: "never" })],
    ["disposition", (m) => ({ ...m, disposition: { state: "bogus", reason: 1 } })],
    ["lastError", (m) => ({ ...m, lastError: { code: 1, message: "stderr-sentinel", at: "no" } })],
  ];
  for (const [name, alter] of cases) {
    await t.test(name, async (t) => {
      const f = repo(t, `strict-${name}-`); const a = allocation(f, "safe"); reclaim(f, a);
      writeFileSync(lease(f, a.id), JSON.stringify(alter(manifest(f, a.id)))); chmodSync(lease(f, a.id), 0o600);
      const before = existsSync(a.path); const report = await reconcileManagedWorktrees({ originRoot: f.root, apply: true });
      assert.equal(report.items.some((x) => x.code === "WORKTREE_IDENTITY_MISMATCH"), true);
      assert.equal(existsSync(a.path), before, `${name} must not apply`);
    });
  }
});

test("RED manifest and leases symlinks are not followed", async (t) => {
  const f = repo(t); const a = allocation(f); reclaim(f, a);
  const outside = f.root + "-outside"; mkdirSync(outside); writeFileSync(join(outside, "safe.json"), readFileSync(lease(f, a.id)));
  // A directory symlink is distinct from a symlinked JSON file and must be rejected too.
  git(f.root, "worktree", "remove", a.path); rmSync(join(f.root, ".state/worktree-lifecycle/leases"), { recursive: true, force: true });
  symlinkSync(outside, join(f.root, ".state/worktree-lifecycle/leases"));
  const report = await reconcileManagedWorktrees({ originRoot: f.root, apply: true });
  assert.equal(report.items.some((x) => x.code === "WORKTREE_IDENTITY_MISMATCH"), true);
});

test("RED report recursively redacts manifest secrets and dry-run is byte-for-byte read-only", async (t) => {
  const f = repo(t); const a = allocation(f); reclaim(f, a); const file = lease(f, a.id);
  const before = readFileSync(file); const beforeMode = (await import("node:fs")).statSync(file).mode; const beforeNames = readdirSync(join(f.root, ".state/worktree-lifecycle/leases")).sort();
  const m = manifest(f, a.id); m.lastError = { code: "E", message: "stderr-sentinel stdout-sentinel", at: new Date().toISOString() }; m.ownerToken = "worktree-owner.v1:" + "a".repeat(64); writeFileSync(file, JSON.stringify(m)); chmodSync(file, 0o600);
  const report = await reconcileManagedWorktrees({ originRoot: f.root }); const text = JSON.stringify(report);
  for (const secret of [m.ownerToken, "stderr-sentinel", "stdout-sentinel"]) assert.equal(text.includes(secret), false);
  assert.deepEqual(readFileSync(file), Buffer.from(JSON.stringify(m)));
  assert.equal((await import("node:fs")).statSync(file).mode, beforeMode);
  assert.deepEqual(readdirSync(join(f.root, ".state/worktree-lifecycle/leases")).sort(), beforeNames);
  assert.equal(existsSync(a.path), true);
  void before;
});

test("RED crash 001 dry-runs without mutation then apply repairs released receipt idempotently", async (t) => {
  const f = repo(t); const a = allocation(f); reclaim(f, a); const branch = `refs/heads/${a.branch}`;
  assert.throws(() => releaseManagedWorktree({ originRoot: f.root, id: a.id, ownerToken: a.ownerToken, fault: oneShotFault("worktree-remove", "after") }), /fault/);
  const before = readFileSync(lease(f, a.id)); const dry = await reconcileManagedWorktrees({ originRoot: f.root });
  assert.equal(factsById(dry.items)[a.id].resources, "001"); assert.equal(readFileSync(lease(f, a.id)).equals(before), true);
  const applied = await reconcileManagedWorktrees({ originRoot: f.root, apply: true }); assert.equal(factsById(applied.items)[a.id].state, "released");
  assert.equal((await reconcileManagedWorktrees({ originRoot: f.root, apply: true })).items.find((x) => x.id === a.id).state, "released");
  assert.equal(git(f.root, "show-ref", "--verify", "--quiet", branch), "");
});

test("RED reconcile forwards a constrained command observer and TTL changes diagnostics only", async (t) => {
  const f = repo(t); const a = allocation(f); reclaim(f, a); const commands = [];
  const young = await reconcileManagedWorktrees({ originRoot: f.root, ttlMs: 1, now: 1, commandObserver: (x) => commands.push(x) });
  const old = await reconcileManagedWorktrees({ originRoot: f.root, ttlMs: 1, now: Date.now() + 100000, commandObserver: (x) => commands.push(x) });
  const y = factsById(young.items)[a.id]; const o = factsById(old.items)[a.id];
  assert.notEqual(y.severity, o.severity, "age is diagnostic, not authorization");
  assert.deepEqual([y.resources, y.state, y.automaticAction], [o.resources, o.state, o.automaticAction]);
  await reconcileManagedWorktrees({ originRoot: f.root, apply: true, commandObserver: (x) => commands.push(x) });
  assert.ok(commands.some((x) => x.args?.[0] === "worktree" && x.args[1] === "remove"), "manager observer must see apply");
  for (const x of commands) assert.equal(x.args?.includes("--force") || x.args?.includes("prune") || x.args?.some((v) => /delete-ref|branch/.test(v)), false);
});

// Preserve the two pre-existing recovery regressions while expanding the safety matrix.
test("reconcile dry-run is redacted and apply releases only a durable reclaimable owner", async (t) => {
  const f = repo(t); const a = allocation(f); reclaim(f, a);
  const dry = await reconcileManagedWorktrees({ originRoot: f.root });
  assert.equal(dry.items.find((item) => item.id === a.id).automaticAction, "release-worktree-only");
  assert.equal(JSON.stringify(dry).includes(a.ownerToken), false);
  assert.equal(existsSync(a.path), true);
  const applied = await reconcileManagedWorktrees({ originRoot: f.root, apply: true });
  assert.equal(applied.items.find((item) => item.id === a.id).state, "released");
  assert.equal(existsSync(a.path), false);
  assert.equal(git(f.root, "show-ref", "--verify", "--quiet", "refs/heads/safe"), "");
});
test("manifest-only malformed files fail closed without following symlinks", async (t) => {
  const f = repo(t); mkdirSync(join(f.root, ".state/worktree-lifecycle/leases"), { recursive: true });
  writeFileSync(join(f.root, ".state/worktree-lifecycle/leases/bad.json"), "{");
  const report = await reconcileManagedWorktrees({ originRoot: f.root });
  assert.equal(report.items.some((item) => item.code === "WORKTREE_IDENTITY_MISMATCH"), true);
});
