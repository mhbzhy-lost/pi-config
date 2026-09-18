import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCoordinatorRegistry } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-registry.ts";
import { connectRepositoryCoordinator } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-client.ts";
import { createCoordinatorServer } from "../packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts";
import { resolveRepositoryIdentity } from "../packages/pi-subagents-enhanced/src/workspace/repository-identity.ts";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const moduleRoot = path.resolve("packages/pi-subagents-enhanced/src");

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "managed-multi-root-"));
  const originRoot = path.join(root, "origin");
  await mkdir(path.join(originRoot, "src"), { recursive: true });
  git(originRoot, "init", "-b", "main");
  git(originRoot, "config", "user.email", "test@example.com");
  git(originRoot, "config", "user.name", "Test User");
  await writeFile(path.join(originRoot, "src", "base.txt"), "base\n");
  git(originRoot, "add", ".");
  git(originRoot, "commit", "-m", "initial");
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, originRoot, baseCommit: git(originRoot, "rev-parse", "HEAD") };
}

async function spawnRootClient(t, { rootSessionId, metadata, repositoryId, originRoot, baseCommit }) {
  const script = `
    import { RootBrokerServer } from ${JSON.stringify(path.join(moduleRoot, "subagent-dispatch/root-broker-server.ts"))};
    import { startAndBindRootBroker, rootBrokerRegistryEntry } from ${JSON.stringify(path.join(moduleRoot, "subagent-dispatch/root-broker-registry.ts"))};
    import { connectRepositoryCoordinator } from ${JSON.stringify(path.join(moduleRoot, "workspace/coordinator-client.ts"))};
    const broker = new RootBrokerServer({ rootSessionId: process.env.ROOT_SESSION_ID, lifecycleSessionId: process.env.ROOT_SESSION_ID, upstream: { async ping() { return {}; }, async stop() {}, async dispose() {} } });
    const pi = {};
    await startAndBindRootBroker(pi, broker);
    const metadata = JSON.parse(process.env.COORDINATOR_METADATA);
    const client = await connectRepositoryCoordinator({ repositoryId: process.env.REPOSITORY_ID }, await rootBrokerRegistryEntry(pi), { metadata });
    const request = async (value) => {
      try {
        if (value.method === "close") { await client.close(); process.stdout.write(JSON.stringify({ ok: true, result: null }) + "\\n"); return; }
        process.stdout.write(JSON.stringify({ ok: true, result: await client[value.method](value.input) }) + "\\n");
      }
      catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: String(error?.message || error) }) + "\\n"); }
    };
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { buffer += chunk; let i; while ((i = buffer.indexOf("\\n")) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (line) void request(JSON.parse(line)); } });
    process.stdout.write(JSON.stringify({ ready: true, pid: process.pid, instanceId: client.instanceId }) + "\\n");
    process.on("SIGTERM", async () => { await client.close().catch(() => {}); await broker.closeRootSession().catch(() => {}); process.exit(0); });
  `;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: process.cwd(), env: { ...process.env, ROOT_SESSION_ID: rootSessionId, COORDINATOR_METADATA: JSON.stringify(metadata), REPOSITORY_ID: repositoryId, ORIGIN_ROOT: originRoot, BASE_COMMIT: baseCommit },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  const lines = [];
  let pending;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { let value = lines.splice(0).join("") + chunk; let i; while ((i = value.indexOf("\n")) >= 0) { const line = value.slice(0, i); value = value.slice(i + 1); const reply = JSON.parse(line); if (pending) { const done = pending; pending = undefined; done(reply); } else lines.push(JSON.stringify(reply)); } if (value) lines.push(value); });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Root client startup timed out")), 5000);
    child.stdout.once("data", function onData(chunk) { clearTimeout(timer); void chunk; resolve(JSON.parse(lines.shift())); });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Root client exited ${code}`)));
  });
  assert.equal(ready.ready, true);
  return { child, pid: ready.pid, call(method, input = {}) { return new Promise((resolve) => { pending = resolve; child.stdin.write(`${JSON.stringify({ method, input })}\n`); }); } };
}

function workspaceRequest(f, rootSessionId) {
  return { workspaceId: `workspace-${rootSessionId}`, owner: { kind: "standalone-subagent", rootSessionId, toolCallId: `tool-${rootSessionId}` }, originRoot: f.originRoot, requestedCwd: path.join(f.originRoot, "src"), originRef: "refs/heads/main", baseCommit: f.baseCommit, contractHash: "a".repeat(64), policy: { publication: "allowed", application: "allowed", writePaths: ["src/**"] } };
}

test("two real Root client processes share repository audit while owned operations remain isolated", async (t) => {
  const f = await fixture(t);
  const repositoryId = (await resolveRepositoryIdentity(f.originRoot)).repositoryId;
  const stateRoot = path.join(f.root, "state");
  const registry = createCoordinatorRegistry({ commonDir: path.resolve(f.originRoot, git(f.originRoot, "rev-parse", "--git-common-dir")), stateRoot });
  const metadata = await registry.claim({ repositoryId });
  t.after(() => registry.release());
  const server = createCoordinatorServer({ endpoint: metadata.endpoint, repositoryId, instanceId: metadata.instanceId, stateRoot, idleGraceMs: 10_000 });
  await server.listen();
  t.after(() => server.close());
  const a = await spawnRootClient(t, { rootSessionId: "root-a", metadata, repositoryId, originRoot: f.originRoot, baseCommit: f.baseCommit });
  const b = await spawnRootClient(t, { rootSessionId: "root-b", metadata, repositoryId, originRoot: f.originRoot, baseCommit: f.baseCommit });
  assert.notEqual(a.pid, b.pid);

  const request = workspaceRequest(f, "root-a");
  assert.equal((await a.call("reserve", request)).ok, true);
  const allocated = await a.call("ensureAllocated", request);
  assert.equal(allocated.ok, true);
  assert.equal((await a.call("bindRun", { workspaceId: request.workspaceId, run: { runId: "run-a", asyncDir: path.join(f.root, "async-a") } })).ok, true);
  assert.equal((await a.call("listOwned", {})).result.length, 1);
  assert.equal((await b.call("listOwned", {})).result.length, 0);
  const audit = await b.call("reconcile", { originRoot: f.originRoot });
  assert.equal(audit.ok, true);
  assert.equal(audit.result.find((item) => item.workspaceId === request.workspaceId).state, "active");
  for (const method of ["statusOwned", "disposeOwned", "releaseOwned"]) {
    const result = await b.call(method, { workspaceId: request.workspaceId });
    assert.equal(result.ok, false, `${method} must reject foreign ownership`);
    assert.match(result.error, /belong|owner|scope/i);
  }
  assert.equal((await a.call("close", {})).ok, true);
  const afterDetach = await b.call("reconcile", { originRoot: f.originRoot });
  assert.equal(afterDetach.result.find((item) => item.workspaceId === request.workspaceId).state, "active");
});

test("canonical storage, migration debt, and state root conflict remain persistent evidence", async (t) => {
  const f = await fixture(t);
  const linked = path.join(f.root, "linked");
  git(f.originRoot, "worktree", "add", "-b", "linked", linked);
  const main = await resolveRepositoryIdentity(f.originRoot);
  const linkedIdentity = await resolveRepositoryIdentity(linked);
  assert.equal(linkedIdentity.repositoryId, main.repositoryId);
  assert.equal(linkedIdentity.originRoot, main.originRoot);
  assert.equal(linkedIdentity.migrationDebt?.action, "inventory-only");
  const registry = createCoordinatorRegistry({ commonDir: main.commonDir, stateRoot: path.join(f.root, "state") });
  await registry.claim({ repositoryId: main.repositoryId });
  t.after(() => registry.release());
  const conflicting = createCoordinatorRegistry({ commonDir: main.commonDir, stateRoot: path.join(f.root, "other-state") });
  await assert.rejects(() => conflicting.claim({ repositoryId: main.repositoryId }), /state root/i);
});
