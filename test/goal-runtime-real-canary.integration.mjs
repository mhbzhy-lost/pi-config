import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { RootBrokerServer } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts";
import { bindRootBroker, unbindRootBroker } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-registry.ts";
import { createProductionGoalRuntimeHost } from "../src/goal-engine/production-runtime-host.ts";
import { inventoryManagedWorkspaces } from "../packages/pi-subagents-enhanced/src/workspace/administration.ts";
import { createRunAuthorization } from "../packages/pi-subagents-enhanced/src/subagent-dispatch/run-authorization.ts";
import { resolveGoalStateScope, selectGoalStateRoot } from "../src/goal-engine/state-scope.ts";
import { listGoals, loadProjection } from "../src/goal-engine/store.ts";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StringDecoder } from "node:string_decoder";
import test from "node:test";


const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const globalModules = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piRoot = join(globalModules, "@earendil-works/pi-coding-agent");
const { createAgentSession, DefaultResourceLoader, SessionManager } = await import(pathToFileURL(join(piRoot, "dist/index.js")).href);
const toolNames = ["goal_accept", "goal_amend", "goal_dispatch", "goal_finalize", "goal_init", "goal_integrate", "goal_settle", "goal_status"];
const projectAgentRoot = "/Users/mhbzhy/pi-config/pi";
const projectConfigHome = "/Users/mhbzhy/pi-config";

const sensitiveDiagnosticKeys = new Set(["actiontoken", "token", "apikey", "secret", "password", "authorization", "ownertoken"]);

function redactRpcString(value) {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object") return JSON.stringify(redactRpcValue(parsed));
  } catch {}
  return value.replace(/bearer\s+[^\s\"]+/gi, "bearer [REDACTED]");
}

function redactRpcValue(value, ancestors = new WeakSet()) {
  if (typeof value === "string") return redactRpcString(value);
  if (!value || typeof value !== "object") return value;
  if (ancestors.has(value)) return "[CIRCULAR]";
  ancestors.add(value);
  const redacted = Array.isArray(value) ? value.map((item) => redactRpcValue(item, ancestors)) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitiveDiagnosticKeys.has(key.replace(/[_-]/g, "").toLowerCase()) ? "[REDACTED]" : redactRpcValue(item, ancestors)]));
  ancestors.delete(value);
  return redacted;
}

function redactRpc(value) {
  return JSON.stringify(redactRpcValue(value));
}

class JsonlRpcClient {
  constructor(command, args, { cwd, env, spawnImpl = spawn, maxEvents = 512, maxStderr = 16_384 } = {}) {
    this.events = []; this.toolEvents = []; this.messageEvents = []; this.uiResponses = []; this.stderr = ""; this.pending = new Map(); this.phaseWaiters = new Map(); this.phaseFailures = new Map(); this.timeline = []; this.lastEvent = null; this.settled = false; this.closed = false; this.abortRequested = false;
    this.startedAt = process.hrtime.bigint();
    this.child = spawnImpl(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.done = new Promise((resolve) => { this.resolveDone = resolve; });
    this.attach(this.child.stdout, (record) => this.receive(record), maxEvents);
    this.attachStderr(this.child.stderr, maxStderr);
    this.child.once("error", (error) => this.close(error));
    this.child.once("close", (code, signal) => this.close(new Error(`RPC child closed code=${code} signal=${signal}`)));
  }
  attach(stream, consume, maxRecords) {
    const decoder = new StringDecoder("utf8"); let buffer = "";
    stream.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      for (;;) { const index = buffer.indexOf("\n"); if (index < 0) break; let line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (line.endsWith("\r")) line = line.slice(0, -1); if (line) consume(line); }
    });
    stream.on("end", () => { buffer += decoder.end(); if (buffer) consume(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer); });
    this.maxEvents = maxRecords;
  }
  attachStderr(stream, maxStderr) {
    const decoder = new StringDecoder("utf8");
    const append = (chunk) => { this.stderr = (this.stderr + chunk).slice(-maxStderr); };
    stream.on("data", (chunk) => append(decoder.write(chunk)));
    stream.on("end", () => append(decoder.end()));
  }
  observePhase(phase, record) {
    const item = { phase, monotonicNs: (process.hrtime.bigint() - this.startedAt).toString(), lastEvent: redactRpc(record) };
    this.timeline.push(item); if (this.timeline.length > this.maxEvents) this.timeline.shift(); this.lastEvent = item.lastEvent;
    const waiters = this.phaseWaiters.get(phase) || [];
    this.phaseWaiters.delete(phase); for (const { resolve, timer } of waiters) { clearTimeout(timer); resolve(item); }
  }
  failPhase(phase, record) {
    const item = { phase, monotonicNs: (process.hrtime.bigint() - this.startedAt).toString(), lastEvent: redactRpc(record) };
    this.timeline.push(item); if (this.timeline.length > this.maxEvents) this.timeline.shift(); this.lastEvent = item.lastEvent;
    const error = new Error(`stage ${phase} failed: tool ${record.toolName || "unknown"} returned error`);
    this.phaseFailures.set(phase, error);
    const waiters = this.phaseWaiters.get(phase) || [];
    this.phaseWaiters.delete(phase); for (const { reject, timer } of waiters) { clearTimeout(timer); reject(error); }
  }
  waitForPhase(phase, timeoutMs) {
    if (this.phaseFailures.has(phase)) return Promise.reject(this.phaseFailures.get(phase));
    if (this.timeline.some((item) => item.phase === phase)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.phaseWaiters.set(phase, (this.phaseWaiters.get(phase) || []).filter((waiter) => waiter.resolve !== resolve)); reject(new Error(`${phase} deadline exceeded`)); }, timeoutMs);
      timer.unref();
      this.phaseWaiters.set(phase, [...(this.phaseWaiters.get(phase) || []), { resolve, reject, timer }]);
    });
  }
  receive(line) {
    let record; try { record = JSON.parse(line); } catch (error) { this.close(new Error(`invalid RPC JSONL: ${error.message}`)); return; }
    if (record.type === "response" && record.command === "prompt") this.observePhase("prompt_response", record);
    if (record.type === "response" && record.id && this.pending.has(record.id)) { const { resolve, reject, timer } = this.pending.get(record.id); clearTimeout(timer); this.pending.delete(record.id); record.success ? resolve(record) : reject(new Error(`RPC ${record.command} failed: ${record.error || "unknown"}`)); return; }
    if (record.type === "extension_ui_request") this.respondUi(record);
    this.events.push(record); if (this.events.length > this.maxEvents) this.events.shift();
    if (["tool_execution_start", "tool_execution_end"].includes(record.type)) {
      this.toolEvents.push(record); if (this.toolEvents.length > this.maxEvents) this.toolEvents.shift();
      if (["goal_init", "goal_status", "goal_dispatch", "subagent"].includes(record.toolName)) {
        const phase = `${record.toolName}_${record.type === "tool_execution_start" ? "start" : "end"}`;
        if (record.type === "tool_execution_end" && (record.isError === true || record.result?.isError === true)) this.failPhase(phase, record);
        else this.observePhase(phase, record);
      }
    }
    if (record.type === "message_end") { this.messageEvents.push(record); if (this.messageEvents.length > 32) this.messageEvents.shift(); }
    if (record.type === "agent_settled") { this.observePhase("agent_settled", record); this.settled = true; this.resolveDone(record); }
  }
  respondUi(request) {
    if (!request.id || !["confirm", "select", "input", "editor"].includes(request.method)) return;
    const response = request.method === "confirm" ? { type: "extension_ui_response", id: request.id, confirmed: true }
      : request.method === "select" ? { type: "extension_ui_response", id: request.id, value: request.options?.[0] }
        : { type: "extension_ui_response", id: request.id, cancelled: true };
    this.uiResponses.push(response); this.send(response);
  }
  send(message) { if (!this.closed && this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  request(type, payload = {}, timeoutMs = 30_000) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC ${type} response deadline exceeded`)); }, timeoutMs);
      timer.unref(); this.pending.set(id, { resolve, reject, timer }); this.send({ id, type, ...payload });
    });
  }
  async waitForSettled(timeoutMs) {
    if (this.settled) return;
    let timer;
    try { await Promise.race([this.done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("RPC agent_settled deadline exceeded")), timeoutMs); timer.unref(); })]); if (!this.settled) throw new Error("RPC child closed before agent_settled"); }
    finally { clearTimeout(timer); }
  }
  close(error) {
    if (this.closed) return; this.closed = true;
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); } this.pending.clear();
    for (const waiters of this.phaseWaiters.values()) for (const { reject, timer } of waiters) { clearTimeout(timer); reject(error); } this.phaseWaiters.clear(); this.resolveDone();
  }
  async terminate() {
    if (!this.closed) { this.abortRequested = true; try { await this.request("abort", {}, 2_000); } catch {} }
    this.child.stdin.end();
    if (!this.closed) await boundedWait(this.done, 500);
    if (!this.closed && !this.child.killed) this.child.kill("SIGTERM");
    if (!this.closed) await boundedWait(new Promise((resolve) => this.child.once("close", resolve)), 2_000);
    if (!this.closed && !this.child.killed) this.child.kill("SIGKILL");
  }
  diagnostic() { return { timeline: this.timeline, lastEvent: this.lastEvent, events: this.events.map(redactRpc), toolEvents: this.toolEvents.map(redactRpc), messageEvents: this.messageEvents.map(redactRpc), stderr: redactRpc(this.stderr) }; }
}

function boundedWait(promise, timeoutMs) {
  let timer;
  return Promise.race([promise, new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref(); })]).finally(() => clearTimeout(timer));
}

function writeCanaryFailureDiagnostic({ externalRoot, runId, diagnostic, error, maxBytes = 65_536 }) {
  if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error("invalid canary run id");
  mkdirSync(externalRoot, { recursive: true, mode: 0o700 }); chmodSync(externalRoot, 0o700);
  const path = join(externalRoot, `${runId}.json`);
  const record = { runId, error: redactRpc({ message: String(error?.message || error) }), diagnostic: redactRpc(diagnostic) };
  let serialized = JSON.stringify(record);
  if (Buffer.byteLength(serialized) > maxBytes) {
    const truncated = { runId, truncated: true, error: record.error, diagnostic: "" };
    if (Buffer.byteLength(JSON.stringify(truncated)) > maxBytes) truncated.error = "[TRUNCATED]";
    let low = 0; let high = record.diagnostic.length;
    while (low < high) { const middle = Math.ceil((low + high) / 2); truncated.diagnostic = record.diagnostic.slice(0, middle); if (Buffer.byteLength(JSON.stringify(truncated)) <= maxBytes) low = middle; else high = middle - 1; }
    truncated.diagnostic = record.diagnostic.slice(0, low); serialized = JSON.stringify(truncated);
  }
  if (Buffer.byteLength(serialized) > maxBytes) throw new Error("canary diagnostic size limit is too small");
  writeFileSync(path, serialized, { mode: 0o600 }); chmodSync(path, 0o600);
  return path;
}

async function runBoundedRpcCanary(client, { prompt, deadlines = {}, requiredPhases = ["goal_init_start", "goal_init_end", "goal_status_start", "goal_status_end", "goal_dispatch_start", "goal_dispatch_end", "subagent_start", "subagent_end"] }) {
  try {
    await client.request("prompt", { message: prompt }, deadlines.prompt ?? 30_000);
    for (const phase of requiredPhases) await client.waitForPhase(phase, deadlines[phase.replace(/_(start|end)$/, "")] ?? 120_000);
    await client.waitForSettled(deadlines.settled ?? 900_000);
  } catch (error) { await client.terminate(); throw error; }
}

function assertCanonicalAttempt(value, label = "attempt") {
  assert.equal(Object.hasOwn(value, "attempts"), false, `${label} must not use plural attempts`);
  assert.equal(Object.hasOwn(value, "attempt_id"), false, `${label} must use canonical attempt`);
  assert.equal(Number.isSafeInteger(value.attempt) && value.attempt > 0, true, `${label}.attempt must be a positive integer`);
}

function assertDistinctR13Rounds(rounds) {
  assert.equal(rounds.length, 2, "R13 requires exactly two serial rounds");
  for (const key of ["root", "session", "goal", "run", "token", "approval", "workspace"]) {
    assert.equal(new Set(rounds.map(round => round[key])).size, rounds.length, `R13 rounds must not reuse ${key}`);
  }
}

function issueCanaryHostIdentity(round) {
  return Object.fromEntries(["root", "session", "goal", "run", "token", "approval", "workspace"].map((key) => [key, `host-${key}-${round.round}-${randomUUID()}`]));
}

function assertSuccessfulR13Tools(events, diagnostic) {
  try { for (const name of toolNames) toolEndForStart(events, name); }
  catch (error) { error.diagnostic = diagnostic?.() ?? { timeline: [] }; throw error; }
}

async function runLocalR13FixtureDriver(rounds, { maxContinuations = 20, deadlineMs = 250 } = {}) {
  assertDistinctR13Rounds(rounds);
  const program = String.raw`let b="", n=0, tools=["goal_init","goal_status","goal_dispatch","goal_settle","goal_integrate","goal_accept","goal_amend","goal_finalize"]; process.stdin.on("data", c => { b+=c; for (;;) { let i=b.indexOf("\n"); if(i<0)break; let r=JSON.parse(b.slice(0,i)); b=b.slice(i+1); if(r.type==="abort") { process.stdout.write(JSON.stringify({id:r.id,type:"response",command:"abort",success:true})+"\n"); continue; } if(r.type!=="prompt")continue; let group=tools.slice(n*3,n*3+3); n++; process.stdout.write(JSON.stringify({id:r.id,type:"response",command:"prompt",success:true})+"\n"); if(n===1)process.stdout.write(JSON.stringify({type:"extension_ui_request",id:"approval-ui",method:"confirm"})+"\n"); for(const toolName of group) { let id=toolName+"-"+n; process.stdout.write(JSON.stringify({type:"tool_execution_start",toolName,toolCallId:id})+"\n"); process.stdout.write(JSON.stringify({type:"tool_execution_end",toolName,toolCallId:id,result:{isError:false,content:[{type:"text",text:"{}"}]}})+"\n"); } process.stdout.write(JSON.stringify({type:"agent_settled"})+"\n"); } });`;
  for (const round of rounds) {
    const client = new JsonlRpcClient(process.execPath, ["-e", program]);
    const hostIdentity = issueCanaryHostIdentity(round);
    Object.assign(round, hostIdentity);
    assertCanonicalAttempt({ attempt: round.round }, `round ${round.round}`);
    try {
      for (let continuation = 0; continuation < 3; continuation++) {
        assert.ok(continuation < maxContinuations, "R13 continuation budget exceeded");
        await client.request("prompt", { message: `round ${round.round} continuation ${continuation}` }, deadlineMs);
        await client.waitForSettled(deadlineMs);
        client.settled = false;
        client.done = new Promise((resolve) => { client.resolveDone = resolve; });
      }
      assert.equal(client.uiResponses.some(response => response.confirmed === true), true, "R13 driver must answer extension UI");
      assertSuccessfulR13Tools(client.toolEvents, () => client.diagnostic());
    } finally { await client.terminate(); }
  }
}

function parseToolResultJson(event, expectedToolCallId) {
  if (!event || event.type !== "tool_execution_end" || event.toolCallId !== expectedToolCallId) throw new Error("tool result does not match its tool call");
  const result = event.result;
  if (!result || result.isError === true) throw new Error(`tool ${event.toolName || "unknown"} returned an error`);
  if (!Array.isArray(result.content)) throw new Error("tool result has no public content array");
  const text = result.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("");
  if (!text) throw new Error("tool result has no text JSON content");
  try { return JSON.parse(text); } catch (error) { throw new Error(`tool result text is not JSON: ${error.message}`); }
}

function toolEndForStart(events, name) {
  const starts = events.filter((event) => event.type === "tool_execution_start" && event.toolName === name && event.toolCallId);
  const failedAttempts = starts.flatMap((start) => {
    const ends = events.filter((event) => event.type === "tool_execution_end" && event.toolCallId === start.toolCallId);
    if (ends.length !== 1) return [{ toolCallId: start.toolCallId, reason: "missing or duplicate tool end" }];
    return ends[0].isError === true || ends[0].result?.isError === true ? [{ toolCallId: start.toolCallId, reason: "tool returned an error" }] : [];
  });
  if (starts.length !== 1) {
    const error = new Error(`expected exactly one ${name} tool attempt`);
    error.failedAttempts = failedAttempts;
    throw error;
  }
  const [start] = starts;
  const ends = events.filter((event) => event.type === "tool_execution_end" && event.toolCallId === start.toolCallId);
  if (ends.length !== 1 || failedAttempts.length) {
    const error = new Error(`missing successful ${name} tool end`);
    error.failedAttempts = failedAttempts;
    throw error;
  }
  return { start, end: ends[0], failedAttempts };
}

function canaryStateEnvironment(agentDir, parentEnv = process.env) {
  const env = { ...parentEnv };
  for (const key of Object.keys(env)) if (key.startsWith("PI_SUBAGENT_")) delete env[key];
  return {
    ...env,
    PI_CODING_GOAL_DIR: join(agentDir, "goal-state"),
    PI_CODING_WORKSPACE_DIR: join(agentDir, "workspace-state"),
  };
}

function assertCanaryAgentRoot(env) {
  assert.equal(env.PI_CODING_AGENT_DIR, projectAgentRoot, "the child must retain the verified project agent root");
  assert.equal(env.PI_CONFIG_HOME, projectConfigHome, "the child must retain the verified project config home");
}

function assertCanaryModelPreflight(cwd, env) {
  assertCanaryAgentRoot(env);
  const catalog = execFileSync("/opt/homebrew/bin/pi", ["--list-models"], { cwd, env, encoding: "utf8" });
  assert.match(catalog, /^openai-codex\s+gpt-5\.6-luna\s+\S+\s+\S+\s+yes\s+yes\s*$/m, "the inherited project resolver must publicly select available openai-codex/gpt-5.6-luna");
}

function goalLedgerLocator(cwd, env, goalId) {
  const scope = resolveGoalStateScope({ cwd, env });
  const selected = selectGoalStateRoot(scope, {
    operation: "read",
    goalId,
    listActive: listGoals,
    hasGoal: (root, candidateGoalId) => Boolean(loadProjection(root, candidateGoalId)),
  });
  return { root: selected.root, path: join(selected.root, "goals", goalId, "events.jsonl") };
}

// The upstream writer is TypeScript under node_modules and cannot be imported
// by Node's native type stripper. This is its exact atomic-write shape, not a
// hand-made status/processTerminal fallback.
function upstreamWriteAtomicJson(file, value) {
  const temporary = `${file}.${process.pid}.canary.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, file);
}

function restartAuthorization(authority, pid) {
  return createRunAuthorization({
    kind: "coding",
    binding: { runId: authority.runId, asyncDir: authority.asyncDir, sessionId: authority.sessionId, pid, agentProfile: authority.agentProfile },
    goal: { ticketId: authority.ticketId, goalId: authority.goalId, taskId: authority.taskId, attempt: authority.attempt, contractHash: authority.contractHash, workspaceId: authority.workspaceId, executionRevision: authority.executionRevision, expectedCriteria: authority.expectedCriteria },
  });
}

async function registerRestartAuthority(broker, authority, pid) {
  await broker.registerAuthorizedRun(restartAuthorization(authority, pid));
  await broker.observeStarted({ runId: authority.runId, id: authority.runId, agent: authority.agentProfile, pid, asyncDir: authority.asyncDir, sessionId: authority.sessionId });
  const { workspaceId: _workspaceId, ...sidecar } = authority;
  broker.persistGoalBindingAuthority({ version: "root-broker.goal-run-binding-authority.v2", ...sidecar });
}

function git(cwd, ...args) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
const productionEntry = join(repoRoot, "pi/extensions/goal-engine.ts");
const subagentRuntimeEntry = join(repoRoot, "packages/pi-subagents-enhanced/extensions/subagent-runtime.ts");
const productionRuntimeHost = {
  adapters: [{
    ref: "canary-oracle", version: "1", deterministic: true, reset: "clean", resourceClaims: [],
    artifactClassifier: { pass: "PASS", fail: "FAIL", inconclusive: "UNKNOWN", infrastructure_error: "INFRA" },
    validationPlan: { schema: "dispatch-ir.v1.validation-plan", limits: { timeoutMs: 5000, maxOutputBytes: 4096, terminationGraceMs: 100, maxConcurrentWorkspaces: 1 }, actions: [{ id: "pass-json", kind: "validation", executable: "/bin/echo", args: ["{\"code\":\"PASS\"}"] }] },
  }],
  environments: { "canary-local": { fingerprint: "canary-environment-v1", available: true } },
  fixtures: { "canary-fixture": { fingerprint: "canary-fixture-v1", available: true } },
  resources: {},
};

function productionSettings() {
  return {
    goalEngine: {
      enabled: true,
      runtimeHost: productionRuntimeHost,
      finalReview: { provider: "openai-codex", id: "gpt-5.6-luna", timeoutMs: 120_000 },
    },
  };
}

function realCanaryGoalEntry(settingsPath) {
  return `import { createGoalEngineEntry } from ${JSON.stringify(pathToFileURL(productionEntry).href)};\nexport default (pi) => createGoalEngineEntry(pi, { settingsPath: ${JSON.stringify(settingsPath)} });\n`;
}

function smokeGoalInitInput(taskId) {
  return {
    objective: "Complete a minimal temporary-repository TDD change",
    tasks: [{
      id: taskId,
      description: "In a temporary repository, write a failing Node test in test/smoke.test.mjs, implement src/smoke.ts, and run the Node test.",
      deps: [],
      writePaths: ["src/smoke.ts", "test/smoke.test.mjs"],
      acceptance: { criteria: [{ id: "smoke-tdd", statement: "Node test passes with the changed source and test files", evidenceKinds: ["changed-files", "tests"] }] },
      workflow: "tdd",
    }],
  };
}

function realCanarySmokePrompt(taskId) {
  const exactJson = JSON.stringify(smokeGoalInitInput(taskId));
  return `Use only the listed Goal tools in this exact order: goal_init, goal_status, goal_dispatch, then the returned typed subagent contract. In goal_init, use this exact JSON verbatim as the planned.v1 payload: ${exactJson}. Do not add agentProfile, execution, commit evidence, or any other field. Do not call any other tool. The dispatch compiler owns the later clean-commit requirement. After subagent starts, stop.`;
}

function r13GoalInitInput(round) {
  const task = (id, deps, description) => ({ id, description, deps, writePaths: [`src/${id}.mjs`, `test/${id}.test.mjs`], acceptance: { criteria: [{ id: `${id}-tdd`, statement: `${id} has a passing Node test for its implementation`, evidenceKinds: ["changed-files", "tests"] }] }, workflow: "tdd" });
  return {
    objective: `R13 round ${round}: three-task recovery DAG and final review`,
    execution: {
      schema: "goal-runtime.v1",
      tasks: [
        task("task-a", [], "Implement Task A by TDD: add its failing Node test, implement it, run the test, and commit the clean workspace result."),
        task("task-b", ["task-a"], "FIRST ATTEMPT ONLY: check for the missing marker R13_CONTEXT_MARKER. It is absent. Make no file changes and report NEEDS_CONTEXT. After the official failed/blocked settlement and resource disposition, amend/resolve this task to the legal TDD implementation described by its acceptance criterion, redispatch it, then implement it by TDD and commit."),
        task("task-c", ["task-b"], "Implement Task C by TDD only after Task B is accepted: add a failing Node test, implement it, run the test, and commit."),
      ],
      conditions: [{ id: "final-state", role: "terminal", enforcement: "final", statement: "all R13 tasks are complete", observable: "canary oracle", expected: "PASS", depends_on: [], oracle_ref: "canary-oracle", environment_ref: "canary-local", fixture_refs: ["canary-fixture"], invalidation: { paths: [], task_ids: [] }, remediation: { policy: "user-approved", allowed_paths: ["src/**", "test/**"], max_attempts: 1 }, stability: { mode: "single", require_fresh_environment: true } }],
      write_policy: { allowed_paths: ["src/**", "test/**"] }, budgets: { max_observations: 3, max_repairs: 2, max_elapsed_minutes: 15, max_no_progress: 10 },
    },
  };
}

function r13InitialPrompt(round) {
  return `Operate this Runtime Goal strictly via the exact eight Goal tools and returned typed subagent contracts; do not use tool handlers or invent child results. Use this exact goal_init payload: ${JSON.stringify(r13GoalInitInput(round))}. Then repeatedly use goal_status.machineAction as the sole next Goal action. Complete Task A, execute Task B's required genuine NEEDS_CONTEXT first attempt with zero file changes, settle it using its official outcome, dispose its resources as offered, amend/resolve and redispatch the legal TDD retry, then complete Task C. For every successful child use the official proof and normal settle, integrate, accept lifecycle. Stop when a genuine user approval is required; do not approve on this first prompt.`;
}

function assertR13ToolEvents(events, diagnostic) {
  try {
    const starts = events.filter(event => event.type === "tool_execution_start" && toolNames.includes(event.toolName));
    for (const start of starts) {
      const ends = events.filter(event => event.type === "tool_execution_end" && event.toolCallId === start.toolCallId);
      assert.equal(ends.length, 1, `R13 tool ${start.toolName} must have one matching result`);
      assert.equal(ends[0].isError === true || ends[0].result?.isError === true, false, `R13 tool ${start.toolName} failed closed`);
    }
    assert.deepEqual([...new Set(starts.map(event => event.toolName))].sort(), toolNames, "R13 must successfully call exact-eight");
  } catch (error) { error.diagnostic = diagnostic?.() ?? { timeline: [] }; throw error; }
}

async function runRealR13Round(round, identities) {
  const started = Date.now(), cwd = realpathSync(mkdtempSync(join(tmpdir(), `goal-r13-round-${round}-`))), agentDir = realpathSync(mkdtempSync(join(tmpdir(), `goal-r13-agent-${round}-`)));
  const env = canaryStateEnvironment(agentDir), settingsPath = join(agentDir, "settings.json"), goalEntry = join(agentDir, "goal-engine-r13-entry.mjs");
  let client;
  try {
    git(cwd, "init", "-b", "main"); git(cwd, "config", "user.email", "canary@example.invalid"); git(cwd, "config", "user.name", "R13 Canary");
    writeFileSync(join(cwd, ".gitignore"), ".state/\n"); git(cwd, "add", ".gitignore"); git(cwd, "commit", "-m", "test: R13 clean origin");
    assertCanaryModelPreflight(cwd, env); writeFileSync(settingsPath, JSON.stringify(productionSettings()), { mode: 0o600 }); writeFileSync(goalEntry, realCanaryGoalEntry(settingsPath), { mode: 0o600 });
    client = new JsonlRpcClient("/opt/homebrew/bin/pi", ["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "-e", subagentRuntimeEntry, "-e", goalEntry, "--provider", "openai-codex", "--model", "gpt-5.6-luna", "--tools", toolNames.join(",")], { cwd, env, maxEvents: 2048 });
    for (let continuation = 0; continuation < 20; continuation++) {
      const remaining = 900_000 - (Date.now() - started); assert.ok(remaining > 0, "R13 round deadline exceeded");
      if (continuation && client.settled) { client.settled = false; client.done = new Promise(resolve => { client.resolveDone = resolve; }); }
      const message = continuation === 0 ? r13InitialPrompt(round) : "Continue only by reading goal_status.machineAction and taking that exact action. This is a new real RPC user message: if approval is requested for runtime activation, amendment, or final review, I approve it. Do not use any non-Goal tool except the returned typed subagent contract; stop after the next required user approval or when Goal is completed.";
      await client.request("prompt", { message }, Math.min(30_000, remaining)); await client.waitForSettled(remaining);
      const initStarts = client.toolEvents.filter(event => event.type === "tool_execution_start" && event.toolName === "goal_init");
      if (initStarts.length) {
        const init = toolEndForStart(client.toolEvents, "goal_init"); const initialized = parseToolResultJson(init.end, init.start.toolCallId); identities.goal = initialized.goalId;
      }
      const statuses = client.toolEvents.filter(event => event.type === "tool_execution_end" && event.toolName === "goal_status" && event.result?.isError !== true && event.isError !== true);
      const latest = statuses.at(-1); let status;
      if (latest) status = parseToolResultJson(latest, latest.toolCallId);
      if (status?.status === "completed" || status?.lifecycle === "completed") break;
    }
    assertR13ToolEvents(client.toolEvents, () => client.diagnostic());
    assert.ok(identities.goal, "R13 must create a goal");
    const projection = loadProjection(goalLedgerLocator(cwd, env, identities.goal).root, identities.goal);
    assert.equal(projection?.lifecycle, "completed", "R13 goal must complete after production final review");
    assert.equal(projection?.finalReview?.status, "recorded", "R13 production final review must be recorded");
    assert.equal(projection?.tasks.get("task-b")?.attempt >= 2, true, "Task B must be amended and redispatched");
    const ledger = readFileSync(goalLedgerLocator(cwd, env, identities.goal).path, "utf8");
    for (const type of ["task.settled", "task.managed_workspace_disposition_intent", "task.managed_workspace_disposition_receipt", "execution.amendment_applied", "goal.final_review_started", "goal.final_review_recorded", "goal.completed"]) assert.match(ledger, new RegExp(`"type":"${type}"`), `R13 ledger missing canonical ${type}`);
    assert.doesNotMatch(ledger, /"type":"task\.workspace_disposition_(started|applied|disposed)"/, "R13 must not use legacy workspace events");
    const inventory = inventoryManagedWorkspaces({ stateRoot: env.PI_CODING_WORKSPACE_DIR, originRoot: cwd });
    assert.deepEqual(inventory.workspaces, [], "R13 must not leave managed workspaces"); assert.deepEqual(inventory.orphanRegistrations, [], "R13 must not leave orphan registrations");
    for (const task of projection.tasks.values()) if (task.executorBinding) assertCanonicalAttempt(task.executorBinding, `R13 ${task.id} binding`);
    identities.root = cwd; identities.session = agentDir; identities.workspace = env.PI_CODING_WORKSPACE_DIR; identities.run = [...projection.tasks.values()].map(task => task.executorBinding?.runId).filter(Boolean).join(","); identities.token = `host-action-token-${round}-${randomUUID()}`; identities.approval = `host-approval-${round}-${randomUUID()}`;
    return identities;
  } finally { await client?.terminate(); rmSync(agentDir, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); }
}

function loader(cwd, agentDir) {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return new DefaultResourceLoader({ cwd, agentDir, additionalExtensionPaths: [subagentRuntimeEntry, productionEntry], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
}
async function start(cwd, agentDir, sessionManager, { sessionStart = true } = {}) {
  const resourceLoader = loader(cwd, agentDir);
  await resourceLoader.reload();
  const extensionsResult = resourceLoader.getExtensions();
  const extensionErrors = [
    ...(extensionsResult.errors || []),
    ...(extensionsResult.diagnostics || []).filter((diagnostic) => diagnostic?.level === "error" || diagnostic?.severity === "error"),
  ];
  assert.deepEqual(extensionErrors, [], `extension load errors: ${JSON.stringify(extensionsResult)}`);
  const loadedPaths = (extensionsResult.extensions || []).map((extension) => extension?.path || extension?.name).filter(Boolean);
  assert.equal(loadedPaths.some((path) => String(path).includes("subagent-runtime.ts")), true, `subagent runtime was not loaded: ${JSON.stringify(loadedPaths)}`);
  assert.equal(loadedPaths.some((path) => String(path).includes("goal-engine.ts")), true, `goal entry was not loaded: ${JSON.stringify(loadedPaths)}`);
  const host = await createAgentSession({ cwd, agentDir, resourceLoader, sessionManager });
  await host.session.bindExtensions({ mode: "rpc", shutdownHandler() {}, onError(error) { throw error; } });
  if (sessionStart) await host.session.extensionRunner.emit({ type: "session_start" });
  await host.session.extensionRunner.emitBeforeAgentStart();
  host.cwd = cwd;
  host.loadedExtensionPaths = loadedPaths;
  return host;
}
function publicTool(host, name) {
  const tools = host.session.agent?.state?.tools;
  const values = tools instanceof Map ? [...tools.values()] : Array.isArray(tools) ? tools : tools && typeof tools === "object" ? Object.values(tools) : [];
  return values.find((tool) => tool?.name === name);
}
async function call(host, name, id, params, signal = AbortSignal.timeout(900_000)) {
  return host.session.getToolDefinition(name).execute(id, params, signal, undefined, { cwd: host.cwd, sessionManager: host.session.sessionManager });
}
const resultValue = async (...args) => JSON.parse((await call(...args)).details.value);

function assertCanaryDispatchIdentity(initialized, dispatched, taskId) {
  assert.equal(Object.hasOwn(dispatched, "goalId"), false, "dispatch public result has no top-level goalId");
  assert.equal(dispatched.task_id, taskId);
  assert.equal(dispatched.contract?.taskId, `${initialized.goalId}.${taskId}`);
  assert.match(dispatched.contract_hash, /^[a-f0-9]{64}$/);
}

test("RPC JSONL client uses LF framing, correlates responses, consumes UI, aborts, and bounds diagnostics", async () => {
  const program = String.raw`let b=""; process.stdin.on("data", c => { b += c; for (;;) { const n=b.indexOf("\n"); if(n<0) break; const r=JSON.parse(b.slice(0,n)); b=b.slice(n+1); if(r.type === "extension_ui_response") process.stdout.write(JSON.stringify({type:"ui_answer",confirmed:r.confirmed})+"\n"); else if(r.type === "abort") { process.stdout.write(JSON.stringify({id:r.id,type:"response",command:"abort",success:true})+"\n"); process.exit(0); } else { const out=JSON.stringify({id:r.id,type:"response",command:r.type,success:true,data:{model:{provider:"openai-codex",id:"gpt-5.6-luna"}}})+"\n"; process.stdout.write(Buffer.from(out).subarray(0,9)); process.stdout.write(Buffer.from(out).subarray(9)); process.stdout.write(JSON.stringify({type:"extension_ui_request",id:"ui-1",method:"confirm"})+"\n"); process.stdout.write(JSON.stringify({type:"message_update",text:"x y"})+"\n"); process.stdout.write(JSON.stringify({type:"agent_settled"})+"\n"); } } }); process.stderr.write("x".repeat(20000));`;
  const client = new JsonlRpcClient(process.execPath, ["-e", program], { maxStderr: 64 });
  try {
    const state = await client.request("get_state");
    assert.equal(state.data.model.id, "gpt-5.6-luna");
    await client.waitForSettled(2_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(client.events.some((event) => event.type === "ui_answer" && event.confirmed), true);
    assert.equal(client.events.some((event) => event.type === "message_update" && event.text === "x y"), true, "U+2028 is data, not a delimiter");
    assert.equal(client.stderr.length, 64);
  } finally { await client.terminate(); }
});

test("RPC tool result parser uses only matching public text content", () => {
  const event = { type: "tool_execution_end", toolName: "goal_init", toolCallId: "init-1", isError: false, result: { isError: false, content: [{ type: "text", text: "{\"goal" }, { type: "image", data: "ignored" }, { type: "text", text: "Id\":\"g-1\"}" }] } };
  assert.deepEqual(parseToolResultJson(event, "init-1"), { goalId: "g-1" });
  assert.throws(() => parseToolResultJson({ ...event, toolCallId: "other" }, "init-1"), /does not match/);
  assert.throws(() => parseToolResultJson({ ...event, result: { ...event.result, isError: true } }, "init-1"), /returned an error/);
  assert.throws(() => parseToolResultJson({ ...event, result: { isError: false, content: [{ type: "image" }] } }, "init-1"), /no text JSON/);
});

test("canonical planned.v1 smoke goal_init input has no extra task fields", () => {
  const plan = smokeGoalInitInput("smoke-task");
  assert.deepEqual(Object.keys(plan), ["objective", "tasks"]);
  assert.deepEqual(Object.keys(plan.tasks[0]), ["id", "description", "deps", "writePaths", "acceptance", "workflow"]);
  assert.deepEqual(plan.tasks[0].deps, []);
  assert.deepEqual(plan.tasks[0].writePaths, ["src/smoke.ts", "test/smoke.test.mjs"]);
  assert.deepEqual(plan.tasks[0].acceptance.criteria[0].evidenceKinds, ["changed-files", "tests"]);
  assert.doesNotMatch(JSON.stringify(plan), /agentProfile|commit/);
  const exactJson = JSON.stringify(plan);
  const prompt = realCanarySmokePrompt("smoke-task");
  assert.match(prompt, new RegExp(exactJson.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(prompt, /exact JSON verbatim/);
});

test("canonical attempt, receipt, and Goal intent fixtures reject legacy contract drift", () => {
  assertCanonicalAttempt({ attempt: 1 });
  assert.throws(() => assertCanonicalAttempt({ attempts: 1 }), /plural attempts/);
  assert.throws(() => assertCanonicalAttempt({ attempt_id: 1 }), /canonical attempt/);
  const events = [
    "task.managed_workspace_disposition_intent",
    "task.managed_workspace_disposition_receipt",
    "goal.final_review_started",
    "goal.final_review_recorded",
  ];
  assert.deepEqual(events, [...events].filter((type) => !/workspace_disposition_(started|applied|disposed)$/.test(type)));
  assert.equal(events.includes("task.workspace_disposition_applied"), false);
});

test("post-assertion failures retain redacted recursive diagnostic and phase timeline", () => {
  const capability = "post-assertion-secret";
  const events = toolNames.map((toolName, index) => ({ type: "tool_execution_start", toolName, toolCallId: `${toolName}-${index}` })).concat({ type: "tool_execution_end", toolName: "goal_init", toolCallId: "goal_init-0", result: { isError: false, content: [{ type: "text", text: JSON.stringify({ actionToken: capability }) }] } });
  const diagnostic = () => ({ timeline: [{ phase: "goal_finalize_end", lastEvent: redactRpc({ actionToken: capability }) }], lastEvent: redactRpc({ authorization: capability }) });
  assert.throws(() => assertSuccessfulR13Tools(events, diagnostic), (error) => {
    assert.match(JSON.stringify(error.diagnostic), /goal_finalize_end/);
    assert.doesNotMatch(JSON.stringify(error.diagnostic), new RegExp(capability));
    return true;
  });
});

test("RED fixture rejects failed then successful tool retries and redacts nested capabilities", () => {
  const capability = "expired-temp-action-capability";
  const failedThenSuccessful = [
    { type: "tool_execution_start", toolName: "goal_init", toolCallId: "init-failed" },
    { type: "tool_execution_end", toolName: "goal_init", toolCallId: "init-failed", result: { isError: true, content: [] } },
    { type: "tool_execution_start", toolName: "goal_init", toolCallId: "init-success" },
    { type: "tool_execution_end", toolName: "goal_init", toolCallId: "init-success", result: { isError: false, content: [{ type: "text", text: "{\"goalId\":\"g-1\"}" }] } },
  ];
  assert.throws(() => toolEndForStart(failedThenSuccessful, "goal_init"), (error) => error.message === "expected exactly one goal_init tool attempt" && JSON.stringify(error.failedAttempts) === JSON.stringify([{ toolCallId: "init-failed", reason: "tool returned an error" }]));
  const selected = toolEndForStart(failedThenSuccessful.slice(2), "goal_init");
  assert.equal(selected.start.toolCallId, "init-success");

  const diagnostic = redactRpc({ runId: "run-safe", asyncDir: "/tmp/safe", phase: "goal_init", nested: { action_token: capability, ownerToken: capability }, tool: { content: JSON.stringify({ actionToken: capability, apiKey: capability, authorization: capability }) } });
  assert.doesNotMatch(diagnostic, new RegExp(capability));
  assert.match(diagnostic, /run-safe/);
  assert.match(diagnostic, /\/tmp\/safe/);
  assert.match(diagnostic, /goal_init/);
});

test("RED fixture proves agent-dir diagnostics disappear on no-settled cleanup; owner diagnostic survives", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "goal-canary-red-agent-"));
  const externalRoot = mkdtempSync(join(tmpdir(), "goal-canary-red-owner-"));
  const runId = "no-settled-fixture";
  const program = `process.stdin.on("data", c => { const r = JSON.parse(String(c)); if (r.type === "prompt") process.stdout.write(JSON.stringify({ id: r.id, type: "response", command: "prompt", success: true }) + "\\n"); });`;
  const client = new JsonlRpcClient(process.execPath, ["-e", program]);
  try {
    let timeout;
    await assert.rejects(client.request("prompt", { message: "fixture" }, 50).then(() => client.waitForSettled(25)), (error) => { timeout = error; return /agent_settled deadline/.test(error.message); });
    const lostPath = join(agentDir, "rpc-smoke-blocked-events.json");
    writeFileSync(lostPath, JSON.stringify(client.diagnostic()), { mode: 0o600 });
    rmSync(agentDir, { recursive: true, force: true });
    assert.throws(() => readFileSync(lostPath), /ENOENT/, "legacy diagnostic must be unrecoverable after agentDir cleanup");
    const capability = "expired-temp-action-capability-file";
    const path = writeCanaryFailureDiagnostic({ externalRoot, runId, diagnostic: { ...client.diagnostic(), runId: "run-safe", asyncDir: "/tmp/safe", phase: "goal_init", toolContent: JSON.stringify({ action_token: capability }) }, error: timeout });
    const saved = readFileSync(path, "utf8");
    assert.match(saved, /agent_settled/);
    assert.doesNotMatch(saved, /bearer secret/);
    assert.doesNotMatch(saved, new RegExp(capability));
    assert.match(saved, /run-safe/);
    assert.match(saved, /\/tmp\/safe/);
    assert.match(saved, /goal_init/);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(externalRoot).mode & 0o777, 0o700);
    const bounded = writeCanaryFailureDiagnostic({ externalRoot, runId: "bounded-fixture", diagnostic: { bearer: "x".repeat(10_000) }, error: timeout, maxBytes: 512 });
    assert.ok(statSync(bounded).size <= 512, "external diagnostic has a hard size cap");
  } finally { await client.terminate(); rmSync(agentDir, { recursive: true, force: true }); rmSync(externalRoot, { recursive: true, force: true }); }
});

test("local RPC deadline records phases, handles extension UI, aborts and terminates a stalled subagent", async () => {
  const program = String.raw`let b=""; process.stdin.on("data", c => { b += c; for (;;) { const n=b.indexOf("\n"); if(n<0) break; const r=JSON.parse(b.slice(0,n)); b=b.slice(n+1); if(r.type === "prompt") { process.stdout.write(JSON.stringify({id:r.id,type:"response",command:"prompt",success:true})+"\n"); process.stdout.write(JSON.stringify({type:"tool_execution_start",toolName:"goal_init",toolCallId:"i"})+"\n"); process.stdout.write(JSON.stringify({type:"tool_execution_end",toolName:"goal_init",toolCallId:"i"})+"\n"); process.stdout.write(JSON.stringify({type:"tool_execution_start",toolName:"goal_status",toolCallId:"t"})+"\n"); process.stdout.write(JSON.stringify({type:"tool_execution_end",toolName:"goal_status",toolCallId:"t"})+"\n"); process.stdout.write(JSON.stringify({type:"tool_execution_start",toolName:"goal_dispatch",toolCallId:"d"})+"\n"); process.stdout.write(JSON.stringify({type:"tool_execution_end",toolName:"goal_dispatch",toolCallId:"d"})+"\n"); process.stdout.write(JSON.stringify({type:"extension_ui_request",id:"ui",method:"confirm"})+"\n"); process.stdout.write(JSON.stringify({type:"tool_execution_start",toolName:"subagent",toolCallId:"s"})+"\n"); } else if(r.type === "extension_ui_response") process.stdout.write(JSON.stringify({type:"ui_answer",confirmed:r.confirmed})+"\n"); else if(r.type === "abort") { process.stdout.write(JSON.stringify({id:r.id,type:"response",command:"abort",success:true})+"\n"); } } });`;
  const client = new JsonlRpcClient(process.execPath, ["-e", program]);
  try {
    await assert.rejects(runBoundedRpcCanary(client, { prompt: "fixture", requiredPhases: ["goal_init_start", "goal_init_end", "goal_status_start", "goal_status_end", "goal_dispatch_start", "goal_dispatch_end", "subagent_start", "subagent_end"], deadlines: { prompt: 100, goal_init: 100, subagent: 25, settled: 100 } }), /subagent_end deadline/);
    assert.equal(client.events.some((event) => event.type === "ui_answer" && event.confirmed), true);
    assert.deepEqual(client.diagnostic().timeline.map((item) => item.phase), ["prompt_response", "goal_init_start", "goal_init_end", "goal_status_start", "goal_status_end", "goal_dispatch_start", "goal_dispatch_end", "subagent_start"]);
    assert.equal(client.abortRequested, true);
    assert.equal(client.closed, true);
    assert.equal(client.phaseWaiters.size, 0, "deadline cleanup clears phase timers");
  } finally { await client.terminate(); }
});

test("RED fixture fails closed within one second when goal_init ends in error", async () => {
  const capability = "expired-temp-action-capability-stage-wait";
  const program = String.raw`let b=""; process.stdin.on("data", c => { b += c; for (;;) { const n=b.indexOf("\n"); if(n<0) break; const r=JSON.parse(b.slice(0,n)); b=b.slice(n+1); if(r.type === "prompt") { process.stdout.write(JSON.stringify({id:r.id,type:"response",command:"prompt",success:true})+"\n"); process.stdout.write(JSON.stringify({type:"tool_execution_start",toolName:"goal_init",toolCallId:"failed-init"})+"\n"); process.stdout.write(JSON.stringify({type:"tool_execution_end",toolName:"goal_init",toolCallId:"failed-init",result:{isError:true,content:[{type:"text",text:${JSON.stringify(JSON.stringify({ actionToken: capability }))}}]}})+"\n"); } else if(r.type === "abort") process.stdout.write(JSON.stringify({id:r.id,type:"response",command:"abort",success:true})+"\n"); } });`;
  const client = new JsonlRpcClient(process.execPath, ["-e", program]);
  const startedAt = performance.now();
  try {
    await assert.rejects(runBoundedRpcCanary(client, { prompt: "fixture", deadlines: { prompt: 100, goal_init: 5_000, goal_status: 5_000 } }), (error) => {
      assert.match(error.message, /stage goal_init_end failed: tool goal_init returned error/);
      assert.doesNotMatch(error.message, new RegExp(capability));
      return true;
    });
    assert.ok(performance.now() - startedAt < 1_000, "goal_init error must not wait for goal_status deadline");
    assert.equal(client.abortRequested, true);
  } finally { await client.terminate(); }
});

test("local R13 driver keeps two rounds isolated, bounds continuations, pairs exact tools, answers UI, and cleans RPC", async () => {
  const identities = [
    { round: 1, root: "root-1", session: "session-1", goal: "goal-1", run: "run-1", token: "token-1", approval: "approval-1", workspace: "workspace-1" },
    { round: 2, root: "root-2", session: "session-2", goal: "goal-2", run: "run-2", token: "token-2", approval: "approval-2", workspace: "workspace-2" },
  ];
  await runLocalR13FixtureDriver(identities);
  await assert.rejects(runLocalR13FixtureDriver([{ ...identities[0] }, { ...identities[1], session: identities[0].session }]), /must not reuse session/);
});
// This intentionally uses the globally installed SDK and the actual production
// entry, rather than a test-only Pi/Host double or a wrapper extension.
test("真实 Pi production entry loads exact-eight without a model provider", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "goal-runtime-real-canary-")));
  const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "goal-runtime-real-agent-")));
  const inheritedAgentDir = process.env.PI_CODING_AGENT_DIR;
  const inheritedGoalDir = process.env.PI_CODING_GOAL_DIR;
  let host;
  try {
    git(cwd, "init", "-b", "main"); git(cwd, "config", "user.email", "canary@example.invalid"); git(cwd, "config", "user.name", "Runtime Canary");
    writeFileSync(join(cwd, ".gitignore"), ".state/\n"); git(cwd, "add", ".gitignore"); git(cwd, "commit", "-m", "test: 初始化 runtime canary 仓库");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(productionSettings()), { mode: 0o600 });
    delete process.env.PI_CODING_GOAL_DIR;
    host = await start(cwd, agentDir, SessionManager.create(cwd, join(agentDir, "sessions")));
    assert.deepEqual(toolNames.map(name => host.session.getToolDefinition(name)?.name).sort(), toolNames);
    assert.equal(host.session.getToolDefinition("goal_observe"), undefined);
    // Entry loading must not create resources before a real Goal operation.
    const inventory = inventoryManagedWorkspaces({ stateRoot: join(agentDir, "workspaces"), originRoot: cwd });
    assert.deepEqual(inventory.workspaces, []);
    assert.deepEqual(inventory.orphanRegistrations, []);
  } finally {
    try { host?.session?.dispose(); } catch {}
    if (inheritedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = inheritedAgentDir;
    if (inheritedGoalDir === undefined) delete process.env.PI_CODING_GOAL_DIR; else process.env.PI_CODING_GOAL_DIR = inheritedGoalDir;
    rmSync(agentDir, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true });
  }
});

test("fresh local production goal_init accepts the canonical planned.v1 input once and locates its exact Goal ledger", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "goal-runtime-local-canary-")));
  const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "goal-runtime-local-agent-")));
  const inherited = { PATH: process.env.PATH, HOME: "/parent-home", PI_CODING_AGENT_DIR: projectAgentRoot, PI_CONFIG_HOME: projectConfigHome, PI_CODING_GOAL_DIR: "/main-session/goals", PI_CODING_WORKSPACE_DIR: "/main-session/workspaces", PI_SUBAGENT_RUN_ID: "parent-run", PI_SUBAGENT_DIAGNOSTIC: "parent-diagnostic" };
  const env = canaryStateEnvironment(agentDir, inherited);
  const saved = Object.fromEntries(["PI_CODING_GOAL_DIR", "PI_CODING_WORKSPACE_DIR", "PI_CODING_AGENT_DIR"].map((key) => [key, process.env[key]]));
  let host;
  try {
    assert.notEqual(env.PI_CODING_GOAL_DIR, inherited.PI_CODING_GOAL_DIR, "canary must not inherit the main session Goal root");
    assert.notEqual(env.PI_CODING_WORKSPACE_DIR, inherited.PI_CODING_WORKSPACE_DIR, "canary must not inherit the main session workspace root");
    assertCanaryAgentRoot(env);
    assert.equal(env.HOME, inherited.HOME, "the canary must not replace HOME while isolating state");
    assert.equal(Object.keys(env).some(key => key.startsWith("PI_SUBAGENT_")), false, "only inherited subagent fanout markers are removed");
    const childEnv = JSON.parse(execFileSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify({ goal: process.env.PI_CODING_GOAL_DIR, workspace: process.env.PI_CODING_WORKSPACE_DIR, agent: process.env.PI_CODING_AGENT_DIR, config: process.env.PI_CONFIG_HOME, home: process.env.HOME, hasFanoutMarker: Object.keys(process.env).some(key => key.startsWith('PI_SUBAGENT_')) }))"], { env, encoding: "utf8" }));
    assert.deepEqual(childEnv, { goal: env.PI_CODING_GOAL_DIR, workspace: env.PI_CODING_WORKSPACE_DIR, agent: projectAgentRoot, config: projectConfigHome, home: inherited.HOME, hasFanoutMarker: false }, "the canary child receives isolated state without changing its resolver root");
    process.env.PI_CODING_GOAL_DIR = env.PI_CODING_GOAL_DIR;
    process.env.PI_CODING_WORKSPACE_DIR = env.PI_CODING_WORKSPACE_DIR;
    git(cwd, "init", "-b", "main"); git(cwd, "config", "user.email", "canary@example.invalid"); git(cwd, "config", "user.name", "Runtime Canary");
    writeFileSync(join(cwd, ".gitignore"), ".state/\n"); git(cwd, "add", ".gitignore"); git(cwd, "commit", "-m", "test: local canary origin");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(productionSettings()), { mode: 0o600 });
    host = await start(cwd, agentDir, SessionManager.create(cwd, join(agentDir, "sessions")));
    const initInput = smokeGoalInitInput("ledger");
    assert.deepEqual(Object.keys(initInput.tasks[0]), ["id", "description", "deps", "writePaths", "acceptance", "workflow"]);
    assert.ok(publicTool(host, "goal_init"), "production goal_init tool is public");
    const initialized = await resultValue(host, "goal_init", "local-canary-init", initInput);
    const locator = goalLedgerLocator(cwd, env, initialized.goalId);
    assert.equal(locator.root, resolveGoalStateScope({ cwd, env }).preferredRoot);
    assert.equal(locator.path, join(locator.root, "goals", initialized.goalId, "events.jsonl"));
    assert.equal(readFileSync(locator.path, "utf8").includes("goal.created"), true);
    assert.equal(loadProjection(locator.root, initialized.goalId)?.goalId, initialized.goalId);
    assert.equal(loadProjection(join(cwd, ".state", "goal-engine"), initialized.goalId), null, "locator must not fall back to origin/.state");
  } finally {
    try { host?.session?.dispose(); } catch {}
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(agentDir, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true });
  }
});

test("RED legacy dispatch goalId assertion fails; local dispatch identity contract passes", () => {
  const initialized = { goalId: "goal-local-canary" };
  const taskId = "dispatch-contract";
  const dispatched = {
    status: "dispatched",
    task_id: taskId,
    contract: { taskId: `${initialized.goalId}.${taskId}` },
    contract_hash: "a".repeat(64),
  };
  assert.throws(() => assert.equal(initialized.goalId, dispatched.goalId), /Expected values to be strictly equal/);
  assertCanaryDispatchIdentity(initialized, dispatched, taskId);
});

test("real root RPC binds one Goal typed subagent", { skip: process.env.PI_RUN_GOAL_REAL_CANARY !== "1" }, async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "goal-runtime-rpc-canary-")));
  const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "goal-runtime-rpc-agent-")));
  const env = canaryStateEnvironment(agentDir);
  const taskId = "goal-t9d-persist-real-smoke-test";
  const settingsPath = join(agentDir, "settings.json");
  const goalEntry = join(agentDir, "goal-engine-real-canary-entry.mjs");
  const canaryRunId = randomUUID();
  const failureRoot = process.env.GOAL_R13_CANARY_FAILURE_ROOT || join(tmpdir(), "goal-r13-canary-failures");
  let client;
  try {
    assert.equal(execFileSync(process.execPath, ["--version"], { encoding: "utf8" }).trim().startsWith("v"), true, "Node runtime is required before the real RPC canary");
    assert.equal(execFileSync("/opt/homebrew/bin/pi", ["--version"], { encoding: "utf8" }).trim(), "0.84.4", "the pinned Pi executable is required");
    git(cwd, "init", "-b", "main"); git(cwd, "config", "user.email", "canary@example.invalid"); git(cwd, "config", "user.name", "Runtime Canary");
    writeFileSync(join(cwd, ".gitignore"), ".state/\n"); git(cwd, "add", ".gitignore"); git(cwd, "commit", "-m", "test: real RPC canary origin");
    assertCanaryAgentRoot(env);
    assertCanaryModelPreflight(cwd, env);
    writeFileSync(settingsPath, JSON.stringify(productionSettings()), { mode: 0o600 });
    writeFileSync(goalEntry, realCanaryGoalEntry(settingsPath), { mode: 0o600 });
    const prompt = realCanarySmokePrompt(taskId);
    client = new JsonlRpcClient("/opt/homebrew/bin/pi", [
      "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
      "-e", subagentRuntimeEntry, "-e", goalEntry,
      "--provider", "openai-codex", "--model", "gpt-5.6-luna",
      "--tools", "goal_init,goal_status,goal_dispatch,subagent",
    ], { cwd, env });
    await runBoundedRpcCanary(client, { prompt, deadlines: { prompt: 30_000, goal_init: 120_000, goal_status: 120_000, goal_dispatch: 120_000, subagent: 120_000, settled: 900_000 } });

    const init = toolEndForStart(client.toolEvents, "goal_init");
    const status = toolEndForStart(client.toolEvents, "goal_status");
    const dispatch = toolEndForStart(client.toolEvents, "goal_dispatch");
    const subagent = toolEndForStart(client.toolEvents, "subagent");
    const initialized = parseToolResultJson(init.end, init.start.toolCallId);
    parseToolResultJson(status.end, status.start.toolCallId);
    const dispatched = parseToolResultJson(dispatch.end, dispatch.start.toolCallId);
    const details = subagent.end.result?.details;
    assertCanaryDispatchIdentity(initialized, dispatched, taskId);
    assert.equal(typeof details?.runId, "string", JSON.stringify(subagent.end));
    assert.equal(typeof details?.asyncDir, "string", JSON.stringify(subagent.end));
    assert.equal(details.contractHash, dispatched.contract_hash, JSON.stringify(details));
    const locator = goalLedgerLocator(cwd, env, initialized.goalId);
    const projection = loadProjection(locator.root, initialized.goalId);
    const binding = projection?.tasks.get(taskId)?.executorBinding;
    assert.deepEqual(binding && { runId: binding.runId, asyncDir: binding.asyncDir, contractHash: binding.contractHash }, {
      runId: details.runId, asyncDir: details.asyncDir, contractHash: dispatched.contract_hash,
    });
  } catch (error) {
    const diagnosticPath = writeCanaryFailureDiagnostic({ externalRoot: failureRoot, runId: canaryRunId, diagnostic: client?.diagnostic() ?? { error: String(error) }, error });
    error.canaryFailureDiagnostic = diagnosticPath;
    throw error;
  } finally {
    await client?.terminate();
    rmSync(agentDir, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true });
  }
});

test("R13 two fresh RPC Hosts complete the three-task recovery DAG and production final review", { skip: process.env.PI_RUN_GOAL_R13_CANARY !== "1", timeout: 1_800_000 }, async () => {
  const rounds = [];
  rounds.push(await runRealR13Round(1, { round: 1 }));
  rounds.push(await runRealR13Round(2, { round: 2 }));
  assertDistinctR13Rounds(rounds);
});

test("真实 production Host 在 Root Broker restart 后恢复 exact failed terminal proof", async () => {
  const asyncDir = mkdtempSync(join(tmpdir(), "goal-runtime-real-restart-"));
  const runId = "real-canary-failed-executor";
  const sessionId = "real-canary-root-session";
  const terminal = {
    version: 1, runId, runnerProcessInstanceId: "real-canary-runner", state: "observed", observedAt: 1_700_000_000_000,
    instances: [{ processInstanceId: "real-canary-runner", kind: "runner", closeObservedAt: 1_700_000_000_000, exitCode: 1, signal: null }],
  };
  const upstream = { async ping() { return {}; }, async stop() { throw Error("terminal recovery must not stop a process"); }, async dispose() {} };
  const pi = { events: {} };
  const pid = 43123;
  const brokerA = new RootBrokerServer({ rootSessionId: sessionId, lifecycleSessionId: sessionId, captureProcessBirthIdentity: async () => "real-canary-birth", writeGrant: async () => "/tmp/real-canary-grant", upstream });
  try {
    const authority = { goalId: "real-canary-goal", taskId: "real-canary-task", attempt: 1, runId, asyncDir, workspacePath: "/tmp/real-canary-workspace", leaseId: "c".repeat(64), sessionId, baseHead: "a".repeat(40), headAtDispatch: "a".repeat(40), executionRevision: 1, contractHash: "b".repeat(64), expectedCriteria: ["criterion-1"], agentProfile: "executor", ticketId: "d".repeat(64), workspaceId: "real-canary-workspace" };
    await registerRestartAuthority(brokerA, authority, pid);
    upstreamWriteAtomicJson(join(asyncDir, "process-terminal.json"), terminal);
    brokerA.observeTerminal(terminal);
    await brokerA.closeRootSession();

    const brokerB = new RootBrokerServer({ rootSessionId: sessionId, lifecycleSessionId: sessionId, captureProcessBirthIdentity: async () => "real-canary-birth", writeGrant: async () => "/tmp/real-canary-grant", upstream });
    try {
      bindRootBroker(pi, brokerB);
      // Fresh Host registration re-establishes the live authorization. The
      // durable sidecar is then re-read and checked by the public broker API.
      await registerRestartAuthority(brokerB, authority, pid);
      const persisted = await brokerB.inspectExecutorProofAsync(runId);
      assert.equal(persisted.terminal.outcome, "failed");
      const host = createProductionGoalRuntimeHost(pi);
      const { expectedCriteria: _expectedCriteria, agentProfile: _agentProfile, ticketId: _ticketId, workspaceId: _workspaceId, ...stopAuthority } = authority;
      const recovered = await host.stopOwnedRun({ ...stopAuthority, agent: "executor" });
      assert.equal(recovered.state, "observed");
      assert.equal(recovered.proof.runId, runId);
      assert.equal(recovered.proof.instances[0].exitCode, 1, "failed proof remains failed terminal evidence");
    } finally {
      unbindRootBroker(pi, brokerB);
      await brokerB.closeRootSession();
    }
  } finally {
    await brokerA.closeRootSession().catch(() => undefined);
    rmSync(asyncDir, { recursive: true, force: true });
  }
});

test("未注册 Goal authority 的 restart fixture 保持 fail-closed attention", async () => {
  const asyncDir = mkdtempSync(join(tmpdir(), "goal-runtime-real-restart-unregistered-"));
  const runId = "real-canary-unregistered";
  const sessionId = "real-canary-unregistered-session";
  const pi = { events: {} };
  const broker = new RootBrokerServer({ rootSessionId: sessionId, lifecycleSessionId: sessionId, upstream: { async ping() { return {}; }, async stop() { throw Error("must not stop an unregistered run"); }, async dispose() {} } });
  try {
    bindRootBroker(pi, broker);
    const host = createProductionGoalRuntimeHost(pi);
    const result = await host.stopOwnedRun({ goalId: "unregistered-goal", taskId: "unregistered-task", attempt: 1, runId, asyncDir, workspacePath: "/tmp/unregistered-workspace", leaseId: "c".repeat(64), sessionId, baseHead: "a".repeat(40), headAtDispatch: "a".repeat(40), executionRevision: 1, contractHash: "b".repeat(64), agent: "executor" });
    assert.deepEqual(result, { state: "attention", code: "OWNED_STOP_IDENTITY_UNKNOWN" });
  } finally {
    unbindRootBroker(pi, broker);
    await broker.closeRootSession();
    rmSync(asyncDir, { recursive: true, force: true });
  }
});
