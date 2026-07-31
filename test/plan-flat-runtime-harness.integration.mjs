import assert from "node:assert/strict";
import { spawn, execFile as execFileCallback } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { parsePlanDocument } from "../scripts/lib/plan/plan-document.mjs";
import { compilePlanToIR } from "../scripts/lib/plan/ir/index.mjs";

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(import.meta.dirname, "..");
const piBinary = process.env.PI_REAL_BIN;
const provider = path.join(repoRoot, "test/fixtures/deterministic-provider.mjs");
const runnerExtension = path.join(repoRoot, "test/fixtures/plan-harness/plan-runner-extension.ts");
const executorExtension = path.join(repoRoot, "test/fixtures/plan-harness/executor-extension.ts");
const sourcePlan = path.join(repoRoot, "test/fixtures/plan-harness/plans/parallel-success.md");
const rootRuntime = path.join(repoRoot, "pi/extensions/subagent-runtime.ts");
const launcher = path.join(repoRoot, "pi/extensions/plan-launcher.ts");
const rootOwner = path.join(repoRoot, "pi/child-extensions/root-session-owner.ts");

async function git(cwd, ...args) { return (await execFile("git", args, { cwd })).stdout.trim(); }
async function gitRaw(cwd, ...args) { return (await execFile("git", args, { cwd })).stdout; }
async function assertRuntimeClean(cwd) {
  const status = await gitRaw(cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all");
  const dirty = status.split("\0").filter(Boolean).map((entry) => ({ status: entry.slice(0, 2), path: entry.slice(3) }))
    .filter((entry) => entry.status !== "??" || !entry.path.startsWith(".pi-subagents/"));
  assert.deepEqual(dirty, []);
  assert.equal(await gitRaw(cwd, "ls-files", "-z", "--", ".pi-subagents"), "");
}
async function readJson(file) { try { return JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error?.code === "ENOENT" || error instanceof SyntaxError) return undefined; throw error; } }
async function runnerDiagnostic(asyncDir) {
  const status = await readJson(path.join(asyncDir, "status.json"));
  const logs = await Promise.all(["runner.stderr.log", "stderr.log", "stderr.txt", "output/runner.stderr", "output/runner.stderr.log", "output.log"].map(async (name) => { try { return await readFile(path.join(asyncDir, name), "utf8"); } catch (error) { if (error?.code === "ENOENT") return ""; throw error; } }));
  return { status, logs: logs.filter(Boolean).join("\n") };
}

async function readPlanEvents(sessionFile) {
  const lines = (await readFile(sessionFile, "utf8")).split("\n").filter(Boolean);
  return lines.map((line) => JSON.parse(line))
    .filter((entry) => entry?.customType === "pi-plan-event-v1" && entry?.data)
    .map((entry) => entry.data);
}

class RootRpc {
  constructor(child) {
    this.child = child; this.records = []; this.stderr = ""; this.buffer = "";
    this.exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.consume(chunk)); child.stderr.on("data", (chunk) => { this.stderr += chunk; });
  }
  consume(chunk) { this.buffer += chunk; for (;;) { const i = this.buffer.indexOf("\n"); if (i < 0) return; const line = this.buffer.slice(0, i); this.buffer = this.buffer.slice(i + 1); if (!line) continue; try { this.records.push(JSON.parse(line)); } catch { this.records.push({ type: "invalid-json", line }); } } }
  send(value) { this.child.stdin.write(`${JSON.stringify(value)}\n`); }
  async waitForExact(predicate, count, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.records.filter(predicate);
      if (found.length === count) return found;
      if (found.length > count) throw new Error(`${label} produced ${found.length} records, expected ${count}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`${label} timed out; stderr=${this.stderr}\nrecords=${JSON.stringify(this.records.slice(-12))}`);
  }
  async close() {
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), 8_000); });
    try {
      const exit = await Promise.race([this.exited, timeout]);
      if (!exit) {
        this.child.kill("SIGKILL");
        await this.exited;
      }
    } finally { clearTimeout(timer); }
  }
}
function resultValue(record) { const raw = record?.result; const text = raw?.content?.filter?.((part) => part?.type === "text").map((part) => part.text).join("\n") ?? raw?.text; if (typeof text === "string") try { return JSON.parse(text); } catch {} return raw?.details ?? raw; }
async function waitForPlanOrRunner(statusPath, asyncDir) {
  const deadline = Date.now() + 30_000; let plan; let runner;
  while (Date.now() < deadline) { plan = await readJson(statusPath); const detail = await runnerDiagnostic(asyncDir); runner = detail.status; if (["validated", "blocked", "cancelled"].includes(plan?.lifecycle)) return { plan, runner }; if (["failed", "stopped"].includes(runner?.state) && !["validated", "blocked", "cancelled"].includes(plan?.lifecycle)) { const diagnostic = JSON.stringify({ plan, runner, error: runner?.error, logs: detail.logs }); if (/Harness Plan Runner must be standalone/.test(diagnostic)) throw new Error("Harness Plan Runner must be standalone"); throw new Error(`Plan Runner terminated before Plan status: ${diagnostic}`); } await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error(`flat Harness timed out: ${JSON.stringify({ plan, runner })}`);
}

async function assertFutureGreen(handle, outcome, planPath, runtimeTmp) {
  const { plan: status, runner: runnerAsyncStatus } = outcome;
  assert.equal(status.lifecycle, "validated"); assert.equal(status.tasks.length, 2);
  assert.ok(status.tasks.every((task) => task.status === "accepted" && task.attempts?.[0]?.status === "integrated"));
  const runnerSessionFile = runnerAsyncStatus.steps?.[0]?.sessionFile;
  assert.ok(runnerSessionFile);
  const events = await readPlanEvents(runnerSessionFile);
  const attempts = status.tasks.flatMap((task) => task.attempts);
  assert.equal(attempts.length, 2);
  const bounds = events.filter((event) => event.type === "attempt.bound");
  assert.equal(bounds.length, 2);
  const executorRuns = attempts.map((attempt) => {
    const matches = bounds.filter((bound) => bound.data.attemptId === attempt.attemptId);
    assert.equal(matches.length, 1, `Plan Runner session must bind ${attempt.attemptId} exactly once`);
    const bound = matches[0];
    assert.equal(bound.data.dispatchId, attempt.dispatchId);
    assert.equal(bound.data.runId, attempt.runId);
    assert.equal(typeof bound.data.asyncDir, "string");
    assert.ok(bound.data.asyncDir.trim());
    return { runId: attempt.runId, asyncDir: bound.data.asyncDir };
  });
  assert.equal(await readFile(path.join(handle.worktree, "README.md"), "utf8"), "base\nworker\n");
  assert.equal(await readFile(path.join(handle.worktree, "worker.txt"), "utf8"), "worker-2\n");
  assert.equal(await git(handle.worktree, "rev-list", "--count", `${handle.baseCommit}..HEAD`), "2"); await assertRuntimeClean(handle.worktree);
  const runs = [{ runId: handle.planRunnerRunId, asyncDir: handle.asyncDir }, ...executorRuns];
  assert.equal(runs.length, 3);
  assert.ok(runs.every((run) => run?.runId && run?.asyncDir));
  assert.equal(new Set(runs.map((run) => run.runId)).size, 3);
  const asyncStatuses = [runnerAsyncStatus, ...await Promise.all(runs.slice(1).map((run) => readJson(path.join(run.asyncDir, "status.json"))))];
  const sessionIds = asyncStatuses.map((value) => value.sessionId);
  for (const [index, run] of runs.entries()) {
    const resolvedAsyncDir = path.resolve(run.asyncDir);
    assert.equal(path.basename(resolvedAsyncDir), run.runId);
    assert.equal(path.basename(path.dirname(resolvedAsyncDir)), "async-subagent-runs");
    assert.ok(resolvedAsyncDir.startsWith(`${path.resolve(runtimeTmp)}${path.sep}`));
    assert.notEqual(path.basename(path.dirname(resolvedAsyncDir)), "nested-subagent-runs");
    for (const field of ["parentRunId", "parentStepIndex", "depth", "path"]) assert.ok(!Object.hasOwn(asyncStatuses[index], field));
  }
  assert.equal(new Set(sessionIds).size, 1);
  assert.match(path.basename(sessionIds[0]), new RegExp(handle.rootSessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.notEqual(path.basename(sessionIds[0]), handle.rootSessionId);
  assert.doesNotMatch(JSON.stringify({ handle, status, asyncStatuses }), /Standalone Host|hostHandle|hostRunId/);

  const plan = parsePlanDocument(await readFile(planPath, "utf8"), planPath);
  const ir = compilePlanToIR(plan);
  assert.equal(plan.schemaVersion, "pi-plan.v3");
  const created = events.find((event) => event.type === "plan.created");
  assert.ok(created, "Plan Runner session must contain plan.created");
  assert.deepEqual(created.data.revision, {
    number: handle.revision,
    manifestSha256: handle.manifestSha256,
    sourceBytesSha256: handle.sourceBytesSha256,
    planHash: plan.sha256,
    irVersion: ir.version,
    irHash: ir.hash,
    taskHashes: Object.fromEntries(ir.nodes.map((node) => [node.id, {
      full: node.hashes.full,
      effective: node.hashes.effective,
      scheduling: node.hashes.scheduling,
    }])),
  });
  const dispatches = events.filter((event) => event.type === "attempt.dispatch-requested");
  assert.equal(dispatches.length, 2);
  for (const node of ir.nodes) {
    const dispatch = dispatches.find((event) => event.data.taskId === node.id);
    assert.ok(dispatch, `Plan Runner session must dispatch ${node.id}`);
    assert.equal(dispatch.data.planIrHash, ir.hash);
    assert.equal(dispatch.data.taskHash, node.hashes.effective);
    assert.equal(dispatch.data.schedulingHash, node.hashes.scheduling);
    assert.ok(dispatch.data.tool.task.includes(`Plan instructions:\n${plan.instructions}`));
    assert.ok(dispatch.data.tool.task.includes(`Task body:\n${node.body}`));
    assert.ok(dispatch.data.tool.task.includes(`Acceptance: ${node.acceptance.strategy}`));
    assert.ok(dispatch.data.tool.task.includes(JSON.stringify(node.acceptance)));
  }
  return { executorRuns, events };
}

test("flat Root runtime Harness reaches two validated Plan Runner happy paths", { timeout: 90_000 }, async (t) => {
  assert.ok(piBinary, "PI_REAL_BIN is required for the flat runtime Harness integration test");
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-plan-flat-runtime-")); const origin = path.join(root, "origin"); const runtimeTmp = path.join(root, "tmp"); const sessions = path.join(root, "sessions");
  let rpc; let primaryError;
  try {
    await mkdir(path.join(origin, ".pi", "agents"), { recursive: true }); await mkdir(runtimeTmp); await mkdir(sessions); await git(origin, "init"); await git(origin, "config", "user.email", "harness@example.com"); await git(origin, "config", "user.name", "Flat Harness");
    await writeFile(path.join(origin, "README.md"), "base\n"); await mkdir(path.join(origin, "docs"));
    const planPaths = [path.join(origin, "docs", "plan-one.md"), path.join(origin, "docs", "plan-two.md")];
    await Promise.all(planPaths.map((planPath) => copyFile(sourcePlan, planPath)));
    await writeFile(path.join(origin, ".pi", "agents", "plan-runner.md"), `---\nname: plan-runner\ndescription: deterministic flat Harness Plan Runner\nmodel: fake/deterministic\nthinking: off\ntemperature: 0\ntools: plan_open,read,grep\nsubagentOnlyExtensions: ${provider},${runnerExtension}\n---\nOpen and execute only the approved Plan revision.\n`);
    await writeFile(path.join(origin, ".pi", "agents", "executor.md"), `---\nname: executor\ndescription: deterministic flat Harness executor\nmodel: fake/deterministic\nthinking: off\ntemperature: 0\ntools: bash,read,contact_supervisor\nsubagentOnlyExtensions: ${provider},${executorExtension},${rootOwner}\n---\nExecute only the approved task and commit the result.\n`);
    await writeFile(path.join(origin, "commit-message"), "test: 初始化 flat Harness\n"); await git(origin, "add", "."); await git(origin, "commit", "--file", "commit-message");
    const rootSessionId = `flat-${path.basename(root)}`;
    const rootEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("PI_SUBAGENT_") && name !== "PI_ROOT_SUBAGENT_BROKER_ENABLED"));
    const child = spawn(piBinary, ["--mode", "rpc", "--session-dir", sessions, "--session-id", rootSessionId, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--approve", "--offline", "-e", provider, "-e", rootRuntime, "-e", launcher, "--provider", "fake", "--model", "fake/deterministic"], { cwd: origin, env: { ...rootEnv, PI_CODING_AGENT_DIR: path.join(repoRoot, "pi"), TMPDIR: runtimeTmp, OPENAI_API_KEY: "not-used" }, stdio: ["pipe", "pipe", "pipe"] });
    rpc = new RootRpc(child); rpc.send({ id: "flat-root-harness", type: "prompt", message: `PI_PLAN_FLAT_ROOT_HARNESS\n${JSON.stringify({ planPaths })}` });
    const events = await rpc.waitForExact((record) => record.type === "tool_execution_end" && record.toolName === "plan_run", 2, 25_000, "plan_run handles");
    const handles = events.map(resultValue);
    const handleKeys = ["asyncDir", "baseCommit", "manifestSha256", "planHash", "planId", "planIrHash", "planRunnerRunId", "revision", "rootSessionId", "schemaVersion", "sourceBytesSha256", "worktree"];
    for (const handle of handles) {
      assert.deepEqual(Object.keys(handle).sort(), handleKeys);
      assert.equal(handle.schemaVersion, "pi-plan-handle.v4");
      assert.equal(handle.rootSessionId, rootSessionId);
    }
    for (const key of ["planId", "worktree", "planRunnerRunId", "asyncDir"]) assert.equal(new Set(handles.map((handle) => handle[key])).size, 2, `Plan handles must have unique ${key}`);
    const outcomes = await Promise.all(handles.map((handle) => waitForPlanOrRunner(path.join(origin, "var", "plan-runs", handle.planId, "status.json"), handle.asyncDir)));
    const greens = await Promise.all(handles.map((handle, index) => assertFutureGreen(handle, outcomes[index], planPaths[index], runtimeTmp)));
    const initialRuns = handles.flatMap((handle, index) => [{ runId: handle.planRunnerRunId, asyncDir: handle.asyncDir }, ...greens[index].executorRuns]);
    assert.equal(initialRuns.length, 6);
    for (const key of ["runId", "asyncDir"]) assert.equal(new Set(initialRuns.map((run) => run[key])).size, 6, `Initial runs must have unique ${key}`);

    const resolvedRuntimeTmp = path.resolve(runtimeTmp);
    const asyncRoots = new Set(handles.map((handle) => path.dirname(path.resolve(handle.asyncDir))));
    assert.equal(asyncRoots.size, 1);
    const [asyncRoot] = asyncRoots;
    assert.equal(path.basename(asyncRoot), "async-subagent-runs");
    assert.ok(asyncRoot.startsWith(`${resolvedRuntimeTmp}${path.sep}`));
    assert.notEqual(asyncRoot, resolvedRuntimeTmp);
    const actualRuns = await Promise.all((await readdir(asyncRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map(async (entry) => ({ asyncDir: path.join(asyncRoot, entry.name), status: await readJson(path.join(asyncRoot, entry.name, "status.json")) })));
    assert.ok(actualRuns.length >= 6);
    const executors = actualRuns.filter(({ status }) => status?.steps?.[0]?.agent === "executor");
    const runners = actualRuns.filter(({ status }) => status?.steps?.[0]?.agent === "plan-runner");
    assert.equal(executors.length, 4);
    assert.deepEqual(new Set(executors.map(({ status }) => status.runId)), new Set(greens.flatMap(({ executorRuns }) => executorRuns.map((run) => run.runId))));
    assert.ok(handles.every((handle) => runners.some(({ status }) => status.runId === handle.planRunnerRunId)));
    for (const { asyncDir, status } of actualRuns) {
      assert.ok(status);
      assert.equal(path.dirname(asyncDir), asyncRoot);
      assert.equal(path.basename(asyncDir), status.runId);
      assert.match(path.basename(status.sessionId), new RegExp(rootSessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.notEqual(path.basename(status.sessionId), rootSessionId);
      for (const field of ["parentRunId", "parentStepIndex", "depth", "path"]) assert.ok(!Object.hasOwn(status, field));
    }
    for (const { status } of runners) assert.equal(handles.filter((handle) => handle.worktree === status.cwd).length, 1, "Plan Runner cwd must belong to exactly one Plan worktree");
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let closeError;
    try { await rpc?.close(); } catch (error) { closeError = error; }
    if (process.env.PLAN_HARNESS_PRESERVE === "1") t.diagnostic(`preserved=${root}`);
    else await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    if (closeError) {
      if (primaryError) { primaryError.cleanupError = closeError; t.diagnostic(`Root close failed: ${closeError.message}`); }
      else throw closeError;
    }
  }
});
