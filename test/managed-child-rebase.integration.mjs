import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const repo = (objectFormat = "sha1") => {
  const root = mkdtempSync(path.join(tmpdir(), "managed-child-rebase-"));
  git(root, "init", "-q", `--object-format=${objectFormat}`); git(root, "config", "user.email", "test@example.invalid"); git(root, "config", "user.name", "Test");
  writeFileSync(path.join(root, "tracked.txt"), "base\n"); git(root, "add", "."); git(root, "commit", "-qm", "base");
  return root;
};
const setup = (objectFormat = "sha1") => {
  const root = repo(objectFormat); const base = git(root, "rev-parse", "HEAD"); const work = `${root}-child`;
  git(root, "worktree", "add", "-b", "child", work, base);
  return { root: realpathSync(root), work: realpathSync(work), base };
};
const recordFor = (root, work, base, writePaths = ["child.txt"]) => ({ path: work, dispatchCwd: work, branchRef: "refs/heads/child", request: { originRoot: root, originRef: git(root, "symbolic-ref", "HEAD"), baseCommit: base, policy: { publication: "allowed", application: "allowed", writePaths } } });
const targetCommit = ({ root }) => { writeFileSync(path.join(root, "target.txt"), "target\n"); git(root, "add", "."); git(root, "commit", "-qm", "target"); return git(root, "rev-parse", "HEAD"); };
const childCommit = ({ work }, file = "child.txt") => { writeFileSync(path.join(work, file), "child\n"); git(work, "add", "."); git(work, "commit", "-qm", "child"); };
const rejectsCode = (fn, code) => assert.rejects(async () => fn(), error => error.code === code);
const gitDir = cwd => path.resolve(cwd, git(cwd, "rev-parse", "--git-dir"));

async function primitive() { return (await import("../packages/pi-subagents-enhanced/src/workspace/git-worktree.ts")).managedGitRebase; }

test("managed child rebase primitive exports", async () => {
  assert.equal(typeof await primitive(), "function");
});

test("clean rebase returns verified candidate facts", async () => {
  const childManagedRebase = await primitive(); const env = setup(); childCommit(env); const target = targetCommit(env);
  const facts = childManagedRebase(recordFor(env.root, env.work, env.base), target);
  assert.equal(facts.state, "completed"); assert.equal(facts.targetHead, target); assert.equal(facts.clean, true); assert.equal(facts.sequencerEmpty, true); assert.deepEqual(facts.changedFiles, ["child.txt"]);
});

test("SHA-256 repositories accept a 64-hex target and return verified candidate facts", async () => {
  const childManagedRebase = await primitive(); const env = setup("sha256"); childCommit(env); const target = targetCommit(env);
  assert.equal(target.length, 64);
  const facts = childManagedRebase(recordFor(env.root, env.work, env.base), target);
  assert.equal(facts.state, "completed"); assert.equal(facts.targetHead, target); assert.equal(facts.head.length, 64);
});

test("real conflict preserves sequencer and unmerged entries and allows only its continue", async () => {
  const childManagedRebase = await primitive(); const env = setup();
  writeFileSync(path.join(env.work, "tracked.txt"), "child\n"); git(env.work, "add", "."); git(env.work, "commit", "-qm", "child conflict");
  writeFileSync(path.join(env.root, "tracked.txt"), "target\n"); git(env.root, "add", "."); git(env.root, "commit", "-qm", "target conflict"); const target = git(env.root, "rev-parse", "HEAD");
  const record = recordFor(env.root, env.work, env.base, ["tracked.txt"]); const facts = childManagedRebase(record, target);
  assert.equal(facts.state, "resolving-conflict"); assert.equal(facts.sequencerEmpty, false); assert.notEqual(git(env.work, "ls-files", "-u", "-z"), "");
  await rejectsCode(() => childManagedRebase({ ...record, branchRef: "refs/heads/not-child" }, target, { continue: true }), "MANAGED_WORKSPACE_IDENTITY");
  assert.notEqual(git(env.work, "ls-files", "-u", "-z"), "");
  writeFileSync(path.join(env.work, "tracked.txt"), "resolved\n"); git(env.work, "add", "tracked.txt");
  const completed = childManagedRebase(record, target, { continue: true });
  assert.equal(completed.state, "completed"); assert.equal(completed.clean, true); assert.equal(completed.sequencerEmpty, true);
});

test("identity gates reject wrong cwd, canonical path, common-dir, branch, detached, locked, prunable and unregistered worktrees", async t => {
  const childManagedRebase = await primitive();
  await t.test("wrong cwd and realpath escape", async () => {
    const env = setup(); const target = targetCommit(env); const record = recordFor(env.root, env.work, env.base);
    await rejectsCode(() => childManagedRebase({ ...record, dispatchCwd: env.root }, target), "MANAGED_WORKSPACE_IDENTITY");
    await rejectsCode(() => childManagedRebase({ ...record, path: `${env.work}/../${path.basename(env.work)}` }, target), "MANAGED_WORKSPACE_IDENTITY");
  });
  await t.test("wrong common-dir", async () => {
    const a = setup(); const b = setup(); const target = targetCommit(a);
    await rejectsCode(() => childManagedRebase({ ...recordFor(a.root, a.work, a.base), request: { ...recordFor(a.root, a.work, a.base).request, originRoot: b.root, originRef: git(b.root, "symbolic-ref", "HEAD") } }, target), "MANAGED_WORKSPACE_IDENTITY");
  });
  await t.test("wrong branch and detached HEAD", async () => {
    const env = setup(); const target = targetCommit(env); const record = recordFor(env.root, env.work, env.base);
    await rejectsCode(() => childManagedRebase({ ...record, branchRef: "refs/heads/wrong" }, target), "MANAGED_WORKSPACE_IDENTITY");
    git(env.work, "checkout", "--detach", "-q"); await rejectsCode(() => childManagedRebase(record, target), "MANAGED_WORKSPACE_IDENTITY");
  });
  await t.test("locked, prunable and unregistered", async () => {
    const locked = setup(); const lockedTarget = targetCommit(locked); git(locked.root, "worktree", "lock", locked.work);
    await rejectsCode(() => childManagedRebase(recordFor(locked.root, locked.work, locked.base), lockedTarget), "MANAGED_WORKSPACE_IDENTITY");
    const prunable = setup(); const prunableRecord = recordFor(prunable.root, prunable.work, prunable.base); const prunableTarget = targetCommit(prunable); rmSync(prunable.work, { recursive: true });
    await rejectsCode(() => childManagedRebase(prunableRecord, prunableTarget), "MANAGED_WORKSPACE_IDENTITY");
    const absent = setup(); const absentRecord = recordFor(absent.root, absent.work, absent.base); const absentTarget = targetCommit(absent); git(absent.root, "worktree", "remove", "--force", absent.work); mkdirSync(absent.work);
    await rejectsCode(() => childManagedRebase(absentRecord, absentTarget), "MANAGED_WORKSPACE_IDENTITY");
  });
});

test("pre-existing merge, cherry-pick, revert, sequencer and rebase states fail closed without abort", async t => {
  const childManagedRebase = await primitive();
  for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer", "rebase-merge", "rebase-apply"]) await t.test(marker, async () => {
    const env = setup(); const target = targetCommit(env); const markerPath = path.join(gitDir(env.work), marker);
    if (marker.includes("rebase") || marker === "sequencer") mkdirSync(markerPath); else writeFileSync(markerPath, env.base + "\n");
    await rejectsCode(() => childManagedRebase(recordFor(env.root, env.work, env.base), target), "MANAGED_WORKSPACE_DIRTY");
    assert.equal(existsSync(markerPath), true);
    await rejectsCode(() => childManagedRebase(recordFor(env.root, env.work, env.base), target, { continue: true }), marker.includes("rebase") ? "MANAGED_WORKSPACE_IDENTITY" : "MANAGED_WORKSPACE_SEQUENCER");
    assert.equal(existsSync(markerPath), true);
  });
});

test("target, workspace HEAD and admission lease/generation drift stop before local Git mutation", async t => {
  const childManagedRebase = await primitive();
  await t.test("target ref advance", async () => {
    const env = setup(); childCommit(env); const target = targetCommit(env); const before = git(env.work, "rev-parse", "HEAD");
    await rejectsCode(() => childManagedRebase(recordFor(env.root, env.work, env.base), target, { fault(phase) { if (phase === "locked") { writeFileSync(path.join(env.root, "advance.txt"), "advance\n"); git(env.root, "add", "."); git(env.root, "commit", "-qm", "advance"); } } }), "MANAGED_WORKSPACE_ORIGIN_DRIFT");
    assert.equal(git(env.work, "rev-parse", "HEAD"), before);
  });
  await t.test("workspace HEAD drift", async () => {
    const env = setup(); childCommit(env); const target = targetCommit(env);
    await rejectsCode(() => childManagedRebase(recordFor(env.root, env.work, env.base), target, { fault(phase) { if (phase === "locked") { writeFileSync(path.join(env.work, "drift.txt"), "drift\n"); git(env.work, "add", "."); git(env.work, "commit", "-qm", "drift"); } } }), "MANAGED_WORKSPACE_IDENTITY");
    assert.equal(git(env.work, "log", "-1", "--pretty=%s"), "drift");
  });
  await t.test("queue lease and generation drift", async () => {
    const env = setup(); childCommit(env); const target = targetCommit(env); let current = { queueLeaseId: "lease-1", admissionGeneration: 1 };
    const admission = { ...current, validate: () => current };
    await rejectsCode(() => childManagedRebase(recordFor(env.root, env.work, env.base), target, { admission, fault(phase) { if (phase === "locked") current = { queueLeaseId: "lease-2", admissionGeneration: 2 }; } }), "MANAGED_WORKSPACE_QUEUE");
    assert.equal(git(env.work, "log", "-1", "--pretty=%s"), "child");
  });
});

test("stale operation lock is recovered by PID+birth identity while a live lock is rejected", async t => {
  const childManagedRebase = await primitive();
  await t.test("stale", () => {
    const env = setup(); childCommit(env); const target = targetCommit(env); const common = git(env.root, "rev-parse", "--git-common-dir"); const lock = path.join(realpathSync(path.isAbsolute(common) ? common : path.resolve(env.root, common)), "pi-managed-workspace-operation.lock");
    mkdirSync(lock); writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ token: "old", pid: 99999999, birthIdentity: "dead" }));
    assert.equal(childManagedRebase(recordFor(env.root, env.work, env.base), target).state, "completed"); assert.equal(existsSync(lock), false);
  });
  await t.test("live", async () => {
    const env = setup(); childCommit(env); const target = targetCommit(env); let nestedError;
    childManagedRebase(recordFor(env.root, env.work, env.base), target, { fault(phase) { if (phase === "locked") try { childManagedRebase(recordFor(env.root, env.work, env.base), target); } catch (error) { nestedError = error; } } });
    assert.equal(nestedError?.code, "MANAGED_WORKSPACE_LOCKED");
  });
});

test("repository with no local configuration still rebases under managed defaults", async () => {
  const childManagedRebase = await primitive(); const env = setup(); childCommit(env); const target = targetCommit(env);
  git(env.root, "config", "--local", "--unset-all", "user.email"); git(env.root, "config", "--local", "--unset-all", "user.name");
  assert.equal(childManagedRebase(recordFor(env.root, env.work, env.base), target).state, "completed");
});

test("repository executable Git configuration and hooks fail closed without execution", async t => {
  const childManagedRebase = await primitive();
  const configurations = [
    ["core.hooksPath", "unsafe-hooks"], ["merge.danger.driver", "touch should-not-run"], ["filter.danger.clean", "touch should-not-run"],
    ["filter.danger.smudge", "touch should-not-run"], ["filter.danger.process", "touch should-not-run"], ["rebase.exec", "touch should-not-run"],
    ["commit.gpgSign", "true"], ["gpg.program", "touch should-not-run"], ["core.editor", "touch should-not-run"],
    ["sequence.editor", "touch should-not-run"], ["core.pager", "touch should-not-run"], ["pager.rebase", "touch should-not-run"],
  ];
  for (const [name, value] of configurations) await t.test(name, async () => {
    const env = setup(); childCommit(env); const target = targetCommit(env); git(env.work, "config", "--local", name, value);
    await rejectsCode(() => childManagedRebase(recordFor(env.root, env.work, env.base), target), "MANAGED_WORKSPACE_CONFIG");
    assert.equal(existsSync(path.join(env.work, "should-not-run")), false);
  });
  await t.test("configured clean filter is rejected before identity inspection can execute it", async () => {
    const env = setup(); const marker = path.join(env.work, "filter-ran");
    writeFileSync(path.join(env.work, ".gitattributes"), "tracked.txt filter=danger\n"); childCommit(env); const target = targetCommit(env);
    git(env.work, "config", "--local", "filter.danger.clean", `sh -c 'touch "${marker}"; cat'`);
    await rejectsCode(() => childManagedRebase(recordFor(env.root, env.work, env.base, [".gitattributes", "child.txt"]), target), "MANAGED_WORKSPACE_CONFIG");
    assert.equal(existsSync(marker), false);
  });
  await t.test("executable .git/hooks hook", async () => {
    const env = setup(); childCommit(env); const target = targetCommit(env); const marker = path.join(env.work, "hook-ran"); const common = git(env.root, "rev-parse", "--git-common-dir"); const hook = path.join(realpathSync(path.isAbsolute(common) ? common : path.resolve(env.root, common)), "hooks", "pre-rebase");
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`); chmodSync(hook, 0o755);
    await rejectsCode(() => childManagedRebase(recordFor(env.root, env.work, env.base), target), "MANAGED_WORKSPACE_CONFIG"); assert.equal(existsSync(marker), false);
  });
});

test("dirty, invalid target, writePaths and malformed admission gates remain fail closed", async () => {
  const childManagedRebase = await primitive(); const env = setup(); const target = targetCommit(env); const record = recordFor(env.root, env.work, env.base);
  writeFileSync(path.join(env.work, "dirty.txt"), "dirty\n"); await rejectsCode(() => childManagedRebase(record, target), "MANAGED_WORKSPACE_DIRTY"); git(env.work, "clean", "-fd");
  await rejectsCode(() => childManagedRebase(record, "0".repeat(40)), "MANAGED_WORKSPACE_ORIGIN_DRIFT");
  childCommit(env); await rejectsCode(() => childManagedRebase(recordFor(env.root, env.work, env.base, ["other.txt"]), target), "MANAGED_WORKSPACE_WRITE_PATHS");
  await rejectsCode(() => childManagedRebase(record, target, { admission: { admissionGeneration: 1 } }), "MANAGED_WORKSPACE_QUEUE");
});
