import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  classifyWorktreeFact,
  inventoryRepositoryWorktrees,
  parseWorktreePorcelain,
} from "../scripts/lib/worktree-lifecycle/inventory.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "worktree-inventory-")));
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  writeFileSync(join(root, "shared.txt"), "base\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "initial");
  const add = (name) => {
    const path = join(root, name);
    git(root, "worktree", "add", "-b", name, path, "HEAD");
    return path;
  };
  const paths = Object.fromEntries(["clean", "dirty", "missing", "locked", "merge", "active", "unmanaged"].map((name) => [name, add(name)]));
  writeFileSync(join(paths.dirty, "untracked.txt"), "dirty\n");
  git(root, "worktree", "lock", "--reason", "test lock", paths.locked);

  // Create a real unresolved merge, not a hand-written sequencer marker.
  git(paths.merge, "checkout", "-b", "merge-source");
  writeFileSync(join(paths.merge, "shared.txt"), "source\n");
  git(paths.merge, "commit", "-am", "source");
  git(paths.merge, "checkout", "merge");
  writeFileSync(join(paths.merge, "shared.txt"), "target\n");
  git(paths.merge, "commit", "-am", "target");
  assert.notEqual(spawnSync("git", ["merge", "merge-source"], { cwd: paths.merge }).status, 0);

  rmSync(paths.missing, { recursive: true, force: true });
  mkdirSync(join(root, ".state/worktree-lifecycle/leases"), { recursive: true });
  for (const name of ["clean", "dirty", "missing", "locked", "merge", "active"]) {
    writeFileSync(join(root, `.state/worktree-lifecycle/leases/${name}.json`), JSON.stringify({
      schemaVersion: 1, id: name, path: paths[name], originRoot: root,
      ownerKind: "test", ownerId: name, ownerToken: "token", state: name === "clean" ? "reclaimable" : "active",
    }));
  }
  return { root, paths, close: () => rmSync(root, { recursive: true, force: true }) };
}

function states(facts) {
  return Object.fromEntries(facts.map((fact) => [fact.registration.path, fact]));
}

test("NUL porcelain parser preserves paths containing newlines and frozen classification exports are conservative", () => {
  const [registration] = parseWorktreePorcelain("worktree /tmp/a\nname\0HEAD 0123456789012345678901234567890123456789\0branch refs/heads/topic\0\0");
  assert.equal(registration.path, "/tmp/a\nname");
  for (const fact of [
    { registration, clean: false, operation: null, owner: { state: "reclaimable" } },
    { registration, clean: true, operation: "merge", owner: { state: "reclaimable" } },
    { registration, clean: true, operation: null, owner: null },
  ]) assert.equal(classifyWorktreeFact(fact).automaticAction, "none");
  assert.deepEqual(classifyWorktreeFact({ registration, pathExists: true, clean: true, owner: { state: "reclaimable" } }), {
    state: "reclaimable", reasons: [], automaticAction: "release-worktree-only",
  });
});

test("real repository inventory stably classifies clean, dirty, missing, locked, merge, active and unmanaged worktrees", async (t) => {
  const f = fixture(); t.after(f.close);
  const facts = states(await inventoryRepositoryWorktrees({ originRoot: f.root, activeProcessCwds: [f.paths.active] }));
  assert.equal(facts[f.root].state, "main");
  assert.equal(facts[f.paths.clean].state, "reclaimable");
  assert.equal(facts[f.paths.clean].automaticAction, "release-worktree-only");
  assert.equal(facts[f.paths.dirty].state, "dirty");
  assert.equal(facts[f.paths.missing].state, "missing");
  assert.equal(facts[f.paths.locked].state, "cleanup-debt");
  assert.equal(facts[f.paths.merge].state, "sequencer");
  assert.equal(facts[f.paths.active].state, "active");
  assert.equal(facts[f.paths.unmanaged].state, "unmanaged");
  for (const fact of Object.values(facts).filter((fact) => fact.state !== "reclaimable")) assert.equal(fact.automaticAction, "none");
});

test("list, status and rev-parse probe failures are facts, never an empty safe inventory", async (t) => {
  const f = fixture(); t.after(f.close);
  for (const failure of ["list", "status", "rev-parse"]) {
    const facts = await inventoryRepositoryWorktrees({ originRoot: f.root, activeProcessCwds: [], probe: ({ kind }) => kind === failure ? { ok: false, stdout: "", stderr: "failed" } : undefined });
    assert.ok(facts.length > 0, `${failure} failure must remain visible`);
    assert.ok(facts.some((fact) => ["cleanup-debt", "unmanaged"].includes(fact.state)));
    assert.ok(facts.every((fact) => fact.automaticAction !== "release-worktree-only"));
  }
});

test("default audit CLI is read-only and never deletes branches", () => {
  const f = fixture();
  try {
    const before = git(f.root, "status", "--porcelain=v1", "--untracked-files=all") + git(f.root, "worktree", "list", "--porcelain");
    const script = new URL("../scripts/worktree-lifecycle.mjs", import.meta.url).pathname;
    const result = spawnSync(process.execPath, [script, "audit", "--json"], { cwd: f.root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
    const after = git(f.root, "status", "--porcelain=v1", "--untracked-files=all") + git(f.root, "worktree", "list", "--porcelain");
    assert.equal(after, before);
    assert.equal(git(f.root, "show-ref", "--verify", "--quiet", "refs/heads/clean"), "");
  } finally { f.close(); }
});
