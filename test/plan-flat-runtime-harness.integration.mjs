import assert from "node:assert/strict";
import { spawn, execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { parsePlanDocument } from "../scripts/lib/plan/plan-document.mjs";
import { compilePlanToIR } from "../scripts/lib/plan/ir/index.mjs";
import { brokerSocketPath, parseProcessTerminal } from "../scripts/lib/subagent-dispatch/root-broker-protocol.ts";
import { driveHarnessAttention } from "./support/flat-plan-attention-driver.mjs";
import { finalizeHarnessCleanup, processesReferencing, removeFixtureWithEvidence, terminateDetachedRunsUnder } from "./support/plan-e2e-process-cleanup.mjs";

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
function sessionMessages(entries) { return entries.filter((entry) => entry?.type === "message" && entry.message && typeof entry.message === "object").map((entry) => entry.message); }
function toolCalls(messages, name) { return messages.flatMap((message, messageIndex) => message?.role === "assistant" ? (message.content ?? []).flatMap((part) => part?.type === "toolCall" && part.name === name ? [{ message, messageIndex, part }] : []) : []); }
function toolResults(messages, name, toolCallId) { return messages.flatMap((message, messageIndex) => message?.role === "toolResult" && message.toolName === name && message.toolCallId === toolCallId ? [{ message, messageIndex }] : []); }
function finiteTime(value, label) { const timestamp = typeof value === "number" ? value : Date.parse(value); assert.ok(Number.isFinite(timestamp), `${label} must be finite`); return timestamp; }
function logicalCallerAt(grants, logicalCallerRunId, initialRunId, occurredAt, label) {
  const timestamp = finiteTime(occurredAt, label);
  const candidates = grants.filter((grant) => grant.logicalCallerRunId === logicalCallerRunId && grant.observedAt <= timestamp);
  return candidates.at(-1)?.activeRunId ?? initialRunId;
}
function assertOfficialTerminal(sidecar, runId) {
  assert.ok(sidecar && typeof sidecar === "object" && !Array.isArray(sidecar), `official terminal for ${runId}`);
  assert.equal(sidecar.runId, runId, `official terminal runId for ${runId}`);
  const { runId: _runId, ...terminal } = sidecar;
  parseProcessTerminal(terminal);
  assert.equal(terminal.state, "observed", `official terminal state for ${runId}`);
  const runner = terminal.instances.find((instance) => instance.kind === "runner" && instance.processInstanceId === terminal.runnerProcessInstanceId);
  assert.ok(runner, `official terminal must contain matching Runner for ${runId}`);
  assert.equal(runner.exitCode, 0, `Runner exit code for ${runId}`);
  assert.equal(runner.signal, null, `Runner signal for ${runId}`);
}
function exactObject(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} fields`);
  return value;
}
function textContent(message) { return Array.isArray(message?.content) ? message.content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("\n") : typeof message?.content === "string" ? message.content : ""; }
async function readSession(sessionFile) { return (await readFile(sessionFile, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
function attentionMarker(body, requestId) {
  const prefix = "PI_PLAN_FLAT_ATTENTION ";
  const markerLines = body.split(/\r?\n/).filter((line) => line.startsWith(prefix));
  assert.equal(markerLines.length, 1, `Attention ${requestId} exact marker line`);
  const marker = exactObject(JSON.parse(markerLines[0].slice(prefix.length)), ["schemaVersion", "executorRunId", "taskId", "writePath"], `Attention ${requestId} marker`);
  assert.equal(marker.schemaVersion, "pi-plan-flat-attention-marker.v1");
  return marker;
}
function rootSessionFile(sessions, sessionId) { return path.join(sessions, path.basename(sessionId)); }

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
        const forced = await this.exited;
        throw new Error(`Root RPC graceful close timed out and forced exit ${JSON.stringify(forced)}`);
      }
      if (exit.code !== 0 || exit.signal !== null) throw new Error(`Root RPC graceful close failed ${JSON.stringify(exit)}`);
    } finally { clearTimeout(timer); }
  }
}
function resultValue(record) { const raw = record?.result; const text = raw?.content?.filter?.((part) => part?.type === "text").map((part) => part.text).join("\n") ?? raw?.text; if (typeof text === "string") try { return JSON.parse(text); } catch {} return raw?.details ?? raw; }
async function waitForPlanOrRunner(statusPath, asyncDir) {
  const deadline = Date.now() + 30_000; let plan; let runner;
  while (Date.now() < deadline) { plan = await readJson(statusPath); const detail = await runnerDiagnostic(asyncDir); runner = detail.status; if (["validated", "blocked", "cancelled"].includes(plan?.lifecycle)) return { plan, runner }; if (["failed", "stopped"].includes(runner?.state) && !["validated", "blocked", "cancelled"].includes(plan?.lifecycle)) { const diagnostic = JSON.stringify({ plan, runner, error: runner?.error, logs: detail.logs }); if (/Harness Plan Runner must be standalone/.test(diagnostic)) throw new Error("Harness Plan Runner must be standalone"); throw new Error(`Plan Runner terminated before Plan status: ${diagnostic}`); } await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error(`flat Harness timed out: ${JSON.stringify({ plan, runner })}`);
}

async function assertFutureGreen(handle, outcome, planPath, runtimeTmp, attention = []) {
  const { plan: status, runner: runnerAsyncStatus } = outcome;
  assert.equal(status.lifecycle, "validated"); assert.equal(status.tasks.length, 2);
  assert.ok(status.tasks.every((task) => task.status === "accepted" && task.attempts?.[0]?.status === "integrated"));
  const runnerSessionFile = runnerAsyncStatus.steps?.[0]?.sessionFile;
  assert.ok(runnerSessionFile);
  const events = await readPlanEvents(runnerSessionFile);
  for (const pending of attention) {
    const attentionEvent = (type) => {
      const matches = events.filter((event) => event.type === type && event.data?.requestId === pending.requestId);
      assert.equal(matches.length, 1, `${pending.requestId} must have one ${type}`);
      assert.equal(matches[0].data.attemptId, pending.attemptId);
      assert.equal(matches[0].data.runId, pending.executorRunId);
      return matches[0];
    };
    const requested = attentionEvent("attempt.attention-requested");
    assert.equal(requested.data.taskId, pending.taskId);
    attentionEvent("attempt.attention-escalated");
    const resolved = attentionEvent("attempt.attention-resolved");
    assert.equal(resolved.data.resolutionSha256, createHash("sha256").update(pending.message).digest("hex"));
  }
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
  return { executorRuns, events, runnerSessionFile };
}

test("flat Root runtime Harness reaches two validated Plan Runner happy paths", { timeout: 140_000 }, async (t) => {
  assert.ok(piBinary, "PI_REAL_BIN is required for the flat runtime Harness integration test");
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-plan-flat-runtime-")); const origin = path.join(root, "origin"); const runtimeTmp = path.join(root, "tmp"); const sessions = path.join(root, "sessions"); const agentDir = path.join(root, "agent-dir");
  let rpc; let primaryError; let rootSessionId; let passed = false;
  try {
    await mkdir(path.join(origin, ".pi", "agents"), { recursive: true }); await mkdir(runtimeTmp); await mkdir(sessions); await mkdir(agentDir); await git(origin, "init"); await git(origin, "config", "user.email", "harness@example.com"); await git(origin, "config", "user.name", "Flat Harness");
    await writeFile(path.join(origin, "README.md"), "base\n"); await mkdir(path.join(origin, "docs"));
    const planPaths = [path.join(origin, "docs", "plan-one.md"), path.join(origin, "docs", "plan-two.md")];
    await Promise.all(planPaths.map((planPath) => copyFile(sourcePlan, planPath)));
    await writeFile(path.join(origin, ".pi", "agents", "plan-runner.md"), `---\nname: plan-runner\ndescription: deterministic flat Harness Plan Runner\nmodel: fake/deterministic\nthinking: off\ntemperature: 0\ntools: plan_open,read,grep\nsubagentOnlyExtensions: ${provider},${runnerExtension}\n---\nOpen and execute only the approved Plan revision.\n`);
    await writeFile(path.join(origin, ".pi", "agents", "executor.md"), `---\nname: executor\ndescription: deterministic flat Harness executor\nmodel: fake/deterministic\nthinking: off\ntemperature: 0\ntools: bash,read,contact_supervisor\nsubagentOnlyExtensions: ${provider},${executorExtension},${rootOwner}\n---\nExecute only the approved task and commit the result.\n`);
    await writeFile(path.join(origin, "commit-message"), "test: 初始化 flat Harness\n"); await git(origin, "add", "."); await git(origin, "commit", "--file", "commit-message");
    rootSessionId = `flat-${path.basename(root)}`;
    const rootEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("PI_SUBAGENT_") && name !== "PI_ROOT_SUBAGENT_BROKER_ENABLED"));
    const child = spawn(piBinary, ["--mode", "rpc", "--session-dir", sessions, "--session-id", rootSessionId, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--approve", "--offline", "-e", provider, "-e", rootRuntime, "-e", launcher, "--provider", "fake", "--model", "fake/deterministic"], { cwd: origin, env: { ...rootEnv, PI_CODING_AGENT_DIR: agentDir, PI_PLAN_HARNESS_ATTENTION: "1", TMPDIR: runtimeTmp, OPENAI_API_KEY: "not-used" }, stdio: ["pipe", "pipe", "pipe"] });
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
    const pending = [];
    const attention = await driveHarnessAttention({
      handles,
      expectedPerPlan: 2,
      readStatuses: () => Promise.all(handles.map((handle) => readJson(path.join(origin, "var", "plan-runs", handle.planId, "status.json")))),
      readRunners: async () => (await Promise.all(handles.map((handle) => runnerDiagnostic(handle.asyncDir)))).map(({ status }) => status),
      onPending: async ({ planIndex, handle, attempt }) => {
        const runner = await runnerDiagnostic(handle.asyncDir);
        const runnerSessionFile = runner.status?.steps?.[0]?.sessionFile;
        assert.ok(runnerSessionFile, "Attention Plan Runner must persist a session file");
        const planEvents = await readPlanEvents(runnerSessionFile);
        const requested = planEvents.filter((event) => event.type === "attempt.attention-requested" && event.data?.requestId === attempt.attention?.requestId);
        assert.equal(requested.length, 1, "waiting Attention must have one requested event");
        const event = requested[0]; const evidence = event.data.evidence;
        assert.equal(event.data.taskId, attempt.taskId); assert.equal(event.data.attemptId, attempt.attemptId); assert.equal(event.data.runId, attempt.runId);
        assert.equal(evidence?.bodyPath, `attention/${event.data.requestId}.md`);
        const body = await readFile(path.join(origin, "var", "plan-runs", handle.planId, evidence.bodyPath), "utf8");
        assert.equal(createHash("sha256").update(body).digest("hex"), evidence.bodySha256);
        const marker = attentionMarker(body, event.data.requestId);
        const executorRunId = attempt.runId;
        assert.equal(marker.executorRunId, executorRunId); assert.equal(marker.taskId, attempt.taskId);
        assert.equal(marker.writePath, attempt.taskId === "task-1" ? "README.md" : "worker.txt");
        const entry = { planIndex, planId: handle.planId, taskId: attempt.taskId, attemptId: attempt.attemptId, executorRunId, requestId: event.data.requestId, expectedProjectionVersion: attempt.attention.projectionVersion, message: `APPROVED ${event.data.requestId}`, marker, requested: event };
        const beforeReply = rpc.records.length;
        rpc.send({ id: `flat-root-attention-reply-${entry.requestId}`, type: "prompt", message: `PI_PLAN_FLAT_ATTENTION_REPLIES\n${JSON.stringify({ replies: [{ planId: entry.planId, requestId: entry.requestId, expectedProjectionVersion: entry.expectedProjectionVersion, message: entry.message }] })}` });
        const reply = await rpc.waitForExact((record) => record.type === "tool_execution_end" && record.toolName === "plan_attention_reply" && resultValue(record)?.requestId === entry.requestId, 1, 45_000, `plan_attention_reply ${entry.requestId}`);
        const record = reply[0]; assert.ok(rpc.records.indexOf(record) >= beforeReply, "reply must be recorded in this Attention round"); assert.ok(!record.result?.isError, JSON.stringify(record));
        const value = resultValue(record); assert.equal(value.status, "queued"); assert.equal(value.planId, entry.planId); assert.equal(value.requestId, entry.requestId);
        pending.push(entry);
      },
    });
    assert.deepEqual(attention.pending.map((entries) => entries.length), [2, 2]);
    assert.equal(pending.length, 4); assert.equal(new Set(pending.map((entry) => entry.requestId)).size, 4); assert.equal(new Set(pending.map((entry) => entry.executorRunId)).size, 4);
    for (const planIndex of [0, 1]) for (const taskId of ["task-1", "task-2"]) assert.equal(pending.filter((entry) => entry.planIndex === planIndex && entry.taskId === taskId).length, 1, `one pending Attention for plan ${planIndex} ${taskId}`);
    const outcomes = await Promise.all(handles.map((handle) => waitForPlanOrRunner(path.join(origin, "var", "plan-runs", handle.planId, "status.json"), handle.asyncDir)));
    const greens = await Promise.all(handles.map((handle, index) => assertFutureGreen(handle, outcomes[index], planPaths[index], runtimeTmp, pending.filter((entry) => entry.planIndex === index))));
    const initialRuns = handles.flatMap((handle, index) => [{ runId: handle.planRunnerRunId, asyncDir: handle.asyncDir }, ...greens[index].executorRuns]);
    assert.equal(initialRuns.length, 6);
    for (const key of ["runId", "asyncDir"]) assert.equal(new Set(initialRuns.map((run) => run[key])).size, 6, `Initial runs must have unique ${key}`);

    await rpc.close();
    rpc = undefined;

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
      assert.ok(typeof status.sessionId === "string" && status.sessionId.trim(), "Persisted actual Run must have a sessionId");
      assert.equal(path.dirname(asyncDir), asyncRoot);
      assert.equal(path.basename(asyncDir), status.runId);
      assert.match(path.basename(status.sessionId), new RegExp(rootSessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.notEqual(path.basename(status.sessionId), rootSessionId);
      for (const field of ["parentRunId", "parentStepIndex", "depth", "path"]) assert.ok(!Object.hasOwn(status, field));
      assertOfficialTerminal(await readJson(path.join(asyncDir, "process-terminal.json")), status.runId);
      assert.ok(Number.isSafeInteger(status.pid) && status.pid > 0, `Run ${status.runId} status PID`);
      try { process.kill(status.pid, 0); assert.fail(`Run ${status.runId} PID ${status.pid} remains alive after graceful close`); } catch (error) { assert.equal(error?.code, "ESRCH", `Run ${status.runId} PID check`); }
    }
    for (const { status } of runners) assert.equal(handles.filter((handle) => handle.worktree === status.cwd).length, 1, "Plan Runner cwd must belong to exactly one Plan worktree");
    const runnerSessions = new Map();
    for (const handle of handles) {
      const sessionFiles = new Set(runners.filter(({ status }) => status.cwd === handle.worktree).map(({ status }) => status.steps?.[0]?.sessionFile));
      assert.equal(sessionFiles.size, 1, `Plan ${handle.planId} Runner generations must share one canonical session`);
      const [sessionFile] = sessionFiles;
      assert.ok(typeof sessionFile === "string" && sessionFile, `Plan ${handle.planId} canonical Runner session`);
      runnerSessions.set(handle.worktree, sessionMessages(await readSession(sessionFile)));
    }
    const rootSession = rootSessionFile(sessions, actualRuns[0].status.sessionId);
    const rootEntries = await readSession(rootSession);
    const diagnostics = rootEntries.filter((entry) => entry?.customType === "pi-root-broker-revival-v1" && entry?.data).map((entry) => entry.data);
    const grants = diagnostics.filter((entry) => entry.phase === "grant.issued").sort((left, right) => left.observedAt - right.observedAt || left.generation - right.generation);
    for (const grant of grants) {
      finiteTime(grant.observedAt, "Root grant observedAt");
      assert.ok(Number.isSafeInteger(grant.generation) && grant.generation >= 1, "Root grant generation must be a positive safe integer");
      assert.ok(typeof grant.logicalCallerRunId === "string" && grant.logicalCallerRunId, "Root grant logical caller");
      assert.ok(typeof grant.activeRunId === "string" && grant.activeRunId, "Root grant active caller");
    }
    for (let index = 1; index < grants.length; index++) assert.ok(grants[index].observedAt > grants[index - 1].observedAt || (grants[index].observedAt === grants[index - 1].observedAt && grants[index].generation >= grants[index - 1].generation), "Root grants must be monotonic by observedAt/generation");
    const closeStarted = diagnostics.filter((entry) => entry.phase === "close.started");
    const closeCompleted = diagnostics.filter((entry) => entry.phase === "close.completed");
    assert.equal(closeStarted.length, 1); assert.equal(closeCompleted.length, 1);
    assert.ok(rootEntries.findIndex((entry) => entry?.data === closeStarted[0]) < rootEntries.findIndex((entry) => entry?.data === closeCompleted[0]), "Root close.started must precede close.completed");
    await assert.rejects(lstat(brokerSocketPath(rootSessionId)), { code: "ENOENT" });

    for (const entry of pending) {
      const reply = exactObject(await readJson(path.join(origin, "var", "plan-runs", entry.planId, "control", "attention", `${entry.requestId}.reply.json`)), ["schemaVersion", "planId", "requestId", "taskId", "attemptId", "runId", "expectedProjectionVersion", "message", "occurredAt"], "durable attention reply");
      const ack = exactObject(await readJson(path.join(origin, "var", "plan-runs", entry.planId, "control", "attention", `${entry.requestId}.ack.json`)), ["schemaVersion", "planId", "requestId", "taskId", "attemptId", "runId", "expectedProjectionVersion", "message", "occurredAt", "result", "deliveredAt"], "durable attention acknowledgement");
      for (const field of ["planId", "requestId", "taskId", "attemptId", "expectedProjectionVersion", "message"]) { assert.equal(reply[field], entry[field]); assert.equal(ack[field], entry[field]); }
      assert.equal(reply.runId, entry.executorRunId); assert.equal(ack.runId, entry.executorRunId);
      assert.equal(reply.schemaVersion, "pi-plan-attention-command.v1"); assert.equal(ack.schemaVersion, "pi-plan-attention-command.v1"); assert.equal(ack.result, "delivered");
      const logicalCallerRunId = handles[entry.planIndex].planRunnerRunId;
      const requestActualCallerRunId = logicalCallerAt(grants, logicalCallerRunId, logicalCallerRunId, entry.requested.occurredAt, `Attention ${entry.requestId} requestedAt`);
      const actualCallerRunId = logicalCallerAt(grants, logicalCallerRunId, logicalCallerRunId, ack.deliveredAt, `Attention ${entry.requestId} deliveredAt`);
      for (const [label, runId] of [["request", requestActualCallerRunId], ["reply", actualCallerRunId]]) {
        const actual = actualRuns.filter(({ status }) => status?.runId === runId);
        assert.equal(actual.length, 1, `Attention ${entry.requestId} ${label} caller must be one persisted Runner`);
        assert.equal(actual[0].status.steps?.[0]?.agent, "plan-runner"); assert.equal(actual[0].status.cwd, handles[entry.planIndex].worktree);
        if (runId !== logicalCallerRunId) assert.ok(grants.some((grant) => grant.logicalCallerRunId === logicalCallerRunId && grant.activeRunId === runId), `Revived ${label} caller must have a matching grant`);
      }
      entry.logicalCallerRunId = logicalCallerRunId; entry.requestActualCallerRunId = requestActualCallerRunId; entry.actualCallerRunId = actualCallerRunId;
      const followups = diagnostics.filter((diagnostic) => diagnostic.phase === "followup.accepted" && diagnostic.logicalCallerRunId === logicalCallerRunId && diagnostic.wakeId === `attention-reply-${entry.requestId}`);
      assert.equal(followups.length, 1, `Attention ${entry.requestId} must have one Root followup`);
      const runnerMessages = runnerSessions.get(handles[entry.planIndex].worktree);
      const supervisor = toolCalls(runnerMessages, "plan_executor_supervisor").filter(({ part }) => part.arguments?.replyTo === entry.requestId);
      assert.equal(supervisor.length, 1, `Attention ${entry.requestId} must have one Supervisor reply call`);
      assert.deepEqual(supervisor[0].part.arguments, { action: "reply", replyTo: entry.requestId, to: entry.executorRunId, message: entry.message });
      const supervisorResults = toolResults(runnerMessages, "plan_executor_supervisor", supervisor[0].part.id);
      assert.equal(supervisorResults.length, 1); assert.ok(supervisorResults[0].messageIndex > supervisor[0].messageIndex); assert.notEqual(supervisorResults[0].message.isError, true);
      const executor = actualRuns.filter(({ status }) => status?.runId === entry.executorRunId);
      assert.equal(executor.length, 1); const messages = sessionMessages(await readSession(executor[0].status.steps?.[0]?.sessionFile));
      const contact = toolCalls(messages, "contact_supervisor"); const bash = toolCalls(messages, "bash");
      assert.equal(contact.length, 1); assert.equal(bash.length, 1);
      assert.deepEqual(contact[0].part.arguments, { reason: "need_decision", message: `PI_PLAN_FLAT_ATTENTION ${JSON.stringify(entry.marker)}` });
      const contactResults = toolResults(messages, "contact_supervisor", contact[0].part.id);
      assert.equal(contactResults.length, 1); assert.notEqual(contactResults[0].message.isError, true);
      assert.ok(contactResults[0].messageIndex > contact[0].messageIndex && bash[0].messageIndex > contactResults[0].messageIndex, `Executor ${entry.executorRunId} must receive approval before bash`);
      assert.equal(bash[0].part.arguments?.command, entry.marker.writePath === "README.md" ? "printf 'worker\\n' >> README.md && git add README.md && git commit -m 'test: 添加确定性 worker 标记'" : "printf 'worker-2\\n' > worker.txt && git add worker.txt && git commit -m 'test: 添加第二个确定性 worker 标记'");
    }
    passed = true;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    try { await rpc?.close(); } catch (error) { cleanupErrors.push(error); }
    try { await terminateDetachedRunsUnder(runtimeTmp); } catch (error) { cleanupErrors.push(error); }
    try { assert.deepEqual(await processesReferencing(root, runtimeTmp), [], "processes remain after Harness cleanup"); } catch (error) { cleanupErrors.push(error); }
    try { if (rootSessionId) await rm(brokerSocketPath(rootSessionId), { force: true }); } catch (error) { cleanupErrors.push(error); }
    await finalizeHarnessCleanup({
      fixture: root,
      passed,
      preserve: process.env.PLAN_HARNESS_PRESERVE === "1",
      primaryError,
      cleanupErrors,
      removeFixture: () => removeFixtureWithEvidence(root, { removeFixture: () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }),
      diagnostic: (message) => t.diagnostic(message),
    });
  }
});
