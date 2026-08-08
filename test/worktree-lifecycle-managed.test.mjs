import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createTemporaryArenaSync } from "./helpers/temporary-arena.mjs";

const managedPath = "../scripts/lib/worktree-lifecycle/managed-worktree.mjs";
const registryPath = "../scripts/lib/worktree-lifecycle/registry.mjs";
const missing = (name) => () => { throw new Error(`RED: managed worktree API ${name} is not implemented`); };
const managed = await import(managedPath).catch(() => ({
  __missing: true,
  createManagedWorktree: missing("createManagedWorktree"),
  preserveManagedWorktree: missing("preserveManagedWorktree"),
  releaseManagedWorktree: missing("releaseManagedWorktree"),
}));
const registry = await import(registryPath).catch(() => ({ markDisposition: missing("markDisposition") }));
const { createManagedWorktree, preserveManagedWorktree, releaseManagedWorktree } = managed;
const { markDisposition } = registry;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitResult(cwd, ...args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function repoFixture(t, prefix = "worktree-managed-") {
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
  return { root, baseCommit: git(root, "rev-parse", "HEAD") };
}

function createOptions(f, overrides = {}) {
  const id = overrides.id ?? "task-one";
  return {
    originRoot: f.root,
    id,
    branch: overrides.branch ?? `topic-${id}`,
    baseCommit: overrides.baseCommit ?? f.baseCommit,
    owner: overrides.owner ?? { kind: "test", id: "owner-one" },
    ...(overrides.fault ? { fault: overrides.fault } : {}),
    ...(overrides.commandObserver ? { commandObserver: overrides.commandObserver } : {}),
  };
}

function manifestPath(root, id) {
  return join(root, ".state/worktree-lifecycle/leases", `${id}.json`);
}

function manifest(root, id) {
  return JSON.parse(readFileSync(manifestPath(root, id), "utf8"));
}

function registeredPaths(root) {
  return git(root, "worktree", "list", "--porcelain", "-z")
    .split("\0")
    .filter((entry) => entry.startsWith("worktree "))
    .map((entry) => entry.slice("worktree ".length));
}

function refExists(root, ref) {
  return gitResult(root, "show-ref", "--verify", "--quiet", ref).status === 0;
}

function markReclaimable(f, allocation) {
  return markDisposition({
    originRoot: f.root,
    id: allocation.id,
    ownerToken: allocation.ownerToken,
    disposition: "reclaimable",
  });
}

function oneShotFault(operation, phase) {
  let fired = false;
  const fault = (event) => {
    if (fired || event.operation !== operation || event.phase !== phase) return;
    fired = true;
    const error = new Error(`injected ${operation} ${phase}`);
    error.code = "TEST_FAULT";
    throw error;
  };
  fault.fired = () => fired;
  return fault;
}

function assertCode(code) {
  return (error) => {
    assert.equal(error?.code, code);
    return true;
  };
}

test("managed module exposes only the three frozen resource APIs", () => {
  assert.deepEqual(Object.keys(managed).sort(), ["createManagedWorktree", "preserveManagedWorktree", "releaseManagedWorktree"]);
});

test("managed create persists intent first, reinspects real Git identity, and activates the exact worktree", (t) => {
  const f = repoFixture(t);
  const observed = [];
  const allocation = createManagedWorktree(createOptions(f, { commandObserver: (command) => observed.push(command) }));
  const stored = manifest(f.root, allocation.id);

  assert.equal(allocation.state, "active");
  assert.equal(stored.state, "active");
  assert.equal(stored.path, allocation.path);
  assert.equal(stored.branchRef, "refs/heads/topic-task-one");
  assert.equal(stored.baseCommit, f.baseCommit);
  assert.equal(stored.headCommit, git(allocation.path, "rev-parse", "HEAD"));
  assert.equal(git(allocation.path, "rev-parse", "--show-toplevel"), allocation.path);
  assert.equal(registeredPaths(f.root).includes(allocation.path), true);
  assert.deepEqual(observed.find((command) => command.args[0] === "worktree" && command.args[1] === "add")?.args, [
    "worktree", "add", "-b", "topic-task-one", allocation.path, f.baseCommit,
  ]);
});

test("preserve records a reason without removing a dirty worktree or its branch", (t) => {
  const f = repoFixture(t);
  const allocation = createManagedWorktree(createOptions(f));
  writeFileSync(join(allocation.path, "untracked.txt"), "keep me\n");
  const preserved = preserveManagedWorktree({
    originRoot: f.root,
    id: allocation.id,
    ownerToken: allocation.ownerToken,
    reason: "human requested investigation",
  });
  assert.equal(preserved.state, "preserved");
  assert.deepEqual(preserved.disposition, { state: "preserved", reason: "human requested investigation" });
  assert.equal(existsSync(allocation.path), true);
  assert.equal(refExists(f.root, allocation.branchRef), true);
});

test("routine release is clean, sequencer-free, worktree-only, non-force, and preserves the branch", (t) => {
  const f = repoFixture(t);
  const allocation = createManagedWorktree(createOptions(f));
  markReclaimable(f, allocation);
  const observed = [];
  const released = releaseManagedWorktree({
    originRoot: f.root,
    id: allocation.id,
    ownerToken: allocation.ownerToken,
    commandObserver: (command) => observed.push(command),
  });
  assert.equal(released.state, "released");
  assert.equal(existsSync(allocation.path), false);
  assert.equal(registeredPaths(f.root).includes(allocation.path), false);
  assert.equal(refExists(f.root, allocation.branchRef), true);
  const remove = observed.find((command) => command.args[0] === "worktree" && command.args[1] === "remove");
  assert.deepEqual(remove.args, ["worktree", "remove", allocation.path]);
  assert.equal(remove.args.includes("--force"), false);
  assert.equal(releaseManagedWorktree({ originRoot: f.root, id: allocation.id, ownerToken: allocation.ownerToken }).state, "released");
});

test("an old owner receipt cannot release a replacement allocation", (t) => {
  const f = repoFixture(t);
  const first = createManagedWorktree(createOptions(f, { branch: "topic-first", owner: { kind: "test", id: "first-owner" } }));
  markReclaimable(f, first);
  releaseManagedWorktree({ originRoot: f.root, id: first.id, ownerToken: first.ownerToken });

  const replacement = createManagedWorktree(createOptions(f, { branch: "topic-replacement", owner: { kind: "test", id: "replacement-owner" } }));
  assert.notEqual(replacement.ownerToken, first.ownerToken);
  assert.throws(
    () => releaseManagedWorktree({ originRoot: f.root, id: first.id, ownerToken: first.ownerToken }),
    assertCode("WORKTREE_LIFECYCLE_OWNER_MISMATCH"),
  );
  assert.equal(existsSync(replacement.path), true);
  assert.equal(manifest(f.root, replacement.id).ownerId, "replacement-owner");
});

test("dirty and real sequencer states become cleanup debt and are never removed", async (t) => {
  await t.test("dirty", (subtest) => {
    const f = repoFixture(subtest, "worktree-managed-dirty-");
    const allocation = createManagedWorktree(createOptions(f));
    markReclaimable(f, allocation);
    writeFileSync(join(allocation.path, "dirty.txt"), "dirty\n");
    assert.throws(
      () => releaseManagedWorktree({ originRoot: f.root, id: allocation.id, ownerToken: allocation.ownerToken }),
      assertCode("WORKTREE_LIFECYCLE_UNSAFE_RELEASE"),
    );
    assert.equal(manifest(f.root, allocation.id).state, "cleanup-debt");
    assert.equal(existsSync(allocation.path), true);
  });

  await t.test("sequencer", (subtest) => {
    const f = repoFixture(subtest, "worktree-managed-sequencer-");
    git(f.root, "checkout", "-b", "source");
    writeFileSync(join(f.root, "shared.txt"), "source\n");
    git(f.root, "commit", "-am", "source");
    git(f.root, "checkout", "main");

    const allocation = createManagedWorktree(createOptions(f));
    writeFileSync(join(allocation.path, "shared.txt"), "target\n");
    git(allocation.path, "commit", "-am", "target");
    markReclaimable(f, allocation);
    assert.notEqual(gitResult(allocation.path, "merge", "source").status, 0);

    assert.throws(
      () => releaseManagedWorktree({ originRoot: f.root, id: allocation.id, ownerToken: allocation.ownerToken }),
      assertCode("WORKTREE_LIFECYCLE_UNSAFE_RELEASE"),
    );
    assert.equal(manifest(f.root, allocation.id).state, "cleanup-debt");
    assert.equal(existsSync(allocation.path), true);
  });
});

test("create retries idempotently at every intent/add/inspect/activate crash boundary", async (t) => {
  for (const operation of ["intent-write", "worktree-add", "identity-inspect", "activate-write"]) {
    for (const phase of ["before", "after"]) {
      await t.test(`${operation} ${phase}`, (subtest) => {
        const f = repoFixture(subtest, "worktree-managed-create-crash-");
        const fault = oneShotFault(operation, phase);
        assert.throws(() => createManagedWorktree(createOptions(f, { fault })), { code: "TEST_FAULT" });
        assert.equal(fault.fired(), true);
        const recovered = createManagedWorktree(createOptions(f));
        assert.equal(recovered.state, "active");
        assert.equal(existsSync(recovered.path), true);
        assert.equal(registeredPaths(f.root).filter((path) => path === recovered.path).length, 1);
        assert.equal(manifest(f.root, recovered.id).state, "active");
      });
    }
  }
});

test("create retry safely attaches the exact reserved branch left by a partial Git add", (t) => {
  const f = repoFixture(t);
  let fired = false;
  const fault = (event) => {
    if (fired || event.operation !== "worktree-add" || event.phase !== "before") return;
    fired = true;
    git(f.root, "branch", "topic-task-one", f.baseCommit);
    const error = new Error("branch created before worktree registration");
    error.code = "TEST_FAULT";
    throw error;
  };
  assert.throws(() => createManagedWorktree(createOptions(f, { fault })), { code: "TEST_FAULT" });
  assert.equal(fired, true);
  assert.equal(refExists(f.root, "refs/heads/topic-task-one"), true);

  const recovered = createManagedWorktree(createOptions(f));
  assert.equal(recovered.state, "active");
  assert.equal(existsSync(recovered.path), true);
  assert.equal(registeredPaths(f.root).includes(recovered.path), true);
});

test("a reserved branch that moved away from baseCommit is retained as cleanup debt, never attached", (t) => {
  const f = repoFixture(t);
  let fired = false;
  const fault = (event) => {
    if (fired || event.operation !== "worktree-add" || event.phase !== "before") return;
    fired = true;
    writeFileSync(join(f.root, "later.txt"), "later\n");
    git(f.root, "add", "later.txt");
    git(f.root, "commit", "-m", "later");
    git(f.root, "branch", "topic-task-one", "HEAD");
    const error = new Error("branch side effect completed before registration");
    error.code = "TEST_FAULT";
    throw error;
  };
  assert.throws(() => createManagedWorktree(createOptions(f, { fault })), { code: "TEST_FAULT" });
  assert.throws(
    () => createManagedWorktree(createOptions(f)),
    assertCode("WORKTREE_LIFECYCLE_IDENTITY_MISMATCH"),
  );
  assert.equal(manifest(f.root, "task-one").state, "cleanup-debt");
  assert.equal(existsSync(join(f.root, ".state/worktree-lifecycle/worktrees/task-one")), false);
  assert.equal(refExists(f.root, "refs/heads/topic-task-one"), true);
});

test("release retries idempotently without phantom released at remove/publish crash boundaries", async (t) => {
  for (const operation of ["worktree-remove", "released-write"]) {
    for (const phase of ["before", "after"]) {
      await t.test(`${operation} ${phase}`, (subtest) => {
        const f = repoFixture(subtest, "worktree-managed-release-crash-");
        const allocation = createManagedWorktree(createOptions(f));
        markReclaimable(f, allocation);
        const fault = oneShotFault(operation, phase);
        assert.throws(
          () => releaseManagedWorktree({ originRoot: f.root, id: allocation.id, ownerToken: allocation.ownerToken, fault }),
          { code: "TEST_FAULT" },
        );
        assert.equal(fault.fired(), true);
        const afterFault = manifest(f.root, allocation.id);
        if (operation === "worktree-remove" && phase === "before") {
          assert.equal(afterFault.state, "reclaimable");
          assert.equal(existsSync(allocation.path), true);
        } else if (!(operation === "released-write" && phase === "after")) {
          assert.notEqual(afterFault.state, "released");
        }
        const recovered = releaseManagedWorktree({ originRoot: f.root, id: allocation.id, ownerToken: allocation.ownerToken });
        assert.equal(recovered.state, "released");
        assert.equal(existsSync(allocation.path), false);
        assert.equal(registeredPaths(f.root).includes(allocation.path), false);
        assert.equal(refExists(f.root, allocation.branchRef), true);
      });
    }
  }
});

test("managed CLI adopts a real pre-existing worktree through begin then identity-checked activate", (t) => {
  const f = repoFixture(t);
  const existingPath = join(f.root, "existing-worktree");
  git(f.root, "worktree", "add", "-b", "existing-topic", existingPath, f.baseCommit);
  const script = new URL("../scripts/worktree-lifecycle.mjs", import.meta.url).pathname;
  const adopted = spawnSync(process.execPath, [
    script, "adopt", "--json", "--id", "adopted-task", "--path", existingPath,
    "--branch", "existing-topic", "--base", f.baseCommit,
    "--owner-kind", "migration", "--owner-id", "approved-owner",
  ], { cwd: f.root, encoding: "utf8" });
  assert.equal(adopted.status, 0, adopted.stderr);
  const receipt = JSON.parse(adopted.stdout);
  assert.equal(receipt.state, "active");
  assert.equal(receipt.path, existingPath);
  assert.equal(receipt.headCommit, f.baseCommit);
  assert.equal(manifest(f.root, "adopted-task").ownerId, "approved-owner");
});

test("managed CLI creates and preserves through the same owner protocol while package scripts stay frozen", (t) => {
  const f = repoFixture(t);
  const script = new URL("../scripts/worktree-lifecycle.mjs", import.meta.url).pathname;
  const created = spawnSync(process.execPath, [
    script, "create", "--json", "--id", "cli-task", "--branch", "cli-topic", "--base", f.baseCommit,
    "--owner-kind", "cli", "--owner-id", "cli-owner",
  ], { cwd: f.root, encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  const receipt = JSON.parse(created.stdout);
  assert.equal(receipt.state, "active");

  const preserved = spawnSync(process.execPath, [
    script, "preserve", "--json", "--id", receipt.id, "--owner-token", receipt.ownerToken,
    "--reason", "keep cli result",
  ], { cwd: f.root, encoding: "utf8" });
  assert.equal(preserved.status, 0, preserved.stderr);
  assert.equal(JSON.parse(preserved.stdout).state, "preserved");

  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts.worktree, "node scripts/worktree-lifecycle.mjs");
  assert.equal(pkg.scripts["worktree:audit"], "node scripts/worktree-lifecycle.mjs audit");
});
