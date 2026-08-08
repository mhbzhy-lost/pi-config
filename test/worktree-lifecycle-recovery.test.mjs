import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { createTemporaryArenaSync } from "./helpers/temporary-arena.mjs";
import { createManagedWorktree, releaseManagedWorktree } from "../scripts/lib/worktree-lifecycle/managed-worktree.mjs";
import { markDisposition } from "../scripts/lib/worktree-lifecycle/registry.mjs";
import * as inventory from "../scripts/lib/worktree-lifecycle/inventory.mjs";

function git(cwd, ...args) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function repo(t, prefix = "worktree-recovery-") {
  const arena = createTemporaryArenaSync(prefix); t.after(() => arena.disposeSync());
  const root = arena.mkdtempSync("repo-"); git(root, "init", "--initial-branch=main"); git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "user.name", "Test");
  writeFileSync(join(root, ".gitignore"), ".state/\n"); writeFileSync(join(root, "a"), "a\n"); git(root, "add", "."); git(root, "commit", "-m", "initial");
  return { arena, root, base: git(root, "rev-parse", "HEAD") };
}
function allocation(f, id = "safe") { return createManagedWorktree({ originRoot: f.root, id, branch: id, baseCommit: f.base, owner: { kind: "test", id: "one" } }); }
function reclaim(f, a) { markDisposition({ originRoot: f.root, id: a.id, ownerToken: a.ownerToken, disposition: "reclaimable" }); }
function lease(f, id) { return join(f.root, ".state/worktree-lifecycle/leases", `${id}.json`); }
function manifest(f, id) { return JSON.parse(readFileSync(lease(f, id), "utf8")); }
function factsById(facts) { return Object.fromEntries(facts.filter((x) => x.id).map((x) => [x.id, x])); }
function oneShotFault(operation, phase) { let fired = false; return (event) => { if (!fired && event.operation === operation && event.phase === phase) { fired = true; throw new Error("fault"); } }; }
function snapshot(f, a) {
  const index = join(f.root, ".git", "index"); const file = lease(f, a.id);
  const take = (p) => ({ bytes: readFileSync(p), mode: statSync(p).mode & 0o777, mtimeMs: statSync(p).mtimeMs });
  return { manifest: take(file), index: take(index), porcelain: git(f.root, "worktree", "list", "--porcelain", "-z"), refs: git(f.root, "show-ref"), path: existsSync(a.path), names: readdirSync(join(f.root, ".state/worktree-lifecycle/leases")).sort() };
}
function assertSnapshot(f, a, before) {
  const after = snapshot(f, a); assert.deepEqual(after, before); const state = join(f.root, ".state/worktree-lifecycle");
  assert.deepEqual(readdirSync(state).filter((x) => /(?:lock|tmp|temp)/i.test(x)), [], "dry-run left state lock/temp");
}
function assertKept(f, a, branchRef = a.branchRef) { assert.equal(existsSync(a.path), true); assert.equal(git(f.root, "show-ref", "--verify", "--quiet", branchRef), ""); }

// The classifier is deliberately read through the namespace: old production lacks it,
// so this is a business RED rather than an import-time fixture failure.
test("RED reconciliation resource classifier enumerates every 000..111 bitmap", () => {
  const classify = inventory.classifyReconciliationResources;
  assert.equal(typeof classify, "function", "inventory must export classifyReconciliationResources");
  const expected = {
    "000": "none", "001": "release-worktree-only", "010": "none", "011": "none",
    "100": "none", "101": "none", "110": "none", "111": "release-worktree-only",
  };
  for (const [resources, automaticAction] of Object.entries(expected)) assert.deepEqual(classify(resources), { resources, automaticAction }, resources);
});

test("RED real repository integrates strict 111 and crash receipt 001", async (t) => {
  const f = repo(t); const full = allocation(f, "full"); reclaim(f, full); const missing = allocation(f, "missing"); reclaim(f, missing);
  assert.throws(() => releaseManagedWorktree({ originRoot: f.root, id: missing.id, ownerToken: missing.ownerToken, fault: oneShotFault("worktree-remove", "after") }), /fault/);
  const facts = factsById(await inventory.inventoryRepositoryWorktrees({ originRoot: f.root }));
  assert.deepEqual([facts.full.resources, facts.full.automaticAction], ["111", "release-worktree-only"]);
  assert.deepEqual([facts.missing.resources, facts.missing.automaticAction], ["001", "release-worktree-only"]);
});

test("RED strict manifest matrix rejects every unauthorized shape without removal", async (t) => {
  const cases = [
    ["0640 mode", (m) => m, (f, a) => chmodSync(lease(f, a.id), 0o640)],
    ["filename/id mismatch", (m) => ({ ...m, id: "other" })], ["manifest symlink", (m) => m, (f, a, m) => { const outside = f.arena.mkdtempSync("outside-"); const target = join(outside, "safe.json"); writeFileSync(target, JSON.stringify(m)); rmSync(lease(f, a.id)); symlinkSync(target, lease(f, a.id)); }],
    ["noncanonical origin", (m) => ({ ...m, originRoot: join(m.originRoot, ".") })], ["noncanonical path", (m) => ({ ...m, path: join(m.path, ".") })], ["noncanonical common", (m) => ({ ...m, gitCommonDir: join(m.gitCommonDir, ".") })],
    ["illegal ref", (m) => ({ ...m, branchRef: "refs/heads/bad..ref" })], ["missing base", (m) => ({ ...m, baseCommit: "f".repeat(40) })], ["backwards timestamps", (m) => ({ ...m, createdAt: "2030-01-02T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" })],
    ["state/disposition conflict", (m) => ({ ...m, state: "active", disposition: { state: "reclaimable", reason: "x" } })], ["reclaimable lastError", (m) => ({ ...m, lastError: { code: "E", message: "legal error", at: "2020-01-01T00:00:00.000Z" } })],
  ];
  for (const [name, alter, prepare] of cases) await t.test(name, async (t) => {
    const f = repo(t, `strict-${name.replace(/[^A-Za-z0-9]/g, "-")}-`); const a = allocation(f); reclaim(f, a); const changed = alter(manifest(f, a.id));
    if (!prepare) { writeFileSync(lease(f, a.id), JSON.stringify(changed)); chmodSync(lease(f, a.id), 0o600); } else prepare(f, a, changed);
    const report = await inventory.reconcileManagedWorktrees({ originRoot: f.root, apply: true });
    assert.equal(report.items.some((x) => x.code === "WORKTREE_IDENTITY_MISMATCH"), true); assertKept(f, a);
  });
});

test("RED leases directory symlink is rejected without escaping its arena", async (t) => {
  const f = repo(t); const a = allocation(f); reclaim(f, a); const outside = f.arena.mkdtempSync("outside-"); writeFileSync(join(outside, "safe.json"), readFileSync(lease(f, a.id)));
  git(f.root, "worktree", "remove", a.path); rmSync(join(f.root, ".state/worktree-lifecycle/leases"), { recursive: true, force: true }); symlinkSync(outside, join(f.root, ".state/worktree-lifecycle/leases"));
  const report = await inventory.reconcileManagedWorktrees({ originRoot: f.root, apply: true }); assert.equal(report.items.some((x) => x.code === "WORKTREE_IDENTITY_MISMATCH"), true);
});

test("RED dry-run leaves a valid reclaimable repository byte-for-byte unchanged", async (t) => {
  const f = repo(t); const a = allocation(f); reclaim(f, a); const before = snapshot(f, a);
  await inventory.reconcileManagedWorktrees({ originRoot: f.root }); assertSnapshot(f, a, before);
});

test("RED report recursively redacts cleanup-debt manifest and probe sentinels", async (t) => {
  const f = repo(t); const a = allocation(f); const m = manifest(f, a.id); const token = m.ownerToken;
  m.state = "cleanup-debt"; m.disposition = { state: "cleanup-debt", reason: "stderr-sentinel" }; m.lastError = { code: "E", message: "last-error-sentinel", at: "2020-01-01T00:00:00.000Z" }; writeFileSync(lease(f, a.id), JSON.stringify(m)); chmodSync(lease(f, a.id), 0o600);
  const report = await inventory.reconcileManagedWorktrees({ originRoot: f.root, probe: () => ({ ok: false, stdout: "stdout-sentinel", stderr: "stderr-sentinel" }) }); const text = JSON.stringify(report);
  for (const secret of [token, "last-error-sentinel", "stdout-sentinel", "stderr-sentinel"]) assert.equal(text.includes(secret), false);
});

test("RED 001 apply releases receipt branchRef and preserves it in dry-run", async (t) => {
  const f = repo(t); const a = allocation(f); reclaim(f, a); const branchRef = a.branchRef;
  assert.throws(() => releaseManagedWorktree({ originRoot: f.root, id: a.id, ownerToken: a.ownerToken, fault: oneShotFault("worktree-remove", "after") }), /fault/);
  const before = snapshot(f, a); const dry = await inventory.reconcileManagedWorktrees({ originRoot: f.root }); assert.equal(factsById(dry.items)[a.id].resources, "001"); assertSnapshot(f, a, before);
  const applied = await inventory.reconcileManagedWorktrees({ originRoot: f.root, apply: true }); assert.equal(factsById(applied.items)[a.id].state, "released"); assert.equal(git(f.root, "show-ref", "--verify", "--quiet", branchRef), "");
});

test("RED authorization rejection table keeps path registration and branch", async (t) => {
  const cases = [
    ["current active", () => ({} )], ["preserved", (f, a) => markDisposition({ originRoot: f.root, id: a.id, ownerToken: a.ownerToken, disposition: "preserved" })],
    ["dirty reclaimable", (f, a) => { reclaim(f, a); writeFileSync(join(a.path, "dirty"), "x"); }], ["active process cwd", (f, a) => reclaim(f, a), (a) => [a.path]],
    ["legacy schema", (f, a) => { reclaim(f, a); const m = manifest(f, a.id); m.schemaVersion = 1; writeFileSync(lease(f, a.id), JSON.stringify(m)); chmodSync(lease(f, a.id), 0o600); }],
  ];
  for (const [name, setup, activeProcessCwds] of cases) await t.test(name, async (t) => { const f = repo(t, `reject-${name}-`); const a = allocation(f); setup(f, a); await inventory.reconcileManagedWorktrees({ originRoot: f.root, apply: true, activeProcessCwds: activeProcessCwds?.(a) }); assertKept(f, a); });
  await t.test("unmanaged", async (t) => { const f = repo(t, "reject-unmanaged-"); const path = f.arena.mkdtempSync("unmanaged-"); git(f.root, "worktree", "add", "-b", "unmanaged", path, f.base); await inventory.reconcileManagedWorktrees({ originRoot: f.root, apply: true }); assert.equal(existsSync(path), true); assert.equal(git(f.root, "show-ref", "--verify", "--quiet", "refs/heads/unmanaged"), ""); });
});

test("RED owner CAS race refuses removal when observer sees origin identity probe", async (t) => {
  const f = repo(t); const a = allocation(f); reclaim(f, a); let raced = false;
  const commandObserver = ({ cwd, args }) => { if (!raced && cwd === f.root && JSON.stringify(args) === JSON.stringify(["rev-parse", "--show-toplevel"])) { raced = true; const m = manifest(f, a.id); m.ownerToken = "worktree-owner.v1:" + "b".repeat(64); writeFileSync(lease(f, a.id), JSON.stringify(m)); chmodSync(lease(f, a.id), 0o600); } };
  await inventory.reconcileManagedWorktrees({ originRoot: f.root, apply: true, commandObserver }); assert.equal(raced, true, "reconcile must forward commandObserver"); assertKept(f, a);
});

test("RED TTL uses explicit young and old times and changes diagnostics only", async (t) => {
  const f = repo(t); const a = allocation(f); reclaim(f, a); const created = Date.parse(manifest(f, a.id).createdAt); const commands = [];
  const young = factsById((await inventory.reconcileManagedWorktrees({ originRoot: f.root, ttlMs: 1_000, now: created + 500, commandObserver: (x) => commands.push(x) })).items)[a.id];
  const old = factsById((await inventory.reconcileManagedWorktrees({ originRoot: f.root, ttlMs: 1_000, now: created + 2_000, commandObserver: (x) => commands.push(x) })).items)[a.id];
  assert.notEqual(young.severity, old.severity); assert.deepEqual({ resources: young.resources, state: young.state, automaticAction: young.automaticAction }, { resources: old.resources, state: old.state, automaticAction: old.automaticAction }); assert.ok(commands.length > 0, "observer must be forwarded");
});
