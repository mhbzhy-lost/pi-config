import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createTemporaryArenaSync } from "./helpers/temporary-arena.mjs";
import { createManagedWorktree, releaseManagedWorktree } from "../scripts/lib/worktree-lifecycle/managed-worktree.mjs";
import { markDisposition } from "../scripts/lib/worktree-lifecycle/registry.mjs";
import * as inventory from "../scripts/lib/worktree-lifecycle/inventory.mjs";

function git(cwd, ...args) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function branchHead(cwd, ref) { try { return execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } }
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
function stringLeaves(value) { return typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(stringLeaves) : []; }
function oneShotFault(operation, phase) { let fired = false; return (event) => { if (!fired && event.operation === operation && event.phase === phase) { fired = true; const error = new Error("fault"); error.code = "TEST_FAULT"; throw error; } }; }
function crashReceipt(f, a) { reclaim(f, a); assert.throws(() => releaseManagedWorktree({ originRoot: f.root, id: a.id, ownerToken: a.ownerToken, fault: oneShotFault("worktree-remove", "after") }), (error) => error?.code === "TEST_FAULT"); }
function stateTree(root, relative = "") {
  const path = join(root, relative); const stat = lstatSync(path); const entry = { path: relative, type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : "other", mode: stat.mode & 0o777, mtimeMs: stat.mtimeMs, ...(stat.isFile() ? { bytes: readFileSync(path) } : {}) };
  return [entry, ...(stat.isDirectory() ? readdirSync(path).sort().flatMap((name) => stateTree(root, join(relative, name))) : [])];
}
function snapshot(f, a) {
  const index = join(f.root, ".git", "index"); const file = lease(f, a.id);
  const take = (p) => ({ bytes: readFileSync(p), mode: statSync(p).mode & 0o777, mtimeMs: statSync(p).mtimeMs });
  return { manifest: take(file), index: take(index), porcelain: git(f.root, "worktree", "list", "--porcelain", "-z"), refs: git(f.root, "show-ref"), path: existsSync(a.path), stateTree: stateTree(join(f.root, ".state/worktree-lifecycle")) };
}
function assertSnapshot(f, a, before) { assert.deepEqual(snapshot(f, a), before); }
function assertKept(f, a, branchRef = a.branchRef) { assert.equal(existsSync(a.path), true); assert.equal(git(f.root, "show-ref", "--verify", "--quiet", branchRef), ""); }
const lifecycleCliScript = fileURLToPath(new URL("../scripts/worktree-lifecycle.mjs", import.meta.url));

// Real Git arena RED/green contract for migration-only stale registrations.
test("stale registration cleanup challenges exact missing prunable unowned registrations and preserves invariants", async (t) => {
  const f = repo(t, "stale-registration-");
  const stale = join(f.arena.path, "gone");
  const kept = join(f.arena.path, "kept");
  git(f.root, "worktree", "add", "-b", "gone", stale, "HEAD");
  git(f.root, "worktree", "add", "-b", "kept", kept, "HEAD");
  rmSync(stale, { recursive: true, force: true });
  const before = { head: git(f.root, "rev-parse", "HEAD"), refs: git(f.root, "show-ref"), kept: git(f.root, "worktree", "list", "--porcelain", "-z"), status: git(f.root, "status", "--porcelain=v1", "-z", "--untracked-files=all") };
  const dry = lifecycleCli(f.root, "prune-stale-registrations", "--json");
  assert.equal(dry.status, 0, dry.stderr);
  const plan = JSON.parse(dry.stdout);
  assert.match(plan.snapshotChallenge, /^[a-f0-9]{64}$/);
  assert.equal(plan.candidates.some((x) => x.path === stale), true);
  assert.equal(lifecycleCli(f.root, "prune-stale-registrations", "--apply", "--json").status, 2);
  const bad = lifecycleCli(f.root, "prune-stale-registrations", "--apply", "--challenge", "a".repeat(64), "--json");
  assert.equal(bad.status, 1); assert.equal(git(f.root, "worktree", "list", "--porcelain", "-z").includes(stale), true);
  const applied = lifecycleCli(f.root, "prune-stale-registrations", "--apply", "--challenge", plan.snapshotChallenge, "--json");
  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(JSON.parse(applied.stdout).removed, [stale]);
  const afterList = git(f.root, "worktree", "list", "--porcelain", "-z");
  assert.equal(afterList.includes(stale), false); assert.equal(afterList.includes(kept), true);
  assert.equal(git(f.root, "rev-parse", "HEAD"), before.head); assert.equal(git(f.root, "show-ref"), before.refs); assert.equal(git(f.root, "status", "--porcelain=v1", "-z", "--untracked-files=all"), before.status);
});

function lifecycleCli(root, ...args) { return spawnSync(process.execPath, [lifecycleCliScript, ...args], { cwd: root, encoding: "utf8" }); }

test("stale cleanup removes every approved missing registration sharing one challenge", async (t) => {
  const f = repo(t, "stale-multiple-");
  const first = join(f.arena.path, "first"), second = join(f.arena.path, "second");
  git(f.root, "worktree", "add", "-b", "first", first, "HEAD");
  git(f.root, "worktree", "add", "-b", "second", second, "HEAD");
  rmSync(first, { recursive: true, force: true }); rmSync(second, { recursive: true, force: true });
  const before = { refs: git(f.root, "show-ref"), head: git(f.root, "rev-parse", "HEAD"), status: git(f.root, "status", "--porcelain=v1", "-z", "--untracked-files=all") };
  const plan = await inventory.planStaleRegistrationCleanup({ originRoot: f.root });
  assert.deepEqual(plan.candidates.map((candidate) => candidate.path), [first, second]);
  const applied = await inventory.applyStaleRegistrationCleanup({ originRoot: f.root, challenge: plan.snapshotChallenge });
  assert.deepEqual(applied.removed, [first, second]);
  const registrations = git(f.root, "worktree", "list", "--porcelain", "-z");
  assert.equal(registrations.includes(first), false); assert.equal(registrations.includes(second), false);
  assert.equal(git(f.root, "show-ref"), before.refs); assert.equal(git(f.root, "rev-parse", "HEAD"), before.head); assert.equal(git(f.root, "status", "--porcelain=v1", "-z", "--untracked-files=all"), before.status);
});

test("stale cleanup retains the failed candidate and branches after partial exact removal", async (t) => {
  const f = repo(t, "stale-partial-");
  const first = join(f.arena.path, "first"), second = join(f.arena.path, "second");
  git(f.root, "worktree", "add", "-b", "first", first, "HEAD");
  git(f.root, "worktree", "add", "-b", "second", second, "HEAD");
  rmSync(first, { recursive: true, force: true }); rmSync(second, { recursive: true, force: true });
  const before = { refs: git(f.root, "show-ref"), head: git(f.root, "rev-parse", "HEAD"), status: git(f.root, "status", "--porcelain=v1", "-z", "--untracked-files=all") };
  const plan = await inventory.planStaleRegistrationCleanup({ originRoot: f.root }); let removals = 0;
  await assert.rejects(inventory.applyStaleRegistrationCleanup({ originRoot: f.root, challenge: plan.snapshotChallenge, probe: ({ kind }) => kind === "stale-registration-remove" && ++removals === 2 ? { ok: false, stdout: "", stderr: "injected" } : null }), (error) => error?.code === "WORKTREE_STALE_REGISTRATION_REMOVE_FAILED");
  const registrations = git(f.root, "worktree", "list", "--porcelain", "-z");
  assert.equal(removals, 2); assert.equal(registrations.includes(first), false); assert.equal(registrations.includes(second), true);
  assert.equal(git(f.root, "show-ref"), before.refs); assert.equal(git(f.root, "rev-parse", "HEAD"), before.head); assert.equal(git(f.root, "status", "--porcelain=v1", "-z", "--untracked-files=all"), before.status);
});

test("stale cleanup accepts detached missing registrations without changing HEAD or refs", async (t) => {
  const f = repo(t, "stale-detached-"); const stale = join(f.arena.path, "gone");
  git(f.root, "worktree", "add", "--detach", stale, "HEAD"); rmSync(stale, { recursive: true, force: true });
  const before = { head: git(f.root, "rev-parse", "HEAD"), refs: git(f.root, "show-ref") };
  const plan = await inventory.planStaleRegistrationCleanup({ originRoot: f.root });
  const candidate = plan.candidates.find((x) => x.path === stale);
  assert.equal(candidate.branch, null); assert.equal(candidate.branchHead, undefined);
  const applied = await inventory.applyStaleRegistrationCleanup({ originRoot: f.root, challenge: plan.snapshotChallenge });
  assert.deepEqual(applied.removed, [stale]); assert.equal(git(f.root, "worktree", "list", "--porcelain", "-z").includes(stale), false);
  assert.equal(git(f.root, "rev-parse", "HEAD"), before.head); assert.equal(git(f.root, "show-ref"), before.refs);
});

test("stale cleanup candidate matrix excludes present, locked, nonprunable, and owned registrations", async (t) => {
  for (const name of ["present", "locked", "nonprunable", "current-owner", "legacy-owner"]) await t.test(name, async (t) => {
    const f = repo(t, `stale-candidate-${name}-`);
    if (name.endsWith("owner")) {
      const a = allocation(f, name); reclaim(f, a);
      if (name === "legacy-owner") { const m = manifest(f, a.id); writeFileSync(lease(f, a.id), JSON.stringify({ schemaVersion: 1, id: m.id, path: m.path, originRoot: m.originRoot, ownerKind: m.ownerKind, ownerId: m.ownerId, ownerToken: m.ownerToken, state: m.state })); chmodSync(lease(f, a.id), 0o600); }
      rmSync(a.path, { recursive: true, force: true });
      const registrations = git(f.root, "worktree", "list", "--porcelain", "-z");
      assert.equal(registrations.includes(a.path), true, "fixture must retain Git registration");
      assert.equal(readFileSync(lease(f, a.id), "utf8").includes(a.path), true, "fixture manifest must match registration");
      const plan = await inventory.planStaleRegistrationCleanup({ originRoot: f.root }); assert.equal(plan.candidates.some((x) => x.path === a.path), false); return;
    }
    const path = join(f.arena.path, name); git(f.root, "worktree", "add", "-b", name, path, "HEAD");
    if (name === "present") { const plan = await inventory.planStaleRegistrationCleanup({ originRoot: f.root }); assert.equal(plan.candidates.some((x) => x.path === path), false); return; }
    if (name === "locked") git(f.root, "worktree", "lock", path);
    rmSync(path, { recursive: true, force: true });
    const options = name === "nonprunable" ? { probe: ({ kind }) => kind === "list" ? { ok: true, stdout: git(f.root, "worktree", "list", "--porcelain", "-z").replace(/prunable [^\0]+\0/, "") } : null } : {};
    const plan = await inventory.planStaleRegistrationCleanup({ originRoot: f.root, ...options }); assert.equal(plan.candidates.some((x) => x.path === path), false);
  });
});

test("stale cleanup invalid owner manifests fail closed and retain registration", async (t) => {
  for (const [name, prepare] of [
    ["malformed", (file) => writeFileSync(file, "{")],
    ["symlink", (file, f) => { const target = join(f.arena.mkdtempSync("manifest-target-"), "x.json"); writeFileSync(target, "{}"); symlinkSync(target, file); }],
    ["wrong-mode", (file) => { writeFileSync(file, "{}"); chmodSync(file, 0o644); }],
  ]) await t.test(name, async (t) => {
    const f = repo(t, `stale-invalid-${name}-`); const stale = join(f.arena.path, "gone"); git(f.root, "worktree", "add", "-b", "gone", stale, "HEAD"); rmSync(stale, { recursive: true, force: true });
    const file = join(f.root, ".state/worktree-lifecycle/leases", "bad.json"); mkdirSync(join(f.root, ".state/worktree-lifecycle/leases"), { recursive: true }); prepare(file, f);
    await assert.rejects(inventory.planStaleRegistrationCleanup({ originRoot: f.root }), (e) => e.code === "WORKTREE_STALE_REGISTRATION_MANIFEST_INVALID"); assert.equal(git(f.root, "worktree", "list", "--porcelain", "-z").includes(stale), true);
  });
});

test("stale cleanup CLI JSON exposes manifest digests but never owner tokens", (t) => {
  const f = repo(t, "stale-redaction-"); const a = allocation(f, "owned"); reclaim(f, a);
  const result = lifecycleCli(f.root, "prune-stale-registrations", "--json"); assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout); assert.equal(plan.snapshot.ownerManifests.some((x) => x.name === "owned.json" && /^[a-f0-9]{64}$/.test(x.digest)), true);
  assert.equal(result.stdout.includes(a.ownerToken), false);
});

test("stale cleanup fresh gate rejects zero-candidate manifest drift", async (t) => {
  const f = repo(t, "stale-empty-race-"); const plan = await inventory.planStaleRegistrationCleanup({ originRoot: f.root });
  let lists = 0, changed = false;
  await assert.rejects(inventory.applyStaleRegistrationCleanup({ originRoot: f.root, challenge: plan.snapshotChallenge, commandObserver: ({ args }) => { if (args.join(" ") === "worktree list --porcelain -z" && ++lists === 2) { changed = true; mkdirSync(join(f.root, ".state/worktree-lifecycle/leases"), { recursive: true }); writeFileSync(join(f.root, ".state/worktree-lifecycle/leases", "bad.json"), "{"); chmodSync(join(f.root, ".state/worktree-lifecycle/leases", "bad.json"), 0o600); } } }), (e) => e.code === "WORKTREE_STALE_REGISTRATION_MANIFEST_INVALID" || e.code === "WORKTREE_STALE_REGISTRATION_CHALLENGE_MISMATCH");
  assert.equal(lists, 2, "drift must be introduced only at apply's fresh gate"); assert.equal(changed, true);
});

test("stale cleanup rejects an approved registration that becomes present after fake successful removal", async (t) => {
  const f = repo(t, "stale-postcondition-");
  const stale = join(f.arena.path, "approved");
  git(f.root, "worktree", "add", "-b", "approved", stale, "HEAD");
  rmSync(stale, { recursive: true, force: true });
  const plan = await inventory.planStaleRegistrationCleanup({ originRoot: f.root });
  let fakeRemoval = false;
  await assert.rejects(
    inventory.applyStaleRegistrationCleanup({
      originRoot: f.root,
      challenge: plan.snapshotChallenge,
      commandObserver: ({ args }) => {
        if (args[0] === "worktree" && args[1] === "remove") {
          mkdirSync(stale);
          fakeRemoval = true;
        }
      },
      probe: ({ kind }) => kind === "stale-registration-remove"
        ? { ok: true, stdout: "", stderr: "" }
        : null,
    }),
    (error) => error?.code === "WORKTREE_STALE_REGISTRATION_POSTCONDITION_FAILED",
  );
  assert.equal(fakeRemoval, true);
  assert.equal(git(f.root, "worktree", "list", "--porcelain", "-z").includes(stale), true);
});

test("stale cleanup removes only approved registration when a stale registration appears after final gate", async (t) => {
  const f = repo(t, "stale-final-gate-race-"); const approved = join(f.arena.path, "approved"), added = join(f.arena.path, "added");
  git(f.root, "worktree", "add", "-b", "approved", approved, "HEAD"); rmSync(approved, { recursive: true, force: true });
  const plan = await inventory.planStaleRegistrationCleanup({ originRoot: f.root }); let addedAtMutation = false;
  const applied = await inventory.applyStaleRegistrationCleanup({ originRoot: f.root, challenge: plan.snapshotChallenge, commandObserver: ({ args }) => {
    if (!addedAtMutation && args[0] === "worktree" && args[1] === "remove") { addedAtMutation = true; git(f.root, "worktree", "add", "--detach", added, "HEAD"); rmSync(added, { recursive: true, force: true }); }
  } });
  const registrations = git(f.root, "worktree", "list", "--porcelain", "-z");
  assert.equal(addedAtMutation, true); assert.deepEqual(applied.removed, [approved]); assert.equal(registrations.includes(approved), false); assert.equal(registrations.includes(added), true, "post-gate stale registration must be retained");
});

test("stale cleanup binds exact prunable reason, manifests, and rejects drift before prune", async (t) => {
  const f = repo(t, "stale-drift-"); const stale = join(f.arena.path, "gone");
  git(f.root, "worktree", "add", "-b", "gone", stale, "HEAD"); rmSync(stale, { recursive: true, force: true });
  const plan = await inventory.planStaleRegistrationCleanup({ originRoot: f.root });
  assert.equal(typeof plan.snapshot.registrations.find((x) => x.path === stale).prunable, "string");
  assert.match(plan.snapshot.registrations.find((x) => x.path === stale).prunable, /gitdir file/);
  const original = plan.snapshotChallenge;
  const changedReason = await inventory.planStaleRegistrationCleanup({ originRoot: f.root, probe: ({ kind }) => kind === "list" ? { ok: true, stdout: git(f.root, "worktree", "list", "--porcelain", "-z").replace(/prunable [^\0]+/, "prunable altered-reason") } : null });
  assert.notEqual(changedReason.snapshotChallenge, original, "reason is challenge material");
  await assert.rejects(inventory.applyStaleRegistrationCleanup({ originRoot: f.root, challenge: original, probe: ({ kind }) => kind === "list" ? { ok: true, stdout: git(f.root, "worktree", "list", "--porcelain", "-z").replace(/prunable [^\0]+/, "prunable altered-reason") } : null }), (e) => e.code === "WORKTREE_STALE_REGISTRATION_CHALLENGE_MISMATCH");
  assert.equal(git(f.root, "worktree", "list", "--porcelain", "-z").includes(stale), true);
  const owned = allocation(f, "owner"); const before = await inventory.planStaleRegistrationCleanup({ originRoot: f.root });
  let changed = false;
  await assert.rejects(inventory.applyStaleRegistrationCleanup({ originRoot: f.root, challenge: before.snapshotChallenge, commandObserver: ({ args }) => { if (!changed && args.join(" ") === "show-ref") { changed = true; writeFileSync(lease(f, owned.id), Buffer.concat([readFileSync(lease(f, owned.id)), Buffer.from(" ")])); chmodSync(lease(f, owned.id), 0o600); } } }), (e) => e.code === "WORKTREE_STALE_REGISTRATION_CHALLENGE_MISMATCH");
  assert.equal(changed, true); assert.equal(git(f.root, "worktree", "list", "--porcelain", "-z").includes(stale), true);
});

test("stale cleanup rejects added candidates and candidate branch HEAD drift", async (t) => {
  const f = repo(t, "stale-matrix-"); const first = join(f.arena.path, "first");
  git(f.root, "worktree", "add", "-b", "first", first, "HEAD"); rmSync(first, { recursive: true, force: true });
  const plan = await inventory.planStaleRegistrationCleanup({ originRoot: f.root });
  const second = join(f.arena.path, "second"); git(f.root, "worktree", "add", "-b", "second", second, "HEAD"); rmSync(second, { recursive: true, force: true });
  await assert.rejects(inventory.applyStaleRegistrationCleanup({ originRoot: f.root, challenge: plan.snapshotChallenge }), (e) => e.code === "WORKTREE_STALE_REGISTRATION_CHALLENGE_MISMATCH");
  assert.equal(git(f.root, "worktree", "list", "--porcelain", "-z").includes(first), true); assert.equal(git(f.root, "worktree", "list", "--porcelain", "-z").includes(second), true);
  const fresh = await inventory.planStaleRegistrationCleanup({ originRoot: f.root }); writeFileSync(join(f.root, "drift"), "x\n"); git(f.root, "add", "drift"); git(f.root, "commit", "-m", "drift"); git(f.root, "update-ref", "refs/heads/first", "HEAD");
  await assert.rejects(inventory.applyStaleRegistrationCleanup({ originRoot: f.root, challenge: fresh.snapshotChallenge }), (e) => e.code === "WORKTREE_STALE_REGISTRATION_CHALLENGE_MISMATCH");
  assert.equal(git(f.root, "worktree", "list", "--porcelain", "-z").includes(first), true);
});

test("stale cleanup fails closed for invalid manifests and CLI rejects detached challenge", async (t) => {
  const f = repo(t, "stale-invalid-"); const stale = join(f.arena.path, "gone");
  git(f.root, "worktree", "add", "-b", "gone", stale, "HEAD"); rmSync(stale, { recursive: true, force: true });
  mkdirSync(join(f.root, ".state/worktree-lifecycle/leases"), { recursive: true }); writeFileSync(join(f.root, ".state/worktree-lifecycle/leases", "bad.json"), "{"); chmodSync(join(f.root, ".state/worktree-lifecycle/leases", "bad.json"), 0o600);
  await assert.rejects(inventory.planStaleRegistrationCleanup({ originRoot: f.root }), (e) => e.code === "WORKTREE_STALE_REGISTRATION_MANIFEST_INVALID");
  assert.equal(lifecycleCli(f.root, "prune-stale-registrations", "--challenge", "a".repeat(64)).status, 2);
  assert.equal(git(f.root, "worktree", "list", "--porcelain", "-z").includes(stale), true);
});

// The classifier is deliberately read through the namespace: old production lacks it,
// so this is a business RED rather than an import-time fixture failure.
test("RED reconciliation resource classifier requires current manifest authority and safety facts", () => {
  const classify = inventory.classifyReconciliationResources;
  assert.equal(typeof classify, "function", "inventory must export classifyReconciliationResources");
  const expected = {
    "000": ["WORKTREE_IDENTITY_MISMATCH", "none"], "001": ["WORKTREE_CLEANUP_DEBT", "release-worktree-only"],
    "010": ["WORKTREE_IDENTITY_MISMATCH", "none"], "011": ["WORKTREE_IDENTITY_MISMATCH", "none"],
    "100": ["WORKTREE_UNMANAGED", "none"], "101": ["WORKTREE_IDENTITY_MISMATCH", "none"],
    "110": ["WORKTREE_UNMANAGED", "none"], "111": ["WORKTREE_CLEANUP_DEBT", "release-worktree-only"],
  };
  const safe = { manifestAuthority: "current", state: "reclaimable", disposition: "reclaimable", clean: true, identity: true, active: false, operation: null, probeFailed: false };
  for (const [resources, [code, automaticAction]] of Object.entries(expected)) {
    const result = classify({ ...safe, resources });
    assert.equal(result.resources, resources, resources); assert.equal(result.code, code, resources); assert.equal(result.automaticAction, automaticAction, resources);
  }
  for (const resources of ["001", "111"]) {
    for (const override of [{ manifestAuthority: "legacy" }, { manifestAuthority: "invalid" }, { active: true }, { clean: false }, { operation: "sequencer" }, { state: "active" }]) {
      const result = classify({ ...safe, resources, ...override });
      assert.equal(result.automaticAction, "none", `${resources} ${JSON.stringify(override)}`);
    }
  }
});

test("RED real repository integrates strict 111 and crash receipt 001", async (t) => {
  const f = repo(t); const full = allocation(f, "full"); reclaim(f, full); const missing = allocation(f, "missing"); reclaim(f, missing);
  assert.throws(() => releaseManagedWorktree({ originRoot: f.root, id: missing.id, ownerToken: missing.ownerToken, fault: oneShotFault("worktree-remove", "after") }), (error) => error?.code === "TEST_FAULT");
  assert.equal(manifest(f, missing.id).state, "reclaimable", "crash fixture must retain its durable reclaimable manifest");
  const facts = factsById(await inventory.inventoryRepositoryWorktrees({ originRoot: f.root }));
  assert.deepEqual([facts.full.resources, facts.full.automaticAction], ["111", "release-worktree-only"]);
  assert.deepEqual([facts.missing.resources, facts.missing.automaticAction], ["001", "release-worktree-only"]);
});

test("RED strict manifest matrix rejects every unauthorized shape without removal", async (t) => {
  const cases = [
    ["0640 mode", (m) => m, (f, a) => chmodSync(lease(f, a.id), 0o640)],
    ["filename/id mismatch", (m) => ({ ...m, id: "other" })], ["manifest symlink", (m) => m, (f, a, m) => { const outside = f.arena.mkdtempSync("outside-"); const target = join(outside, "safe.json"); writeFileSync(target, JSON.stringify(m)); rmSync(lease(f, a.id)); symlinkSync(target, lease(f, a.id)); }],
    ["noncanonical origin", (m) => ({ ...m, originRoot: `${m.originRoot}/.` }), "originRoot"], ["noncanonical path", (m) => ({ ...m, path: `${m.path}/.` }), "path"], ["noncanonical common", (m) => ({ ...m, gitCommonDir: `${m.gitCommonDir}/.` }), "gitCommonDir"],
    ["illegal ref", (m) => ({ ...m, branchRef: "refs/heads/bad..ref" })], ["missing base", (m) => ({ ...m, baseCommit: "f".repeat(40) })], ["backwards timestamps", (m) => ({ ...m, createdAt: "2030-01-02T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" })],
    ["state/disposition conflict", (m) => ({ ...m, state: "active", disposition: { state: "reclaimable", reason: "x" } })], ["reclaimable lastError", (m) => ({ ...m, lastError: { code: "E", message: "legal error", at: "2020-01-01T00:00:00.000Z" } })],
  ];
  for (const [name, alter, prepare] of cases) await t.test(name, async (t) => {
    const f = repo(t, `strict-${name.replace(/[^A-Za-z0-9]/g, "-")}-`); const a = allocation(f); reclaim(f, a); const original = manifest(f, a.id); const changed = alter(original);
    if (typeof prepare === "string") { assert.notEqual(changed[prepare], original[prepare]); assert.equal(resolve(changed[prepare]), resolve(original[prepare])); }
    if (!prepare || typeof prepare === "string") { writeFileSync(lease(f, a.id), JSON.stringify(changed)); chmodSync(lease(f, a.id), 0o600); } else prepare(f, a, changed);
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
  assert.throws(() => releaseManagedWorktree({ originRoot: f.root, id: a.id, ownerToken: a.ownerToken, fault: oneShotFault("worktree-remove", "after") }), (error) => error?.code === "TEST_FAULT");
  assert.equal(manifest(f, a.id).state, "reclaimable", "crash fixture must retain its durable reclaimable manifest");
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
  const f = repo(t); const a = allocation(f); reclaim(f, a); let raced = false, originTopLevelProbes = 0;
  const commandObserver = ({ cwd, args }) => { if (cwd === f.root && JSON.stringify(args) === JSON.stringify(["rev-parse", "--show-toplevel"])) { originTopLevelProbes += 1; if (originTopLevelProbes === 2) { raced = true; const m = manifest(f, a.id); m.ownerToken = "worktree-owner.v1:" + "b".repeat(64); writeFileSync(lease(f, a.id), JSON.stringify(m)); chmodSync(lease(f, a.id), 0o600); } } };
  const report = await inventory.reconcileManagedWorktrees({ originRoot: f.root, apply: true, commandObserver }); assert.equal(raced, true, "replace the token only at the manager canonical probe, after inventory-before"); assert.ok(originTopLevelProbes >= 3, "inventory-before, manager verification, and inventory-after must probe origin identity"); assertKept(f, a);
  const item = factsById(report.items)[a.id]; assert.deepEqual([item.code, item.automaticAction], ["WORKTREE_IDENTITY_MISMATCH", "none"], "a stale owner CAS result must fail closed in this report");
});

test("RED TTL uses explicit young and old times and changes diagnostics only", async (t) => {
  const f = repo(t); const a = allocation(f); reclaim(f, a); const created = Date.parse(manifest(f, a.id).createdAt); const commands = [];
  const young = factsById((await inventory.reconcileManagedWorktrees({ originRoot: f.root, ttlMs: 1_000, now: created + 500, commandObserver: (x) => commands.push(x) })).items)[a.id];
  const old = factsById((await inventory.reconcileManagedWorktrees({ originRoot: f.root, ttlMs: 1_000, now: created + 2_000, commandObserver: (x) => commands.push(x) })).items)[a.id];
  assert.notEqual(young.severity, old.severity); assert.deepEqual({ resources: young.resources, state: young.state, automaticAction: young.automaticAction }, { resources: old.resources, state: old.state, automaticAction: old.automaticAction }); assert.ok(commands.length > 0, "observer must be forwarded");
});

test("RED current 001 receipts bind canonical common directory and a real path", async (t) => {
  const cases = [
    ["another canonical common directory", (f, m) => ({ ...m, gitCommonDir: f.arena.mkdtempSync("other-common-") })],
    ["missing candidate below symlink ancestor", (f, m) => { const ancestor = join(f.arena.mkdtempSync("path-parent-"), "linked"); symlinkSync(f.arena.path, ancestor); return { ...m, path: join(ancestor, "missing") }; }],
  ];
  for (const [name, alter] of cases) await t.test(name, async (t) => {
    const f = repo(t, "strict-current-001-"); const a = allocation(f); crashReceipt(f, a); const m = alter(f, manifest(f, a.id)); writeFileSync(lease(f, a.id), JSON.stringify(m)); chmodSync(lease(f, a.id), 0o600);
    const before = readFileSync(lease(f, a.id)); const report = await inventory.reconcileManagedWorktrees({ originRoot: f.root, apply: true }); const item = factsById(report.items)[a.id];
    assert.deepEqual([item.code, item.automaticAction], ["WORKTREE_IDENTITY_MISMATCH", "none"]); assert.equal(manifest(f, a.id).state, "reclaimable"); assert.deepEqual(readFileSync(lease(f, a.id)), before);
  });
});

test("RED 001 inventory rejects every parent directory symlink without leaking leases", async (t) => {
  for (const relative of [".state", ".state/worktree-lifecycle"]) await t.test(relative, async (t) => {
    const f = repo(t, "parent-link-"); const a = allocation(f); crashReceipt(f, a); const source = join(f.root, relative), outside = f.arena.mkdtempSync("moved-state-"); const moved = join(outside, "contents"); renameSync(source, moved); symlinkSync(moved, source);
    const before = readFileSync(lease(f, a.id)); const report = await inventory.reconcileManagedWorktrees({ originRoot: f.root, apply: true }); const text = JSON.stringify(report); const item = report.items.find((x) => x.code === "WORKTREE_IDENTITY_MISMATCH");
    assert.ok(item, "an untrusted parent directory must produce a generic identity mismatch"); assert.equal(item.automaticAction, "none"); assert.equal(stringLeaves(report).includes(a.ownerId), false); assert.equal(text.includes(a.ownerToken), false); assert.deepEqual(readFileSync(lease(f, a.id)), before);
  });
});

test("RED manifest state semantics reject shape-valid inconsistent receipts without apply mutation", async (t) => {
  const cases = [
    ["preserved needs head", (m) => ({ ...m, state: "preserved", disposition: { state: "preserved", reason: "hold" }, headCommit: null })],
    ["preserved forbids lastError", (m) => ({ ...m, state: "preserved", disposition: { state: "preserved", reason: "hold" }, lastError: { code: "E", message: "legal", at: m.updatedAt } })],
    ["cleanup-debt needs lastError", (m) => ({ ...m, state: "cleanup-debt", disposition: { state: "cleanup-debt", reason: "debt" }, lastError: null })],
    ["active needs head", (m) => ({ ...m, state: "active", disposition: null, headCommit: null })],
    ["allocating forbids head", (m) => ({ ...m, state: "allocating", disposition: null, headCommit: m.baseCommit })],
    ["released disposition must agree", (m) => ({ ...m, state: "released", disposition: { state: "preserved", reason: "wrong" }, headCommit: null })],
  ];
  for (const [name, alter] of cases) await t.test(name, async (t) => {
    const f = repo(t, "state-semantics-"); const a = allocation(f); const changed = alter(manifest(f, a.id)); writeFileSync(lease(f, a.id), JSON.stringify(changed)); chmodSync(lease(f, a.id), 0o600); const before = readFileSync(lease(f, a.id));
    const report = await inventory.reconcileManagedWorktrees({ originRoot: f.root, apply: true }); assert.equal(report.items.some((x) => x.code === "WORKTREE_IDENTITY_MISMATCH"), true); assert.deepEqual(readFileSync(lease(f, a.id)), before);
  });
});

test("RED duplicate current 001 receipts sharing path and branch are never candidates", async (t) => {
  const f = repo(t); const first = allocation(f, "first"); const second = allocation(f, "second"); crashReceipt(f, first); crashReceipt(f, second); const duplicate = { ...manifest(f, second.id), path: manifest(f, first.id).path, branchRef: manifest(f, first.id).branchRef }; writeFileSync(lease(f, second.id), JSON.stringify(duplicate)); chmodSync(lease(f, second.id), 0o600);
  const before = [readFileSync(lease(f, first.id)), readFileSync(lease(f, second.id))]; const report = await inventory.reconcileManagedWorktrees({ originRoot: f.root, apply: true });
  for (const id of [first.id, second.id]) assert.deepEqual([factsById(report.items)[id].code, factsById(report.items)[id].automaticAction], ["WORKTREE_IDENTITY_MISMATCH", "none"]); assert.deepEqual([readFileSync(lease(f, first.id)), readFileSync(lease(f, second.id))], before);
});

test("RED released 001 apply verifies idempotence through all origin identity probes", async (t) => {
  const f = repo(t); const a = allocation(f); reclaim(f, a); releaseManagedWorktree({ originRoot: f.root, id: a.id, ownerToken: a.ownerToken }); const before = readFileSync(lease(f, a.id)); const commands = [];
  const report = await inventory.reconcileManagedWorktrees({ originRoot: f.root, apply: true, commandObserver: (x) => commands.push(x) }); const topLevels = commands.filter((x) => x.cwd === f.root && JSON.stringify(x.args) === JSON.stringify(["rev-parse", "--show-toplevel"]));
  assert.ok(topLevels.length >= 3, "inventory-before, manager verification, and inventory-after must each probe origin identity"); assert.equal(factsById(report.items)[a.id].state, "released"); assert.equal(git(f.root, "show-ref", "--verify", "--quiet", a.branchRef), ""); assert.deepEqual(readFileSync(lease(f, a.id)), before);
});

test("RED inventory observer sees all origin identity and registration probes", async (t) => {
  const f = repo(t); const commands = []; await inventory.inventoryRepositoryWorktrees({ originRoot: f.root, commandObserver: (x) => commands.push(x) });
  for (const args of [["rev-parse", "--show-toplevel"], ["rev-parse", "--git-common-dir"], ["worktree", "list", "--porcelain", "-z"]]) assert.equal(commands.some((x) => x.cwd === f.root && JSON.stringify(x.args) === JSON.stringify(args)), true, `missing observer event for ${args.join(" ")}`);
});

test("RED malformed legacy manifests fail closed without leaking their sentinel", async (t) => {
  for (const [id, raw] of [["schema-only", { schemaVersion: 1 }], ["missing-path", { schemaVersion: 1, id: "missing-path", state: "reclaimable" }], ["missing-id", { schemaVersion: 1, path: "/missing", state: "reclaimable" }], ["missing-state", { schemaVersion: 1, id: "missing-state", path: "/missing" }]]) await t.test(id, async (t) => {
    const f = repo(t, "malformed-legacy-"); const secret = `legacy-secret-${id}`;
    mkdirSync(join(f.root, ".state/worktree-lifecycle/leases"), { recursive: true, mode: 0o700 }); writeFileSync(lease(f, id), JSON.stringify({ ...raw, secret })); chmodSync(lease(f, id), 0o600);
    let inventoryReport, report;
    await assert.doesNotReject(async () => { inventoryReport = await inventory.inventoryRepositoryWorktrees({ originRoot: f.root }); });
    await assert.doesNotReject(async () => { report = await inventory.reconcileManagedWorktrees({ originRoot: f.root, apply: true }); });
    for (const result of [inventoryReport, report.items]) {
      assert.equal(JSON.stringify(result).includes(secret), false);
      assert.equal(result.some((item) => item.code === "WORKTREE_IDENTITY_MISMATCH" && item.automaticAction === "none"), true);
    }
  });
});

test("RED current 001 receipts require their branch to exist at the receipt head", async (t) => {
  for (const [name, mutate] of [["deleted", (f, a) => git(f.root, "update-ref", "-d", a.branchRef)], ["moved", (f, a) => { writeFileSync(join(f.root, "other"), "other\n"); git(f.root, "add", "other"); git(f.root, "commit", "-m", "other"); git(f.root, "update-ref", a.branchRef, "HEAD"); }]]) await t.test(name, async (t) => {
    const f = repo(t, "001-branch-"); const a = allocation(f); crashReceipt(f, a); const before = readFileSync(lease(f, a.id)); mutate(f, a);
    const main = git(f.root, "rev-parse", "refs/heads/main"); const branchBefore = branchHead(f.root, a.branchRef); const report = await inventory.reconcileManagedWorktrees({ originRoot: f.root, apply: true }); const item = factsById(report.items)[a.id];
    assert.deepEqual([item.code, item.automaticAction], ["WORKTREE_IDENTITY_MISMATCH", "none"]); assert.equal(manifest(f, a.id).state, "reclaimable"); assert.deepEqual(readFileSync(lease(f, a.id)), before); assert.equal(git(f.root, "rev-parse", "refs/heads/main"), main); assert.equal(branchHead(f.root, a.branchRef), branchBefore);
  });
});

test("RED reconciliation applies the inventory owner token, not a replacement observed later", async (t) => {
  const f = repo(t); const a = allocation(f); reclaim(f, a); const before = readFileSync(lease(f, a.id)); let commonProbes = 0, replaced = false;
  const commandObserver = ({ cwd, args }) => { if (cwd === f.root && JSON.stringify(args) === JSON.stringify(["rev-parse", "--git-common-dir"]) && ++commonProbes === 2) { const m = manifest(f, a.id); m.ownerToken = "worktree-owner.v1:" + "c".repeat(64); writeFileSync(lease(f, a.id), JSON.stringify(m)); chmodSync(lease(f, a.id), 0o600); replaced = true; } };
  const report = await inventory.reconcileManagedWorktrees({ originRoot: f.root, apply: true, commandObserver }); const item = factsById(report.items)[a.id];
  assert.equal(replaced, true); assert.deepEqual([item.code, item.automaticAction], ["WORKTREE_IDENTITY_MISMATCH", "none"]); assertKept(f, a); assert.deepEqual(readFileSync(lease(f, a.id)), Buffer.from(JSON.stringify({ ...JSON.parse(before), ownerToken: "worktree-owner.v1:" + "c".repeat(64) })));
});

test("RED reconcile CLI defaults to a redacted dry-run and applies only through the manager", (t) => {
  const f = repo(t); const a = allocation(f); reclaim(f, a); const before = snapshot(f, a);
  const dry = lifecycleCli(f.root, "reconcile", "--json"); assert.equal(dry.status, 0, dry.stderr); const report = JSON.parse(dry.stdout);
  assert.equal(report.apply, false); assert.equal(JSON.stringify(report).includes(a.ownerToken), false); const item = factsById(report.items)[a.id]; assert.equal(item.path, a.path); assert.equal(item.registration.path, a.path); assert.equal(item.registration.branch, a.branchRef); assertSnapshot(f, a, before);
  const text = lifecycleCli(f.root, "reconcile"); assert.equal(text.status, 0, text.stderr); assert.equal(text.stdout.includes("undefined"), false);
  const applied = lifecycleCli(f.root, "reconcile", "--apply", "--json"); assert.equal(applied.status, 0, applied.stderr); assert.equal(JSON.parse(applied.stdout).apply, true); assert.equal(existsSync(a.path), false); assert.equal(git(f.root, "show-ref", "--verify", "--quiet", a.branchRef), "");
});

test("RED lifecycle CLI parses flags per command before touching resources", (t) => {
  const f = repo(t); const cases = [
    ["audit irrelevant known", ["audit", "--id", "x"]], ["reconcile irrelevant known", ["reconcile", "--id", "x"]], ["release irrelevant known", ["release", "--path", "x", "--id", "x", "--owner-token", "t"]],
    ["duplicate", ["reconcile", "--json", "--json"]], ["unknown", ["audit", "--wat"]], ["positional", ["audit", "extra"]], ["missing value", ["create", "--id"]], ["apply equals", ["reconcile", "--apply=false"]], ["create apply", ["create", "--apply"]],
    ["adopt irrelevant", ["adopt", "--reason", "x"]], ["preserve irrelevant", ["preserve", "--branch", "x"]],
  ];
  for (const [name, args] of cases) { const before = git(f.root, "worktree", "list", "--porcelain", "-z"); const result = lifecycleCli(f.root, ...args); assert.equal(result.status, 2, name); assert.match(result.stderr, /^WORKTREE_LIFECYCLE_CLI_USAGE:/, name); assert.equal(git(f.root, "worktree", "list", "--porcelain", "-z"), before, name); }
});

test("RED duplicate released 001 receipts are not passed to the manager", async (t) => {
  const f = repo(t); const first = allocation(f, "released-first"); const second = allocation(f, "released-second"); reclaim(f, first); reclaim(f, second); releaseManagedWorktree({ originRoot: f.root, id: first.id, ownerToken: first.ownerToken }); releaseManagedWorktree({ originRoot: f.root, id: second.id, ownerToken: second.ownerToken });
  const duplicate = { ...manifest(f, second.id), path: manifest(f, first.id).path, branchRef: manifest(f, first.id).branchRef }; writeFileSync(lease(f, second.id), JSON.stringify(duplicate)); chmodSync(lease(f, second.id), 0o600); const before = [readFileSync(lease(f, first.id)), readFileSync(lease(f, second.id))], refs = git(f.root, "show-ref"); let topLevels = 0;
  const report = await inventory.reconcileManagedWorktrees({ originRoot: f.root, apply: true, commandObserver: ({ cwd, args }) => { if (cwd === f.root && JSON.stringify(args) === JSON.stringify(["rev-parse", "--show-toplevel"])) topLevels += 1; } });
  for (const id of [first.id, second.id]) assert.deepEqual([factsById(report.items)[id].code, factsById(report.items)[id].automaticAction], ["WORKTREE_IDENTITY_MISMATCH", "none"]);
  assert.equal(topLevels, 2, "only inventory-before and inventory-after may probe the origin top-level"); assert.deepEqual([readFileSync(lease(f, first.id)), readFileSync(lease(f, second.id))], before); assert.equal(git(f.root, "show-ref"), refs);
});
