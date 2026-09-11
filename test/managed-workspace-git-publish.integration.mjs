import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishWorkspaceSnapshot } from "../packages/pi-subagents-enhanced/src/workspace/git-worktree.ts";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function fixture(t) { const root = await mkdtemp(join(tmpdir(), "publish-git-")); const originRoot = join(root, "origin"); await mkdir(originRoot); git(originRoot, "init", "-b", "main"); git(originRoot, "config", "user.email", "test@example.com"); git(originRoot, "config", "user.name", "Test"); await writeFile(join(originRoot, "base.txt"), "base\n"); git(originRoot, "add", "."); git(originRoot, "commit", "-m", "base"); t.after(() => rm(root, { recursive: true, force: true })); return { root, originRoot, baseCommit: git(originRoot, "rev-parse", "HEAD") }; }

test("publishes dirty workspace tree without touching its index and excludes ignored files", async (t) => { const f = await fixture(t); const workspace = join(f.root, "workspace"); git(f.originRoot, "worktree", "add", "-b", "worker", workspace, "main"); await writeFile(join(workspace, ".gitignore"), "ignored.txt\n"); await writeFile(join(workspace, "result.txt"), "result\n"); await writeFile(join(workspace, "ignored.txt"), "secret\n"); const before = git(workspace, "diff", "--cached", "--raw"); const record = { path: realpathSync(workspace), dispatchCwd: realpathSync(workspace), branchRef: "refs/heads/worker", request: { workspaceId: "w1", originRoot: realpathSync(f.originRoot), originRef: "refs/heads/main", baseCommit: f.baseCommit } }; const artifact = publishWorkspaceSnapshot({ record, policy: { publication: "allowed", application: "allowed", writePaths: [".gitignore", "result.txt"] }, proofId: "a".repeat(64) }); assert.match(artifact.publishedTree, /^[a-f0-9]{40}$/); assert.equal(git(workspace, "diff", "--cached", "--raw"), before); assert.deepEqual(artifact.changedFiles, [".gitignore", "result.txt"]); });
