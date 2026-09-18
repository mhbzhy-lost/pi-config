import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveRepositoryIdentity } from "../packages/pi-subagents-enhanced/src/workspace/repository-identity.ts";
import { managedWorkspacePaths } from "../packages/pi-subagents-enhanced/src/workspace/ledger.ts";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "coordinator-identity-"));
  const origin = join(root, "origin");
  const linked = join(root, "linked");
  const clone = join(root, "clone");
  await mkdir(origin);
  git(origin, "init", "-b", "main");
  git(origin, "config", "user.email", "test@example.com");
  git(origin, "config", "user.name", "Test User");
  await writeFile(join(origin, "README.md"), "initial\n");
  git(origin, "add", "README.md");
  git(origin, "commit", "-m", "initial");
  git(origin, "worktree", "add", "-b", "linked", linked);
  git(root, "clone", origin, clone);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, origin, linked, clone };
}

test("common-dir identity shares the canonical main-worktree storage partition", async (t) => {
  const f = await fixture(t);
  const main = await resolveRepositoryIdentity(f.origin);
  const linked = await resolveRepositoryIdentity(f.linked);
  const otherClone = await resolveRepositoryIdentity(f.clone);

  assert.equal(linked.repositoryId, main.repositoryId);
  assert.equal(linked.originRoot, main.originRoot);
  assert.equal(linked.storageRepositoryId, main.storageRepositoryId);
  assert.notEqual(otherClone.repositoryId, main.repositoryId);
  assert.equal(main.originRoot, f.origin);
});

test("identity fails closed for non-Git, missing, and symlink cwd values", async (t) => {
  const f = await fixture(t);
  const nonGit = join(f.root, "non-git");
  const symlinkCwd = join(f.root, "origin-link");
  await mkdir(nonGit);
  await symlink(f.origin, symlinkCwd);

  await assert.rejects(resolveRepositoryIdentity(nonGit), /Git|repository|identity/i);
  await assert.rejects(resolveRepositoryIdentity(join(f.root, "missing")), /unavailable|Git|repository/i);
  await assert.rejects(resolveRepositoryIdentity(symlinkCwd), /symlink|canonical|identity/i);
});

test("identity hashes use the canonical realpath partition shared with the ledger and audit", async (t) => {
  // displayPath 只给人看：身份哈希必须与 ledger canonicalOrigin(realpath) 推导同一分区，
  // 否则 macOS /var→/private/var 下写入分区与 audit 分区永久分叉（R12h 真实现场）。
  const f = await fixture(t);
  const stateRoot = await mkdtemp(join(tmpdir(), "identity-partition-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const main = await resolveRepositoryIdentity(f.origin);
  const canonical = await realpath(main.originRoot);
  assert.equal(main.storageRepositoryId, sha256(canonical));
  const paths = managedWorkspacePaths({ stateRoot, originRoot: f.origin, workspaceId: "partition-probe" });
  assert.equal(paths.storageRepositoryId, main.storageRepositoryId);
});

test("legacy partition id is the realpath form of the linked worktree toplevel", async (t) => {
  const f = await fixture(t);
  const identity = await resolveRepositoryIdentity(f.linked);
  assert.equal(identity.migrationDebt?.legacyStorageRepositoryId, sha256(await realpath(f.linked)));
});

test("a legacy linked-worktree ledger partition is inventory-only migration debt", async (t) => {
  const f = await fixture(t);
  const identity = await resolveRepositoryIdentity(f.linked);
  assert.equal(identity.migrationDebt?.kind, "legacy-linked-worktree-ledger-partition");
  assert.notEqual(identity.migrationDebt?.legacyStorageRepositoryId, identity.storageRepositoryId);
  assert.equal(identity.migrationDebt?.action, "inventory-only");
});
