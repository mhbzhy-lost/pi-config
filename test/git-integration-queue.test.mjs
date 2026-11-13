import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { GitIntegrationQueue } from "../src/git-integration-queue/queue.ts";
import { repositoryIdentity } from "../src/git-integration-queue/repository.ts";
import { classifyHandoff } from "../src/git-integration-queue/adapter.ts";
import { queueRequest } from "../src/git-integration-queue/client.ts";

function run(cwd, args) { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim(); }
function commit(cwd, message) { run(cwd, ["add", "-A"]); run(cwd, ["commit", "-m", message]); return run(cwd, ["rev-parse", "HEAD"]); }
async function repoFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "git-integration-queue-"));
  const state = await mkdtemp(join(tmpdir(), "git-integration-queue-state-"));
  run(root, ["init", "-b", "main"]);
  run(root, ["config", "user.email", "queue@test.invalid"]);
  run(root, ["config", "user.name", "Queue Test"]);
  await writeFile(join(root, "pipeline.txt"), "base\n");
  const base = commit(root, "base");
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(state, { recursive: true, force: true })]));
  return { root, state, base };
}

test("repository identity is shared by linked worktrees", async (t) => {
  const fixture = await repoFixture(t);
  const linked = join(fixture.root, "linked");
  run(fixture.root, ["worktree", "add", linked, "-b", "linked"]);
  assert.equal(repositoryIdentity(fixture.root).repositoryId, repositoryIdentity(linked).repositoryId);
  run(fixture.root, ["worktree", "remove", "--force", linked]);
});

test("queue is FIFO and requestId idempotent", async (t) => {
  const fixture = await repoFixture(t);
  run(fixture.root, ["checkout", "-b", "feature"]);
  await writeFile(join(fixture.root, "pipeline.txt"), "base\nfirst\n");
  const firstCommit = commit(fixture.root, "first");
  await writeFile(join(fixture.root, "pipeline.txt"), "base\nfirst\nsecond\n");
  commit(fixture.root, "second");
  const secondCommit = run(fixture.root, ["rev-parse", "HEAD"]);
  run(fixture.root, ["checkout", "main"]);
  const queue = new GitIntegrationQueue(fixture.state, fixture.root);
  await queue.init();
  const one = await queue.enqueue({ targetRef: "refs/heads/main", requestId: "one", source: { kind: "commit", commit: firstCommit } });
  const duplicate = await queue.enqueue({ targetRef: "refs/heads/main", requestId: "one", source: { kind: "commit", commit: firstCommit } });
  await queue.enqueue({ targetRef: "refs/heads/main", requestId: "two", source: { kind: "commit", commit: secondCommit } });
  await queue.process();
  const status = await queue.status();
  assert.equal(duplicate.sequence, one.sequence);
  assert.deepEqual(status.items.map((item) => item.state), ["completed", "completed"]);
  assert.equal(run(fixture.root, ["rev-parse", "HEAD"]), secondCommit);
  assert.equal(run(fixture.root, ["rev-list", "--count", "main"]), "3");
  assert.equal(fixture.base.length, 40);
});

test("handoff patch is digest-checked and integrated without a source worktree", async (t) => {
  const fixture = await repoFixture(t);
  run(fixture.root, ["checkout", "-b", "feature"]);
  await writeFile(join(fixture.root, "pipeline.txt"), "base\npatch\n");
  commit(fixture.root, "patch");
  const patchPath = join(fixture.state, "task.patch");
  const patch = execFileSync("git", ["-C", fixture.root, "diff", `${fixture.base}..HEAD`, "--", "pipeline.txt"], { encoding: "utf8" });
  await writeFile(patchPath, patch);
  const digest = createHash("sha256").update(patch).digest("hex");
  run(fixture.root, ["checkout", "main"]);
  const queue = new GitIntegrationQueue(fixture.state, fixture.root);
  await queue.init();
  await queue.enqueue({ targetRef: "refs/heads/main", requestId: "patch", source: { kind: "handoff-patch", patchPath, handoffPath: join(fixture.state, "handoff.json"), baseCommit: fixture.base, patchDigest: digest } });
  await queue.process();
  assert.equal((await queue.status()).items[0].state, "completed");
  assert.equal(await readFile(join(fixture.root, "pipeline.txt"), "utf8"), "base\npatch\n");
});

test("dirty target is preserved and does not integrate", async (t) => {
  const fixture = await repoFixture(t);
  await writeFile(join(fixture.root, "pipeline.txt"), "dirty\n");
  const queue = new GitIntegrationQueue(fixture.state, fixture.root);
  await queue.init();
  await queue.enqueue({ targetRef: "refs/heads/main", requestId: "dirty", source: { kind: "commit", commit: fixture.base } });
  await queue.process();
  const item = (await queue.status()).items[0];
  assert.equal(item.state, "preserved");
  assert.equal(item.reasonCode, "TARGET_DIRTY");
});

test("handoff classifier distinguishes no-change, enqueue, and preserve", async (t) => {
  const fixture = await repoFixture(t);
  const patchPath = join(fixture.state, "empty.patch");
  await writeFile(patchPath, "");
  const manifestPath = join(fixture.state, "handoff.json");
  const manifest = {
    version: 1,
    runId: "run",
    groups: [{
      stepIndex: 0,
      baseCommit: fixture.base,
      repoRoot: fixture.root,
      children: [{ index: 0, taskIndex: 0, agent: "executor", status: "completed", summary: "no-op", patch: { path: patchPath, branch: "feature", changed: false, diffStat: "", filesChanged: 0, insertions: 0, deletions: 0 } }],
      cleanup: { state: "complete", tasks: [{ index: 0, path: join(fixture.root, "gone"), branch: "feature", worktreeRemoved: true, branchRemoved: true }] },
    }],
  };
  await writeFile(manifestPath, JSON.stringify(manifest));
  assert.equal(classifyHandoff(manifestPath)[0].receipt.outcome, "no-change");
});

test("repository daemon serves status over Unix socket", async (t) => {
  const fixture = await repoFixture(t);
  const socket = join(fixture.state, "queue.sock");
  const daemon = spawn(process.execPath, [fileURLToPath(new URL("../src/git-integration-queue/daemon.ts", import.meta.url)), "--socket", socket, "--state-root", fixture.state, "--repo", fixture.root], { stdio: "ignore" });
  t.after(() => daemon.kill("SIGTERM"));
  let status;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { status = await queueRequest(socket, "status"); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  assert.equal(status.repositoryId, repositoryIdentity(fixture.root).repositoryId);
  assert.deepEqual(status.items, []);
  const first = await Promise.all([
    queueRequest(socket, "enqueue", { targetRef: "refs/heads/main", requestId: "daemon-a", source: { kind: "commit", commit: fixture.base } }),
    queueRequest(socket, "enqueue", { targetRef: "refs/heads/main", requestId: "daemon-b", source: { kind: "commit", commit: fixture.base } }),
  ]);
  assert.deepEqual(first.map((item) => item.sequence).sort((a, b) => a - b), [1, 2]);
  await queueRequest(socket, "process");
  const afterConcurrentEnqueue = await queueRequest(socket, "status");
  assert.deepEqual(afterConcurrentEnqueue.items.map((item) => item.state), ["completed", "completed"]);
});

test("daemon restart preserves an in-flight item instead of replaying Git", async (t) => {
  const fixture = await repoFixture(t);
  const queue = new GitIntegrationQueue(fixture.state, fixture.root);
  await queue.init();
  const queued = await queue.enqueue({ targetRef: "refs/heads/main", requestId: "in-flight", source: { kind: "commit", commit: fixture.base } });
  await queue.process();
  const ledgerFile = join(fixture.state, repositoryIdentity(fixture.root).repositoryId, "in-flight.json");
  const record = JSON.parse(await readFile(ledgerFile, "utf8"));
  record.state = "integrating";
  await writeFile(ledgerFile, `${JSON.stringify(record)}\n`);
  const restarted = new GitIntegrationQueue(fixture.state, fixture.root);
  await restarted.init();
  const item = (await restarted.status()).items.find((entry) => entry.requestId === queued.requestId);
  assert.equal(item.state, "preserved");
  assert.equal(item.reasonCode, "DAEMON_RESTART_DURING_INTEGRATION");
});
