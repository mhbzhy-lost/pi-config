import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createTemporaryArenaSync } from "./helpers/temporary-arena.mjs";
import { createManagedWorktree } from "../scripts/lib/worktree-lifecycle/managed-worktree.mjs";
import { markDisposition } from "../scripts/lib/worktree-lifecycle/registry.mjs";
import { reconcileManagedWorktrees } from "../scripts/lib/worktree-lifecycle/inventory.mjs";

function git(cwd, ...args) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
test("reconcile dry-run is redacted and apply releases only a durable reclaimable owner", async (t) => {
  const arena = createTemporaryArenaSync("worktree-recovery-"); t.after(() => arena.disposeSync());
  const root = arena.mkdtempSync("repo-"); git(root, "init", "--initial-branch=main"); git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "user.name", "Test");
  writeFileSync(join(root, "a"), "a\n"); git(root, "add", "a"); git(root, "commit", "-m", "initial");
  const allocation = createManagedWorktree({ originRoot: root, id: "safe", branch: "safe", baseCommit: git(root, "rev-parse", "HEAD"), owner: { kind: "test", id: "one" } });
  markDisposition({ originRoot: root, id: allocation.id, ownerToken: allocation.ownerToken, disposition: "reclaimable" });
  const dry = await reconcileManagedWorktrees({ originRoot: root });
  assert.equal(dry.items.find((item) => item.id === "safe").automaticAction, "release-worktree-only");
  assert.equal(JSON.stringify(dry).includes(allocation.ownerToken), false);
  assert.equal(existsSync(allocation.path), true);
  const applied = await reconcileManagedWorktrees({ originRoot: root, apply: true });
  assert.equal(applied.items.find((item) => item.id === "safe").state, "released");
  assert.equal(existsSync(allocation.path), false);
  assert.equal(git(root, "show-ref", "--verify", "--quiet", "refs/heads/safe"), "");
});

test("manifest-only malformed files fail closed without following symlinks", async (t) => {
  const arena = createTemporaryArenaSync("worktree-recovery-"); t.after(() => arena.disposeSync());
  const root = arena.mkdtempSync("repo-"); git(root, "init", "--initial-branch=main"); git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "user.name", "Test"); writeFileSync(join(root, "a"), "a"); git(root, "add", "a"); git(root, "commit", "-m", "initial");
  mkdirSync(join(root, ".state/worktree-lifecycle/leases"), { recursive: true }); writeFileSync(join(root, ".state/worktree-lifecycle/leases/bad.json"), "{");
  const report = await reconcileManagedWorktrees({ originRoot: root });
  assert.equal(report.items.some((item) => item.code === "WORKTREE_IDENTITY_MISMATCH"), true);
});
