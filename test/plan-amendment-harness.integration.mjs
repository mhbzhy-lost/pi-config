import assert from "node:assert/strict";
import { spawn, execFile as execFileCallback } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { parsePlanDocument } from "../scripts/lib/plan/plan-document.mjs";
import { compilePlanToIR } from "../scripts/lib/plan/ir/index.mjs";
import { createPlanRevisionStore } from "../scripts/lib/plan/plan-revision-store.mjs";
import { brokerSocketPath, parseProcessTerminal } from "../scripts/lib/subagent-dispatch/root-broker-protocol.ts";
import { processesReferencing, terminateDetachedRunsUnder } from "./support/plan-e2e-process-cleanup.mjs";

const execFile = promisify(execFileCallback);
const root = path.resolve(import.meta.dirname, "..");
const piBinary = process.env.PI_REAL_BIN;
const provider = path.join(root, "test/fixtures/deterministic-provider.mjs");
const runnerExtension = path.join(root, "test/fixtures/plan-harness/plan-runner-extension.ts");
const executorExtension = path.join(root, "test/fixtures/plan-harness/executor-extension.ts");
const rootControl = path.join(root, "test/fixtures/plan-harness/root-amendment-control-extension.ts");
const sourcePlan = path.join(root, "test/fixtures/plan-harness/plans/amendment-success.md");
const rootRuntime = path.join(root, "pi/extensions/subagent-runtime.ts");
const launcher = path.join(root, "pi/extensions/plan-launcher.ts");
const rootOwner = path.join(root, "pi/child-extensions/root-session-owner.ts");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function git(cwd, ...args) { return (await execFile("git", args, { cwd })).stdout.trim(); }
async function gitRaw(cwd, ...args) { return (await execFile("git", args, { cwd })).stdout; }
async function assertRuntimeClean(cwd, allowedPrefixes = [".pi-subagents/", "attempts/"]) {
  const entries = (await gitRaw(cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all")).split("\0").filter(Boolean)
    .map((entry) => ({ status: entry.slice(0, 2), file: entry.slice(3) }));
  const tracked = entries.filter((entry) => entry.status !== "??");
  assert.equal(tracked.length, 0, `tracked runtime changes: ${tracked.map((entry) => entry.file).join(", ")}`);
  const unexpected = entries.filter((entry) => entry.status === "??" && !allowedPrefixes.some((prefix) => entry.file.startsWith(prefix)));
  assert.equal(unexpected.length, 0, `unexpected runtime files: ${unexpected.map((entry) => entry.file).join(", ")}`);
}
async function readJson(file) { return JSON.parse(await readFile(file, "utf8")); }
async function readEntries(file) { return (await readFile(file, "utf8")).split("\n").filter(Boolean).map(JSON.parse); }
async function readEvents(file) { return (await readEntries(file)).filter((entry) => entry.customType === "pi-plan-event-v1").map((entry) => entry.data); }
async function waitFor(read, predicate, label, timeout = 90_000) { const deadline = Date.now() + timeout; let value; while (Date.now() < deadline) { try { value = await read(); if (predicate(value)) return value; } catch (error) { if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; } await sleep(40); } throw new Error(`${label}: ${JSON.stringify(value)}`); }
function exact(value, keys, label) { assert.ok(value && typeof value === "object" && !Array.isArray(value), label); assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} fields`); return value; }
function resultValue(record) { const text = record?.result?.content?.filter?.((part) => part.type === "text").map((part) => part.text).join("\n") ?? record?.result?.text; try { return JSON.parse(text); } catch { return record?.result?.details ?? record?.result; } }
function assertTerminal(value, runId, successful) { assert.equal(value?.runId, runId); const { runId: ignored, ...terminal } = value; parseProcessTerminal(terminal); assert.equal(terminal.state, "observed"); if (successful) { const runner = terminal.instances.find((entry) => entry.kind === "runner" && entry.processInstanceId === terminal.runnerProcessInstanceId); assert.ok(runner, `matching runner for ${runId}`); assert.equal(runner.exitCode, 0); assert.equal(runner.signal, null); } }

class RootRpc {
  constructor(child) { this.child = child; this.records = []; this.stderr = ""; this.buffer = ""; this.exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); }); child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", (chunk) => this.consume(chunk)); child.stderr.on("data", (chunk) => { this.stderr += chunk; }); }
  consume(chunk) { this.buffer += chunk; for (;;) { const index = this.buffer.indexOf("\n"); if (index < 0) return; const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1); if (line) this.records.push(JSON.parse(line)); } }
  send(value) { this.child.stdin.write(`${JSON.stringify(value)}\n`); }
  async one(predicate, label, timeout = 90_000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const found = this.records.filter(predicate); if (found.length === 1) return found[0]; if (found.length > 1) throw new Error(`${label}: duplicate result`); await sleep(25); } throw new Error(`${label}: ${this.stderr}`); }
  async close() { this.child.stdin.end(); const exit = await Promise.race([this.exited, sleep(8_000).then(() => undefined)]); if (!exit) { this.child.kill("SIGKILL"); await this.exited; throw new Error("Root close timed out after forced exit"); } if (exit.code !== 0 || exit.signal !== null) throw new Error(`Root close failed: ${JSON.stringify(exit)}`); }
}

function revision2(parentPlanHash) {
  return `# Amendment recovery\n\n**Goal:** Record the clarified amended artifact and its repair.\n\n## Execution Contract\n\n\`\`\`json\n{"schemaVersion":"pi-plan.v3","revision":2,"parentPlanHash":"${parentPlanHash}","verification":[{"id":"plan:amended","command":"test -f amended.txt","cwd":".","timeoutMs":120000},{"id":"plan:repair","command":"test -f repair.txt && ! test -e decision.txt","cwd":".","timeoutMs":120000}],"requiredGates":["deterministic","plan-audit","external-review","final-completeness"],"resourceCapacities":{},"executionDefaults":{"agent":"executor","risk":"normal","workflow":{"mode":"inherit-repository"},"timeoutMs":120000},"taskExecution":{"task-1":{},"task-2":{}},"taskAcceptance":{"task-1":{"strategy":"commands","commandIds":["plan:amended"]},"task-2":{"strategy":"commands","commandIds":["plan:repair"]}}}\n\`\`\`\n\n### Task 1: Record amendment\n\n**Files:**\n- Create: \`amended.txt\`\n\nCreate amended.txt containing exactly \`amended\` and commit it.\n\n### Task 2: Repair amendment\n\n**Deps:** Task 1\n\n**Files:**\n- Create: \`repair.txt\`\n\nCreate repair.txt containing exactly \`repair\` and commit it.\n`;
}

test("same Root flat amendment crash Harness revives the canonical Plan Runner", { timeout: 140_000 }, async (t) => {
  assert.ok(piBinary, "PI_REAL_BIN is required for this integration Harness");
  const fixture = await mkdtemp(path.join(os.tmpdir(), "pi-plan-flat-amendment-"));
  const origin = path.join(fixture, "origin"); const runtimeTmp = path.join(fixture, "tmp"); const sessions = path.join(fixture, "sessions"); const agentDir = path.join(fixture, "agent-dir"); const barrier = path.join(fixture, "barrier"); const rootSessionId = `amendment-${path.basename(fixture)}`;
  let rpc; let primaryError; let passed = false;
  try {
    await mkdir(path.join(origin, ".pi", "agents"), { recursive: true }); await Promise.all([mkdir(runtimeTmp), mkdir(sessions), mkdir(agentDir)]);
    await git(origin, "init"); await git(origin, "config", "user.email", "harness@example.com"); await git(origin, "config", "user.name", "Harness");
    await writeFile(path.join(origin, "README.md"), "base\n"); await mkdir(path.join(origin, "docs")); await writeFile(path.join(origin, "docs", "plan.md"), await readFile(sourcePlan));
    await writeFile(path.join(origin, ".pi", "agents", "plan-runner.md"), `---\nname: plan-runner\ndescription: deterministic amendment plan runner\nmodel: fake/deterministic\nthinking: off\ntemperature: 0\ntools: plan_open,read,grep\nsubagentOnlyExtensions: ${provider},${runnerExtension}\n---\nOpen and execute only the approved Plan revision.\n`);
    await writeFile(path.join(origin, ".pi", "agents", "executor.md"), `---\nname: executor\ndescription: deterministic amendment executor\nmodel: fake/deterministic\nthinking: off\ntemperature: 0\ntools: bash,read,contact_supervisor\nsubagentOnlyExtensions: ${provider},${executorExtension},${rootOwner}\n---\nExecute only the approved task and commit the result.\n`);
    await git(origin, "add", "."); await git(origin, "commit", "-m", "harness base"); const baseCommit = await git(origin, "rev-parse", "HEAD");
    const source1 = await readFile(path.join(origin, "docs", "plan.md"), "utf8"); const source2 = revision2(parsePlanDocument(source1, "plan.md").sha256); const ir2 = compilePlanToIR(parsePlanDocument(source2, "revision-2.md"));
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("PI_SUBAGENT_") && name !== "PI_ROOT_SUBAGENT_BROKER_ENABLED"));
    rpc = new RootRpc(spawn(piBinary, ["--mode", "rpc", "--session-dir", sessions, "--session-id", rootSessionId, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--approve", "--offline", "-e", provider, "-e", rootRuntime, "-e", launcher, "-e", rootControl, "--provider", "fake", "--model", "fake/deterministic"], { cwd: origin, env: { ...environment, OPENAI_API_KEY: "not-used", PI_CODING_AGENT_DIR: agentDir, TMPDIR: runtimeTmp, PI_PLAN_HARNESS_AMENDMENT: "1", PI_PLAN_HARNESS_AMENDMENT_SOURCE: source2, PI_PLAN_HARNESS_SUPERSEDE_BARRIER: barrier }, stdio: ["pipe", "pipe", "pipe"] }));
    rpc.send({ id: "launch", type: "prompt", message: `PI_PLAN_FLAT_ROOT_HARNESS\n${JSON.stringify({ planPaths: [path.join(origin, "docs", "plan.md")] })}` });
    const handle = resultValue(await rpc.one((record) => record.type === "tool_execution_end" && record.toolName === "plan_run", "plan handle")); exact(handle, ["asyncDir", "baseCommit", "manifestSha256", "planHash", "planId", "planIrHash", "planRunnerRunId", "revision", "rootSessionId", "schemaVersion", "sourceBytesSha256", "worktree"], "handle"); assert.equal(handle.schemaVersion, "pi-plan-handle.v4"); assert.equal(handle.rootSessionId, rootSessionId); assert.equal(handle.baseCommit, baseCommit);
    const statusPath = path.join(origin, "var", "plan-runs", handle.planId, "status.json"); const pending = await waitFor(() => readJson(statusPath), (status) => status?.tasks?.[0]?.attempts?.filter((attempt) => attempt.status === "waiting-attention").length === 1, "waiting attention"); const old = pending.tasks[0].attempts[0];
    rpc.send({ id: "reply", type: "prompt", message: `PI_PLAN_FLAT_ATTENTION_REPLIES\n${JSON.stringify({ replies: [{ planId: handle.planId, requestId: old.attention.requestId, expectedProjectionVersion: old.attention.projectionVersion, message: "APPROVED" }] })}` }); await rpc.one((record) => record.type === "tool_execution_end" && record.toolName === "plan_attention_reply", "durable reply");
    await waitFor(() => access(path.join(barrier, "entered")).then(() => true), Boolean, "supersede barrier");
    const runnerStatus = await readJson(path.join(handle.asyncDir, "status.json")); const canonicalSession = runnerStatus.steps[0].sessionFile; const before = await readEvents(canonicalSession); const amended = before.filter((event) => event.type === "plan.amended"); assert.equal(amended.length, 1); assert.equal(before.filter((event) => event.type === "attempt.superseded").length, 0); assert.equal(before.filter((event) => event.type === "attempt.workspace-released").length, 0); const oldDispatch = before.find((event) => event.type === "attempt.dispatch-requested"); const oldBound = before.find((event) => event.type === "attempt.bound"); assert.ok(oldDispatch && oldBound); assert.match(oldDispatch.data.tool.task, /decision\.txt/);
    const store = createPlanRevisionStore({ stateRoot: origin }); const stored1 = await store.readRevision(handle.planId, 1); const pointer1 = await store.readCurrent(handle.planId); assert.equal(pointer1.revision, 1); assert.equal(pointer1.manifestSha256, stored1.manifestSha256); await assert.rejects(access(path.join(handle.worktree, "decision.txt")));
    rpc.send({ id: "crash", type: "prompt", message: `PI_PLAN_FLAT_AMENDMENT_CRASH\n${JSON.stringify({ logicalRunId: handle.planRunnerRunId, executorRunId: old.runId })}` });
    const crash = resultValue(await rpc.one((record) => record.type === "tool_execution_end" && record.toolName === "plan_harness_crash_amendment", "crash proof")); exact(crash, ["actualRunId", "executorProof", "executorRunId", "logicalRunId", "runnerProof"], "crash proof"); assert.equal(crash.logicalRunId, handle.planRunnerRunId); assert.equal(crash.executorRunId, old.runId); assertTerminal(crash.executorProof, old.runId, false); assertTerminal(crash.runnerProof, crash.actualRunId, false);
    const final = await waitFor(() => readJson(statusPath), (status) => status?.lifecycle === "validated", "validated"); const after = await readEvents(canonicalSession); assert.equal(new Set(after.map((event) => event.eventId)).size, after.length); assert.equal(after.filter((event) => event.type === "plan.amended").length, 1); assert.equal(after.filter((event) => event.type === "attempt.dispatch-requested" && event.data.taskHash === oldDispatch.data.taskHash).length, 1);
    const superseded = after.filter((event) => event.type === "attempt.superseded" && event.data.attemptId === old.attemptId); assert.equal(superseded.length, 1); assert.equal(superseded[0].data.evidence.kind, "terminal"); assert.equal(superseded[0].data.evidence.dispatchId, oldDispatch.data.dispatchId); assert.equal(superseded[0].data.evidence.runId, oldBound.data.runId); assert.equal(superseded[0].data.evidence.asyncDir, oldBound.data.asyncDir); assert.match(superseded[0].data.evidence.artifactSha256, /^[0-9a-f]{64}$/); assert.equal(after.filter((event) => event.type === "attempt.workspace-released" && event.data.attemptId === old.attemptId && event.data.disposition === "superseded-preserve").length, 1);
    const dispatches = after.filter((event) => event.type === "attempt.dispatch-requested"); const revision2Dispatches = new Map(); for (const node of ir2.nodes) { const matching = dispatches.filter((event) => event.data.taskId === node.id && event.data.planIrHash === ir2.hash && event.data.taskHash === node.hashes.effective && event.data.schedulingHash === node.hashes.scheduling); assert.equal(matching.length, 1, `${node.id} exact dispatch`); revision2Dispatches.set(node.id, matching[0]); }
    assert.equal(final.gates.filter((gate) => gate.status === "passed").length, 4); for (const [taskId, dispatch] of revision2Dispatches) { const task = final.tasks.find((entry) => entry.taskId === taskId); const attempt = task?.attempts.find((attempt) => attempt.attemptId === dispatch.data.attemptId); assert.ok(attempt, `final Attempt for ${taskId}`); assert.ok(["integrated", "accepted"].includes(attempt.status), `final Attempt status for ${taskId}`); } const oldFinal = final.tasks.find((task) => task.taskId === "task-1").attempts.find((attempt) => attempt.attemptId === old.attemptId); assert.equal(oldFinal.status, "superseded"); await assertRuntimeClean(oldFinal.workspace.path); const stored2 = await store.readRevision(handle.planId, 2); const pointer2 = await store.readCurrent(handle.planId); assert.deepEqual(stored1.sourceBytes, Buffer.from(source1)); assert.deepEqual(stored2.sourceBytes, Buffer.from(source2)); assert.equal(pointer2.revision, 2); assert.equal(await readFile(path.join(handle.worktree, "amended.txt"), "utf8"), "amended\n"); assert.equal(await readFile(path.join(handle.worktree, "repair.txt"), "utf8"), "repair\n"); await assert.rejects(access(path.join(handle.worktree, "decision.txt"))); await assertRuntimeClean(handle.worktree); assert.equal(await git(handle.worktree, "rev-list", "--count", `${baseCommit}..HEAD`), "2");
    await rpc.close(); rpc = undefined;
    const asyncRoot = path.dirname(handle.asyncDir); const runs = await Promise.all((await readdir(asyncRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map(async (entry) => ({ dir: path.join(asyncRoot, entry.name), status: await readJson(path.join(asyncRoot, entry.name, "status.json")) }))); const runners = runs.filter((run) => run.status.steps?.[0]?.agent === "plan-runner"); const executors = runs.filter((run) => run.status.steps?.[0]?.agent === "executor"); assert.ok(runners.length >= 2); assert.ok(executors.length >= 3);
    for (const run of runs) { for (const field of ["parentRunId", "parentStepIndex", "depth", "path"]) assert.ok(!Object.hasOwn(run.status, field)); if (run.status.steps?.[0]?.agent === "plan-runner") assert.equal(run.status.steps[0].sessionFile, canonicalSession); assertTerminal(await readJson(path.join(run.dir, "process-terminal.json")), run.status.runId, ![old.runId, crash.actualRunId].includes(run.status.runId)); try { process.kill(run.status.pid, 0); assert.fail(`PID remains live: ${run.status.pid}`); } catch (error) { assert.equal(error.code, "ESRCH"); } }
    const rootEntries = await readEntries(path.join(sessions, path.basename(runs[0].status.sessionId))); const diagnostics = rootEntries.filter((entry) => entry.customType === "pi-root-broker-revival-v1").map((entry) => entry.data); assert.ok(diagnostics.some((entry) => entry.phase === "grant.issued" && entry.logicalCallerRunId === handle.planRunnerRunId && entry.activeRunId !== handle.planRunnerRunId)); assert.equal(diagnostics.filter((entry) => entry.phase === "close.started").length, 1); assert.equal(diagnostics.filter((entry) => entry.phase === "close.completed").length, 1); await assert.rejects(lstat(brokerSocketPath(rootSessionId)), { code: "ENOENT" }); passed = true;
  } catch (error) { primaryError = error; throw error; } finally {
    const cleanupErrors = [];
    try { await rpc?.close(); } catch (error) { cleanupErrors.push(error); }
    try { await terminateDetachedRunsUnder(runtimeTmp); } catch (error) { cleanupErrors.push(error); }
    try { assert.deepEqual(await processesReferencing(fixture, runtimeTmp), [], "processes remain after Harness cleanup"); } catch (error) { cleanupErrors.push(error); }
    try { await rm(brokerSocketPath(rootSessionId), { force: true }); } catch (error) { cleanupErrors.push(error); }
    if (passed && process.env.PLAN_HARNESS_PRESERVE !== "1") await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); else t.diagnostic(`preserved=${fixture}`);
    if (cleanupErrors.length) {
      const cleanupError = new AggregateError(cleanupErrors, "Harness cleanup failed");
      if (primaryError) t.diagnostic(cleanupError.message);
      else throw cleanupError;
    }
  }
});
