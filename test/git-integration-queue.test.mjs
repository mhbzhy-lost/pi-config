import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import net from "node:net";
import { createHash } from "node:crypto";
import test from "node:test";
import { GitIntegrationQueue } from "../src/git-integration-queue/queue.ts";
import { repositoryIdentity } from "../src/git-integration-queue/repository.ts";
import { socketPath } from "../src/git-integration-queue/connection.ts";
import { classifyHandoff } from "../src/git-integration-queue/adapter.ts";
import { queueRequest } from "../src/git-integration-queue/client.ts";

function run(cwd, args) { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
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
  assert.equal(repositoryIdentity(linked).repositoryRoot, repositoryIdentity(fixture.root).repositoryRoot);
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
  const sourceFirst = join(dirname(fixture.root), `${fixture.root.split("/").pop()}-source-first`);
  const sourceSecond = join(dirname(fixture.root), `${fixture.root.split("/").pop()}-source-second`);
  run(fixture.root, ["worktree", "add", "--detach", sourceFirst, firstCommit]);
  run(fixture.root, ["worktree", "add", "--detach", sourceSecond, secondCommit]);
  t.after(() => {
    for (const source of [sourceFirst, sourceSecond]) { try { run(fixture.root, ["worktree", "remove", "--force", source]); } catch {} }
  });
  run(fixture.root, ["checkout", "main"]);
  const queue = new GitIntegrationQueue(fixture.state, fixture.root);
  await queue.init();
  const one = await queue.enqueue({ targetRef: "refs/heads/main", requestId: "one", source: { kind: "commit", commit: firstCommit, worktreePath: sourceFirst } });
  const duplicate = await queue.enqueue({ targetRef: "refs/heads/main", requestId: "one", source: { kind: "commit", commit: firstCommit, worktreePath: sourceFirst } });
  await queue.enqueue({ targetRef: "refs/heads/main", requestId: "two", source: { kind: "commit", commit: secondCommit, worktreePath: sourceSecond } });
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
  const handoffPath = join(fixture.state, "handoff.json");
  await writeFile(handoffPath, "{}\n");
  const digest = createHash("sha256").update(patch).digest("hex");
  run(fixture.root, ["checkout", "main"]);
  const queue = new GitIntegrationQueue(fixture.state, fixture.root);
  await queue.init();
  await queue.enqueue({ targetRef: "refs/heads/main", requestId: "patch", source: { kind: "handoff-patch", patchPath, handoffPath, baseCommit: fixture.base, patchDigest: digest } });
  await queue.process();
  assert.equal((await queue.status()).items[0].state, "completed");
  assert.equal(await readFile(join(fixture.root, "pipeline.txt"), "utf8"), "base\npatch\n");
});

test("dirty target is preserved and does not integrate", async (t) => {
  const fixture = await repoFixture(t);
  const source = join(dirname(fixture.root), `${fixture.root.split("/").pop()}-source`);
  run(fixture.root, ["worktree", "add", source, "-b", "source"]);
  t.after(() => { try { run(fixture.root, ["worktree", "remove", "--force", source]); } catch {} });
  await writeFile(join(fixture.root, "pipeline.txt"), "dirty\n");
  const queue = new GitIntegrationQueue(fixture.state, fixture.root);
  await queue.init();
  await queue.enqueue({ targetRef: "refs/heads/main", requestId: "dirty", source: { kind: "commit", commit: fixture.base, worktreePath: source } });
  await queue.process();
  const item = (await queue.status()).items[0];
  assert.equal(item.state, "preserved");
  assert.equal(item.reasonCode, "TARGET_DIRTY");
});

test("requestId cannot escape the item namespace or use control names", async (t) => {
  const fixture = await repoFixture(t);
  const queue = new GitIntegrationQueue(fixture.state, fixture.root);
  await queue.init();
  const source = { kind: "commit", commit: fixture.base, worktreePath: fixture.root };
  await assert.rejects(queue.enqueue({ targetRef: "main", requestId: "../escaped", source }), /unsupported/);
  await assert.rejects(queue.enqueue({ targetRef: "main", requestId: "meta", source }), /unsupported|reserved/);
  await assert.rejects(queue.enqueue({ targetRef: "main", requestId: "a".repeat(257), source }), /unsupported/);
  await queue.enqueue({ targetRef: "main", requestId: "same-input", source });
  await assert.rejects(queue.enqueue({ targetRef: "other", requestId: "same-input", source }), /different queue input/);
  await queue.process();
  assert.equal(repositoryIdentity(fixture.root).repositoryId.length, 64);
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

test("failure receipts retain diagnostic paths", () => {
  const handoffPath = join(tmpdir(), "missing-git-queue-handoff.json");
  const receipt = classifyHandoff(handoffPath)[0].receipt;
  assert.equal(receipt.outcome, "failed-closed");
  assert.equal(receipt.reasonCode, "HANDOFF_UNREADABLE");
  assert.equal(receipt.worktreePath, handoffPath);
  assert.equal(receipt.handoffPath, handoffPath);
});

test("handoff classifier covers enqueue, preserve, and fail-closed legs", async (t) => {
  const fixture = await repoFixture(t);
  const patchPath = join(fixture.state, "changed.patch");
  await writeFile(patchPath, "diff --git a/pipeline.txt b/pipeline.txt\n--- a/pipeline.txt\n+++ b/pipeline.txt\n@@ -1 +1,2 @@\n base\n+changed\n");
  const manifestPath = join(fixture.state, "legs.json");
  const group = (patch) => ({ version: 1, runId: "legs", groups: [{ repoRoot: fixture.root, baseCommit: fixture.base, children: [{ index: 0, taskIndex: 0, patch }], cleanup: { tasks: [{ index: 0, worktreeRemoved: true, preserved: false }] } }] });
  await writeFile(manifestPath, JSON.stringify(group({ path: patchPath, changed: true })));
  assert.equal(classifyHandoff(manifestPath)[0].receipt.outcome, "enqueued");
  await writeFile(manifestPath, JSON.stringify({ ...group({ path: patchPath, changed: true }), groups: [{ ...group({ path: patchPath, changed: true }).groups[0], cleanup: { tasks: [{ index: 0, worktreeRemoved: false, preserved: true }] } }] }));
  assert.equal(classifyHandoff(manifestPath)[0].receipt.outcome, "preserved");
  await writeFile(manifestPath, JSON.stringify(group({ path: patchPath })));
  assert.equal(classifyHandoff(manifestPath)[0].receipt.outcome, "failed-closed");
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
    queueRequest(socket, "enqueue", { targetRef: "refs/heads/main", requestId: "daemon-a", source: { kind: "commit", commit: fixture.base, worktreePath: fixture.root } }),
    queueRequest(socket, "enqueue", { targetRef: "refs/heads/main", requestId: "daemon-b", source: { kind: "commit", commit: fixture.base, worktreePath: fixture.root } }),
  ]);
  assert.deepEqual(first.map((item) => item.sequence).sort((a, b) => a - b), [1, 2]);
  await queueRequest(socket, "process");
  const afterConcurrentEnqueue = await queueRequest(socket, "status");
  assert.deepEqual(afterConcurrentEnqueue.items.map((item) => item.state), ["completed", "completed"]);
});

test("production socket path stays within a short platform budget", () => {
  const socket = socketPath("a".repeat(64));
  assert.ok(Buffer.byteLength(socket) <= 104, `${socket} is too long`);
});

test("malformed daemon frames return an error without killing the daemon", async (t) => {
  const fixture = await repoFixture(t);
  const socket = join(fixture.state, "protocol.sock");
  const daemon = spawn(process.execPath, [fileURLToPath(new URL("../src/git-integration-queue/daemon.ts", import.meta.url)), "--socket", socket, "--state-root", fixture.state, "--repo", fixture.root], { stdio: "ignore" });
  t.after(() => daemon.kill("SIGTERM"));
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { await queueRequest(socket, "status"); break; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  await new Promise((resolve, reject) => {
    const client = net.createConnection(socket);
    let data = "";
    client.on("data", (chunk) => { data += chunk.toString(); if (data.includes("\n")) { client.destroy(); resolve(); } });
    client.on("error", reject);
    client.on("connect", () => client.write("not-json\n"));
  });
  const response = JSON.parse(await new Promise((resolve, reject) => {
    const client = net.createConnection(socket);
    let data = "";
    client.on("data", (chunk) => { data += chunk.toString(); if (data.includes("\n")) { client.destroy(); resolve(data.trim()); } });
    client.on("error", reject);
    client.on("connect", () => client.write(`${JSON.stringify({ id: "status", method: "status", params: {} })}\n`));
  }));
  assert.equal(response.ok, true);
});

test("a second daemon cannot steal a live repository lease", async (t) => {
  const fixture = await repoFixture(t);
  const socket = join(fixture.state, "lease.sock");
  const args = [fileURLToPath(new URL("../src/git-integration-queue/daemon.ts", import.meta.url)), "--socket", socket, "--state-root", fixture.state, "--repo", fixture.root];
  const first = spawn(process.execPath, args, { stdio: "ignore" });
  t.after(() => first.kill("SIGTERM"));
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { await queueRequest(socket, "status"); break; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  const second = spawn(process.execPath, args, { stdio: "ignore" });
  const secondExit = await new Promise((resolve) => second.once("exit", (code, signal) => resolve({ code, signal })));
  assert.notEqual(secondExit.code, 0);
  const status = await queueRequest(socket, "status");
  assert.equal(status.repositoryId, repositoryIdentity(fixture.root).repositoryId);
});

test("dead daemon lease is safely recovered", async (t) => {
  const fixture = await repoFixture(t);
  const repositoryId = repositoryIdentity(fixture.root).repositoryId;
  const leasePath = join(fixture.state, repositoryId, "daemon-lease.json");
  await mkdir(join(fixture.state, repositoryId), { recursive: true });
  await writeFile(leasePath, JSON.stringify({ protocol: "pi-git-queue.lease.v1", pid: 99999999, token: "stale", epoch: 1 }));
  const socket = join(fixture.state, "stale-lease.sock");
  const daemon = spawn(process.execPath, [fileURLToPath(new URL("../src/git-integration-queue/daemon.ts", import.meta.url)), "--socket", socket, "--state-root", fixture.state, "--repo", fixture.root], { stdio: "ignore" });
  t.after(() => daemon.kill("SIGTERM"));
  const status = await (async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { return await queueRequest(socket, "status"); } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    throw new Error("stale lease daemon did not become ready");
  })();
  assert.equal(status.repositoryId, repositoryId);
});

test("stale fencing token is rejected before queue writes", async (t) => {
  const fixture = await repoFixture(t);
  const repositoryId = repositoryIdentity(fixture.root).repositoryId;
  const leasePath = join(fixture.state, repositoryId, "daemon-lease.json");
  await mkdir(join(fixture.state, repositoryId), { recursive: true });
  await writeFile(leasePath, JSON.stringify({ protocol: "pi-git-queue.lease.v1", pid: process.pid, token: "current", epoch: 2 }));
  const queue = new GitIntegrationQueue(fixture.state, fixture.root, 2, "stale");
  await queue.init();
  await assert.rejects(queue.enqueue({ targetRef: "main", requestId: "stale-token", source: { kind: "commit", commit: fixture.base, worktreePath: fixture.root } }), /fencing token is stale/);
});

test("detached target fails closed instead of killing queue", async (t) => {
  const fixture = await repoFixture(t);
  const source = join(dirname(fixture.root), `${fixture.root.split("/").pop()}-detached-source`);
  run(fixture.root, ["worktree", "add", source, "-b", "detached-source"]);
  t.after(() => { try { run(fixture.root, ["worktree", "remove", "--force", source]); } catch {} });
  run(fixture.root, ["switch", "--detach"]);
  const queue = new GitIntegrationQueue(fixture.state, fixture.root);
  await queue.init();
  await queue.enqueue({ targetRef: "main", requestId: "detached-target", source: { kind: "commit", commit: fixture.base, worktreePath: source } });
  await queue.process();
  const item = (await queue.status()).items[0];
  assert.equal(item.state, "preserved");
  assert.equal(item.reasonCode, "DETACHED_HEAD");
});

test("sequencer marker fails closed at integration gate", async (t) => {
  const fixture = await repoFixture(t);
  const source = join(dirname(fixture.root), `${fixture.root.split("/").pop()}-sequencer-source`);
  run(fixture.root, ["worktree", "add", source, "-b", "sequencer-source"]);
  const marker = join(fixture.root, ".git", "CHERRY_PICK_HEAD");
  await writeFile(marker, fixture.base);
  t.after(async () => { await rm(marker, { force: true }); try { run(fixture.root, ["worktree", "remove", "--force", source]); } catch {} });
  const queue = new GitIntegrationQueue(fixture.state, fixture.root);
  await queue.init();
  await queue.enqueue({ targetRef: "main", requestId: "sequencer-target", source: { kind: "commit", commit: fixture.base, worktreePath: source } });
  await queue.process();
  const item = (await queue.status()).items[0];
  assert.equal(item.state, "preserved");
  assert.equal(item.reasonCode, "SEQUENCER_ACTIVE");
});

test("daemon restart preserves an in-flight item instead of replaying Git", async (t) => {
  const fixture = await repoFixture(t);
  const queue = new GitIntegrationQueue(fixture.state, fixture.root);
  await queue.init();
  const queued = await queue.enqueue({ targetRef: "refs/heads/main", requestId: "in-flight", source: { kind: "commit", commit: fixture.base, worktreePath: fixture.root } });
  await queue.process();
  const itemKey = createHash("sha256").update("in-flight").digest("hex").slice(0, 32);
  const ledgerFile = join(fixture.state, repositoryIdentity(fixture.root).repositoryId, "items", `${itemKey}.json`);
  const record = JSON.parse(await readFile(ledgerFile, "utf8"));
  record.state = "integrating";
  await writeFile(ledgerFile, `${JSON.stringify(record)}\n`);
  const restarted = new GitIntegrationQueue(fixture.state, fixture.root);
  await restarted.init();
  const item = (await restarted.status()).items.find((entry) => entry.requestId === queued.requestId);
  assert.equal(item.state, "preserved");
  assert.equal(item.reasonCode, "DAEMON_RESTART_DURING_INTEGRATION");
});
